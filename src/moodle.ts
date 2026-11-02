import type { SessionSite, Site, TokenSite } from "./store.js";

const TIMEOUT_MS = 30_000;

/**
 * The only pages session mode may fetch. A session cookie can do anything the user can,
 * so this stays a short list of report and course-wide pages and never includes an activity's
 * own page: opening one can mark it as viewed, and quiz pages can start attempts.
 */
const READABLE_PAGES = new Set([
  "/user/preferences.php",
  "/grade/report/overview/index.php",
  "/grade/report/user/index.php",
  "/mod/assign/index.php",
  "/mod/quiz/index.php",
  "/course/overview.php",
]);

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

export type MoodleFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

let transport: MoodleFetch = (url, init) => fetch(url, init);

/** Hosted mode replaces this, because there the site URLs come from strangers. */
export function setMoodleTransport(next: MoodleFetch): void {
  transport = next;
}

export const moodleFetch: MoodleFetch = (url, init) => transport(url, init);

async function postJson(url: string, body: string | URLSearchParams, contentType: string): Promise<any> {
  const res = await moodleFetch(url, {
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

export interface SiteProbe {
  sitename: string;
  url: string;
  mobileApi: boolean;
  passwordLogin: boolean;
  maintenance: boolean;
}

/** Also recognises Moodle sites that refuse to give out their mobile config at all. */
export async function probeSite(siteUrl: string): Promise<SiteProbe> {
  let config: any;
  try {
    config = await getPublicConfig(siteUrl);
  } catch (err) {
    if (!(err instanceof MoodleError) || !(await looksLikeMoodle(siteUrl))) throw err;
    return { sitename: new URL(siteUrl).host, url: siteUrl, mobileApi: false, passwordLogin: false, maintenance: false };
  }
  return {
    sitename: htmlToText(config.sitename),
    url: config.wwwroot,
    mobileApi: Boolean(config.enablewebservices && config.enablemobilewebservice),
    passwordLogin: config.typeoflogin === 1,
    maintenance: Boolean(config.maintenanceenabled),
  };
}

async function looksLikeMoodle(siteUrl: string): Promise<boolean> {
  const res = await moodleFetch(`${siteUrl}/login/index.php`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  // SSO sites redirect away from this page; the cookie check at sign-in still catches a wrong URL.
  return (res.status >= 300 && res.status < 400) || (res.ok && (await res.text()).includes("M.cfg"));
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

const sessionExpired = (): MoodleError =>
  new MoodleError("Moodle browser session ended. Sign in on the site again, then call moodle_login.", "sessionexpired");

/** Moodle's own AJAX endpoint, which stays on when the mobile service is off but only exposes some functions. */
async function callAjax(site: Pick<SessionSite, "url" | "session">, methodname: string, args: Record<string, unknown>): Promise<any> {
  const query = new URLSearchParams({ sesskey: site.session.sesskey, info: methodname });
  const res = await moodleFetch(`${site.url}/lib/ajax/service.php?${query}`, {
    method: "POST",
    body: JSON.stringify([{ index: 0, methodname, args }]),
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: site.session.cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300 && res.status < 400) throw sessionExpired();
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new MoodleError(`${methodname}: Moodle answered HTTP ${res.status} without JSON.`);
  }
  const first = Array.isArray(data) ? data[0] : data;
  const failure = first?.exception ?? (first?.error ? first : undefined);
  if (!failure) return first?.data;
  const code: string | undefined = failure.errorcode;
  if (code === "servicerequireslogin" || code === "invalidsesskey" || code === "requireloginerror") throw sessionExpired();
  if (code === "servicenotavailable") {
    throw new MoodleError(
      `${methodname}: this site only offers this through its mobile web service, which is off, so it is not available in browser-session mode.`,
      code,
    );
  }
  throw new MoodleError(`${methodname}: ${failure.message ?? failure.error ?? code}`, code);
}

export async function callMoodle(
  site: Pick<TokenSite, "url" | "token"> | Pick<SessionSite, "url" | "session">,
  wsfunction: string,
  params: Record<string, unknown> = {},
  /** Text as stored, for writing back, rather than as displayed. */
  options: { raw?: boolean } = {},
): Promise<any> {
  if ("session" in site) return callAjax(site, wsfunction, params);
  const body = encodeParams(params);
  body.set("wstoken", site.token);
  body.set("wsfunction", wsfunction);
  body.set("moodlewsrestformat", "json");
  body.set("moodlewssettingfilter", options.raw ? "false" : "true");
  body.set("moodlewssettingfileurl", options.raw ? "false" : "true");
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
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
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

function urlOnSite(siteUrl: string, fileUrl: string): URL {
  const root = new URL(siteUrl);
  const url = new URL(fileUrl);
  const prefix = root.pathname.replace(/\/+$/, "") + "/";
  if (url.origin !== root.origin || !url.pathname.startsWith(prefix)) {
    throw new MoodleError(`Refusing to send Moodle credentials outside ${siteUrl}`);
  }
  return url;
}

/** File URLs need the token and must never leave the site that issued it. */
export function authorizedFileUrl(site: Pick<TokenSite, "url" | "token">, fileUrl: string): URL {
  const url = urlOnSite(site.url, fileUrl);
  url.pathname = url.pathname.replace(/(?<!\/webservice)\/pluginfile\.php\//, "/webservice/pluginfile.php/");
  if (!url.pathname.includes("/webservice/pluginfile.php/")) {
    throw new MoodleError("Only Moodle pluginfile.php URLs can be downloaded.");
  }
  url.searchParams.set("token", site.token);
  return url;
}

/** Puts files in one new draft area and returns its id. Nothing reaches the assignment until the area is saved to it. */
export async function uploadDraftFiles(site: Pick<TokenSite, "url" | "token">, files: { name: string; bytes: Buffer }[]): Promise<number> {
  let itemid = 0;
  for (const file of files) {
    const body = new FormData();
    body.set("token", site.token);
    body.set("filearea", "draft");
    body.set("itemid", String(itemid));
    body.set("file_1", new Blob([new Uint8Array(file.bytes)]), file.name);
    const res = await moodleFetch(`${site.url}/webservice/upload.php`, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new MoodleError(`Upload of ${file.name} failed with HTTP ${res.status}`);
    const data: any = await res.json();
    const uploaded = Array.isArray(data) ? data[0] : undefined;
    if (!uploaded?.itemid) throw new MoodleError(`Upload of ${file.name} failed: ${data?.error ?? data?.message ?? "Moodle gave no reason"}`, data?.errorcode);
    itemid = uploaded.itemid;
  }
  return itemid;
}

/** Redirects are refused because the request carries the token or the session cookie. */
export async function fetchSiteFile(site: Site, fileUrl: string): Promise<Response> {
  const signal = AbortSignal.timeout(120_000);
  if (!("session" in site)) return moodleFetch(authorizedFileUrl(site, fileUrl), { redirect: "error", signal });
  const url = urlOnSite(site.url, fileUrl);
  url.pathname = url.pathname.replace(/\/webservice\/pluginfile\.php\//, "/pluginfile.php/");
  if (!url.pathname.includes("/pluginfile.php/")) throw new MoodleError("Only Moodle pluginfile.php URLs can be downloaded.");
  const res = await moodleFetch(url, { headers: { Cookie: site.session.cookie }, redirect: "manual", signal });
  if (res.status >= 300 && res.status < 400) throw sessionExpired();
  return res;
}

/** Accepts a bare MoodleSession value or a pasted `name=value` cookie string. */
export function parseSessionCookie(input: string): string {
  const pasted = input.trim().replace(/^cookie:\s*/i, "");
  const cookie = pasted.includes("=") ? pasted : `MoodleSession=${pasted}`;
  const wellFormed = /^[^\s;=]+=[^\s;]*(;\s*[^\s;=]+=[^\s;]*)*;?$/.test(cookie) && /^[\x20-\x7e]+$/.test(cookie);
  if (!wellFormed || !/(^|;\s*)MoodleSession[^=;\s]*=[^;\s]+/.test(cookie)) {
    throw new MoodleError("That does not look like a MoodleSession cookie.");
  }
  return cookie;
}

/** Fetches a report page with the session cookie. Never follows a redirect, so the page fetched is always the one asked for. */
export async function fetchPage(
  site: Pick<SessionSite, "url" | "session">,
  path: string,
  query: Record<string, string> = {},
): Promise<string> {
  if (!READABLE_PAGES.has(path)) throw new MoodleError(`Refusing to open ${path} in browser-session mode.`);
  const url = new URL(`${site.url}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await moodleFetch(url, {
    headers: { Cookie: site.session.cookie, Accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300 && res.status < 400) {
    const target = new URL(res.headers.get("location") ?? "", url);
    if (target.pathname.includes("/login/")) throw sessionExpired();
    if (target.pathname.endsWith("/course/overview.php")) throw new MoodleError(`Moodle moved ${path} to its course overview.`, "movedtooverview");
    throw new MoodleError(`Moodle sent ${path} on to ${target.pathname}. Open the site in your browser: it may want you to accept a policy or enrol first.`);
  }
  const html = await res.text();
  const moodleError = /<p class="errormessage">([\s\S]*?)<\/p>/.exec(html)?.[1];
  if (moodleError) throw new MoodleError(`${path}: ${htmlToText(moodleError)}`);
  if (!res.ok) throw new MoodleError(`Moodle answered HTTP ${res.status} for ${path}`);
  if (!isSignedIn(html)) throw sessionExpired();
  return html;
}

const loginInfo = (html: string): string | undefined => /<div class="logininfo">([\s\S]*?)<\/div>/.exec(html)?.[1];

/** Goes by markup, not wording, because pages come in the user's language. Guests get no profile link. */
function isSignedIn(html: string): boolean {
  if (/<body\b[^>]*class="[^"]*\bnotloggedin\b/.test(html)) return false;
  const info = loginInfo(html);
  return info === undefined || info.includes("user/profile.php");
}

/** Checks the cookie and reads what the session needs, from a page that only displays links. */
export async function readSession(
  site: Pick<SessionSite, "url"> & { cookie: string },
): Promise<{ sesskey: string; fullname?: string; userid?: number }> {
  const html = await fetchPage({ url: site.url, session: { cookie: site.cookie, sesskey: "" } }, "/user/preferences.php");
  const sesskey = /"sesskey":"([A-Za-z0-9]+)"/.exec(html)?.[1];
  if (!sesskey) throw new MoodleError("Moodle accepted the cookie, but its page has no sesskey, so this site's pages are not supported.");
  // When an admin is "logged in as" someone, the real user comes first and the current one last.
  const profile = [...(loginInfo(html) ?? "").matchAll(/user\/profile\.php\?id=(\d+)[^>]*>([^<]*)</g)].at(-1);
  return { sesskey, userid: profile ? Number(profile[1]) : undefined, fullname: profile ? htmlToText(profile[2]) : undefined };
}

/** Top-level elements with the given tag names. Counts nesting, since teacher feedback can hold tables of its own. */
function elements(html: string, tags: string): { attrs: string; inner: string }[] {
  const found: { attrs: string; inner: string }[] = [];
  let depth = 0;
  let start = 0;
  let attrs = "";
  for (const m of html.matchAll(new RegExp(`<(/?)(?:${tags})\\b([^>]*)>`, "gi"))) {
    if (!m[1]) {
      if (depth++ === 0) {
        start = m.index + m[0].length;
        attrs = m[2];
      }
    } else if (depth > 0 && --depth === 0) {
      found.push({ attrs, inner: html.slice(start, m.index) });
    }
  }
  return found;
}

const layoutError = (page: string): MoodleError =>
  new MoodleError(`Could not read ${page}: its layout is not the one this server knows. A site theme or Moodle version may have changed it.`);

const orNullText = (html: string | undefined): string | null => {
  const text = htmlToText(html);
  return text && text !== "-" ? text : null;
};

/** Parses the table on /grade/report/overview/index.php. A course without a link to its report has no id on this page. */
export function parseGradesOverview(html: string): { courseid: number | null; course: string; grade: string | null; rank: string | null }[] {
  const tables = elements(html, "table").filter((t) => /\bid="overview-grade"/.test(t.attrs));
  if (tables.length === 0) {
    throw new MoodleError("The grades overview page shows no course table. Either you have no courses with grades, or this site changed the page layout.");
  }
  return tables
    .flatMap((t) => elements(t.inner, "tr"))
    .map((row) => elements(row.inner, "td").map((c) => c.inner))
    .filter((cells) => htmlToText(cells[0]))
    .map((cells) => {
      const id = /href="[^"]*[?&;]id=(\d+)/.exec(cells[0])?.[1];
      return { courseid: id ? Number(id) : null, course: htmlToText(cells[0]), grade: orNullText(cells[1]), rank: orNullText(cells[2]) };
    });
}

/** Parses the user-grade table on /grade/report/user/index.php. Text such as dates and grades keeps the site's own format. */
export function parseCourseGrades(html: string) {
  const table = elements(html, "table").find((t) => /\buser-grade\b/.test(t.attrs));
  if (!table) throw layoutError("the course grade report");
  const items = [];
  for (const row of elements(table.inner, "tr")) {
    const cells = elements(row.inner, "t[dh]");
    const column = (name: string): string | undefined => cells.find((c) => new RegExp(`\\bcolumn-${name}\\b`).test(c.attrs))?.inner;
    const nameCell = column("itemname");
    // The table's header row has every column; category headings have a name and no other column.
    if (nameCell === undefined || cells.some((c) => /\bheader\b/.test(c.attrs))) continue;
    // Moodle 3.11 also gives the indent cell of a category a column class.
    if (!cells.some((c) => /\bcolumn-(?!itemname|leader)/.test(c.attrs))) continue;
    const title = /<div class="[^"]*\browtitle\b[^"]*">([\s\S]*?)<\/div>/.exec(nameCell)?.[1];
    const link = /\/mod\/(\w+)\/\w+\.php\?id=(\d+)/.exec(nameCell);
    const range = orNullText(column("range"));
    const bounds = /^(-?[\d.,]+)\s*[\u2013-]\s*(-?[\d.,]+)$/.exec(range ?? "");
    const toNumber = (text: string): number => Number(text.replace(",", "."));
    items.push({
      id: null,
      name: htmlToText(title ?? nameCell),
      type: link?.[1] ?? null,
      cmid: link ? Number(link[2]) : null,
      // A grade can share its cell with an action menu, which comes after it.
      grade: orNullText(column("grade")?.split(/<div[^>]*\b(?:ps|pl)-1\b/)[0]),
      min: bounds ? toNumber(bounds[1]) : null,
      max: bounds ? toNumber(bounds[2]) : null,
      range,
      percent: orNullText(column("percentage")),
      weight: orNullText(column("weight")),
      feedback: orNullText(column("feedback")) ?? undefined,
      graded_at: null,
    });
  }
  return items;
}

/** Parses /mod/assign/index.php, the course-wide list. Reading it does not count as viewing any assignment. */
export function parseAssignmentIndex(html: string) {
  const assignLink = /href="([^"]*\/mod\/assign\/view\.php\?id=(\d+)[^"]*)"/;
  const table = elements(html, "table").find((t) => assignLink.test(t.inner));
  if (!table) {
    if (/<table\b[^>]*generaltable/.test(html)) throw layoutError("the course assignment list");
    return [];
  }
  const assignments = [];
  let section: string | null = null;
  for (const row of elements(table.inner, "tr")) {
    const cells = elements(row.inner, "t[dh]").map((c) => c.inner);
    const at = cells.findIndex((c) => assignLink.test(c));
    if (at < 0 || cells.length < at + 4) continue;
    // Moodle prints a section's name only on its first row.
    if (at > 0) section = orNullText(cells[at - 1]) ?? section;
    const link = assignLink.exec(cells[at])!;
    assignments.push({
      assignid: null,
      cmid: Number(link[2]),
      section,
      name: htmlToText(cells[at]),
      due: null,
      due_text: orNullText(cells[at + 1]),
      submission_status: orNullText(cells[at + 2]),
      grade: orNullText(cells[at + 3]),
      url: htmlToText(link[1]),
    });
  }
  return assignments;
}

/** Parses the assignment table Moodle 5.0 and newer show on /course/overview.php when that section is expanded. */
export function parseAssignmentOverview(html: string) {
  const table = elements(html, "table").find((t) => /\bcourse-overview-table\b/.test(t.attrs));
  if (!table) return [];
  const rows = elements(table.inner, "tr").filter((row) => /data-mdl-overview-cmid="\d+"/.test(row.attrs));
  if (rows.length === 0) throw layoutError("the course overview");
  return rows.map((row) => {
    const cells = elements(row.inner, "td");
    const item = (name: string) => cells.find((c) => c.attrs.includes(`data-mdl-overview-item="${name}"`));
    const nameCell = item("name")?.inner ?? "";
    const link = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(nameCell);
    const due = Number(/data-mdl-overview-value="(\d+)"/.exec(item("duedate")?.attrs ?? "")?.[1]);
    return {
      assignid: null,
      cmid: Number(/data-mdl-overview-cmid="(\d+)"/.exec(row.attrs)![1]),
      // The section is the text that follows the link.
      section: orNullText(/<\/a>\s*<\/div>\s*<div>([\s\S]*?)<\/div>/.exec(nameCell)?.[1]),
      name: htmlToText(link?.[2]),
      due: isoTime(due),
      due_text: orNullText(item("duedate")?.inner),
      submission_status: orNullText(item("submissionstatus")?.inner),
      grade: orNullText(item("Grade")?.inner),
      url: link ? htmlToText(link[1]) : null,
    };
  });
}

/** The JSON state behind the course page, which Moodle 4.0 and newer expose to AJAX. Fetching it marks nothing as viewed. */
export async function readCourseState(site: Pick<SessionSite, "url" | "session">, courseid: number) {
  let raw: string;
  try {
    raw = await callMoodle(site, "core_courseformat_get_state", { courseid });
  } catch (err) {
    if (!(err instanceof MoodleError) || err.errorcode === "sessionexpired") throw err;
    throw new MoodleError("Course contents are not available in browser-session mode on this site. They need Moodle 4.0 or newer.", err.errorcode);
  }
  const state = JSON.parse(raw);
  const cms = new Map<number, any>((state.cm ?? []).map((m: any) => [Number(m.id), m]));
  return (state.section ?? []).map((section: any) => ({
    section: htmlToText(section.title),
    activities: (section.cmlist ?? [])
      .map((id: unknown) => cms.get(Number(id)))
      .filter(Boolean)
      .map((m: any) => ({
        cmid: Number(m.id),
        type: m.module ?? m.modname,
        name: htmlToText(m.name),
        url: m.url ?? null,
        visible: Boolean(m.uservisible),
      })),
  }));
}

/** Parses /mod/quiz/index.php, the course-wide list. It links to quizzes without opening them. */
export function parseQuizIndex(html: string) {
  // Moodle links these relative to the page, unlike its assignment list.
  const quizLink = /href="((?:[^"]*\/mod\/quiz\/)?view\.php\?id=(\d+)[^"]*)"/;
  const table = elements(html, "table").find((t) => quizLink.test(t.inner));
  if (!table) {
    if (/<table\b[^>]*generaltable/.test(html)) throw layoutError("the course quiz list");
    return [];
  }
  const quizzes = [];
  let section: string | null = null;
  for (const row of elements(table.inner, "tr")) {
    const cells = elements(row.inner, "t[dh]").map((c) => c.inner);
    const at = cells.findIndex((c) => quizLink.test(c));
    if (at < 0) continue;
    if (at > 0) section = orNullText(cells[at - 1]) ?? section;
    const link = quizLink.exec(cells[at])!;
    quizzes.push({
      quizid: null,
      cmid: Number(link[2]),
      section,
      name: htmlToText(cells[at]),
      closes_text: orNullText(cells[at + 1]),
      grade: orNullText(cells[at + 2]),
    });
  }
  return quizzes;
}

/** Moodle 5.0 replaced the assignment list page with a section of its course overview. */
export async function readAssignments(site: Pick<SessionSite, "url" | "session">, courseid: number) {
  const id = String(courseid);
  try {
    return parseAssignmentIndex(await fetchPage(site, "/mod/assign/index.php", { id }));
  } catch (err) {
    if (!(err instanceof MoodleError) || err.errorcode !== "movedtooverview") throw err;
  }
  return parseAssignmentOverview(await fetchPage(site, "/course/overview.php", { id, "expand[]": "assign" }));
}

/** Moodle 5.0 moved this list into its course overview too. */
export async function readQuizzes(site: Pick<SessionSite, "url" | "session">, courseid: number) {
  const id = String(courseid);
  try {
    const quizzes = parseQuizIndex(await fetchPage(site, "/mod/quiz/index.php", { id }));
    return quizzes.map((q) => ({ ...q, url: `${site.url}/mod/quiz/view.php?id=${q.cmid}` }));
  } catch (err) {
    if (!(err instanceof MoodleError) || err.errorcode !== "movedtooverview") throw err;
  }
  return parseAssignmentOverview(await fetchPage(site, "/course/overview.php", { id, "expand[]": "quiz" })).map((q) => ({
    quizid: null,
    cmid: q.cmid,
    section: q.section,
    name: q.name,
    closes_text: q.due_text,
    grade: q.grade,
    url: q.url,
  }));
}
