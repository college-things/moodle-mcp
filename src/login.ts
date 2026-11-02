import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { callMoodle, MoodleError, parseSessionCookie, probeSite, readSession, requestToken } from "./moodle.js";
import { normalizeSiteUrl, saveSite } from "./store.js";

const FORM_LIFETIME_MS = 10 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;

export interface LoginResult {
  site: string;
  sitename?: string;
  fullname?: string;
}

export interface LoginForm {
  formUrl: string;
  siteUrl: string;
  sitename: string;
  /** The mobile service is off, so the form asks for a browser session instead of a password. */
  sessionMode: boolean;
  done: Promise<LoginResult>;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A valid token can still be refused by site policy, which is not a failed login. */
export async function identifyToken(siteUrl: string, token: string): Promise<{ info: any; restricted: boolean }> {
  try {
    return { info: await callMoodle({ url: siteUrl, token }, "core_webservice_get_site_info"), restricted: false };
  } catch (err) {
    if (!(err instanceof MoodleError) || err.errorcode !== "accessexception") throw err;
    return { info: {}, restricted: true };
  }
}

export function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}
label{display:block;margin:1rem 0 .25rem}input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
button{margin-top:1.25rem;padding:.6rem 1.2rem;font:inherit}.err{color:#b00020}small{color:#666}</style></head><body>${body}</body></html>`;
}

function formHtml(siteUrl: string, sitename: string, passwordLogin: boolean, error?: string): string {
  const passwordForm = `<form method="post"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button>Sign in</button></form>
<p><small>The password goes only to this site and is not stored. moodle-mcp keeps the access token it returns. Check that the address above is your school's site.</small></p>
<hr><h2>Site uses a captcha?</h2>
<p>Password sign-in can fail on such sites.`;
  const ssoIntro = `<p>This site signs in through an external provider, so a password cannot be used here.`;
  return page(
    "Moodle login",
    `<h1>Moodle login</h1><p>${escapeHtml(sitename)}<br><small>${escapeHtml(siteUrl)}</small></p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
${passwordLogin ? passwordForm : ssoIntro} Sign in on the site yourself, open its <a href="${escapeHtml(siteUrl)}/user/managetoken.php" target="_blank" rel="noreferrer">Security keys page</a>, then copy the key for "Moodle mobile web service" and paste it here.</p>
<form method="post"><label for="t">Security key</label><input id="t" name="token" type="password" autocomplete="off" required>
<button>Use key</button></form>`,
  );
}

function sessionFormHtml(siteUrl: string, sitename: string, restricted: boolean, error?: string): string {
  const site = escapeHtml(siteUrl);
  const reason = restricted ? "This site refuses mobile API calls for your account" : "This site has its mobile service turned off";
  return page(
    "Moodle login",
    `<h1>Moodle login</h1><p>${escapeHtml(sitename)}<br><small>${site}</small></p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<p>${reason}, so moodle-mcp has to use your browser's session. You sign in on the site, not here.</p>
<ol><li><a href="${site}/login/index.php" target="_blank" rel="noreferrer">Sign in on the site</a> as usual.</li>
<li>On that tab, open developer tools (F12), then Application in Chrome or Edge, or Storage in Firefox or Safari, then Cookies.</li>
<li>Copy the value of the cookie whose name starts with <code>MoodleSession</code>. If its name has anything after that, paste it as <code>name=value</code>.</li></ol>
<form method="post"><label for="c">Session cookie</label><input id="c" name="cookie" type="password" autocomplete="off" required autofocus>
<button>Use session</button></form>
<p><small>Treat this cookie like a password: it can do anything you can on the site until the session ends. moodle-mcp only reads with it, sends it only to the address above and stores it in a file only your account can read. It stops working when you log out on the site or the session times out.</small></p>`,
  );
}

let active: { siteUrl: string; form: LoginForm; server: Server } | undefined;

/** Serves a one-time form on loopback, so credentials never pass through the chat. */
export async function startLoginForm(input: string): Promise<LoginForm> {
  const siteUrl = normalizeSiteUrl(input);
  if (active?.siteUrl === siteUrl) return active.form;
  active?.server.close();
  const probe = await probeSite(siteUrl);
  // SSO sites have no password login, but a pasted security key still works there.
  const { sitename, mobileApi, passwordLogin } = probe;
  // A site can have the service on and still refuse it to some accounts, which only shows after sign-in.
  let restrictedAccount = false;
  const render = (error?: string): string =>
    mobileApi && !restrictedAccount ? formHtml(siteUrl, sitename, passwordLogin, error) : sessionFormHtml(siteUrl, sitename, restrictedAccount, error);
  const secret = randomBytes(24).toString("base64url");
  let resolve!: (result: LoginResult) => void;
  let reject!: (err: Error) => void;
  const done = new Promise<LoginResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  done.catch(() => {});
  const server = createServer((req, res) => {
    const respond = (status: number, html: string): void => {
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "Referrer-Policy": "no-referrer",
      });
      res.end(html);
    };
    const port = (server.address() as AddressInfo).port;
    if (req.headers.host !== `127.0.0.1:${port}` || req.url !== `/${secret}`) return respond(404, "Not found");
    if (req.method === "GET") return respond(200, render());
    if (req.method !== "POST") return respond(405, "Method not allowed");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on("end", async () => {
      const fields = new URLSearchParams(body);
      if (!mobileApi || restrictedAccount) {
        try {
          const cookie = parseSessionCookie(fields.get("cookie") ?? "");
          const { sesskey, fullname, userid } = await readSession({ url: siteUrl, cookie });
          const key = await saveSite({ url: siteUrl, session: { cookie, sesskey }, sitename, fullname, userid });
          respond(200, page("Signed in", "<h1>Signed in</h1><p>You can close this tab and return to your chat.</p>"));
          finish();
          resolve({ site: key, sitename, fullname: fullname ?? "your account" });
        } catch (err) {
          const expired = err instanceof MoodleError && err.errorcode === "sessionexpired";
          respond(401, render(expired ? "Moodle did not accept this cookie. Check that you are signed in on the site and that you copied all of it." : (err as Error).message));
        }
        return;
      }
      const pasted = fields.get("token")?.trim();
      try {
        const token = pasted || (await requestToken(siteUrl, fields.get("username") ?? "", fields.get("password") ?? ""));
        const { info, restricted } = await identifyToken(siteUrl, token);
        if (restricted) {
          restrictedAccount = true;
          return respond(200, render());
        }
        const key = await saveSite({
          url: siteUrl,
          token,
          sitename: info.sitename,
          fullname: info.fullname,
          userid: info.userid,
        });
        respond(200, page("Signed in", "<h1>Signed in</h1><p>You can close this tab and return to your chat.</p>"));
        finish();
        resolve({ site: key, sitename: info.sitename, fullname: info.fullname });
      } catch (err) {
        const message = pasted ? "Moodle did not accept this security key." : (err as Error).message;
        respond(401, render(message));
      }
    });
  });
  const timer = setTimeout(() => {
    finish();
    reject(new Error("Login form expired."));
  }, FORM_LIFETIME_MS);
  timer.unref();
  const finish = (): void => {
    clearTimeout(timer);
    server.close();
    if (active?.server === server) active = undefined;
  };
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  const form: LoginForm = { formUrl: `http://127.0.0.1:${port}/${secret}`, siteUrl, sitename, sessionMode: !mobileApi, done };
  active = { siteUrl, form, server };
  return form;
}

export function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  execFile(command, args, () => {
    // The URL is also returned to the caller, so a failed launch is not fatal.
  });
}
