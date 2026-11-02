import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pickSite, siteKey, normalizeSiteUrl, writePrivateFile, type Site, type Sites, type SiteStore } from "./store.js";

const KEY_BYTES = 32;

export function parseMasterKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} random bytes in base64. Create one with: openssl rand -base64 32`);
  return key;
}

function deriveKey(master: Buffer, salt: Buffer, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, salt, `moodle-mcp/v1/${context}`, KEY_BYTES));
}

/**
 * AES-256-GCM with a key derived per record. The context is bound into both the key and
 * the authentication tag, so a record copied to another user's file does not decrypt.
 */
export class Vault {
  /** @param keys The current master key first, then any previous one still being rotated out. */
  constructor(private readonly keys: Buffer[]) {}

  seal(context: string, value: unknown): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(this.keys[0], salt, context), iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }

  /** `stale` means an old key opened it, so the caller should write it back. */
  open<T>(context: string, text: string): { value: T; stale: boolean } {
    const record = JSON.parse(text);
    if (record.v !== 1) throw new Error("Unknown encrypted record version.");
    for (const [index, master] of this.keys.entries()) {
      try {
        const key = deriveKey(master, Buffer.from(record.salt, "base64"), context);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        const plain = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
        return { value: JSON.parse(plain.toString("utf8")), stale: index > 0 };
      } catch {
        // Wrong key or tampered record: the next key decides.
      }
    }
    throw new Error("Could not decrypt a stored record. Wrong master key, or the file was altered.");
  }
}

/** Encrypted Moodle tokens, one file per user. The file name is an opaque user id. */
export class UserSites {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly vault: Vault,
    private readonly dir: string,
  ) {}

  private path(userId: string): string {
    if (!/^[0-9a-f]{64}$/.test(userId)) throw new Error("Invalid user id.");
    return join(this.dir, `${userId}.enc`);
  }

  /** Read-modify-write on one user's file must not interleave. */
  private serial<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(userId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {}).finally(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId);
    });
    this.queues.set(userId, tail);
    return run;
  }

  private async read(userId: string): Promise<Sites> {
    let text: string;
    try {
      text = await readFile(this.path(userId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const { value, stale } = this.vault.open<Sites>(`sites/${userId}`, text);
    if (stale) await this.write(userId, value);
    return value;
  }

  private write(userId: string, sites: Sites): Promise<void> {
    return writePrivateFile(this.path(userId), this.vault.seal(`sites/${userId}`, sites));
  }

  save(userId: string, site: Site): Promise<string> {
    return this.serial(userId, async () => {
      const sites = await this.read(userId);
      const key = siteKey(site.url);
      sites[key] = site;
      await this.write(userId, sites);
      return key;
    });
  }

  removeUser(userId: string): Promise<void> {
    return this.serial(userId, () => rm(this.path(userId), { force: true }));
  }

  async userIds(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => []);
    return names.filter((n) => n.endsWith(".enc")).map((n) => n.slice(0, -".enc".length));
  }

  /** The only way tools reach tokens in hosted mode. Every method is fixed to one user. */
  forUser(userId: string): SiteStore {
    return {
      list: () => this.serial(userId, () => this.read(userId)),
      resolve: async (name) => pickSite(await this.serial(userId, () => this.read(userId)), name),
      remove: (name) =>
        this.serial(userId, async () => {
          const sites = await this.read(userId);
          let key = name;
          try {
            key = siteKey(normalizeSiteUrl(name));
          } catch {
            // Not URL shaped: treat it as a key.
          }
          if (!sites[key]) return false;
          delete sites[key];
          await this.write(userId, sites);
          return true;
        }),
    };
  }
}
