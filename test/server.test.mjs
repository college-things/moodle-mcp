import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { authorizedFileUrl, encodeParams, htmlToText } from "../dist/moodle.js";
import { normalizeSiteUrl } from "../dist/store.js";

const TEST_TOKEN = "test-token";
const calls = [];
let refuseBestGrade = false;

/** Answers like Moodle's mobile web service, with shapes taken from its API docs. */
const functions = {
  core_webservice_get_site_info: () => ({
    sitename: "Test &amp; Moodle",
    fullname: "Test Student",
    username: "student",
    userid: 7,
    release: "4.5",
    lang: "en",
    functions: [{ name: "mod_quiz_get_user_quiz_attempts" }],
  }),
  core_enrol_get_users_courses: () => [{ id: 3, fullname: "Maths <b>101</b>", shortname: "M101", progress: 40, startdate: 1700000000 }],
  mod_page_get_pages_by_courses: () => ({ pages: [{ coursemodule: 11, name: "Lecture 1", content: "<p>Limits</p>" }] }),
  gradereport_user_get_grade_items: () => ({
    usergrades: [{ gradeitems: [{ id: 1, itemname: "Quiz 1", itemtype: "mod", itemmodule: "quiz", gradeformatted: "8.00", grademax: 10, feedback: "<p>Good</p>" }] }],
  }),
  mod_quiz_get_quizzes_by_courses: () => ({ quizzes: [{ id: 5, coursemodule: 12, name: "Quiz 1", grade: 10, sumgrades: 20, attempts: 0 }] }),
  mod_quiz_get_user_best_grade: () =>
    refuseBestGrade ? { exception: "x", errorcode: "accessexception", message: "no" } : { hasgrade: true, grade: 8 },
  mod_quiz_get_user_quiz_attempts: () => ({ attempts: [{ id: 9, attempt: 1, state: "finished", sumgrades: 16, timestart: 1700000000 }] }),
  mod_quiz_get_attempt_review: () => ({
    grade: "8.00",
    attempt: { state: "finished" },
    questions: [{ slot: 1, type: "multichoice", status: "Correct", mark: "1.00", html: '<input type="radio" checked>A<input type="radio">B' }],
  }),
};

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (value) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url.startsWith("/lib/ajax/service-nologin.php")) {
      return json([{ error: false, data: { sitename: "Test Moodle", wwwroot: "x", enablewebservices: 1, enablemobilewebservice: 1, typeoflogin: 1 } }]);
    }
    if (req.url === "/login/token.php") {
      const form = new URLSearchParams(body);
      return json(form.get("password") === "right" ? { token: TEST_TOKEN } : { error: "Invalid login", errorcode: "invalidlogin" });
    }
    if (req.url === "/webservice/rest/server.php") {
      const form = new URLSearchParams(body);
      const fn = form.get("wsfunction");
      calls.push(Object.fromEntries(form));
      if (form.get("wstoken") !== TEST_TOKEN) return json({ exception: "x", errorcode: "invalidtoken" });
      return json(functions[fn]?.() ?? { exception: "x", errorcode: "invalidrecord", message: `unknown ${fn}` });
    }
    if (req.url.startsWith("/webservice/pluginfile.php/1/notes.txt")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("notes");
    }
    res.writeHead(404);
    res.end();
  });
});

let home;
let siteUrl;
let client;

const callTool = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

before(async () => {
  await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
  siteUrl = `http://127.0.0.1:${mock.address().port}`;
  home = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      // An empty PATH keeps the login tool from opening a real browser tab.
      env: { ...process.env, MOODLE_MCP_HOME: home, PATH: "" },
    }),
  );
});

after(async () => {
  await client.close();
  mock.close();
  await rm(home, { recursive: true, force: true });
});

test("every tool is read-only except session management", async () => {
  const { tools } = await client.listTools();
  const writers = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(writers, ["moodle_login", "moodle_logout"]);
  assert.ok(!tools.some((t) => /submit|start|save|process/.test(t.name)));
});

test("tools explain that login is needed", async () => {
  assert.match((await callTool("moodle_list_courses")).error, /moodle_login/);
});

