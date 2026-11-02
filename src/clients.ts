import { fileURLToPath } from "node:url";

/** Absolute launch paths work even when GUI clients do not inherit the shell's PATH. */
export function clientConfig(client?: string): string {
  const command = process.execPath;
  const args = [fileURLToPath(new URL("./index.js", import.meta.url))];
  if (client === "codex") {
    return `[mcp_servers.moodle]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(args[0])}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120`;
  }
  if (client === "antigravity") return JSON.stringify({ mcpServers: { moodle: { command, args } } }, null, 2);
  throw new Error("Usage: moodle-mcp config <codex|antigravity>");
}
