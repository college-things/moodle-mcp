import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGuardedFetch, isPublicAddress } from "../dist/netguard.js";
import { MoodleOAuth } from "../dist/oauth.js";
import { UserSites, Vault } from "../dist/vault.js";

const MASTER_KEY = randomBytes(32).toString("base64");
const REDIRECT = "https://app.example/callback";

/** A Moodle with its own accounts. Every token only ever sees its own owner's data. */
function mockMoodle(accounts) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (value) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      seen.push(req.url);
      if (req.url.startsWith("/lib/ajax/service-nologin.php")) {
        return json([{ error: false, data: { sitename: "Mock <b>Moodle</b>", enablewebservices: 1, enablemobilewebservice: 1, typeoflogin: 1 } }]);
      }
      const form = new URLSearchParams(body);
      if (req.url === "/login/token.php") {
        const account = accounts.find((a) => a.username === form.get("username") && a.password === form.get("password"));
        return json(account ? { token: account.token } : { error: "Invalid login", errorcode: "invalidlogin" });
      }
      if (req.url === "/webservice/rest/server.php") {
        const account = accounts.find((a) => a.token === form.get("wstoken"));
        seen.push(`token:${form.get("wstoken")}`);
        if (!account) return json({ exception: "x", errorcode: "invalidtoken" });
        const fn = form.get("wsfunction");
        if (fn === "core_webservice_get_site_info") {
          return json({ sitename: "Mock", fullname: account.fullname, username: account.username, userid: account.userid });
        }
        if (fn === "core_enrol_get_users_courses") {
          return json(Number(form.get("userid")) === account.userid ? [{ id: account.userid, fullname: `${account.fullname} course` }] : []);
        }
        return json({ exception: "x", errorcode: "invalidrecord", message: `unknown ${fn}` });
      }
      if (req.url.startsWith("/webservice/pluginfile.php/1/notes.txt")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("notes");
      }
      if (req.url === "/moved") {
        res.writeHead(307, { Location: "/target" });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, seen };
}

const alice = { username: "alice", password: "pw-alice-secret", token: "token-alice-secret", userid: 1, fullname: "Alice A" };
const bob = { username: "bob", password: "pw-bob-secret", token: "token-bob-secret", userid: 2, fullname: "Bob B" };
const carol = { username: "carol", password: "pw-carol-secret", token: "token-carol-secret", userid: 1, fullname: "Carol C" };

const siteOne = mockMoodle([alice, bob]);
const siteTwo = mockMoodle([carol]);
let siteOneUrl;
let siteTwoUrl;
const homes = [];
const running = [];

async function newHome() {
  const home = await mkdtemp(join(tmpdir(), "moodle-mcp-http-"));
  homes.push(home);
  return home;
}

function freePort() {
  return new Promise((ok) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/** Resolves when the server listens, or rejects with its error output when it exits instead. */
async function startServer(extraEnv = {}, home) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = home ?? (await newHome());
  const child = spawn(process.execPath, ["dist/index.js", "http"], {
    env: {
      ...process.env,
      MOODLE_MCP_HOME: dir,
      MOODLE_MCP_MASTER_KEY: MASTER_KEY,
      MOODLE_MCP_PUBLIC_URL: base,
      MOODLE_MCP_PORT: String(port),
      MOODLE_MCP_ALLOW_PRIVATE_SITES: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  running.push(child);
  let log = "";
  await new Promise((ok, fail) => {
    child.stderr.on("data", (c) => {
      log += c;
      if (log.includes("listening on")) ok();
    });
    child.on("exit", () => fail(new Error(log)));
  });
  return { base, home: dir, child, log: () => log, stop: () => new Promise((ok) => (child.once("exit", ok), child.kill())) };
}

const startFailure = (env) =>
  startServer(env).then(
    () => assert.fail("server should have refused to start"),
    (err) => err.message,
  );

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(base, metadata = {}) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...metadata }),
  });
  return { status: res.status, client: await res.json() };
}

const authorizeUrl = (base, client, challenge, extra = {}) =>
  `${base}/authorize?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  })}`;

const postLogin = (base, fields) => fetch(`${base}/login`, { method: "POST", body: new URLSearchParams(fields), redirect: "manual" });

