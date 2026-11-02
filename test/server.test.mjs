import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { authorizedFileUrl, encodeParams, fetchPage, htmlToText, parseQuizIndex, parseAssignmentIndex, parseCourseGrades, parseSessionCookie } from "../dist/moodle.js";
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
  mod_assign_get_assignments: () => ({
    courses: [
      {
        assignments: [
          {
            id: 21,
            name: "Essay",
            submissiondrafts: 1,
            configs: [
              { subtype: "assignsubmission", plugin: "file", name: "enabled", value: "1" },
              { subtype: "assignsubmission", plugin: "file", name: "maxfilesubmissions", value: "2" },
              { subtype: "assignsubmission", plugin: "onlinetext", name: "enabled", value: "1" },
            ],
          },
          { id: 22, name: "Instant", submissiondrafts: 0, configs: [{ subtype: "assignsubmission", plugin: "onlinetext", name: "enabled", value: "1" }] },
        ],
      },
    ],
  }),
  mod_assign_get_submission_status: () => ({
    lastattempt: {
      canedit: submission.status !== "submitted",
      submission: {
        status: submission.status,
        plugins: [
          { type: "file", fileareas: [{ area: "submission_files", files: submission.files.map((filename) => ({ filename })) }] },
          { type: "onlinetext", editorfields: [{ name: "onlinetext", text: submission.text, format: 1 }] },
        ],
      },
    },
  }),
  mod_assign_save_submission: () => {
    submission.status = "draft";
    return [];
  },
  mod_assign_submit_for_grading: () => {
    submission.status = "submitted";
    return [];
  },
  mod_forum_get_forums_by_courses: () => [{ id: 31, cmid: 32, name: "News", type: "news", numdiscussions: 1 }],
  mod_forum_get_forum_discussions: () => ({ discussions: [{ discussion: 41, name: "Welcome", message: "<p>Hello</p>", userfullname: "Teacher", numreplies: 0 }] }),
  mod_forum_get_discussion_posts: () => ({ posts: [{ id: 51, subject: "Welcome", message: "<p>Hello</p>", author: { fullname: "Teacher" } }] }),
};

const submission = { status: "new", files: [], text: "" };
const uploads = [];

const SESSION_COOKIE = "MoodleSessionabc=sess1";
const SESSKEY = "Key123abc";
const sessionLog = [];
// Which way the mock site behaves: "on" is the mobile API, "off" reports it disabled, "refused" errors out.
let mobile = "on";
let ajaxExposesCourses = true;
// Moodle 5.0 sends the assignment list page on to the course overview.
let assignListMoved = false;

const moodlePage = (content, loginInfo = '<a href="http://x/user/profile.php?id=7" title="View profile">Test Student</a> (<a href="http://x/login/logout.php?sesskey=Key123abc">Log out</a>)', bodyClass = "") =>
  `<html><head><script>M.cfg = {"wwwroot":"http://x","sesskey":"${SESSKEY}"};</script></head><body class="${bodyClass}">${content}<div class="logininfo">You are logged in as ${loginInfo}</div></body></html>`;

