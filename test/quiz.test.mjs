import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("quiz lifecycle through MCP preserves fields, validates identity, handles warnings and finishes once", async () => {
  const calls = [];
  let state = "inprogress";
  let warning = false;
  let legacy = false;
  const mock = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = Object.fromEntries(new URLSearchParams(body));
    calls.push(p);
    let data;
    switch (p.wsfunction) {
      case "core_webservice_get_site_info": data = { userid: 7, functions: legacy ? [] : [{ name: "mod_quiz_get_user_quiz_attempts" }] }; break;
      case "mod_quiz_get_quizzes_by_courses": data = { quizzes: [{ id: 5, name: "Quiz &amp; test" }] }; break;
      case "mod_quiz_start_attempt": data = { attempt: { id: 9, quiz: 5, state }, warnings: [] }; break;
      case "mod_quiz_get_user_quiz_attempts":
      case "mod_quiz_get_user_attempts": data = { attempts: [{ id: 9, quiz: 5, state }] }; break;
      case "mod_quiz_get_attempt_data": data = { attempt: { id: 9 }, nextpage: -1, questions: [{ html: '<input name="q2:1_answer" value="a"><input name="q2:1_:sequencecheck" value="1">' }] }; break;
      case "mod_quiz_get_attempt_summary": data = { questions: [{ slot: 1, status: "Answer saved" }], totalunanswered: 0, warnings: [] }; break;
      case "mod_quiz_process_attempt":
        if (warning) data = { state, warnings: [{ message: "stale sequence" }] };
        else { if (p.finishattempt === "1") state = "finished"; data = { state, warnings: [] }; }
        break;
      default: data = { exception: "error", message: "unexpected call" };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const home = await mkdtemp(join(tmpdir(), "moodle-quiz-"));
  const url = `http://127.0.0.1:${mock.address().port}`;
  await writeFile(join(home, "sites.json"), JSON.stringify({ test: { url, token: "test" } }));
  const client = new Client({ name: "quiz-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env, MOODLE_MCP_HOME: home } }));
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
    };
    assert.match((await call("moodle_quiz_start_attempt", { quizid: 5, confirm_name: "wrong" })).error, /confirm_name/);
    assert.equal(calls.filter(c => c.wsfunction === "mod_quiz_start_attempt").length, 0);
    assert.equal((await call("moodle_quiz_start_attempt", { quizid: 5, confirm_name: "Quiz & test" })).attempt.id, 9);
    assert.match((await call("moodle_quiz_attempt_data", { attemptid: 9 })).questions[0].html, /sequencecheck/);
    const data = [{ name: "q2:1_answer", value: "a" }, { name: "q2:1_:sequencecheck", value: "1" }, { name: "slots", value: "1" }];
    assert.equal((await call("moodle_quiz_save_answers", { attemptid: 9, data })).state, "inprogress");
    assert.equal(calls.at(-1)["data[1][name]"], "q2:1_:sequencecheck");
    assert.equal(calls.at(-1).finishattempt, "0");
    warning = true;
    assert.match((await call("moodle_quiz_save_answers", { attemptid: 9, data })).error, /stale sequence/);
    warning = false;
    assert.match((await call("moodle_quiz_submit_attempt", { quizid: 5, attemptid: 999, confirm_name: "Quiz & test" })).error, /does not belong/);
    assert.match((await call("moodle_quiz_submit_attempt", { quizid: 5, attemptid: 9, confirm_name: "wrong" })).error, /confirm_name/);
    assert.equal(calls.filter(c => c.finishattempt === "1").length, 0);
    legacy = true;
    assert.equal((await call("moodle_quiz_submit_attempt", { quizid: 5, attemptid: 9, confirm_name: "Quiz & test" })).finished, true);
    assert.equal(calls.at(-1).finishattempt, "1");
    assert.equal((await call("moodle_quiz_submit_attempt", { quizid: 5, attemptid: 9, confirm_name: "Quiz & test" })).note, "Already submitted.");
    assert.equal(calls.filter(c => c.finishattempt === "1").length, 1);
    await writeFile(join(home, "sites.json"), JSON.stringify({ test: { url, session: { cookie: "x", sesskey: "y" } } }));
    assert.match((await call("moodle_quiz_attempt_data", { attemptid: 9 })).error, /browser/);
  } finally {
    await client.close();
    mock.closeAllConnections();
    await new Promise(r => mock.close(r));
    await rm(home, { recursive: true, force: true });
  }
});
