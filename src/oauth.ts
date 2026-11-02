import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";
import { escapeHtml, identifyToken, page } from "./login.js";
import { getPublicConfig, htmlToText, MoodleError, requestToken } from "./moodle.js";
import { normalizeSiteUrl, siteKey, writePrivateFile } from "./store.js";
import type { UserSites, Vault } from "./vault.js";

export const SCOPE = "moodle.read";

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 86_400;
const CODE_TTL_S = 60;
const PENDING_TTL_S = 10 * 60;
const UNUSED_CLIENT_TTL_S = 30 * 86_400;
const MAX_SIGNIN_FAILURES = 5;
const MAX_PENDING = 10_000;
const MAX_CLIENTS = 100_000;
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "about:", "blob:", "ftp:", "ws:", "wss:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface RefreshRecord {
  userId: string;
  clientId: string;
  family: string;
  expiresAt: number;
  used?: boolean;
}

interface AccessRecord {
  userId: string;
  clientId: string;
  family: string;
  expiresAt: number;
}

interface CodeRecord extends AccessRecord {
  challenge: string;
  redirectUri: string;
  used?: boolean;
}

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
  failures: number;
  site?: { url: string; name: string; passwordLogin: boolean };
}

interface PersistedState {
  identityKey: string;
  clients: Record<string, OAuthClientInformationFull>;
  refresh: Record<string, RefreshRecord>;
}

export interface OAuthOptions {
  vault: Vault;
  sites: UserSites;
  dir: string;
  resource: URL;
  allowPasswordLogin: boolean;
  allowedRedirectHosts: string[];
  now?: () => number;
}

/** Tokens are random, so a plain hash is enough to make a leaked state file useless. */
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const newSecret = (): string => randomBytes(32).toString("base64url");
const STATE_CONTEXT = "oauth-state";

/**
 * OAuth 2.1 authorization server whose only way to prove identity is signing in to Moodle.
 * An account is one Moodle user on one site. There is deliberately no way to attach a
 * second site from a link: such a link, sent to a victim, would put the victim's token
 * into the attacker's account.
 */