const REPORT_PAGES = {
  "/user/preferences.php": "<h2>Preferences</h2>",
  // Markup below follows Moodle 4.5's grade/report/overview/lib.php.
  "/grade/report/overview/index.php": `<table id="overview-grade" class="boxaligncenter generaltable"><thead><tr><th class="header c0">Course name</th><th class="header c1">Grade</th></tr></thead><tbody>
<tr id="r0"><td class="cell c0"><a href="http://x/course/user.php?mode=grade&amp;id=3&amp;user=7">Maths &amp; 101</a></td><td class="cell c1">85.00</td></tr>
<tr id="r1"><td class="cell c0">No link course</td><td class="cell c1">-</td></tr>
<tr class="emptyrow"><td class="cell c0"></td><td class="cell c1"></td></tr></tbody></table>`,
  // Follows gradereport_user's report/user.php, including the category heading and the spacer row.
  "/grade/report/user/index.php": `<table class="generaltable boxaligncenter user-grade"><thead><tr><th class="header column-itemname">Grade item</th><th class="header column-grade">Grade</th><th class="header column-range">Range</th><th class="header column-percentage">Percentage</th><th class="header column-feedback">Feedback</th></tr></thead><tbody>
<tr class="cat_1"><td class="level1 b2t category column-itemname" colspan="5"><div>Maths</div></td></tr>
<tr class="cat_1"><td class="leader b1l"></td><th class="level2 item column-itemname" colspan="1"><div class="item d-flex"><div class="me-1"><img alt="Assignment"></div><div><span class="d-block text-uppercase small" title="Assignment">Assignment</span><div class="rowtitle"><a title="Link" class="gradeitemheader" href="http://x/mod/assign/view.php?id=21">Essay</a></div></div></div></th><td class="level2 item itemcenter gradepass column-grade"><div class="d-flex"><div><img alt="Pass">8.50</div><div class="ps-1 d-flex"><a href="http://x/grade/report/grader">Grade analysis</a></div></div></td><td class="level2 item itemcenter column-range">0&ndash;100</td><td class="level2 item itemcenter column-percentage">8.50 %</td><td class="level2 item feedbacktext column-feedback"><p>See</p><table><tr><td>my</td></tr></table><p>table</p></td></tr>
<tr class="cat_1 spacer"><td class="spacer" colspan="5"></td></tr>
<tr class="cat_1"><th class="level1 baggt column-itemname"><div class="courseitem d-flex"><div><span class="d-block small">Course total</span><div class="rowtitle">Course total</div></div></div></th><td class="level1 itemcenter column-grade">-</td><td class="level1 itemcenter column-range">0&ndash;100</td><td class="level1 itemcenter column-percentage">-</td><td class="level1 feedbacktext column-feedback">&nbsp;</td></tr></tbody></table>`,
  // Captured from a real Moodle 5.0 with ?id=2&expand[]=assign.
  "/course/overview.php": `<table class="course-overview-table boxaligncenter table w-100"> <caption class="accesshide">Table listing all Assignment activities</caption> <thead> <tr> <th scope="col" data-mdl-overview-column="name">Name</th> <th scope="col" data-mdl-overview-column="duedate">Due date</th> <th scope="col" data-mdl-overview-column="submissionstatus">Submission status</th> <th scope="col" data-mdl-overview-column="Grade">Grade</th> </tr> </thead> <tbody>
<tr data-mdl-overview-cmid="2"> <td class=" text-start" data-mdl-overview-item="name" data-mdl-overview-value="Graded report"> <div class="d-flex flex-column"> <div class="fw-bold"> <a href="http://x/mod/assign/view.php?id=2" class="activityname">Graded report</a> </div> <div> Week 2 </div> <div class="ms-2"> </div> </div> </td> <td class=" text-start" data-mdl-overview-item="duedate" data-mdl-overview-value="1793377298"> Friday, 30 October 2026, 4:21 PM </td> <td class=" text-start" data-mdl-overview-item="submissionstatus" data-mdl-overview-value="Submitted for grading"> Submitted for grading </td> <td class=" text-start" data-mdl-overview-item="Grade" data-mdl-overview-value="42.50000"> 42.50 </td> </tr>
<tr data-mdl-overview-cmid="3"> <td class=" text-start" data-mdl-overview-item="name" data-mdl-overview-value="No deadline"> <div class="d-flex flex-column"> <div class="fw-bold"> <a href="http://x/mod/assign/view.php?id=3" class="activityname">No deadline</a> </div> <div> Week 2 </div> <div class="ms-2"> </div> </div> </td> <td class=" text-start" data-mdl-overview-item="duedate" data-mdl-overview-value=""> - </td> <td class=" text-start" data-mdl-overview-item="submissionstatus" data-mdl-overview-value="No submission"> No submission </td> <td class=" text-start" data-mdl-overview-item="Grade" data-mdl-overview-value=""> - </td> </tr> </tbody></table>`,
  // Follows mod_assign's render_assign_course_index_summary with sections on.
  "/mod/quiz/index.php": `<table class="generaltable"><thead><tr><th class="header c0">Topic</th><th class="header c1">Name</th><th class="header c2">Quiz closes</th><th class="header c3 lastcol">Grade</th></tr></thead><tbody>
<tr><td class="cell c0">Week 1</td><td class="cell c1"><a href="http://x/mod/quiz/view.php?id=12">Quiz 1</a></td><td class="cell c2">Monday, 2 November 2026</td><td class="cell c3 lastcol">8.00</td></tr></tbody></table>`,
  "/mod/assign/index.php": `<table class="generaltable"><thead><tr><th class="header c0">Topic</th><th class="header c1">Assignments</th><th class="header c2">Due date</th><th class="header c3">Submission</th><th class="header c4 lastcol">Grade</th></tr></thead><tbody>
<tr><td class="cell c0">Week 1</td><td class="cell c1"><a href="http://x/mod/assign/view.php?id=21">Essay</a></td><td class="cell c2">Monday, 2 November 2026, 11:59 PM</td><td class="cell c3">Submitted for grading</td><td class="cell c4 lastcol">8.50</td></tr>
<tr><td class="cell c0"></td><td class="cell c1"><a href="http://x/mod/assign/view.php?id=22">Report</a></td><td class="cell c2">-</td><td class="cell c3">No submission</td><td class="cell c4 lastcol">-</td></tr>
<tr class="lastrow"><td colspan="5"><div class="tabledivider"></div></td></tr></tbody></table>`,
};