async function openForm(base, client, challenge) {
  const res = await fetch(authorizeUrl(base, client, challenge));
  const html = await res.text();
  return { res, html, id: /name="id" value="([^"]+)"/.exec(html)[1] };
}

/** Walks the whole browser flow and returns the code from the redirect. */
async function signInForCode(base, client, challenge, siteUrl, credentials) {
  const { id } = await openForm(base, client, challenge);
  const siteStep = await postLogin(base, { id, site: siteUrl });
  assert.equal(siteStep.status, 200);
  const done = await postLogin(base, { id, ...credentials });
  assert.equal(done.status, 303);
  const target = new URL(done.headers.get("location"));
  assert.equal(target.origin + target.pathname, REDIRECT);
  assert.equal(target.searchParams.get("state"), "xyz");
  return target.searchParams.get("code");
}

const tokenRequest = (base, fields) =>
  fetch(`${base}/token`, { method: "POST", body: new URLSearchParams(fields) });

const exchange = (base, client, code, verifier) =>
  tokenRequest(base, { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });

/** A signed-in user: their OAuth tokens plus an MCP client using them. */
async function signIn(base, siteUrl, credentials) {
  const { client } = await register(base);
  const { verifier, challenge } = pkce();
  const code = await signInForCode(base, client, challenge, siteUrl, credentials);
  const res = await exchange(base, client, code, verifier);
  assert.equal(res.status, 200);
  const tokens = await res.json();
  return { client, tokens };
}

async function connect(base, accessToken) {
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return mcp;
}

async function callTool(mcp, name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const accountOf = (user) => ({ username: user.username, password: user.password });

const mcpPost = (base, token, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

async function allFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(path)));
    else out.push(path);
  }
  return out;
}

let main;

before(async () => {
  await Promise.all([siteOne.server, siteTwo.server].map((s) => new Promise((ok) => s.listen(0, "127.0.0.1", ok))));
  siteOneUrl = `http://127.0.0.1:${siteOne.server.address().port}`;
  siteTwoUrl = `http://127.0.0.1:${siteTwo.server.address().port}`;
  main = await startServer();
});

