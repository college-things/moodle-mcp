import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Site {
  url: string;
  token: string;
  sitename?: string;
  fullname?: string;
  userid?: number;
}

type Sites = Record<string, Site>;

function storePath(): string {
  const base = process.env.MOODLE_MCP_HOME ?? join(homedir(), ".config", "moodle-mcp");
  return join(base, "sites.json");
}

/** Read on every call so a login from the CLI reaches a running server. */
export async function loadSites(): Promise<Sites> {
  try {
    return JSON.parse(await readFile(storePath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function saveSites(sites: Sites): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(sites, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export function siteKey(url: string): string {
  const { host, pathname } = new URL(url);
  return (host + pathname).replace(/\/+$/, "");
}

export async function saveSite(site: Site): Promise<string> {
  const sites = await loadSites();
  const key = siteKey(site.url);
  sites[key] = site;
  await saveSites(sites);
  return key;
}

export async function removeSite(key: string): Promise<boolean> {
  const sites = await loadSites();
  if (!sites[key]) return false;
  delete sites[key];
  await saveSites(sites);
  return true;
}

/** Picks a site by key or URL; the name may be omitted when only one is stored. */
export async function resolveSite(name?: string): Promise<Site> {
  const sites = await loadSites();
  const keys = Object.keys(sites);
  if (name) {
    let key = name;
    try {
      key = siteKey(normalizeSiteUrl(name));
    } catch {
      // Not URL shaped: treat it as a key.
    }
    const site = sites[key];
    if (site) return site;
    throw new Error(`Not logged in to "${name}". Call moodle_login with its URL first.`);
  }
  const only = keys.length === 1 ? sites[keys[0]] : undefined;
  if (only) return only;
  if (keys.length === 0) throw new Error("No Moodle site is logged in. Call moodle_login with the site URL first.");
  throw new Error(`Several sites are logged in, pass "site" as one of: ${keys.join(", ")}`);
}

export function normalizeSiteUrl(input: string): string {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Moodle site URL must use https, otherwise the password would travel unencrypted.");
  }
  const path = url.pathname.replace(/\/(login\/index\.php|my\/?|index\.php)$/, "").replace(/\/+$/, "");
  return url.origin + path;
}