/** Answers like a site with the mobile service off: function lists come from Moodle 4.5's db/services.php. */
function sessionSite(req, res, body) {
  const cookie = req.headers.cookie ?? "";
  const path = req.url.split("?")[0];
  sessionLog.push({ method: req.method, path, url: req.url, cookie });
  const signedIn = cookie === SESSION_COOKIE;
  if (path === "/lib/ajax/service.php") {
    const [{ methodname, args }] = JSON.parse(body);
    const fail = (errorcode) => [{ error: true, exception: { message: errorcode, errorcode } }];
    let answer;
    if (!signedIn) answer = fail("servicerequireslogin");
    else if (new URL(req.url, "http://x").searchParams.get("sesskey") !== SESSKEY) answer = fail("invalidsesskey");
    else if (methodname === "core_course_get_enrolled_courses_by_timeline_classification" && ajaxExposesCourses) {
      answer = args.classification === "allincludinghidden"
        ? fail("invalidparameter")
        : [{ error: false, data: { courses: [{ id: 3, fullname: "Maths <b>101</b>", shortname: "M101", progress: 40, startdate: 1700000000 }], nextoffset: 1 } }];
    } else if (methodname === "core_calendar_get_action_events_by_timesort") {
      answer = [{ error: false, data: { events: [{ name: "Essay is due", timesort: 1800000000, overdue: false, modulename: "assign", course: { id: 3, fullname: "Maths 101" }, url: "http://x/mod/assign/view.php?id=21" }] } }];
    } else if (methodname === "core_courseformat_get_state") {
      const state = { section: [{ id: 1, title: "Week 1", cmlist: ["12"] }], cm: [{ id: "12", name: "Quiz 1", module: "quiz", url: "http://x/mod/quiz/view.php?id=12", uservisible: true }] };
      answer = [{ error: false, data: JSON.stringify(state) }];
    } else answer = fail("servicenotavailable");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(answer));
  }
  if (path.startsWith("/pluginfile.php/")) {
    if (!signedIn) {
      res.writeHead(303, { Location: "/login/index.php" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("session notes");
  }
  if (cookie === "MoodleSession=guest") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(moodlePage(REPORT_PAGES[path] ?? "", "You are currently using guest access"));
  }
  if (!signedIn && path !== "/login/index.php") {
    res.writeHead(303, { Location: "http://x/login/index.php" });
    return res.end();
  }
  if (path === "/mod/assign/index.php" && assignListMoved) {
    res.writeHead(303, { Location: "http://x/course/overview.php?id=3&expand%5B%5D=assign#assign_overview_collapsible" });
    return res.end();
  }
  const content = path === "/login/index.php" ? "<form>login</form>" : REPORT_PAGES[path];
  res.writeHead(content === undefined ? 404 : 200, { "Content-Type": "text/html" });
  return res.end(moodlePage(content ?? ""));
}

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (value) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url.startsWith("/lib/ajax/service-nologin.php")) {
      if (mobile === "refused") return json([{ error: true, exception: { message: "no", errorcode: "servicenotavailable" } }]);
      const on = mobile === "on" ? 1 : 0;
      return json([{ error: false, data: { sitename: "Test Moodle", wwwroot: "x", enablewebservices: on, enablemobilewebservice: on, typeoflogin: 1 } }]);
    }
    if (mobile !== "on") return sessionSite(req, res, body);
    if (req.url === "/login/token.php") {
      const form = new URLSearchParams(body);
      if (form.get("password") === "restricted") return json({ token: "restricted-token" });
      return json(form.get("password") === "right" ? { token: TEST_TOKEN } : { error: "Invalid login", errorcode: "invalidlogin" });
    }
    if (req.url === "/webservice/upload.php") {
      uploads.push(/filename="([^"]+)"/.exec(body)?.[1]);
      return json([{ itemid: 777, filename: uploads.at(-1) }]);
    }
    if (req.url === "/webservice/rest/server.php") {
      const form = new URLSearchParams(body);
      const fn = form.get("wsfunction");
      calls.push(Object.fromEntries(form));
      if (form.get("wstoken") === "restricted-token") return json({ exception: "x", errorcode: "accessexception", message: "no" });
      if (form.get("wstoken") !== TEST_TOKEN) return json({ exception: "x", errorcode: "invalidtoken" });
      return json(functions[fn]?.() ?? { exception: "x", errorcode: "invalidrecord", message: `unknown ${fn}` });
    }
    if (req.url.startsWith("/webservice/pluginfile.php/1/notes.txt")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("notes");
    }
    if (req.url.startsWith("/webservice/pluginfile.php/1/lecture.docx")) {
      const xml = "<w:document><w:p><w:t>First &amp; line</w:t></w:p><w:p><w:t>Другий рядок</w:t></w:p></w:document>";
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(zipSync({ "word/document.xml": strToU8(xml) }));
    }
    res.writeHead(404);
    res.end();
  });
});

