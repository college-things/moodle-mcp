# Changelog

All notable changes to moodle-mcp are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Security

- **Passwords and tokens no longer follow redirects in local mode.** A Moodle site that answered sign-in or an API call with a 307 or 308 redirect made the server post the username, password or token again to the redirect target. That could be another host or a plain `http` address. These requests now refuse redirects and tell the user to enter the site's final address, as hosted mode already did.
- **Reading crafted files can no longer hang the server.** Text extraction from HTML and Office files took quadratic time on markup that never closes, such as a file full of unclosed `<script` tags or long runs of tabs. A single course file or forum attachment could freeze the server, and on a hosted server that affected every user. Extraction now runs in linear time.
- **Archives of Office "zip bombs" are capped as a whole.** A `.zip` holding many small `.docx`, `.pptx` or `.xlsx` files could unpack each one up to the 200 MB limit, gigabytes in total. One 200 MB budget now covers everything inside a file being read.
- **Assignment uploads refuse more secret locations.** Uploads are now refused from `Library`, `AppData` and `Keychains` folders, where macOS and Windows keep keychains, browser cookies and saved passwords. They are also refused for more credential file names: `.keychain-db`, `.ppk`, `.gpg`, `.asc`, `.jks`, `.keystore`, browser `Cookies`, `Login Data` and `Web Data`, `credentials.json`, `token.json`, and this server's own `sites.json` and `oauth.enc`. This limits what a prompt injection in course text could talk an assistant into handing in.
- **Hosted mode blocks two more address ranges:** `64:ff9b:1::/48` (local-use NAT64) and `192.88.99.0/24` (6to4 relay).
- **Downloads use a private temporary folder.** The shared `moodle-mcp` folder in the system temp directory is used only when the current user owns it and other users cannot write to it. On a shared Linux machine another account could otherwise create that folder first and redirect where downloads are written.
- **The Docker image and CI actions are pinned.** The `node:22-slim` base image is pinned by digest, and `actions/checkout` and `actions/setup-node` are pinned by commit.

### Changed

- On Windows the system temp folder sits under `AppData`. A file saved by `moodle_download_file` must therefore be copied to a normal folder before it can be uploaded to an assignment.

## 1.2.0 - 2026-11-02

### Added

- Quiz completion: tools to start, read, save and submit quiz attempts, with name confirmation before an attempt is started or finished.
- Real browser control: a dedicated Chromium profile the user signs in to directly, including SSO and captcha sites, with tools to navigate, act on pages, take screenshots and save the session for the read tools.
- `moodle-mcp config <codex|antigravity>` prints a ready-made client configuration.

## 1.1.1 - 2026-11-02

### Fixed

- `moodle_grades_overview` crashed the whole server when a site refused the API call.
- Courses with nothing to list reported a layout error, because Moodle still prints the table with a one-cell spacer row.

## 1.1.0 - 2026-11-02

### Added

- `moodle_read_file` reads `.doc`, `.ppt` and `.zip` files.
- Browser-session mode lists course contents and quizzes.
- Dockerfile for the hosted HTTP server.

### Fixed

- Quiz lists on real Moodle sites use relative links, which the parser now reads.

## 1.0.0 - 2026-11-02

### Added

- First release: an MCP server for any Moodle site, with courses, contents, pages, grades, deadlines, assignments, forums, quizzes and file downloads.
- Sign-in through a local browser form, with browser-session mode for sites whose mobile service is off.
- Hosted HTTP mode with OAuth sign-in and encrypted per-user token storage.
- Homework upload and submission, reading text from PDF and Office files, and release packaging.
- Support for Windows.
