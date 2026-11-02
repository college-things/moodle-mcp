# moodle-mcp

MCP server that connects AI assistants to any Moodle site through the official Moodle mobile web service, with a more limited browser-session mode for sites where that service is unavailable. No site-specific setup: give it the site's URL and sign in.

Ask things like "what's due this week?", "summarize the lecture PDF in my history course", "how am I doing in maths?" or "upload `essay.docx` to the Essay assignment".

## Install

Requires Node.js 22 or newer.

### Claude Desktop

Download `moodle-mcp-1.1.1.mcpb` from the [latest release](https://github.com/college-things/moodle-mcp/releases/latest) and open it.

### Claude Code

```bash
npm install -g https://github.com/college-things/moodle-mcp/releases/download/v1.1.1/moodle-mcp-1.1.1.tgz
```

```bash
claude mcp add moodle -- moodle-mcp
```

The repository is also a Claude Code plugin. After cloning it and running `npm install`, try it with `claude --plugin-dir /path/to/moodle-mcp`.

### Other MCP clients

After the global install above:

```json
{
  "mcpServers": {
    "moodle": { "command": "moodle-mcp" }
  }
}
```

## Sign in

Ask the assistant to log in to your site, or run:

```bash
moodle-mcp login https://your.moodle.site
```

Either way, a form opens on `127.0.0.1` in your browser, so your password never passes through the chat. The password goes only to your Moodle site and is not stored.

Sites with single sign-on or a captcha can't use a password here. The form explains how to paste a security key from the site's `/user/managetoken.php` page instead. This works only if the site shows you that page.

### Sites with the mobile service off

If the site reports web services or the mobile service as disabled, or refuses them to your account after you sign in, the form switches to browser-session mode and has no password field. You sign in on the site as usual, copy the value of the `MoodleSession` cookie from your browser's developer tools, and paste it into the form on `127.0.0.1`. `moodle_check_site` shows which mode a site needs (`sign_in`).

The session ends when you log out on the site or it times out, and then you repeat these steps.

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
| `moodle_forums`, `moodle_forum_discussions`, `moodle_forum_posts` | Announcements and course discussions |
| `moodle_read_file` | Text of PDF, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xlsx`, `.zip`, HTML and plain text course files, for analysis |
| `moodle_download_file` | Saves a course file to a temporary folder (50 MB limit) |
| `moodle_save_assignment_submission` | Uploads your files or text to an assignment, usually as a draft |
| `moodle_submit_assignment` | Hands in a saved draft for grading, after you confirm the assignment's name |

## Limits

- **No quiz taking, on purpose.** It can't start, answer or submit quizzes, and it never reads the questions of an attempt in progress. Having an AI answer graded tests would be cheating, so this won't be added. It can show results and, where the teacher allows, review finished attempts.
- **Homework is your own work, and you stay in control.** The assistant should only upload files you name. Replacing files, handing in, and saving on assignments with no drafts each need an explicit confirmation. Moodle's submission statement is shown for you to accept yourself. Hidden folders and key files can't be uploaded.
- **Homework tools run only on the local server,** and need the mobile service. Browser-session mode and hosted mode can't change assignments.
- **Some files have no readable text.** Scanned PDFs and archives other than `.zip`, such as `.7z` and `.rar`, can only be downloaded.
- **It sees what your account sees.** Quiz review works only when the teacher allows it, and quizzes you can't currently access are listed by `moodle_course_contents` but not by `moodle_quizzes`.
- **Browser-session mode covers less.** In this mode, only these work: `moodle_list_courses`, `moodle_course_contents`, `moodle_quizzes`, `moodle_grades_overview`, `moodle_course_grades`, `moodle_deadlines`, `moodle_assignments`, `moodle_whoami`, `moodle_download_file` and `moodle_read_file`.
  - `moodle_course_contents` gives sections and activity names without file links, and needs Moodle 4.0 or newer. `moodle_quizzes` gives names, closing dates as the site words them and grades, without attempts.
  - `moodle_assignments` gives names, submission status, grade and the due date as the site words it (Moodle 5.0 and newer also give an exact `due`), without instructions, files or `assignid`.
  - Grades keep the site's own number format, and have no item id or graded date.
  - `moodle_course_pages`, `moodle_assignment_status` and `moodle_quiz_attempt_review` report that they are unavailable. Moodle does not expose them to AJAX on 4.5, and reading their pages would mean opening activities, which can mark them as viewed. The only quiz page this mode opens is the course-wide list, which links to quizzes without starting anything.
  - Report pages are ordinary page views, so they appear in the site's logs and update your last access to the course. They don't mark any activity as viewed.
- **Browser-session mode is tested on local installs, not yet on a school's site.** The tools above ran against real Moodle 3.11, 4.1, 4.5 and 5.0 installs in Docker with the mobile API off, including Ukrainian, the Classic theme and a custom session cookie name on 4.5. No quiz attempt was created and no activity was marked as viewed. Not checked yet:
  - custom themes from a school or vendor (an unknown layout gives an error, not an empty list)
  - Moodle 5.1 and newer
  - session IP tracking or a firewall in front of the site, because every test request came from the same machine as the sign-in
  - SSO sign-in, and sites that refuse to give out their mobile config at all, which have only run against a mock
- **Phone apps need a hosted server.** Phones can't launch a local stdio server, so they connect to `http` mode, described under [Hosting](#hosting-for-phone-apps).

## Hosting for phone apps

`moodle-mcp http` serves the same tools over Streamable HTTP, for clients that connect to a remote MCP server. Each person signs in with their own Moodle account and can reach only that account's data.

**Before you host this for other people, understand what you would be holding.** A Moodle mobile token is not limited to reading. This server only reads with it, but a stolen token allows whatever the Moodle mobile app can do for that student, including submitting work. Passwords also pass through your server's memory during sign-in. You would be responsible for students' credentials and education records, so check your school's policy and the privacy law that applies (FERPA and GDPR are the usual ones) first. Hosting it only for yourself avoids most of this.

### How it works

- **Sign-in.** The server is an OAuth 2.1 authorization server with PKCE and dynamic client registration, so clients discover it from the URL alone. During authorization the user enters their site's address, then a password or security key, on a page served by this server. Moodle's answer proves who they are.
- **Accounts.** An account is one Moodle user on one site, identified by a keyed hash of the two. Signing in again reaches the same account and replaces its token. To use a second site or account, disconnect and reconnect.
- **Isolation.** Each `/mcp` request builds a new server bound to the user its bearer token proves. There are no sessions to share, and no tool takes a user as input.
- **Storage.** Each user's Moodle token is in its own AES-256-GCM file, with a key derived per record and bound to that user's id, so a file copied to another user does not decrypt. OAuth state is encrypted the same way, and holds refresh tokens only as hashes. Access tokens stay in memory, so a restart sends clients to refresh.
- **Retention.** `moodle_logout` deletes the stored token and ends every grant for the account. An account with no live grant, which happens 30 days after its last refresh, has its token deleted by an hourly sweep. Neither revokes the token on the Moodle site, because the mobile web service has no call for that. It lasts until the site expires it, or until the user removes it from their Security keys page.
- **Outbound requests.** Site addresses come from users, so the server contacts only public addresses over HTTPS, checking DNS answers at connect time. It never follows redirects and caps response size.

### Limits of hosted mode

- Browser-session sign-in is not offered. Sites with the mobile service off are refused, because collecting students' session cookies on a shared server is too risky.
- One Moodle account per connection. A link that adds a site to an existing account would let an attacker send a victim a link and collect the victim's token in the attacker's account, so no such link exists.
- `moodle_download_file` returns the file in the response, up to 10 MB, and writes nothing to disk.
- It runs as a single process: sign-ins in progress and access tokens are in memory, and the rest is in local files. Running several instances behind a load balancer does not work.

### Deploy

A `Dockerfile` is included. It stores data in `/data`, so mount a persistent volume there, and pass the variables below. The steps here run the server directly.

1. Create a master key and keep it in your platform's secret store, not in the repository or in backups of the data folder:

   ```bash
   openssl rand -base64 32
   ```

2. Start the server, using a persistent private folder for `MOODLE_MCP_HOME`:

   ```bash
   MOODLE_MCP_MASTER_KEY=... MOODLE_MCP_PUBLIC_URL=https://moodle-mcp.example.org MOODLE_MCP_HOME=/var/lib/moodle-mcp MOODLE_MCP_TRUST_PROXY=1 node dist/index.js http
   ```

3. Put a reverse proxy in front of it to terminate TLS. The server has no TLS of its own and listens on `127.0.0.1:3000` by default. Don't log request bodies on the proxy: `POST /login` carries passwords.
4. Check `GET /healthz`, then add `https://moodle-mcp.example.org/mcp` as a remote connector in your client.

| Variable | Purpose |
| --- | --- |
| `MOODLE_MCP_MASTER_KEY` | Required. 32 random bytes in base64. The server refuses to start without it. |
| `MOODLE_MCP_PUBLIC_URL` | Required. Public origin with no path, using HTTPS. Requests with any other `Host` are refused. |
| `MOODLE_MCP_HOME` | Data folder, stored under `hosted/`. Defaults to `~/.config/moodle-mcp`. |
| `MOODLE_MCP_HOST`, `MOODLE_MCP_PORT` | Listen address. Defaults to `127.0.0.1` and `3000`. |
| `MOODLE_MCP_TRUST_PROXY` | Number of proxies in front of the server, so rate limits see real client addresses. Without it, all users share one limit; set too high, clients can spoof their address. |
| `MOODLE_MCP_ALLOWED_SITES` | Comma-separated Moodle hostnames. Recommended for a single school. |
| `MOODLE_MCP_ALLOWED_REDIRECT_HOSTS` | Comma-separated HTTPS hostnames of client apps allowed to register. Recommended: see phishing below. |
| `MOODLE_MCP_DISABLE_PASSWORD_LOGIN` | `1` accepts security keys only, so passwords never reach the server. Many sites hide the Security keys page from students, so check yours first. |
| `MOODLE_MCP_PREVIOUS_MASTER_KEY` | Old key during rotation. |
| `MOODLE_MCP_ALLOW_PRIVATE_SITES` | `1` turns off the private address check. For tests only. |

To rotate the master key, start once with the new key in `MOODLE_MCP_MASTER_KEY` and the old one in `MOODLE_MCP_PREVIOUS_MASTER_KEY`. Startup re-encrypts everything and logs when it's done, and then you can remove the old key. Losing the master key means every user has to sign in again.

### What this does not protect against

- **A compromised running server.** Encryption at rest protects a leaked disk or backup. Someone who controls the running process, or has both the data folder and the key, gets every token, and can capture passwords as they are typed.
- **The operator.** Users have to trust whoever runs the server. The sign-in page says so.
- **Consent phishing.** Anyone can register a client and send a victim an authorization link. If the victim signs in, that client gets read access to their Moodle data. The page names the requesting app and where it returns to, and warns about this, but client names are self-declared. `MOODLE_MCP_ALLOWED_REDIRECT_HOSTS` closes this by allowing only apps you name.
- **Prompt injection.** A malicious course page can still try to instruct the user's assistant. It can only ever reach that user's own data.

## What has been tested

| Where | Covered |
| --- | --- |
| `do.ipo.kpi.ua`, a real school site on Moodle 4.5.6 | Courses, grades, pages, assignments, quiz lists, file download, reading PDF, `.doc`, `.docx`, `.ppt` and `.zip`. Its forums had no discussions, it had no upcoming deadlines, and its teachers block quiz review. Nothing was uploaded |
| `iekportal.com.ua`, a real school site whose mobile API refuses the test account | Inside a signed-in browser, with the parser logic pasted into the page: the course list, deadlines and course contents calls, and the grade, assignment and quiz pages across 9 courses. This found a false error on courses with no assignments, since fixed. One course's grade page answers "invalid user", which the site reports for that account |
| Moodle 3.11, 4.1, 4.5 and 5.0 in Docker, mobile service on | Deadlines, quiz attempts and review, forums, and the full homework flow: draft, replace, online text, hand in, no-draft assignments, submission statements, locks |
| The same four versions, mobile service off | Browser-session mode, and that it creates no quiz attempt. Course contents need 4.0 or newer |
| Moodle 4.5 in Docker, hosted mode | Full OAuth sign-in with a real MCP client over HTTP, reading tools, no write tools, nothing readable on disk. The container image builds and starts |
| Mock servers, in `npm test`, on Linux, macOS and Windows | All tools, sign-in forms and hosted mode |

Not tested:

- Homework upload on a real school's site, because a test would hand in real work.
- A full browser-session sign-in on `iekportal.com.ua`, which needs a user to paste their own cookie. The parts it relies on were checked inside a signed-in browser instead.
- Hosted mode on a public deployment, or from a real phone app.
- Opening the `.mcpb` bundle in Claude Desktop. Its server was unpacked and run directly.

## Security

These notes describe the local stdio server. Hosted mode is covered above.

- The access token is stored unencrypted in `~/.config/moodle-mcp/sites.json`, readable only by your user account. On Windows this relies on the permissions of your profile folder, because the file mode has no effect there. Set `MOODLE_MCP_HOME` to use another folder. `moodle_logout` forgets the token on this computer but doesn't revoke it on the site.
- In browser-session mode the same file holds the session cookie, unencrypted. **Treat it like a password: until the session ends it allows anything your account can do on the site, not only reading.** This server only reads with it, but anyone who gets the file could do more. Log out on the site to end the session; `moodle_logout` only forgets the cookie on this computer.
- Tokens and session cookies are only sent to the site that issued them, and requests carrying a session cookie never follow redirects.
- Site URLs must use HTTPS, except on `localhost`.
- The homework tools read local files, so a malicious course page could try to talk the assistant into uploading something private. Check the file names your client shows before approving these tools, and don't set them to run without asking.
- Text from Moodle is written by other people, so a malicious course page could try to instruct the assistant. The server tells assistants to treat it as data. Check the address shown on the login form before typing your password.

## Development

```bash
npm install
npm test
```

`scripts/pack-release.sh` builds the release files. Tests run the built server over stdio and HTTP against mock Moodle servers, so they need no account.
