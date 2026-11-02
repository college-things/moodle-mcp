# moodle-mcp

MCP server that gives AI assistants read-only access to any Moodle site through the official Moodle mobile web service. No site-specific setup: give it the site's URL and sign in.

## Install

Requires Node.js 20 or newer.

```bash
npm install
npm run build
```

### Claude Code

This repository is also a Claude Code plugin. To try it for one session:

```bash
claude --plugin-dir /path/to/moodle-mcp
```

Or register the server directly:

```bash
claude mcp add moodle -- node /path/to/moodle-mcp/dist/index.js
```

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "moodle": {
      "command": "node",
      "args": ["/path/to/moodle-mcp/dist/index.js"]
    }
  }
}
```

## Sign in

Ask the assistant to log in to your site, or run:

```bash
node dist/index.js login https://your.moodle.site
```

Either way, a form opens on `127.0.0.1` in your browser, so your password never passes through the chat. The password goes only to your Moodle site and is not stored.

Sites with single sign-on or a captcha can't use a password here. The form explains how to paste a security key from the site's `/user/managetoken.php` page instead. This works only if the site shows you that page.

## Tools

| Tool | What it does |
| --- | --- |
| `moodle_check_site` | Checks whether a URL is a usable Moodle site, without logging in |
| `moodle_login`, `moodle_logout`, `moodle_list_sites`, `moodle_whoami` | Manage sign-ins; several sites can be signed in at once |
| `moodle_list_courses`, `moodle_course_contents` | Enrolled courses, their sections, activities and files |
| `moodle_course_pages` | Text of Page activities |
| `moodle_grades_overview`, `moodle_course_grades` | Final grades, grade items and teacher feedback |
| `moodle_deadlines` | Upcoming and overdue activities across all courses |
| `moodle_assignments`, `moodle_assignment_status` | Instructions, due dates, your submission, grade and feedback |
| `moodle_quizzes`, `moodle_quiz_attempt_review` | Quiz dates and limits, your attempts and scores, review of finished attempts |
| `moodle_download_file` | Saves a course file to a temporary folder (50 MB limit) |

## Limits

- **Read-only by design.** It can't start, answer or submit quizzes or assignments, and it never reads the questions of an attempt in progress.
- **It sees what your account sees.** Quiz review works only when the teacher allows it, and quizzes you can't currently access are listed by `moodle_course_contents` but not by `moodle_quizzes`.
- **The mobile web service must be enabled.** If an administrator turned it off, login reports this; there is no page-scraping fallback yet. `moodle_check_site` tells you up front.
- **Desktop only for now.** This is a local stdio server, so phone apps can't use it without a hosted version.

## Security

- The access token is stored unencrypted in `~/.config/moodle-mcp/sites.json`, readable only by your user account. Set `MOODLE_MCP_HOME` to use another folder. `moodle_logout` forgets the token on this computer but doesn't revoke it on the site.
- Tokens are only sent to the site that issued them.
- Site URLs must use HTTPS, except on `localhost`.
- Text from Moodle is written by other people, so a malicious course page could try to instruct the assistant. The server tells assistants to treat it as data. Check the address shown on the login form before typing your password.

## Development

```bash
npm test
```

Tests run the built server over stdio against a mock Moodle server, so they need no account.