const fetchPageFor = (path) => fetchPage({ url: siteUrl, session: { cookie: SESSION_COOKIE, sesskey: SESSKEY } }, path);

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

test("quiz writes and browser actions are exposed with mutation annotations", async () => {
  const { tools } = await client.listTools();
  for (const name of ["moodle_quiz_start_attempt", "moodle_quiz_save_answers", "moodle_quiz_submit_attempt", "moodle_browser_open", "moodle_browser_action"]) {
    assert.equal(tools.find(t => t.name === name)?.annotations.readOnlyHint, false, name);
  }
  for (const name of ["moodle_quiz_attempt_data", "moodle_quiz_attempt_summary", "moodle_browser_snapshot", "moodle_browser_screenshot"]) {
    assert.equal(tools.find(t => t.name === name)?.annotations.readOnlyHint, true, name);
  }
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
  // Windows has no mode bits: there the file relies on the permissions of the user's profile folder.
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
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

test("reads the text of office files and refuses formats it cannot read", async () => {
  const read = await callTool("moodle_read_file", { url: `${siteUrl}/pluginfile.php/1/lecture.docx` });
  assert.equal(read.text, "First & line\nДругий рядок");
  assert.equal(read.next_offset, null);
});

test("reads forums", async () => {
  const [forum] = await callTool("moodle_forums", { courseid: 3 });
  const [discussion] = await callTool("moodle_forum_discussions", { forumid: forum.forumid });
  assert.equal(discussion.message, "Hello");
  const [post] = await callTool("moodle_forum_posts", { discussionid: discussion.discussionid });
  assert.equal(post.author, "Teacher");
});

test("homework stays a draft until the name is confirmed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodle-mcp-hw-"));
  const homework = join(dir, "homework.txt");
  await writeFile(homework, "my work");

  const saved = await callTool("moodle_save_assignment_submission", { assignid: 21, file_paths: [homework] });
  assert.equal(saved.status, "draft");
  assert.equal(saved.handed_in, false);
  assert.equal(uploads.at(-1), "homework.txt");
  const save = calls.findLast((c) => c.wsfunction === "mod_assign_save_submission");
  assert.equal(save["plugindata[files_filemanager]"], "777");
  // Moodle fails or blanks the text when a save leaves it out.
  assert.equal(save["plugindata[onlinetext_editor][text]"], "");

  submission.files = ["homework.txt"];
  assert.match((await callTool("moodle_save_assignment_submission", { assignid: 21, file_paths: [homework] })).error, /replace/);
  assert.match((await callTool("moodle_submit_assignment", { assignid: 21, confirm_name: "essay" })).error, /does not match/);
  assert.ok(!calls.some((c) => c.wsfunction === "mod_assign_submit_for_grading"));
  assert.equal((await callTool("moodle_submit_assignment", { assignid: 21, confirm_name: "Essay" })).handed_in, true);
  assert.match((await callTool("moodle_save_assignment_submission", { assignid: 21, online_text: "late" })).error, /cannot be changed/);
  await rm(dir, { recursive: true });
});