after(async () => {
  for (const child of running) child.kill();
  siteOne.server.close();
  siteTwo.server.close();
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

test("http mode refuses to start without safe settings", async () => {
  assert.match(await startFailure({ MOODLE_MCP_MASTER_KEY: "" }), /MOODLE_MCP_MASTER_KEY is required/);
  assert.match(await startFailure({ MOODLE_MCP_MASTER_KEY: "c2hvcnQ=" }), /32 random bytes/);
  assert.match(await startFailure({ MOODLE_MCP_PUBLIC_URL: "" }), /MOODLE_MCP_PUBLIC_URL is required/);
  assert.match(await startFailure({ MOODLE_MCP_PUBLIC_URL: "http://moodle-mcp.example.org" }), /must use https/);
  assert.match(await startFailure({ MOODLE_MCP_PUBLIC_URL: "https://x.example/sub" }), /origin/);
});

test("/mcp needs a valid bearer token and points clients at OAuth discovery", async () => {
  const anonymous = await mcpPost(main.base);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate"), /resource_metadata=".*oauth-protected-resource\/mcp"/);
  assert.equal((await mcpPost(main.base, "made-up")).status, 401);
  const metadata = await (await fetch(`${main.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, `${main.base}/mcp`);
  const server = await (await fetch(`${main.base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.equal((await fetch(`${main.base}/mcp`)).status, 405);
});

test("one user cannot reach another user's sites", async () => {
  const a = await connect(main.base, (await signIn(main.base, siteOneUrl, accountOf(alice))).tokens.access_token);
  const b = await connect(main.base, (await signIn(main.base, siteOneUrl, accountOf(bob))).tokens.access_token);
  const c = await connect(main.base, (await signIn(main.base, siteTwoUrl, accountOf(carol))).tokens.access_token);

  assert.equal((await callTool(a, "moodle_whoami")).fullname, "Alice A");
  assert.equal((await callTool(b, "moodle_whoami")).fullname, "Bob B");
  // Carol has the same numeric user id as Alice, on another site: still another person.
  assert.equal((await callTool(c, "moodle_whoami")).fullname, "Carol C");
  assert.equal((await callTool(a, "moodle_list_courses"))[0].name, "Alice A course");

  const listed = await callTool(a, "moodle_list_sites");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].user, "Alice A");

  // Alice names Carol's site. Nothing reaches that site, by key or by URL.
  siteTwo.seen.length = 0;
  const siteTwoKey = new URL(siteTwoUrl).host;
  assert.match((await callTool(a, "moodle_whoami", { site: siteTwoUrl })).error, /Not logged in/);
  assert.match((await callTool(a, "moodle_whoami", { site: siteTwoKey })).error, /Not logged in/);
  assert.match((await callTool(a, "moodle_list_courses", { site: siteTwoUrl })).error, /Not logged in/);
  assert.deepEqual(siteTwo.seen, []);

  // Logging out of a site someone else uses does nothing to them.
  assert.match(await callTool(a, "moodle_logout", { site: siteTwoUrl }), /Not logged in/);
  assert.equal((await callTool(c, "moodle_whoami")).fullname, "Carol C");

  // Requests interleaved on one server never cross over.
  const names = await Promise.all(Array.from({ length: 30 }, (_, i) => callTool([a, b, c][i % 3], "moodle_whoami")));
  names.forEach((who, i) => assert.equal(who.fullname, ["Alice A", "Bob B", "Carol C"][i % 3]));

  // Each user's calls carried only that user's Moodle token.
  siteOne.seen.length = 0;
  await callTool(b, "moodle_list_courses");
  assert.ok(siteOne.seen.includes(`token:${bob.token}`));
  assert.ok(!siteOne.seen.includes(`token:${alice.token}`));

  await Promise.all([a.close(), b.close(), c.close()]);
});

test("nothing usable is stored in plaintext", async () => {
  const server = await startServer();
  const { tokens } = await signIn(server.base, siteOneUrl, accountOf(alice));
  const files = await allFiles(join(server.home, "hosted"));
  assert.ok(files.some((f) => f.endsWith("oauth.enc")));
  const userFiles = files.filter((f) => f.includes("/users/"));
  assert.equal(userFiles.length, 1);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const secret of [alice.token, alice.password, alice.username, alice.fullname, siteOneUrl, tokens.access_token, tokens.refresh_token]) {
      assert.ok(!text.includes(secret), `${file} contains ${secret}`);
    }
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.ok(!userFiles[0].includes("alice"));
  assert.doesNotMatch(server.log(), /secret/);
  await server.stop();
});

test("another user's encrypted file does not open under this user's id", async () => {
  const dir = await newHome();
  const vault = new Vault([randomBytes(32)]);
  const sites = new UserSites(vault, dir);
  const [first, second] = ["a".repeat(64), "b".repeat(64)];
  await sites.save(first, { url: "https://one.example", token: "first-token" });
  await sites.save(second, { url: "https://two.example", token: "second-token" });
  await copyFile(join(dir, `${second}.enc`), join(dir, `${first}.enc`));
  await assert.rejects(sites.forUser(first).list(), /Could not decrypt/);
  assert.equal(Object.values(await sites.forUser(second).list())[0].token, "second-token");
  await assert.rejects(sites.save("../x", { url: "https://one.example", token: "t" }), /Invalid user id/);
  await assert.rejects(sites.forUser("../../etc/passwd").list(), /Invalid user id/);
});

test("a changed byte or a wrong key fails instead of returning data", () => {
  const vault = new Vault([randomBytes(32)]);
  const sealed = JSON.parse(vault.seal("c", { a: 1 }));
  assert.deepEqual(vault.open("c", JSON.stringify(sealed)).value, { a: 1 });
  const data = Buffer.from(sealed.data, "base64");
  data[0] ^= 1;
  assert.throws(() => vault.open("c", JSON.stringify({ ...sealed, data: data.toString("base64") })), /Could not decrypt/);
  assert.throws(() => new Vault([randomBytes(32)]).open("c", JSON.stringify(sealed)), /Could not decrypt/);
  assert.notEqual(JSON.parse(vault.seal("c", { a: 1 })).iv, sealed.iv);
});

test("signing in again keeps one account and logout ends all of it", async () => {
  const server = await startServer();
  const first = await signIn(server.base, siteOneUrl, accountOf(alice));
  const second = await signIn(server.base, siteOneUrl, accountOf(alice));
  const other = await signIn(server.base, siteOneUrl, accountOf(bob));
  const users = () => readdir(join(server.home, "hosted", "users"));
  assert.equal((await users()).length, 2);

  const mcp = await connect(server.base, first.tokens.access_token);
  assert.match(await callTool(mcp, "moodle_logout", { site: siteOneUrl }), /Logged out/);
  await mcp.close();
  assert.equal((await users()).length, 1);

  // Every grant the account had is gone, from either sign-in.
  assert.equal((await mcpPost(server.base, first.tokens.access_token)).status, 401);
  assert.equal((await mcpPost(server.base, second.tokens.access_token)).status, 401);
  const refresh = await tokenRequest(server.base, { grant_type: "refresh_token", client_id: second.client.client_id, refresh_token: second.tokens.refresh_token });
  assert.equal((await refresh.json()).error, "invalid_grant");

  const bobClient = await connect(server.base, other.tokens.access_token);
  assert.equal((await callTool(bobClient, "moodle_whoami")).fullname, "Bob B");
  await bobClient.close();
  await server.stop();
});

test("authorization codes need the right verifier and client, and work once", async () => {
  const server = await startServer();
  const { client } = await register(server.base);
  const { client: intruder } = await register(server.base);
  const { verifier, challenge } = pkce();
  const code = await signInForCode(server.base, client, challenge, siteOneUrl, accountOf(alice));

  assert.equal((await (await exchange(server.base, client, code, pkce().verifier)).json()).error, "invalid_grant");
  assert.equal((await (await exchange(server.base, intruder, code, verifier)).json()).error, "invalid_grant");

  const issued = await (await exchange(server.base, client, code, verifier)).json();
  assert.equal((await mcpPost(server.base, issued.access_token)).status, 200);

  // A replay means the code leaked, so what it issued stops working.
  assert.equal((await (await exchange(server.base, client, code, verifier)).json()).error, "invalid_grant");
  assert.equal((await mcpPost(server.base, issued.access_token)).status, 401);
  await server.stop();
});

test("refresh tokens rotate, and a reused one ends the grant", async () => {
  const server = await startServer();
  const { client, tokens } = await signIn(server.base, siteOneUrl, accountOf(alice));
  const { client: intruder } = await register(server.base);
  const refresh = (c, token) => tokenRequest(server.base, { grant_type: "refresh_token", client_id: c.client_id, refresh_token: token });

  assert.equal((await (await refresh(intruder, tokens.refresh_token)).json()).error, "invalid_grant");
  const next = await (await refresh(client, tokens.refresh_token)).json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await mcpPost(server.base, next.access_token)).status, 200);

  assert.equal((await (await refresh(client, tokens.refresh_token)).json()).error, "invalid_grant");
  assert.equal((await mcpPost(server.base, next.access_token)).status, 401);
  assert.equal((await (await refresh(client, next.refresh_token)).json()).error, "invalid_grant");
  await server.stop();
});