export class MoodleOAuth implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly access = new Map<string, AccessRecord>();
  private saving: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  private constructor(
    private readonly options: OAuthOptions,
    private readonly state: PersistedState,
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  static async open(options: OAuthOptions): Promise<MoodleOAuth> {
    const path = join(options.dir, "oauth.enc");
    let text: string | undefined;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!text) {
      const state = { identityKey: randomBytes(32).toString("base64"), clients: {}, refresh: {} };
      const fresh = new MoodleOAuth(options, state);
      await fresh.persist();
      return fresh;
    }
    const { value, stale } = options.vault.open<PersistedState>(STATE_CONTEXT, text);
    const provider = new MoodleOAuth(options, value);
    if (stale) await provider.persist();
    return provider;
  }

  private persist(): Promise<void> {
    const write = () =>
      writePrivateFile(join(this.options.dir, "oauth.enc"), this.options.vault.seal(STATE_CONTEXT, this.state));
    const run = this.saving.then(write, write);
    this.saving = run.catch(() => {});
    return run;
  }

  get clientsStore() {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: async (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        for (const uri of client.redirect_uris) this.checkRedirectUri(String(uri));
        if (client.redirect_uris.length === 0) throw new InvalidClientMetadataError("redirect_uris must not be empty");
        if (Object.keys(this.state.clients).length >= MAX_CLIENTS) throw new InvalidClientMetadataError("Too many registered clients");
        const full = client as OAuthClientInformationFull;
        this.state.clients[full.client_id] = full;
        await this.persist();
        return full;
      },
    };
  }

  private checkRedirectUri(uri: string): void {
    const url = new URL(uri);
    const refuse = (why: string): never => {
      throw new InvalidClientMetadataError(`redirect_uri ${why}`);
    };
    if (url.hash) refuse("must not have a fragment");
    const { allowedRedirectHosts } = this.options;
    if (allowedRedirectHosts.length > 0) {
      if (url.protocol !== "https:" || !allowedRedirectHosts.includes(url.hostname)) refuse("is not on this server's list of allowed apps");
      return;
    }
    if (FORBIDDEN_SCHEMES.has(url.protocol)) refuse("uses a forbidden scheme");
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) refuse("must use https unless it is on loopback");
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkScopes(params.scopes);
    this.checkResource(params.resource);
    this.dropExpired();
    if (this.pending.size >= MAX_PENDING) {
      res.status(503);
      return this.sendPage(res, undefined, page("Busy", "<h1>Busy</h1><p>Too many sign-ins are in progress. Try again in a few minutes.</p>"));
    }
    const id = newSecret();
    const pending: Pending = { client, params, expiresAt: this.now() + PENDING_TTL_S, failures: 0 };
    this.pending.set(id, pending);
    this.sendPage(res, pending, this.siteForm(id, pending));
  }

  private checkScopes(scopes: string[] = []): void {
    if (scopes.some((s) => s !== SCOPE)) throw new InvalidScopeError(`Only the ${SCOPE} scope exists`);
  }

  private checkResource(resource?: URL): void {
    if (!resource) return;
    const plain = (url: URL): string => url.href.replace(/#.*$/, "").replace(/\/$/, "");
    if (plain(resource) !== plain(this.options.resource)) throw new InvalidTargetError("Tokens here are only for this server");
  }

  /** Handles POST /login: first the site address, then the sign-in on that site. */
  async handleLogin(req: Request, res: Response): Promise<void> {
    this.dropExpired();
    const fields = (req.body ?? {}) as Record<string, unknown>;
    const field = (name: string): string => (typeof fields[name] === "string" ? (fields[name] as string) : "");
    const id = field("id");
    const pending = this.pending.get(id);
    if (!pending) {
      res.status(400);
      return this.sendPage(res, undefined, page("Sign-in expired", "<h1>Sign-in expired</h1><p>Start again from your app.</p>"));
    }
    if (!pending.site) {
      try {
        pending.site = await this.lookUpSite(field("site"));
        this.sendPage(res, pending, this.signInForm(id, pending));
      } catch (err) {
        res.status(400);
        this.sendPage(res, pending, this.siteForm(id, pending, publicMessage(err, "Could not reach that site.")));
      }
      return;
    }
    await this.signIn(id, pending, field("username"), field("password"), field("token").trim(), res);
  }

  private async lookUpSite(input: string): Promise<NonNullable<Pending["site"]>> {
    let url: string;
    try {
      url = normalizeSiteUrl(input.trim());
    } catch {
      throw new MoodleError("Enter the site's full https address.");
    }
    const config = await getPublicConfig(url);
    if (!config.enablewebservices || !config.enablemobilewebservice) {
      throw new MoodleError(`${url} has mobile web services turned off, so an administrator would need to enable them.`);
    }
    return { url, name: htmlToText(config.sitename), passwordLogin: config.typeoflogin === 1 && this.options.allowPasswordLogin };
  }

  private async signIn(id: string, pending: Pending, username: string, password: string, pasted: string, res: Response): Promise<void> {
    const site = pending.site!;
    try {
      if (!pasted && !site.passwordLogin) throw new MoodleError("Paste a security key to sign in here.");
      const token = pasted || (await requestToken(site.url, username, password));
      const { info } = await identifyToken(site.url, token);
      // Taken once, so a double submit cannot mint two codes from one approval.
      if (!this.pending.delete(id)) throw new MoodleError("This sign-in was already used.");
      const key = siteKey(site.url);
      const subject = typeof info.userid === "number" ? `user:${info.userid}` : `token:${hashToken(token)}`;
      const userId = createHmac("sha256", Buffer.from(this.state.identityKey, "base64")).update(`${key}\0${subject}`).digest("hex");
      const code = newSecret();
      // Recorded first, so a sweep between these steps sees this user as live.
      this.codes.set(hashToken(code), {
        userId,
        clientId: pending.client.client_id,
        family: newSecret(),
        challenge: pending.params.codeChallenge,
        redirectUri: pending.params.redirectUri,
        expiresAt: this.now() + CODE_TTL_S,
      });
      await this.options.sites.save(userId, { url: site.url, token, sitename: info.sitename, fullname: info.fullname, userid: info.userid });
      const target = new URL(pending.params.redirectUri);
      target.searchParams.set("code", code);
      if (pending.params.state) target.searchParams.set("state", pending.params.state);
      this.setPageHeaders(res, pending);
      res.redirect(303, target.href);
    } catch (err) {
      pending.failures += 1;
      if (pending.failures >= MAX_SIGNIN_FAILURES) {
        this.pending.delete(id);
        res.status(429);
        return this.sendPage(res, undefined, page("Too many attempts", "<h1>Too many attempts</h1><p>Start again from your app.</p>"));
      }
      res.status(401);
      const fallback = "Could not sign in to that site.";
      this.sendPage(res, pending, this.signInForm(id, pending, pasted ? "Moodle did not accept this security key." : publicMessage(err, fallback)));
    }
  }

  private consent(pending: Pending): string {
    const target = new URL(pending.params.redirectUri);
    const where = target.protocol === "https:" || target.protocol === "http:" ? target.hostname : target.protocol;
    const name = (pending.client.client_name ?? "An app").slice(0, 100);
    return `<p><b>${escapeHtml(name)}</b>, returning to <b>${escapeHtml(where)}</b>, is asking to read your Moodle data through this server.
If you did not start this from your own assistant app, close this page: whoever sent you the link would get access to your account.</p>`;
  }

  private siteForm(id: string, pending: Pending, error?: string): string {
    return page(
      "Connect Moodle",
      `<h1>Connect Moodle</h1>${this.consent(pending)}
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login"><input type="hidden" name="id" value="${escapeHtml(id)}">
<label for="s">Your Moodle site's address</label><input id="s" name="site" inputmode="url" autocomplete="url" placeholder="https://moodle.your-school.edu" required autofocus>
<button>Continue</button></form>`,
    );
  }

  private signInForm(id: string, pending: Pending, error?: string): string {
    const site = pending.site!;
    const hidden = `<input type="hidden" name="id" value="${escapeHtml(id)}">`;
    const passwordForm = site.passwordLogin
      ? `<form method="post" action="/login">${hidden}<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button>Sign in</button></form>
<p><small>Your password passes through this hosted server once, to get an access token from the site, and is never stored. Only type it if you trust whoever runs this server.</small></p><hr>`
      : "";
    return page(
      "Connect Moodle",
      `<h1>Sign in to Moodle</h1><p>${escapeHtml(site.name)}<br><small>${escapeHtml(site.url)}</small></p>${this.consent(pending)}
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}${passwordForm}
<p>Or sign in on the site yourself, open its <a href="${escapeHtml(site.url)}/user/managetoken.php" target="_blank" rel="noreferrer">Security keys page</a>, then copy the key for "Moodle mobile web service" and paste it here.</p>
<form method="post" action="/login">${hidden}<label for="t">Security key</label><input id="t" name="token" type="password" autocomplete="off" required>
<button>Use key</button></form>
<p><small>This server keeps the access token encrypted until you log out. That token gives the same access as the Moodle mobile app.</small></p>`,
    );
  }

  private setPageHeaders(res: Response, pending?: Pending): void {
    let formAction = "'self'";
    if (pending) {
      // Browsers apply form-action to the redirect that follows a submitted form.
      const target = new URL(pending.params.redirectUri);
      formAction += target.protocol === "https:" || target.protocol === "http:" ? ` ${target.origin}` : ` ${target.protocol}`;
    }
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  }

  private sendPage(res: Response, pending: Pending | undefined, html: string): void {
    this.setPageHeaders(res, pending);
    res.type("html").send(html);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.liveCode(client, authorizationCode).challenge;
  }

  private liveCode(client: OAuthClientInformationFull, code: string): CodeRecord {
    const record = this.codes.get(hashToken(code));
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.liveCode(client, authorizationCode);
    if (record.used) {
      // A replayed code means it leaked, so whatever it issued cannot be trusted.
      await this.revokeFamily(record.family);
      throw new InvalidGrantError("Authorization code was already used");
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    this.checkResource(resource);
    record.used = true;
    return this.issueTokens(record.userId, client.client_id, record.family);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkScopes(scopes);
    this.checkResource(resource);
    const hash = hashToken(refreshToken);
    const record = this.state.refresh[hash];
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) throw new InvalidGrantError("Invalid refresh token");
    if (record.used) {
      await this.revokeFamily(record.family);
      throw new InvalidGrantError("Refresh token was already used");
    }
    record.used = true;
    return this.issueTokens(record.userId, client.client_id, record.family);
  }

  private async issueTokens(userId: string, clientId: string, family: string): Promise<OAuthTokens> {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    this.state.refresh[hashToken(refreshToken)] = { userId, clientId, family, expiresAt: this.now() + REFRESH_TTL_S };
    await this.persist();
    // Access tokens live only in memory: a restart just makes clients refresh.
    this.access.set(hashToken(accessToken), { userId, clientId, family, expiresAt: this.now() + ACCESS_TTL_S });
    return { access_token: accessToken, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: SCOPE };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.access.get(hashToken(token));
    if (!record || record.expiresAt < this.now()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: record.clientId,
      scopes: [SCOPE],
      expiresAt: record.expiresAt,
      resource: this.options.resource,
      extra: { userId: record.userId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashToken(request.token);
    const record = this.access.get(hash) ?? this.state.refresh[hash];
    if (record?.clientId === client.client_id) await this.revokeFamily(record.family);
  }

  private async revokeFamily(family: string): Promise<void> {
    this.dropTokens((record) => record.family === family);
    await this.persist();
  }

  private dropTokens(match: (record: AccessRecord) => boolean): void {
    for (const [hash, record] of this.access) if (match(record)) this.access.delete(hash);
    for (const [hash, record] of Object.entries(this.state.refresh)) if (match(record)) delete this.state.refresh[hash];
    for (const [hash, record] of this.codes) if (match(record)) this.codes.delete(hash);
  }

  /** Logout: the stored Moodle token and every way back into the account end together. */
  async forgetUser(userId: string): Promise<void> {
    this.dropTokens((record) => record.userId === userId);
    await this.persist();
    await this.options.sites.removeUser(userId);
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt < now) this.pending.delete(id);
    this.dropTokens((record) => record.expiresAt < now);
  }

  /** Deletes the Moodle tokens of accounts nobody can reach any more, rather than keeping them forever. */
  async sweep(): Promise<void> {
    this.dropExpired();
    const live = new Set<string>();
    const usedClients = new Set<string>();
    for (const record of [...this.access.values(), ...this.codes.values(), ...Object.values(this.state.refresh)]) {
      live.add(record.userId);
      usedClients.add(record.clientId);
    }
    const cutoff = this.now() - UNUSED_CLIENT_TTL_S;
    for (const [id, client] of Object.entries(this.state.clients)) {
      if (!usedClients.has(id) && (client.client_id_issued_at ?? 0) < cutoff) delete this.state.clients[id];
    }
    await this.persist();
    for (const userId of await this.options.sites.userIds()) {
      if (!live.has(userId)) await this.options.sites.removeUser(userId);
    }
  }
}

/** Only messages this code wrote or Moodle sent; network errors may name internal details. */
function publicMessage(err: unknown, fallback: string): string {
  return err instanceof MoodleError ? err.message : fallback;
}
