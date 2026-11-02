#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clientConfig } from "./clients.js";
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
  console.error(`Signed in to ${result.site}${result.fullname ? ` as ${result.fullname}` : ""}`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === "config") {
    console.log(clientConfig(arg));
    return;
  }
  if (command === "browser-install") {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.resolve("playwright/package.json"))), "install", "chromium"], { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Browser install failed (${code}).`)));
    });
    return;
  }
  if (command === "login") {
    if (!arg) throw new Error("Usage: moodle-mcp login <site-url>");
    return cliLogin(arg);
  }
  if (command === "http") {
    const { startHttpServer } = await import("./http.js");
    return startHttpServer();
  }
  if (command) throw new Error(`Unknown command "${command}". Usage: moodle-mcp [login <site-url> | browser-install | config <codex|antigravity> | http]`);
  // Stdout carries the protocol here, and the PDF library logs font warnings with console.log.
  console.log = console.error;
  await createMcpServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