test("revoking a token ends its grant only for the client that holds it", async () => {
  const server = await startServer();
  const { client, tokens } = await signIn(server.base, siteOneUrl, accountOf(alice));
  const { client: intruder } = await register(server.base);
  const revoke = (c) => fetch(`${server.base}/revoke`, { method: "POST", body: new URLSearchParams({ client_id: c.client_id, token: tokens.access_token }) });
  await revoke(intruder);
  assert.equal((await mcpPost(server.base, tokens.access_token)).status, 200);
  await revoke(client);
  assert.equal((await mcpPost(server.base, tokens.access_token)).status, 401);
  await server.stop();
});

test("tokens can only be requested for this server", async () => {
  const { client } = await register(main.base);
  const url = authorizeUrl(main.base, client, pkce().challenge, { resource: "https://other.example/mcp" });
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(new URL(res.headers.get("location")).searchParams.get("error"), "invalid_target");
  const scoped = await fetch(authorizeUrl(main.base, client, pkce().challenge, { scope: "admin" }), { redirect: "manual" });
  assert.equal(new URL(scoped.headers.get("location")).searchParams.get("error"), "invalid_scope");
});

test("client registration refuses unsafe redirect addresses", async () => {
  const server = await startServer({ MOODLE_MCP_ALLOWED_REDIRECT_HOSTS: "app.example" });
  assert.equal((await register(server.base)).status, 201);
  assert.equal((await register(server.base, { redirect_uris: ["https://evil.example/cb"] })).status, 400);
  await server.stop();
  assert.equal((await register(main.base, { redirect_uris: ["http://evil.example/cb"] })).status, 400);
  assert.equal((await register(main.base, { redirect_uris: ["file:///etc/passwd"] })).status, 400);
  assert.equal((await register(main.base, { redirect_uris: ["http://127.0.0.1:9/cb"] })).status, 201);
  assert.equal((await register(main.base, { redirect_uris: ["myapp://cb"] })).status, 201);
});

