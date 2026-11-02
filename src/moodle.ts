import type { Site } from "./store.js";

const TIMEOUT_MS = 30_000;

export class MoodleError extends Error {
  constructor(
    message: string,
    readonly errorcode?: string,
  ) {
    super(message);
  }
}

/** Flattens nested params into Moodle's `a[0][b]=c` form encoding. */
export function encodeParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    } else out.append(prefix, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

async function postJson(url: string, body: string | URLSearchParams, contentType: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": contentType, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new MoodleError(`Moodle answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new MoodleError("Moodle did not answer with JSON. Is this URL a Moodle site?");
  }
}

/** Works without login, so it also tells whether a URL is a usable Moodle. */
export async function getPublicConfig(siteUrl: string): Promise<any> {
  const data = await postJson(
    `${siteUrl}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`,
    JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]),
    "application/json",
  );
  const first = data?.[0];
  if (!first || first.error || !first.data) {
    throw new MoodleError(`${siteUrl} did not return Moodle mobile config. Mobile access may be disabled.`);
  }
  return first.data;
}

/** Exchanges a password for a mobile service token. The password is not kept. */
export async function requestToken(siteUrl: string, username: string, password: string): Promise<string> {
  const data = await postJson(
    `${siteUrl}/login/token.php`,
    new URLSearchParams({ username, password, service: "moodle_mobile_app" }),
    "application/x-www-form-urlencoded",
  );
  if (!data.token) throw new MoodleError(data.error ?? "Moodle did not return a token", data.errorcode);
  return data.token;
}

export async function callMoodle(
  site: Pick<Site, "url" | "token">,
  wsfunction: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const body = encodeParams(params);
  body.set("wstoken", site.token);
  body.set("wsfunction", wsfunction);
  body.set("moodlewsrestformat", "json");
  body.set("moodlewssettingfilter", "true");
  body.set("moodlewssettingfileurl", "true");
  const data = await postJson(`${site.url}/webservice/rest/server.php`, body, "application/x-www-form-urlencoded");
  if (data && typeof data === "object" && data.exception) {
    if (data.errorcode === "invalidtoken") {
      throw new MoodleError("Moodle session expired. Call moodle_login to sign in again.", data.errorcode);
    }
    if (data.errorcode === "accessexception") {
      throw new MoodleError(
        `${wsfunction}: this Moodle site refuses this API call for your account (accessexception). A site administrator controls this access.`,
        data.errorcode,
      );
    }
    throw new MoodleError(`${wsfunction}: ${data.message ?? data.errorcode}`, data.errorcode);
  }
  return data;
}

/**
 * Plain text from Moodle HTML. Keeps the state of quiz inputs, which is the part
 * of a reviewed answer that would otherwise vanish along with the tags.
 */
export function htmlToText(html: unknown): string {
  if (typeof html !== "string") return "";
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const fromCode = (code: number): string => {
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  };
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<input\b[^>]*>/gi, (tag) => {
      const type = /type=["']?(\w+)/i.exec(tag)?.[1]?.toLowerCase();
      if (type === "radio" || type === "checkbox") return /\bchecked\b/i.test(tag) ? "[x] " : "[ ] ";
      if (type === "text" || type === "number") return `[${/value=["']([^"']*)/i.exec(tag)?.[1] ?? ""}] `;
      return "";
    })
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole)
    .replace(/\r/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isoTime(seconds: unknown): string | null {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** File URLs need the token and must never leave the site that issued it. */
export function authorizedFileUrl(site: Pick<Site, "url" | "token">, fileUrl: string): URL {
  const root = new URL(site.url);
  const url = new URL(fileUrl);
  const prefix = root.pathname.replace(/\/+$/, "") + "/";
  if (url.origin !== root.origin || !url.pathname.startsWith(prefix)) {
    throw new MoodleError(`Refusing to send the Moodle token outside ${site.url}`);
  }
  url.pathname = url.pathname.replace(/(?<!\/webservice)\/pluginfile\.php\//, "/webservice/pluginfile.php/");
  if (!url.pathname.includes("/webservice/pluginfile.php/")) {
    throw new MoodleError("Only Moodle pluginfile.php URLs can be downloaded.");
  }
  url.searchParams.set("token", site.token);
  return url;
}
