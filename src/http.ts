import { homedir } from "node:os";
import { join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { setMoodleTransport } from "./moodle.js";
import { createGuardedFetch } from "./netguard.js";
import { MoodleOAuth, SCOPE } from "./oauth.js";
import { createMcpServer, ToolContent, type ToolContext } from "./tools.js";
import { parseMasterKey, UserSites, Vault } from "./vault.js";

// Files come back inside a JSON response here, so the limit is lower than on stdio.
const HOSTED_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function publicOrigin(value: string | undefined): URL {
  if (!value) throw new Error("MOODLE_MCP_PUBLIC_URL is required in http mode, for example https://moodle-mcp.example.org");
  const url = new URL(value);
  if (url.protocol !== "https:" && !LOOPBACK.has(url.hostname)) throw new Error("MOODLE_MCP_PUBLIC_URL must use https.");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("MOODLE_MCP_PUBLIC_URL must be an origin with no path, because OAuth endpoints live at its root.");
  return url;
}

function hostedContext(userId: string, sites: UserSites, oauth: MoodleOAuth): ToolContext {
  const store = sites.forUser(userId);
  const reconnect = "On this hosted server you sign in when connecting. To sign in again or use another Moodle account, disconnect this connector in your app and connect it again.";
  return {
    store: {
      ...store,
      remove: async (key) => {
        const removed = await store.remove(key);
        // An account is one Moodle identity, so without its site nothing is left to keep.
        if (removed) await oauth.forgetUser(userId);
        return removed;
      },
    },
    where: "on this hosted server for the current user",
    loginDescription: `Explains how to sign in on this hosted server. ${reconnect}`,
    login: async () => reconnect,
    maxDownloadBytes: HOSTED_MAX_DOWNLOAD_BYTES,
    // Never written to disk: a shared temp folder would hold many students' files.
    deliverFile: async ({ url, filename, bytes, type }) =>
      new ToolContent([
        { type: "text", text: JSON.stringify({ filename, bytes: bytes.length, content_type: type }) },
        { type: "resource", resource: { uri: url, mimeType: type || "application/octet-stream", blob: bytes.toString("base64") } },
      ]),
  };
}

export async function startHttpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.MOODLE_MCP_MASTER_KEY) {
    throw new Error("MOODLE_MCP_MASTER_KEY is required in http mode. Create one with: openssl rand -base64 32");
  }
  const keys = [parseMasterKey(env.MOODLE_MCP_MASTER_KEY, "MOODLE_MCP_MASTER_KEY")];
  if (env.MOODLE_MCP_PREVIOUS_MASTER_KEY) keys.push(parseMasterKey(env.MOODLE_MCP_PREVIOUS_MASTER_KEY, "MOODLE_MCP_PREVIOUS_MASTER_KEY"));
  const origin = publicOrigin(env.MOODLE_MCP_PUBLIC_URL);
  const resource = new URL("/mcp", origin);
  const allowPrivate = env.MOODLE_MCP_ALLOW_PRIVATE_SITES === "1";
  if (allowPrivate) console.error("Warning: MOODLE_MCP_ALLOW_PRIVATE_SITES lets users make this server contact private addresses. Use it only in tests.");
  setMoodleTransport(createGuardedFetch({ allowPrivate, allowedHosts: list(env.MOODLE_MCP_ALLOWED_SITES) }));

  const dir = join(env.MOODLE_MCP_HOME ?? join(homedir(), ".config", "moodle-mcp"), "hosted");
  const vault = new Vault(keys);
  const sites = new UserSites(vault, join(dir, "users"));
  const oauth = await MoodleOAuth.open({
    vault,
    sites,
    dir,
    resource,
    allowPasswordLogin: env.MOODLE_MCP_DISABLE_PASSWORD_LOGIN !== "1",
    allowedRedirectHosts: list(env.MOODLE_MCP_ALLOWED_REDIRECT_HOSTS),
  });
  if (keys.length > 1) {
    // Reading re-encrypts under the current key, so rotation finishes here rather than at each user's next visit.
    for (const userId of await sites.userIds()) await sites.forUser(userId).list();
    console.error("Master key rotation finished. MOODLE_MCP_PREVIOUS_MASTER_KEY can be removed.");
  }

  const host = env.MOODLE_MCP_HOST ?? "127.0.0.1";
  const port = Number(env.MOODLE_MCP_PORT ?? 3000);
  const app = createMcpExpressApp({ host, allowedHosts: [origin.hostname] });
  app.disable("x-powered-by");
  // Rate limits key on the client IP, which only the reverse proxy knows.
  app.set("trust proxy", Number(env.MOODLE_MCP_TRUST_PROXY ?? 0));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: origin,
      resourceServerUrl: resource,
      scopesSupported: [SCOPE],
      resourceName: "Moodle",
      // A client secret that expires would strand a client that still holds a valid grant.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  app.post("/login", loginLimit, express.urlencoded({ extended: false, limit: "16kb" }), (req: Request, res: Response, next: NextFunction) => {
    oauth.handleLogin(req, res).catch(next);
  });

  // Browsers attach an Origin; other sites must not script this endpoint.
  const sameOrigin = (req: Request, res: Response, next: NextFunction): void => {
    const sent = req.headers.origin;
    if (sent && sent !== origin.origin) {
      res.status(403).json({ error: "forbidden_origin" });
      return;
    }
    next();
  };
  const bearer = requireBearerAuth({
    verifier: oauth,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
  });
  // Per user, because each call also spends that user's standing with their Moodle site.
  const userLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => String(req.auth?.extra?.userId),
  });

  // Stateless: a server and transport per request, bound to the user the bearer token proves.
  // With no session map there is nothing one user could reach or hijack from another.
  app.post("/mcp", sameOrigin, bearer, userLimit, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const server = createMcpServer(hostedContext(String(req.auth!.extra!.userId), sites, oauth));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport as any);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });
  app.all("/mcp", (_req: Request, res: Response) => {
    res.set("Allow", "POST").status(405).json({ error: "method_not_allowed" });
  });

  // Express would otherwise print the stack to the client, and a stack can quote request data.
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error(`Request failed: ${err.name}`);
    res.status(500).json({ error: "server_error" });
  });

  await oauth.sweep();
  setInterval(() => {
    oauth.sweep().catch((err: Error) => console.error(`Sweep failed: ${err.message}`));
  }, SWEEP_INTERVAL_MS).unref();

  await new Promise<void>((ok, fail) => {
    const listener = app.listen(port, host, (err?: Error) => (err ? fail(err) : ok()));
    listener.on("error", fail);
  });
  console.error(`moodle-mcp listening on ${host}:${port}, public address ${resource.href}`);
}
