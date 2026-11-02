import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("real Chromium via MCP signs in, completes a two-page quiz and restores the profile", { timeout: 60000 }, async () => {
  let submitted = false;
  const answers = [];
  const mock = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = req.url.split("?")[0];
    const signedIn = /MoodleSession=browser-test/.test(req.headers.cookie ?? "");
    if (path === "/sign-in") {
      res.writeHead(303, { "Set-Cookie": "MoodleSession=browser-test; Path=/; HttpOnly", Location: "/" });
      return res.end();
    }
    res.setHeader("Content-Type", "text/html");
    let html;
    if (!signedIn) html = '<h1>Sign in</h1><form action="/sign-in" method="post"><label>Password<input type="password" value="private-password"></label><button>Sign in</button></form>';
    else if (path === "/user/preferences.php") html = '<script>M.cfg={"sesskey":"Browser123"}</script><div class="logininfo"><a href="/user/profile.php?id=7">Browser Student</a> (<a href="/login/logout.php">Log out</a>)</div>';
    else if (path === "/delayed") html = `<h1>Dynamic controls</h1><script>setTimeout(() => {
      const button = document.createElement('button');
      button.textContent = 'Late action';
      button.onclick = () => { document.body.textContent = 'Delayed control clicked'; };
      document.body.append(button);
    }, 800);</script>`;
    else if (path === "/page-2") {
      answers.push(new URLSearchParams(body).get("answer1"));
      html = '<h1>Question 2</h1><form method="post" action="/finish"><label>Answer 2<input name="answer2"></label><button>Submit all and finish</button></form>';
    } else if (path === "/finish") {
      answers.push(new URLSearchParams(body).get("answer2"));
      submitted = true;
      html = '<h1>Finished</h1><p>Grade: 10 / 10</p>';
    } else html = '<h1>Practice quiz</h1><form method="post" action="/page-2"><label><input type="radio" name="answer1" value="a">Choice A</label><label><input type="radio" name="answer1" value="b">Choice B</label><button>Next page</button></form><a href="https://example.org/">External</a>';
    res.end(`<!doctype html><html><head><title>Moodle browser test</title></head><body>${html}</body></html>`);
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const home = await mkdtemp(join(tmpdir(), "moodle-browser-"));
  const url = `http://127.0.0.1:${mock.address().port}`;
  const client = new Client({ name: "browser-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env, MOODLE_MCP_HOME: home } }));
    const raw = async (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => {
      const r = await raw(name, args);
      return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
    };
    assert.match((await call("moodle_browser_snapshot")).error, /Open a browser/);
    const login = await call("moodle_browser_open", { url, headless: true });
    assert.match(login.snapshot, /Sign in/);
    assert.doesNotMatch(login.snapshot, /private-password/);
    assert.match((await call("moodle_browser_action", { action: "fill", selector: 'input[type="password"]', value: "x" })).error, /passwords directly/);
    await call("moodle_browser_action", { action: "click", selector: 'role=button[name="Sign in"]' });
    const sync = await call("moodle_browser_sync_login");
    assert.equal(sync.user, "Browser Student");
    assert.doesNotMatch(JSON.stringify(sync), /browser-test|Browser123/);
    const sites = JSON.parse(await readFile(join(home, "sites.json"), "utf8"));
    assert.match(Object.values(sites)[0].session.cookie, /MoodleSession=browser-test/);
    assert.match((await call("moodle_browser_action", { action: "click", selector: "input" })).error, /exactly one/);
    await call("moodle_browser_action", { action: "check", selector: 'input[value="b"]' });
    const page2 = await call("moodle_browser_action", { action: "click", selector: 'role=button[name="Next page"]' });
    assert.match(page2.snapshot, /Question 2/);
    await call("moodle_browser_action", { action: "fill", selector: 'input[name="answer2"]', value: "42" });
    const screenshot = await raw("moodle_browser_screenshot");
    assert.equal(screenshot.content[0].type, "image");
    assert.equal(Buffer.from(screenshot.content[0].data, "base64").subarray(1, 4).toString(), "PNG");
    const final = await call("moodle_browser_action", { action: "click", selector: 'role=button[name="Submit all and finish"]' });
    assert.match(final.snapshot, /Finished/);
    assert.equal(submitted, true);
    assert.deepEqual(answers, ["b", "42"]);
    assert.match((await call("moodle_browser_navigate", { path: "https://example.org" })).error, /stay on/);
    await call("moodle_browser_navigate", { path: "/delayed" });
    assert.match((await call("moodle_browser_action", { action: "click", selector: 'role=button[name="Late action"]' })).snapshot, /Delayed control clicked/);
    await call("moodle_browser_close");
    const statePath = join(home, "browser", createHash("sha256").update(url).digest("hex"), "mcp-session.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.cookies.find(c => c.name === "MoodleSession").expires, -1);
    if (process.platform !== "win32") assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    // Reopening must restore session-only cookies independently of the site store.
    await rm(join(home, "sites.json"));
    assert.match((await call("moodle_browser_open", { url, headless: true })).snapshot, /Practice quiz/);
    await call("moodle_browser_close");
  } finally {
    await client.close();
    mock.closeAllConnections();
    await new Promise(r => mock.close(r));
    await rm(home, { recursive: true, force: true });
  }
});
