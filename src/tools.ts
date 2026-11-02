import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openInBrowser, startLoginForm } from "./login.js";
import { authorizedFileUrl, callMoodle, getPublicConfig, htmlToText, isoTime, MoodleError } from "./moodle.js";
import { loadSites, normalizeSiteUrl, removeSite, resolveSite, siteKey, type Site } from "./store.js";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const site = z.string().optional().describe("Site key or URL. Optional when only one site is logged in.");
const courseid = z.number().int().describe("Course id from moodle_list_courses.");

const hasFunction = (info: any, name: string): boolean => info.functions?.some((f: any) => f.name === name) ?? false;

async function currentUser(s: Site): Promise<number> {
  if (s.userid) return s.userid;
  return (await callMoodle(s, "core_webservice_get_site_info")).userid;
}

/** One refused call must not hide the rest of a list: sites restrict functions one by one. */
async function orNull<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof MoodleError && err.errorcode !== "invalidtoken") return null;
    throw err;
  }
}

async function quizAttempts(s: Site, fn: string, quizid: number, userid: number): Promise<any[]> {
  const data = await callMoodle(s, fn, { quizid, userid, status: "all", includepreviews: false });
  return data.attempts ?? [];
}

export function registerTools(server: McpServer): void {
  const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    annotations: ToolAnnotations = read,
  ): void => {
    const handler = async (args: any) => {
      try {
        const result = await run(args);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
      }
    };
    (server.registerTool as any)(name, { description, inputSchema, annotations }, handler);
  };

  tool(
    "moodle_check_site",
    "Check without logging in whether a URL is a Moodle site this server can use.",
    { url: z.string().describe("Site URL, for example https://do.ipo.kpi.ua") },
    async ({ url }) => {
      const config = await getPublicConfig(normalizeSiteUrl(url));
      return {
        sitename: htmlToText(config.sitename),
        url: config.wwwroot,
        mobile_api_enabled: Boolean(config.enablewebservices && config.enablemobilewebservice),
        password_login: config.typeoflogin === 1,
        maintenance: Boolean(config.maintenanceenabled),
      };
    },
  );

  tool(
    "moodle_login",
    "Open a local browser form where the user signs in to a Moodle site. Returns immediately. " +
      "Never ask the user for their password in chat: they type it into the form. " +
      "Once they confirm, continue with moodle_list_sites or any other tool.",
    { url: z.string().describe("Site URL, for example https://do.ipo.kpi.ua") },
    async ({ url }) => {
      const form = await startLoginForm(url);
      openInBrowser(form.formUrl);
      return `Login form opened in the browser for ${form.sitename} (${form.siteUrl}). If no tab appeared, open ${form.formUrl}. The form stays valid for 10 minutes.`;
    },
    { readOnlyHint: false, openWorldHint: true },
  );

  tool(
    "moodle_logout",
    "Forget the stored access token for a site on this computer.",
    { site: z.string().describe("Site key or URL.") },
    async ({ site: name }) => {
      let key = name;
      try {
        key = siteKey(normalizeSiteUrl(name));
      } catch {
        // Not URL shaped: treat it as a key.
      }
      return (await removeSite(key)) ? `Logged out of ${key}.` : `Not logged in to ${key}.`;
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  );

  tool("moodle_list_sites", "List Moodle sites that are logged in on this computer.", {}, async () => {
    const sites = await loadSites();
    return Object.entries(sites).map(([key, s]) => ({
      site: key,
      url: s.url,
      sitename: htmlToText(s.sitename),
      user: s.fullname,
    }));
  });

  tool("moodle_whoami", "Show the signed-in user and the site's Moodle version.", { site }, async ({ site: name }) => {
    const info = await callMoodle(await resolveSite(name), "core_webservice_get_site_info");
    return {
      sitename: htmlToText(info.sitename),
      fullname: info.fullname,
      username: info.username,
      userid: info.userid,
      moodle_release: info.release,
      language: info.lang,
    };
  });

  tool("moodle_list_courses", "List courses the signed-in user is enrolled in.", { site }, async ({ site: name }) => {
    const s = await resolveSite(name);
    const courses = await callMoodle(s, "core_enrol_get_users_courses", { userid: await currentUser(s) });
    return courses.map((c: any) => ({
      id: c.id,
      name: htmlToText(c.fullname),
      shortname: c.shortname,
      progress_percent: c.progress ?? null,
      completed: c.completed ?? null,
      last_access: isoTime(c.lastaccess),
      start: isoTime(c.startdate),
      end: isoTime(c.enddate),
    }));
  });

  tool(
    "moodle_course_contents",
    "List a course's sections and activities: lectures, practical work, files, quizzes and assignments.",
    { site, courseid },
    async ({ site: name, courseid: id }) => {
      const sections = await callMoodle(await resolveSite(name), "core_course_get_contents", { courseid: id });
      return sections.map((section: any) => ({
        section: htmlToText(section.name),
        summary: htmlToText(section.summary) || undefined,
        activities: (section.modules ?? []).map((m: any) => ({
          cmid: m.id,
          instance: m.instance,
          type: m.modname,
          name: htmlToText(m.name),
          description: htmlToText(m.description) || undefined,
          url: m.url,
          visible: Boolean(m.uservisible),
          dates: m.dates?.map((d: any) => ({ label: d.label, at: isoTime(d.timestamp) })),
          completed: m.completiondata ? m.completiondata.state > 0 : undefined,
          files: m.contents
            ?.filter((f: any) => f.type === "file")
            .map((f: any) => ({ name: f.filename, size: f.filesize, url: f.fileurl })),
        })),
      }));
    },
  );

  tool(
    "moodle_course_pages",
    "Read the text of a course's Page activities, where teachers often put lectures and practical work instructions.",
    { site, courseid },
    async ({ site: name, courseid: id }) => {
      const data = await callMoodle(await resolveSite(name), "mod_page_get_pages_by_courses", { courseids: [id] });
      return (data.pages ?? []).map((p: any) => ({
        cmid: p.coursemodule,
        name: htmlToText(p.name),
        intro: htmlToText(p.intro) || undefined,
        content: htmlToText(p.content),
      }));
    },
  );

  tool("moodle_grades_overview", "Show the signed-in user's final grade in every course.", { site }, async ({ site: name }) => {
    const s = await resolveSite(name);
    const [overview, courses] = await Promise.all([
      callMoodle(s, "gradereport_overview_get_course_grades", {}),
      callMoodle(s, "core_enrol_get_users_courses", { userid: await currentUser(s) }),
    ]);
    const names = new Map(courses.map((c: any) => [c.id, htmlToText(c.fullname)]));
    return (overview.grades ?? []).map((g: any) => ({
      courseid: g.courseid,
      course: names.get(g.courseid) ?? null,
      grade: g.grade,
      rank: g.rank ?? null,
    }));
  });

  tool(
    "moodle_course_grades",
    "Show every grade item in one course, with range, percentage and teacher feedback.",
    { site, courseid },
    async ({ site: name, courseid: id }) => {
      const s = await resolveSite(name);
      const data = await callMoodle(s, "gradereport_user_get_grade_items", {
        courseid: id,
        userid: await currentUser(s),
      });
      const items = data.usergrades?.[0]?.gradeitems ?? [];
      return items.map((g: any) => ({
        id: g.id,
        name: htmlToText(g.itemname) || (g.itemtype === "course" ? "Course total" : g.itemtype),
        type: g.itemmodule ?? g.itemtype,
        cmid: g.cmid ?? null,
        grade: g.gradeformatted ?? g.graderaw ?? null,
        min: g.grademin,
        max: g.grademax,
        percent: g.percentageformatted ?? null,
        weight: g.weightformatted ?? null,
        feedback: htmlToText(g.feedback) || undefined,
        graded_at: isoTime(g.gradedategraded),
      }));
    },
  );

  tool(
    "moodle_deadlines",
    "List upcoming deadlines and overdue activities across all courses.",
    {
      site,
      days: z.number().int().min(1).max(365).default(30).describe("How many days ahead to look."),
      past_days: z.number().int().min(0).max(365).default(30).describe("How many days back to look for overdue work."),
    },
    async ({ site: name, days, past_days }) => {
      const now = Math.floor(Date.now() / 1000);
      const data = await callMoodle(await resolveSite(name), "core_calendar_get_action_events_by_timesort", {
        timesortfrom: now - past_days * 86_400,
        timesortto: now + days * 86_400,
        limitnum: 50,
      });
      return (data.events ?? []).map((e: any) => ({
        name: htmlToText(e.name),
        course: htmlToText(e.course?.fullname),
        courseid: e.course?.id,
        type: e.modulename,
        due: isoTime(e.timesort),
        overdue: e.overdue ?? false,
        action: e.action?.name,
        url: e.url,
      }));
    },
  );

  tool(
    "moodle_assignments",
    "List a course's assignments with instructions, due dates and attached files.",
    { site, courseid },
    async ({ site: name, courseid: id }) => {
      const data = await callMoodle(await resolveSite(name), "mod_assign_get_assignments", { courseids: [id] });
      return (data.courses?.[0]?.assignments ?? []).map((a: any) => ({
        assignid: a.id,
        cmid: a.cmid,
        name: htmlToText(a.name),
        instructions: htmlToText(a.intro) || undefined,
        opens: isoTime(a.allowsubmissionsfromdate),
        due: isoTime(a.duedate),
        cutoff: isoTime(a.cutoffdate),
        max_grade: a.grade,
        files: a.introattachments?.map((f: any) => ({ name: f.filename, size: f.filesize, url: f.fileurl })),
      }));
    },
  );

  tool(
    "moodle_assignment_status",
    "Show the signed-in user's submission, grade and teacher feedback for one assignment.",
    { site, assignid: z.number().int().describe("assignid from moodle_assignments.") },
    async ({ site: name, assignid }) => {
      const data = await callMoodle(await resolveSite(name), "mod_assign_get_submission_status", { assignid });
      const submission = data.lastattempt?.submission;
      const plugins: any[] = submission?.plugins ?? [];
      return {
        // Moodle reports "new" with a timestamp when nothing was handed in yet.
        submitted: submission?.status === "submitted",
        submission_status: submission?.status ?? "none",
        grading_status: data.lastattempt?.gradingstatus ?? null,
        last_modified: isoTime(submission?.timemodified),
        can_edit: data.lastattempt?.canedit ?? null,
        online_text:
          htmlToText(
            plugins
              .flatMap((p) => p.editorfields ?? [])
              .map((f: any) => f.text)
              .join("\n"),
          ) || undefined,
        files: plugins
          .flatMap((p) => p.fileareas ?? [])
          .flatMap((area: any) => area.files ?? [])
          .map((f: any) => ({ name: f.filename, size: f.filesize, url: f.fileurl })),
        grade: data.feedback?.gradefordisplay ? htmlToText(data.feedback.gradefordisplay) : null,
        graded_at: isoTime(data.feedback?.gradeddate),
        feedback:
          htmlToText(
            (data.feedback?.plugins ?? [])
              .flatMap((p: any) => p.editorfields ?? [])
              .map((f: any) => f.text)
              .join("\n"),
          ) || undefined,
      };
    },
  );

  tool(
    "moodle_quizzes",
    "List a course's quizzes with time limits and dates, plus the signed-in user's attempts and scores.",
    { site, courseid },
    async ({ site: name, courseid: id }) => {
      const s = await resolveSite(name);
      const [data, info] = await Promise.all([
        callMoodle(s, "mod_quiz_get_quizzes_by_courses", { courseids: [id] }),
        callMoodle(s, "core_webservice_get_site_info"),
      ]);
      const userid: number = info.userid;
      // mod_quiz_get_user_attempts was replaced in newer Moodle versions.
      const attemptsFn = hasFunction(info, "mod_quiz_get_user_quiz_attempts")
        ? "mod_quiz_get_user_quiz_attempts"
        : "mod_quiz_get_user_attempts";
      return Promise.all(
        (data.quizzes ?? []).map(async (q: any) => {
          const [best, attempts] = await Promise.all([
            orNull(callMoodle(s, "mod_quiz_get_user_best_grade", { quizid: q.id, userid })),
            orNull(quizAttempts(s, attemptsFn, q.id, userid)),
          ]);
          return {
            quizid: q.id,
            cmid: q.coursemodule,
            name: htmlToText(q.name),
            description: htmlToText(q.intro) || undefined,
            opens: isoTime(q.timeopen),
            closes: isoTime(q.timeclose),
            time_limit_seconds: q.timelimit || null,
            attempts_allowed: q.attempts || "unlimited",
            max_grade: q.grade,
            // Null when the teacher hides marks; raw_score below is hidden the same way.
            best_grade: best?.grade ?? null,
            // Null, unlike an empty list, means the site refused to say.
            attempts:
              attempts?.map((a) => ({
                attemptid: a.id,
                number: a.attempt,
                state: a.state,
                started: isoTime(a.timestart),
                finished: isoTime(a.timefinish),
                raw_score: a.sumgrades,
                max_raw_score: q.sumgrades,
              })) ?? null,
          };
        }),
      );
    },
  );

  tool(
    "moodle_quiz_attempt_review",
    "Read a finished quiz attempt: questions, the user's answers, marks and feedback, for studying mistakes. " +
      "Shows only what the teacher allows students to review. Does not work on attempts still in progress.",
    { site, attemptid: z.number().int().describe("attemptid from moodle_quizzes.") },
    async ({ site: name, attemptid }) => {
      const data = await callMoodle(await resolveSite(name), "mod_quiz_get_attempt_review", { attemptid, page: -1 });
      return {
        grade: data.grade,
        state: data.attempt?.state,
        questions: (data.questions ?? []).map((q: any) => ({
          number: q.questionnumber ?? q.number ?? q.slot,
          type: q.type,
          state: q.status ?? q.state,
          mark: q.mark ?? null,
          max_mark: q.maxmark ?? null,
          content: htmlToText(q.html),
        })),
      };
    },
  );

  tool(
    "moodle_download_file",
    "Download a course or assignment file from a Moodle file URL to a temporary folder and return its local path.",
    { site, url: z.string().url().describe("A file url returned by another moodle_ tool.") },
    async ({ site: name, url }) => {
      const s = await resolveSite(name);
      // Redirects are refused because the request URL carries the token.
      const res = await fetch(authorizedFileUrl(s, url), {
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const body: any = await res.json();
        throw new Error(body.message ?? body.error ?? "Moodle refused the download.");
      }
      if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) {
        throw new Error("File is larger than the 50 MB download limit.");
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("File is larger than the 50 MB download limit.");
      const base = join(tmpdir(), "moodle-mcp");
      await mkdir(base, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(base, "file-"));
      const filename = basename(decodeURIComponent(new URL(url).pathname)).replace(/[^\p{L}\p{N}._ -]/gu, "_") || "file";
      const path = join(dir, filename);
      await writeFile(path, bytes, { mode: 0o600 });
      return { path, bytes: bytes.length, content_type: type };
    },
  );
}
