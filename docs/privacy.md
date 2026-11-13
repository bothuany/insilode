# Privacy

Last updated 23 October 2026.

Insilode is a code editor that runs on your computer, and its website, insilode.dev, is a static site. Neither one has accounts, advertising or analytics, and the maintainers do not receive any usage data from either. This page says what each part does with the network and with your files.

## The Insilode app

- **No telemetry.** Insilode ships without the keys VS Code uses to report usage and crashes, so it sends no usage data, no crash reports and no experiment requests. You can check: `product.json` in the app folder has no `aiConfig` or `crashReporter` entry.
- **Your code stays on your machine.** The call-flow index, boards and harness scan are built locally. The MCP server and its bridge listen on `127.0.0.1` only and need a random token (see [SECURITY.md](../SECURITY.md)). Insilode keeps its data in `~/.insilode` (settings, caches, the bridge files, backups made by Import from VS Code).
- **Agents across windows.** So the Agents page can list your other Insilode windows, each window writes two small files, `rows.json` and `project.json`, to the extension's global storage folder on your computer: session names and states, the activity line, todos, the first 120 characters of the prompt, token and cost totals, the PR number and title, and the project folder. Nothing is sent anywhere, and no transcript path, token or port is written.
- **Import from VS Code** reads your VS Code or Cursor user folder on your computer and writes into Insilode's. Nothing is uploaded. Before it changes a file it copies it to `User/import-backups/`.
- **Connections the app makes:**
  - **Updates:** it asks `github.com/bothuany/insilode/releases` for the latest release. GitHub sees the request as it sees any download. Set `update.mode` to `none` to stop it.
  - **Extensions:** the extensions view and installs talk to [Open VSX](https://open-vsx.org/), under its own privacy terms.
  - **Agents:** Claude Code, Codex and any CLI you run are separate programs. What they send to their providers is governed by their own terms and settings, not by Insilode.
  - **Your extensions and your code** can make their own connections, as in any editor.

## The website

- **No cookies and no trackers.** insilode.dev sets no cookies, loads no analytics, advertising or social scripts, and uses no third-party fonts or images.
- **GitHub's API.** The home page asks `api.github.com` for the star count and the latest release, so its download buttons point at the right files. Your browser keeps the answer in `localStorage` for 30 minutes so it asks less often. That is the only thing the site stores, and it is only on your device.
- **Hosting.** The site is served by GitHub Pages, and DNS for insilode.dev is provided by Cloudflare. Like any host, they handle your IP address and request details to deliver pages, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and [Cloudflare's](https://www.cloudflare.com/privacypolicy/). The maintainers do not get these logs.
- **The live demo** at `/try/` runs entirely in your browser on a bundled sample project. It sends nothing back.

## Contact and changes

The maintainer is Recep Batuhan Dikmen. For a privacy question, open an issue on [GitHub](https://github.com/bothuany/insilode/issues); for something sensitive, use the private route in [SECURITY.md](../SECURITY.md). If these practices change, this page changes with them, and its history is in the repository.