test("assignments without drafts need the name before saving", async () => {
  submission.status = "new";
  submission.files = [];
  const before = calls.filter((c) => c.wsfunction === "mod_assign_save_submission").length;
  assert.match((await callTool("moodle_save_assignment_submission", { assignid: 22, online_text: "x" })).error, /no drafts/);
  assert.equal(calls.filter((c) => c.wsfunction === "mod_assign_save_submission").length, before);
});

test("uploads refuse hidden folders and key files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodle-mcp-hw-"));
  const hidden = join(dir, ".ssh");
  await mkdir(hidden);
  await writeFile(join(hidden, "notes.txt"), "secret");
  await writeFile(join(dir, "id_ed25519"), "secret");
  const count = uploads.length;
  for (const path of [join(hidden, "notes.txt"), join(dir, "id_ed25519")]) {
    assert.match((await callTool("moodle_save_assignment_submission", { assignid: 21, file_paths: [path] })).error, /Refusing/);
  }
  assert.equal(uploads.length, count);
  await rm(dir, { recursive: true });
});

test("an account the mobile API refuses is offered a browser session and nothing is stored", async () => {
  const alias = siteUrl.replace("127.0.0.1", "localhost");
  const text = await callTool("moodle_login", { url: alias });
  const formUrl = /open (http:\S+)\./.exec(text)[1];
  const res = await fetch(formUrl, { method: "POST", body: new URLSearchParams({ username: "student", password: "restricted" }) });
  assert.match(await res.text(), /refuses mobile API calls for your account[\s\S]*name="cookie"/);
  assert.doesNotMatch(await readFile(join(home, "sites.json"), "utf8"), /restricted-token/);
});

