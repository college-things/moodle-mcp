import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { callMoodle, getPublicConfig, htmlToText, MoodleError, requestToken } from "./moodle.js";
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
  done: Promise<LoginResult>;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
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

let active: { siteUrl: string; form: LoginForm; server: Server } | undefined;

/** Serves a one-time form on loopback, so credentials never pass through the chat. */
export async function startLoginForm(input: string): Promise<LoginForm> {
  const siteUrl = normalizeSiteUrl(input);
  if (active?.siteUrl === siteUrl) return active.form;
  active?.server.close();
  const config = await getPublicConfig(siteUrl);
  if (!config.enablewebservices || !config.enablemobilewebservice) {
    throw new Error(`${siteUrl} has mobile web services turned off, so an administrator would need to enable them.`);
  }
  const sitename = htmlToText(config.sitename);
  // SSO sites have no password login, but a pasted security key still works there.
  const passwordLogin = config.typeoflogin === 1;
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
    if (req.method === "GET") return respond(200, formHtml(siteUrl, sitename, passwordLogin));
    if (req.method !== "POST") return respond(405, "Method not allowed");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on("end", async () => {
      const fields = new URLSearchParams(body);
      const pasted = fields.get("token")?.trim();
      try {
        const token = pasted || (await requestToken(siteUrl, fields.get("username") ?? "", fields.get("password") ?? ""));
        // A valid token can still be refused by site policy, which is not a failed login.
        let info: any = {};
        let restricted = false;
        try {
          info = await callMoodle({ url: siteUrl, token }, "core_webservice_get_site_info");
        } catch (err) {
          if (!(err instanceof MoodleError) || err.errorcode !== "accessexception") throw err;
          restricted = true;
        }
        const key = await saveSite({
          url: siteUrl,
          token,
          sitename: info.sitename,
          fullname: info.fullname,
          userid: info.userid,
        });
        const note = restricted ? "<p>This site restricts API access for your account, so some tools may not work.</p>" : "";
        respond(200, page("Signed in", `<h1>Signed in</h1>${note}<p>You can close this tab and return to your chat.</p>`));
        finish();
        resolve({ site: key, sitename: info.sitename, fullname: info.fullname });
      } catch (err) {
        const message = pasted ? "Moodle did not accept this security key." : (err as Error).message;
        respond(401, formHtml(siteUrl, sitename, passwordLogin, message));
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
  const form: LoginForm = { formUrl: `http://127.0.0.1:${port}/${secret}`, siteUrl, sitename, done };
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
