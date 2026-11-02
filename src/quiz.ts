import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callMoodle, htmlToText } from "./moodle.js";
import type { SiteStore, TokenSite } from "./store.js";

/** Moodle enforces attempt ownership, access rules, time limits and question sequencing. */
export function registerQuizTools(server: McpServer, store: SiteStore): void {
  const site = z.string().optional();
  const attemptid = z.number().int().positive();
  const fields = z.array(z.object({ name: z.string().min(1), value: z.string() })).max(1000);
  const preflightdata = fields.default([]).describe("Access declarations required by Moodle. Enter passwords in the browser, never in chat.");
  const resolve = async (name?: string): Promise<TokenSite> => {
    const s = await store.resolve(name);
    if ("session" in s) throw new Error("Quiz API tools need the mobile service. Use moodle_browser_open and the browser tools in browser-session mode.");
    return s;
  };
  const title = async (s: TokenSite, id: number): Promise<string> => {
    const data = await callMoodle(s, "mod_quiz_get_quizzes_by_courses");
    const quiz = data.quizzes?.find((q: any) => q.id === id);
    if (!quiz) throw new Error(`Quiz ${id} is unavailable to this account.`);
    return htmlToText(quiz.name);
  };
  const checked = (data: any) => {
    if (data.warnings?.length) throw new Error(`Moodle warning: ${data.warnings.map((w: any) => htmlToText(w.message ?? w.warningcode)).join("; ")}. Check the attempt before retrying.`);
    return data;
  };
  const add = (name: string, description: string, inputSchema: any, run: (args: any) => Promise<any>, readOnlyHint = false) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: true } }, async (args: any) => {
      try { return { content: [{ type: "text" as const, text: JSON.stringify(await run(args), null, 2) }] }; }
      catch (err) { return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] }; }
    });
  };
  add("moodle_quiz_start_attempt", "Start a quiz at the user's request. May consume an attempt and start a timer. Existing attempts should be resumed using their attemptid. Restricted quizzes can be taken through the browser tools.",
    { site, quizid: z.number().int().positive(), confirm_name: z.string(), preflightdata },
    async ({ site, quizid, confirm_name, preflightdata }) => {
      const s = await resolve(site);
      const name = await title(s, quizid);
      if (name !== confirm_name) throw new Error(`confirm_name must match the quiz name: ${name}`);
      return checked(await callMoodle(s, "mod_quiz_start_attempt", { quizid, preflightdata, forcenew: false }));
    });
  add("moodle_quiz_attempt_data", "Read one page of an active attempt. question.html contains the exact input names, values and sequencecheck fields needed to save answers. Follow nextpage until -1; respect sequential navigation.",
    { site, attemptid, page: z.number().int().min(0).default(0), preflightdata },
    async ({ site, ...params }) => checked(await callMoodle(await resolve(site), "mod_quiz_get_attempt_data", params)), true);
  add("moodle_quiz_attempt_summary", "Read all question statuses before finishing an attempt, including unanswered questions.",
    { site, attemptid, preflightdata },
    async ({ site, ...params }) => checked(await callMoodle(await resolve(site), "mod_quiz_get_attempt_summary", params)), true);
  add("moodle_quiz_save_answers", "Save answers without finishing the attempt. Copy exact field names from fresh question HTML, including :sequencecheck fields and slots. Returns Moodle's attempt state. Never retry a failed write blindly; read the attempt first.",
    { site, attemptid, data: fields.min(1), preflightdata },
    async ({ site, ...params }) => checked(await callMoodle(await resolve(site), "mod_quiz_process_attempt", { ...params, finishattempt: false, timeup: false })));
  add("moodle_quiz_submit_attempt", "Finish an attempt for grading when the user requests submission. Read the summary first. Finishing cannot usually be undone; confirm_name must identify the quiz. Saves any supplied answer fields before finishing.",
    { site, attemptid, quizid: z.number().int().positive(), confirm_name: z.string(), data: fields.default([]), preflightdata },
    async ({ site, quizid, confirm_name, ...params }) => {
      const s = await resolve(site);
      const info = await callMoodle(s, "core_webservice_get_site_info");
      const fn = info.functions?.some((f: any) => f.name === "mod_quiz_get_user_quiz_attempts")
        ? "mod_quiz_get_user_quiz_attempts" : "mod_quiz_get_user_attempts";
      const attempts = checked(await callMoodle(s, fn, { quizid, userid: info.userid, status: "all", includepreviews: false }));
      const attempt = attempts.attempts?.find((a: any) => a.id === params.attemptid);
      if (!attempt) throw new Error("This attempt does not belong to the selected quiz and user.");
      const name = await title(s, quizid);
      if (name !== confirm_name) throw new Error(`confirm_name must match the quiz name: ${name}`);
      if (attempt.state === "finished") return { quiz: name, state: "finished", finished: true, note: "Already submitted." };
      checked(await callMoodle(s, "mod_quiz_get_attempt_summary", { attemptid: params.attemptid, preflightdata: params.preflightdata }));
      const result = checked(await callMoodle(s, "mod_quiz_process_attempt", { ...params, finishattempt: true, timeup: false }));
      return { quiz: name, ...result, finished: result.state === "finished" };
    });
}