test("a refused call returns an error and leaves the server running", async () => {
  const path = join(home, "sites.json");
  const saved = await readFile(path, "utf8");
  await writeFile(path, JSON.stringify({ ...JSON.parse(saved), refused: { url: siteUrl, token: "restricted-token" } }));
  assert.match((await callTool("moodle_grades_overview", { site: "refused" })).error, /refuses/);
  // An unobserved rejection would have ended the process by now.
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(Array.isArray(await callTool("moodle_list_sites")));
  await writeFile(path, saved);
});

test("logout forgets the token", async () => {
  assert.match(await callTool("moodle_logout", { site: siteUrl }), /Logged out/);
  assert.match((await callTool("moodle_whoami")).error, /moodle_login/);
});

test("check_site tells when sign-in needs a browser session", async () => {
  mobile = "off";
  const off = await callTool("moodle_check_site", { url: siteUrl });
  assert.equal(off.mobile_api_enabled, false);
  assert.equal(off.sign_in, "browser_session");
  mobile = "refused";
  assert.equal((await callTool("moodle_check_site", { url: siteUrl })).sign_in, "browser_session");
  mobile = "on";
  assert.equal((await callTool("moodle_check_site", { url: siteUrl })).sign_in, "mobile_api");
});

test("session form has no password field and accepts only a signed-in cookie", async () => {
  mobile = "off";
  const text = await callTool("moodle_login", { url: siteUrl });
  assert.match(text, /session cookie/);
  const formUrl = /open (http:\S+)\./.exec(text)[1];
  const html = await (await fetch(formUrl)).text();
  assert.match(html, /name="cookie"/);
  assert.doesNotMatch(html, /name="(password|username)"/);

  const post = (cookie) => fetch(formUrl, { method: "POST", body: new URLSearchParams({ cookie }) });
  assert.match(await (await post("not a cookie;")).text(), /does not look like/);
  const stale = await post("MoodleSession=stale");
  assert.equal(stale.status, 401);
  assert.match(await stale.text(), /did not accept/);
  assert.equal((await post("guest")).status, 401);
  assert.equal((await post(SESSION_COOKIE)).status, 200);

  const path = join(home, "sites.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  const [entry] = Object.values(stored);
  assert.deepEqual(entry.session, { cookie: SESSION_COOKIE, sesskey: SESSKEY });
  assert.equal(entry.userid, 7);
  assert.equal(entry.fullname, "Test Student");
  // Windows has no mode bits: there the file relies on the permissions of the user's profile folder.
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("session mode reads the signed-in user and courses", async () => {
  assert.equal((await callTool("moodle_whoami")).fullname, "Test Student");
  assert.equal((await callTool("moodle_list_sites"))[0].mode, "browser_session");
  const [course] = await callTool("moodle_list_courses");
  assert.equal(course.id, 3);
  assert.equal(course.name, "Maths 101");
  assert.equal(course.progress_percent, 40);
  const ajax = sessionLog.filter((r) => r.path === "/lib/ajax/service.php").at(-1);
  assert.equal(ajax.cookie, SESSION_COOKIE);
  assert.match(ajax.url, new RegExp(`sesskey=${SESSKEY}`));
});

test("session mode falls back to the grades page for courses", async () => {
  ajaxExposesCourses = false;
  const courses = await callTool("moodle_list_courses");
  ajaxExposesCourses = true;
  assert.deepEqual(courses.map((c) => [c.id, c.name]), [[3, "Maths & 101"]]);
});

test("session mode reads grades from report pages", async () => {
  assert.deepEqual(await callTool("moodle_grades_overview"), [
    { courseid: 3, course: "Maths & 101", grade: "85.00", rank: null },
    { courseid: null, course: "No link course", grade: null, rank: null },
  ]);
  const [essay, total] = await callTool("moodle_course_grades", { courseid: 3 });
  assert.equal(essay.name, "Essay");
  assert.equal(essay.type, "assign");
  assert.equal(essay.cmid, 21);
  assert.equal(essay.grade, "8.50");
  assert.equal(essay.max, 100);
  assert.equal(essay.percent, "8.50 %");
  assert.match(essay.feedback, /See[\s\S]*my[\s\S]*table/);
  assert.equal(total.name, "Course total");
  assert.equal(total.grade, null);
  assert.ok(sessionLog.some((r) => r.url === "/grade/report/user/index.php?id=3"));
});

test("session mode reads deadlines and assignments", async () => {
  const [deadline] = await callTool("moodle_deadlines", {});
  assert.equal(deadline.name, "Essay is due");
  assert.equal(deadline.due, new Date(1800000000 * 1000).toISOString());
  const [essay, report] = await callTool("moodle_assignments", { courseid: 3 });
  assert.equal(essay.cmid, 21);
  assert.equal(essay.section, "Week 1");
  assert.equal(essay.due_text, "Monday, 2 November 2026, 11:59 PM");
  assert.equal(essay.submission_status, "Submitted for grading");
  assert.equal(essay.grade, "8.50");
  assert.equal(report.section, "Week 1");
  assert.equal(report.due_text, null);
});

test("session mode follows Moodle 5.0 to the course overview for assignments", async () => {
  assignListMoved = true;
  const [report, open] = await callTool("moodle_assignments", { courseid: 3 });
  assignListMoved = false;
  assert.equal(report.cmid, 2);
  assert.equal(report.name, "Graded report");
  assert.equal(report.section, "Week 2");
  assert.equal(report.due, new Date(1793377298 * 1000).toISOString());
  assert.equal(report.submission_status, "Submitted for grading");
  assert.equal(report.grade, "42.50");
  assert.equal(report.url, "http://x/mod/assign/view.php?id=2");
  assert.equal(open.due, null);
  assert.equal(open.grade, null);
  assert.ok(sessionLog.some((r) => r.url === "/course/overview.php?id=3&expand%5B%5D=assign"));
});

test("session mode lists course contents and quizzes without opening them", async () => {
  const [section] = await callTool("moodle_course_contents", { courseid: 3 });
  assert.equal(section.section, "Week 1");
  assert.deepEqual(section.activities.map((a) => [a.cmid, a.type, a.name]), [[12, "quiz", "Quiz 1"]]);
  const [quiz] = await callTool("moodle_quizzes", { courseid: 3 });
  assert.equal(quiz.cmid, 12);
  assert.equal(quiz.grade, "8.00");
  assert.equal(quiz.closes_text, "Monday, 2 November 2026");
});

test("session mode says plainly what it cannot do", async () => {
  assert.match((await callTool("moodle_quiz_attempt_review", { attemptid: 9 })).error, /browser-session mode/);
  assert.match((await callTool("moodle_assignment_status", { assignid: 1 })).error, /browser-session mode/);
});

test("session mode stays read-only and away from activity pages", async () => {
  assert.ok(sessionLog.length > 0);
  const writes = sessionLog.filter((r) => r.method !== "GET" && r.path !== "/lib/ajax/service.php");
  assert.deepEqual(writes, []);
  const pages = new Set(sessionLog.filter((r) => r.method === "GET").map((r) => r.path));
  // The course-wide list is the one quiz page allowed: it only links to quizzes.
  for (const path of pages) assert.doesNotMatch(path, /\/mod\/(quiz\/(?!index\.php)|assign\/view)|logout/);
  for (const page of ["view", "attempt", "startattempt", "processattempt", "summary", "review"]) {
    await assert.rejects(fetchPageFor(`/mod/quiz/${page}.php`), /Refusing/);
  }
});

test("session mode downloads with the cookie and only from the site", async () => {
  const file = await callTool("moodle_download_file", { url: `${siteUrl}/webservice/pluginfile.php/1/notes.txt` });
  assert.equal(await readFile(file.path, "utf8"), "session notes");
  await rm(file.path);
  assert.equal(sessionLog.at(-1).path, "/pluginfile.php/1/notes.txt");
  assert.doesNotMatch(sessionLog.at(-1).url, /token/);
  const before = sessionLog.length;
  assert.match((await callTool("moodle_download_file", { url: "https://evil.example/pluginfile.php/1/a" })).error, /Refusing/);
  assert.match((await callTool("moodle_download_file", { url: `${siteUrl}/mod/quiz/view.php?id=1` })).error, /pluginfile/);
  assert.equal(sessionLog.length, before);
});

test("an ended session asks the user to sign in again", async () => {
  const path = join(home, "sites.json");
  const stored = await readFile(path, "utf8");
  await writeFile(path, stored.replace(SESSION_COOKIE, "MoodleSession=ended"));
  assert.match((await callTool("moodle_list_courses")).error, /session ended/);
  assert.match((await callTool("moodle_grades_overview")).error, /session ended/);
  assert.match((await callTool("moodle_download_file", { url: `${siteUrl}/pluginfile.php/1/a` })).error, /session ended/);
  await writeFile(path, stored);
  assert.match(await callTool("moodle_logout", { site: siteUrl }), /Logged out/);
  mobile = "on";
});

test("parseSessionCookie takes a value or name=value, and nothing else", () => {
  assert.equal(parseSessionCookie(" abc123 "), "MoodleSession=abc123");
  assert.equal(parseSessionCookie("MoodleSessionxy=abc"), "MoodleSessionxy=abc");
  assert.equal(parseSessionCookie("Cookie: lb=1; MoodleSession=abc"), "lb=1; MoodleSession=abc");
  assert.throws(() => parseSessionCookie("other=abc"), /does not look like/);
  assert.throws(() => parseSessionCookie("MoodleSession=a\r\nX-Evil: 1"), /does not look like/);
});

test("course grades skip category rows that carry only an indent column, as on Moodle 3.11", () => {
  const html = `<table class="user-grade"><tr><td class="column-leader" rowspan="2"></td><td class="d1 column-itemname" colspan="5">Maths</td></tr>
<tr><th class="item column-itemname">Essay</th><td class="item column-grade">5</td></tr></table>`;
  assert.deepEqual(parseCourseGrades(html).map((g) => g.name), ["Essay"]);
});

test("page parsers report an unknown layout instead of an empty list", () => {
  assert.throws(() => parseCourseGrades("<p>new theme</p>"), /layout/);
  assert.throws(() => parseAssignmentIndex('<table class="generaltable"><tr><td>x</td><td>y</td></tr></table>'), /layout/);
  assert.deepEqual(parseAssignmentIndex("<p>There are no assignments</p>"), []);
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

test("a course with nothing to list is empty, and an unknown table is an error", () => {
  // Captured shape from a real site: a header and a one-cell spacer row.
  const empty = '<table class="generaltable"><thead><tr><th>Topic</th><th>Name</th></tr></thead><tbody><tr class="lastrow"><td colspan="5"><div class="tabledivider"></div></td></tr></tbody></table>';
  assert.deepEqual(parseAssignmentIndex(empty), []);
  assert.deepEqual(parseQuizIndex(empty), []);
  const unknown = '<table class="generaltable"><tbody><tr><td>Essay</td><td>Monday</td></tr></tbody></table>';
  assert.throws(() => parseAssignmentIndex(unknown), /layout/);
  assert.throws(() => parseQuizIndex(unknown), /layout/);
});

test("quiz list reads the relative links a real Moodle prints", () => {
  const html = '<table class="generaltable"><tbody><tr><td>Week 1</td><td><a href="view.php?id=12">Quiz 1</a></td><td>Monday</td><td>8.00</td></tr></tbody></table>';
  assert.deepEqual(parseQuizIndex(html), [{ quizid: null, cmid: 12, section: "Week 1", name: "Quiz 1", closes_text: "Monday", grade: "8.00" }]);
});
