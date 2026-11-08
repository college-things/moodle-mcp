import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { MoodleError, type MoodleFetch } from "./moodle.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
// The transition prefixes can wrap a private IPv4 address, so none of them count as public.
for (const [net, bits] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // IPv4-mapped IPv6 addresses are checked against the IPv4 rules by BlockList.
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Checks at connect time, so a name cannot pass a check and then rebind to a private address. */
function publicLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new MoodleError(`${hostname} resolves to a private address, so this server will not contact it.`), []);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined && name !== "set-cookie") headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export interface GuardOptions {
  /** Only for tests against a mock Moodle on loopback. */
  allowPrivate?: boolean;
  /** Hostnames this deployment serves. Empty means any public host. */
  allowedHosts?: string[];
}

/**
 * A fetch for URLs supplied by strangers: public addresses only, https only, a size
 * cap, and no redirects, because a Moodle request carries a password or a token.
 */
export function createGuardedFetch({ allowPrivate = false, allowedHosts = [] }: GuardOptions = {}): MoodleFetch {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) {
        return reject(new MoodleError(`This server is not set up to use ${url.hostname}.`));
      }
      if (!allowPrivate) {
        if (url.protocol !== "https:") return reject(new MoodleError("Moodle site URL must use https."));
        const host = url.hostname.replace(/^\[|\]$/g, "");
        // Node skips the lookup for IP literals, so they are checked here.
        if (isIP(host) && !isPublicAddress(host)) {
          return reject(new MoodleError(`${host} is a private address, so this server will not contact it.`));
        }
      }
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: init.method ?? "GET",
          headers: init.headers as Record<string, string> | undefined,
          signal: init.signal ?? undefined,
          lookup: allowPrivate ? undefined : (publicLookup as any),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          // "manual" callers read the answer themselves; nothing here ever follows it.
          if (status >= 300 && status < 400 && init.redirect !== "manual") {
            res.destroy();
            let target = "another address";
            try {
              target = new URL(res.headers.location ?? "", url).origin;
            } catch {
              // An unreadable Location still means the site redirected.
            }
            return reject(new MoodleError(`The site redirected to ${target}. Use the site's final address.`, "redirected"));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              res.destroy();
              return reject(new MoodleError("The site's response was too large."));
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const empty = status === 204 || status === 205 || status === 304;
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: toHeaders(res.headers) }));
          });
        },
      );
      req.on("error", reject);
      req.end(init.body === undefined || init.body === null ? undefined : String(init.body));
    });
}
