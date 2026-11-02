import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpServer } from "../dist/tools.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("generated Codex and Antigravity configs launch the same MCP from another working directory", async () => {
  const run = client => execFileSync(process.execPath, ["dist/index.js", "config", client], { encoding: "utf8" });
  const config = JSON.parse(run("antigravity")).mcpServers.moodle;
  const toml = run("codex");
  assert.equal(JSON.parse(/^command = (.+)$/m.exec(toml)[1]), config.command);
  assert.deepEqual(JSON.parse(/^args = (.+)$/m.exec(toml)[1]), config.args);
  const client = new Client({ name: "config-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ ...config, cwd: "/" }));
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === "moodle_quiz_start_attempt"));
    assert.ok(tools.some(t => t.name === "moodle_browser_action"));
  } finally { await client.close(); }
});

test("hosted context never exposes quiz-taking or browser tools", async () => {
  const server = createMcpServer({
    store: { list: async () => ({}), resolve: async () => { throw new Error("not signed in"); }, remove: async () => false },
    where: "in hosted mode", loginDescription: "Sign in", login: async () => "sign in",
    maxDownloadBytes: 10_000, deliverFile: async () => ({}),
  });
  const client = new Client({ name: "hosted-tools-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    assert.equal(tools.some(t => t.name.startsWith("moodle_browser_")), false);
    for (const name of ["moodle_quiz_start_attempt", "moodle_quiz_save_answers", "moodle_quiz_submit_attempt", "moodle_quiz_attempt_data", "moodle_quiz_attempt_summary"]) {
      assert.equal(tools.some(t => t.name === name), false);
    }
    assert.ok(tools.some(t => t.name === "moodle_quiz_attempt_review"));
  } finally { await client.close(); await server.close(); }
});