test("login form rejects a wrong password, then stores only the token", async () => {
  const text = await callTool("moodle_login", { url: siteUrl });
  const formUrl = /open (http:\S+)\./.exec(text)[1];
  assert.equal((await fetch(formUrl.replace(/\/[^/]+$/, "/wrong"))).status, 404);
  assert.match(await (await fetch(formUrl)).text(), /Test Moodle/);

  const post = (fields) => fetch(formUrl, { method: "POST", body: new URLSearchParams(fields) });
  const bad = await post({ username: "student", password: "wrong" });
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /Invalid login/);
  assert.equal((await post({ username: "student", password: "right" })).status, 200);

  const path = join(home, "sites.json");
  const stored = await readFile(path, "utf8");
  assert.match(stored, /test-token/);
  assert.doesNotMatch(stored, /right/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("reads courses, pages and grades", async () => {
  assert.equal((await callTool("moodle_list_courses"))[0].name, "Maths 101");
  assert.equal((await callTool("moodle_course_pages", { courseid: 3 }))[0].content, "Limits");
  const [grade] = await callTool("moodle_course_grades", { courseid: 3 });
  assert.equal(grade.grade, "8.00");
  assert.equal(grade.feedback, "Good");
});

test("quiz list uses the newer attempts function", async () => {
  const [quiz] = await callTool("moodle_quizzes", { courseid: 3 });
  assert.equal(quiz.best_grade, 8);
  assert.equal(quiz.attempts[0].attemptid, 9);
  assert.ok(calls.some((c) => c.wsfunction === "mod_quiz_get_user_quiz_attempts"));
});

test("one refused call does not hide the quiz list", async () => {
  refuseBestGrade = true;
  const [quiz] = await callTool("moodle_quizzes", { courseid: 3 });
  refuseBestGrade = false;
  assert.equal(quiz.best_grade, null);
  assert.equal(quiz.attempts.length, 1);
});

test("attempt review keeps which answer was chosen", async () => {
  const review = await callTool("moodle_quiz_attempt_review", { attemptid: 9 });
  assert.equal(review.questions[0].content, "[x] A[ ] B");
  assert.ok(calls.some((c) => c.wsfunction === "mod_quiz_get_attempt_review" && c.page === "-1"));
});

test("downloads site files and keeps the token on the site", async () => {
  const file = await callTool("moodle_download_file", { url: `${siteUrl}/pluginfile.php/1/notes.txt` });
  assert.equal(await readFile(file.path, "utf8"), "notes");
  await rm(file.path);
  assert.match((await callTool("moodle_download_file", { url: "https://evil.example/pluginfile.php/1/a" })).error, /Refusing/);
});

test("logout forgets the token", async () => {
  assert.match(await callTool("moodle_logout", { site: siteUrl }), /Logged out/);
  assert.match((await callTool("moodle_whoami")).error, /moodle_login/);
});

test("encodeParams flattens arrays the way Moodle expects", () => {
  assert.equal(encodeParams({ courseids: [3], flag: true }).toString(), "courseids%5B0%5D=3&flag=1");
});

test("htmlToText decodes entities and drops scripts", () => {
  assert.equal(htmlToText("<script>x</script><p>A &amp; B</p>&#1058;"), "A & B\nТ");
});

test("normalizeSiteUrl trims page paths and refuses plain http", () => {
  assert.equal(normalizeSiteUrl("do.ipo.kpi.ua/login/index.php"), "https://do.ipo.kpi.ua");
  assert.equal(normalizeSiteUrl("https://x.edu/moodle/my/"), "https://x.edu/moodle");
  assert.throws(() => normalizeSiteUrl("http://x.edu"), /https/);
});

test("authorizedFileUrl respects a site in a subfolder", () => {
  const site = { url: "https://x.edu/moodle", token: "t" };
  const url = authorizedFileUrl(site, "https://x.edu/moodle/pluginfile.php/1/a.pdf");
  assert.equal(url.pathname, "/moodle/webservice/pluginfile.php/1/a.pdf");
  assert.throws(() => authorizedFileUrl(site, "https://x.edu/other/pluginfile.php/1/a.pdf"), /Refusing/);
});