test("the form names the requesting app, escapes it, and resists framing", async () => {
  const { client } = await register(main.base, { client_name: "<img src=x onerror=alert(1)>" });
  const { res, html, id } = await openForm(main.base, client, pkce().challenge);
  assert.ok(!html.includes("<img"));
  assert.match(html, /app\.example/);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/app\.example/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const step = await (await postLogin(main.base, { id, site: siteOneUrl })).text();
  assert.ok(!step.includes("<b>Moodle</b>"), "site name from the site is escaped too");
  assert.match(step, /passes through this hosted server/);
});

test("the sign-in form locks after repeated failures", async () => {
  const { client } = await register(main.base);
  const { id } = await openForm(main.base, client, pkce().challenge);
  await postLogin(main.base, { id, site: siteOneUrl });
  for (let i = 0; i < 4; i++) {
    const bad = await postLogin(main.base, { id, username: "alice", password: "wrong" });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /Invalid login/);
  }
  assert.equal((await postLogin(main.base, { id, username: "alice", password: "wrong" })).status, 429);
  assert.equal((await postLogin(main.base, { id, ...accountOf(alice) })).status, 400);
  assert.equal((await postLogin(main.base, { id: "unknown", site: siteOneUrl })).status, 400);
});

test("a security key signs in, and a bad one is refused", async () => {
  const { client } = await register(main.base);
  const { verifier, challenge } = pkce();
  const { id } = await openForm(main.base, client, challenge);
  await postLogin(main.base, { id, site: siteOneUrl });
  const bad = await postLogin(main.base, { id, token: "not-a-token" });
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /did not accept/);
  const done = await postLogin(main.base, { id, token: bob.token });
  assert.equal(done.status, 303);
  const code = new URL(done.headers.get("location")).searchParams.get("code");
  const { access_token } = await (await exchange(main.base, client, code, verifier)).json();
  const mcp = await connect(main.base, access_token);
  assert.equal((await callTool(mcp, "moodle_whoami")).fullname, "Bob B");
  await mcp.close();
});

test("operators can turn off passwords and limit which sites are used", async () => {
  const server = await startServer({ MOODLE_MCP_DISABLE_PASSWORD_LOGIN: "1", MOODLE_MCP_ALLOWED_SITES: "127.0.0.1" });
  const { client } = await register(server.base);
  const { id } = await openForm(server.base, client, pkce().challenge);
  const form = await (await postLogin(server.base, { id, site: siteOneUrl })).text();
  assert.ok(!form.includes('name="password"'));
  siteOne.seen.length = 0;
  const refused = await postLogin(server.base, { id, ...accountOf(alice) });
  assert.equal(refused.status, 401);
  assert.ok(!siteOne.seen.includes("/login/token.php"), "the password never left the server");
  await server.stop();

  const limited = await startServer({ MOODLE_MCP_ALLOWED_SITES: "moodle.example" });
  const other = await register(limited.base);
  const opened = await openForm(limited.base, other.client, pkce().challenge);
  const answer = await postLogin(limited.base, { id: opened.id, site: siteOneUrl });
  assert.equal(answer.status, 400);
  assert.match(await answer.text(), /not set up to use/);
  await limited.stop();
});

test("users cannot make the server contact private addresses", async () => {
  const server = await startServer({ MOODLE_MCP_ALLOW_PRIVATE_SITES: "0" });
  const { client } = await register(server.base);
  const { id } = await openForm(server.base, client, pkce().challenge);
  siteOne.seen.length = 0;
  for (const site of [siteOneUrl, "https://127.0.0.1", "https://169.254.169.254", "https://[::1]", "https://2130706433", "https://localhost"]) {
    const res = await postLogin(server.base, { id, site });
    assert.equal(res.status, 400, site);
  }
  assert.deepEqual(siteOne.seen, []);
  await server.stop();
});

