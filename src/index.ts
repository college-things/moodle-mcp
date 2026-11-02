#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openInBrowser, startLoginForm } from "./login.js";
import { createMcpServer } from "./tools.js";

async function cliLogin(url: string): Promise<void> {
  const form = await startLoginForm(url);
  console.error(`Sign in at ${form.formUrl}`);
  openInBrowser(form.formUrl);
  // The form server is unref'd so it cannot hold a stdio server open; here it must.
  const keepAlive = setInterval(() => {}, 1000);
  const result = await form.done.finally(() => clearInterval(keepAlive));
  console.error(`Signed in to ${result.site}${result.fullname ? ` as ${result.fullname}` : ", but the site restricts API access"}`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === "login") {
    if (!arg) throw new Error("Usage: moodle-mcp login <site-url>");
    return cliLogin(arg);
  }
  if (command === "http") {
    const { startHttpServer } = await import("./http.js");
    return startHttpServer();
  }
  if (command) throw new Error(`Unknown command "${command}". Usage: moodle-mcp [login <site-url> | http]`);
  await createMcpServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