test("the address guard classifies addresses and refuses names that resolve privately", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::", "not-an-ip"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  const guarded = createGuardedFetch();
  await assert.rejects(guarded("https://localhost:1/"), /private address/);
  await assert.rejects(guarded("http://example.org/"), /https/);
});

test("the guard never follows a redirect, which could carry a token elsewhere", async () => {
  const guarded = createGuardedFetch({ allowPrivate: true });
  siteOne.seen.length = 0;
  await assert.rejects(guarded(`${siteOneUrl}/moved`, { method: "POST", body: "wstoken=x" }), /redirected to/);
  assert.equal((await guarded(`${siteOneUrl}/moved`, { redirect: "manual" })).status, 307);
  assert.ok(!siteOne.seen.includes("/target"));
});

test("hosted downloads come back inline and are not left on disk", async () => {
  const server = await startServer();
  const { tokens } = await signIn(server.base, siteOneUrl, accountOf(alice));
  const mcp = await connect(server.base, tokens.access_token);
  const result = await mcp.callTool({ name: "moodle_download_file", arguments: { url: `${siteOneUrl}/pluginfile.php/1/notes.txt` } });
  assert.equal(JSON.parse(result.content[0].text).filename, "notes.txt");
  assert.equal(Buffer.from(result.content[1].resource.blob, "base64").toString(), "notes");
  assert.ok(!JSON.stringify(result).includes(alice.token));
  const refused = await callTool(mcp, "moodle_download_file", { url: "https://evil.example/pluginfile.php/1/a" });
  assert.match(refused.error, /Refusing/);
  assert.match(await callTool(mcp, "moodle_login", { url: siteOneUrl }), /connect it again/);
  await mcp.close();
  await server.stop();
});

test("browsers from other origins and wrong Host headers are refused", async () => {
  const { tokens } = await signIn(main.base, siteOneUrl, accountOf(alice));
  assert.equal((await mcpPost(main.base, tokens.access_token, { Origin: "https://evil.example" })).status, 403);
  const { port } = new URL(main.base);
  const status = await new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/healthz", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      ok(res.statusCode);
    });
    req.on("error", fail);
    req.end();
  });
  assert.equal(status, 403);
});

test("grants survive a restart, a wrong key does not start, and keys rotate", async () => {
  const first = await startServer();
  const { client, tokens } = await signIn(first.base, siteOneUrl, accountOf(alice));
  await first.stop();

  assert.match(await startFailure({ MOODLE_MCP_HOME: first.home, MOODLE_MCP_MASTER_KEY: randomBytes(32).toString("base64") }), /Could not decrypt/);

  const newKey = randomBytes(32).toString("base64");
  const rotating = await startServer({ MOODLE_MCP_MASTER_KEY: newKey, MOODLE_MCP_PREVIOUS_MASTER_KEY: MASTER_KEY }, first.home);
  assert.match(rotating.log(), /rotation finished/);
  // Access tokens live in memory, so a restart sends clients to their refresh token.
  assert.equal((await mcpPost(rotating.base, tokens.access_token)).status, 401);
  await rotating.stop();

  const rotated = await startServer({ MOODLE_MCP_MASTER_KEY: newKey }, first.home);
  const refreshed = await tokenRequest(rotated.base, { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200);
  const mcp = await connect(rotated.base, (await refreshed.json()).access_token);
  assert.equal((await callTool(mcp, "moodle_whoami")).fullname, "Alice A");
  await mcp.close();
  await rotated.stop();
});

test("the sweep deletes Moodle tokens of accounts nobody can reach", async () => {
  const dir = await newHome();
  const vault = new Vault([randomBytes(32)]);
  const sites = new UserSites(vault, join(dir, "users"));
  const oauth = await MoodleOAuth.open({ vault, sites, dir, resource: new URL("https://x.example/mcp"), allowPasswordLogin: true, allowedRedirectHosts: [] });
  await sites.save("c".repeat(64), { url: "https://one.example", token: "abandoned" });
  await oauth.sweep();
  assert.deepEqual(await sites.userIds(), []);
});
