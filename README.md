<p align="center">
  <img src="editor/branding/icon.png" width="112" alt="Insilode icon">
</p>

<h1 align="center">Insilode™</h1>

<p align="center">
  Every code editor shows your files. <b>Insilode</b> shows how your code runs.<br>
  Built on VS Code. Your extensions, themes and keybindings work.
</p>

<p align="center">
  <a href="https://github.com/bothuany/insilode/releases/latest"><img src="https://img.shields.io/badge/download-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-6f86ff" alt="Download for Windows, macOS and Linux"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-6f86ff" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20CLI-6f86ff" alt="Agents: Claude Code, Codex and any CLI">
</p>

[![The Insilode editor: the file explorer, a Java file, the flow of POST /orders on the canvas, Claude Code in the terminal and the Agents dock](docs/media/insilode-editor.webp)](https://insilode.dev/try/)

<p align="center"><b><a href="https://insilode.dev/try/">Try it in your browser</a></b>: follow a request across services, review what an agent changed, and answer an agent waiting for you. Nothing to install.</p>

https://github.com/user-attachments/assets/0e8d49db-7eec-40ef-9815-a625069425ae

## Install

Download the file for your system from the [latest release](https://github.com/bothuany/insilode/releases/latest); `SHA256SUMS.txt` sits beside them. Each one ships with everything it needs, and Insilode installs beside a stock VS Code, not over it.

- **Windows:** `Insilode-Setup-<version>-x64.exe`. It installs for the current user, without admin rights.
- **macOS:** `Insilode-<version>-darwin-arm64.dmg` (Apple silicon) or `Insilode-<version>-darwin-x64.dmg` (Intel); the `.zip` files hold the same app.
- **Linux (x64):** `insilode_<version>_amd64.deb` (Debian 12, Ubuntu 22.04 or newer), `insilode-<version>-1.x86_64.rpm`, or `Insilode-<version>-linux-x64.tar.gz`.

To install from a terminal instead, which also skips the prompt a browser download triggers, and check the download against `SHA256SUMS.txt`:

```powershell
irm https://insilode.dev/install.ps1 | iex            # Windows, in PowerShell
```

```bash
curl -fsSL https://insilode.dev/install.sh | sh       # macOS
```

The builds are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper warn about a file a browser downloaded; [docs/building.md](docs/building.md#install) says what to click. winget, Homebrew and an APT repository are prepared but not published. C# flows need the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0); every other language needs nothing.

## Coming from VS Code

Insilode is a fork of VS Code (Code - OSS, the open-source core of VS Code), so the editor you know is all there: Git, the terminal, the debugger, language servers, IntelliSense, search, tasks, multi-root workspaces, profiles. Insilode adds to it.

- **Extensions** install from [Open VSX](https://open-vsx.org/), the open registry VS Code forks use. A few of Microsoft's own extensions (Pylance, C# Dev Kit, the Remote - SSH / WSL / Dev Containers family, GitHub Copilot) are licensed for Microsoft's builds only and are not there; open alternatives are.
- **Themes, keybindings and settings** work the same: the same commands, shortcuts and `settings.json`.
- **Import from VS Code:** on first launch, or with **Insilode: Import from VS Code…**, import your settings, keybindings, snippets and theme from VS Code or Cursor; extensions available on Open VSX are installed, the rest are listed. Your Insilode settings are backed up first. [How it works →](docs/import-from-vscode.md)

## See how your code runs

Pick an endpoint and watch the chain it runs, card by card: controller → handler → services → database. The index is read from your source with tree-sitter, with no build step (C# uses a Roslyn analyzer instead). Database cards show the table the query touches, and for EF Core, JPA / Spring Data, Django ORM, SQLAlchemy, Prisma and TypeORM a schema card lists its columns. The flow follows calls across services too: an HTTP call continues into the route it reaches, a message continues into the listener of its topic or queue (Kafka, RabbitMQ, JMS, SQS, Celery, NestJS). Links found by matching names or paths are drawn dashed as guesses (`HTTP?`, `topic?`), so you always know what is certain.

The canvas is the map; the code is read in the **reading pane** beside it. The pane opens on the entry method, and a call opens its callee in a peek right under the line that makes it (two deep; deeper, the callee takes the top and the methods above it stay as folded one-line headers). Click into the pane and step like a debugger that runs nothing: `j` over, `l` into, `h` out (Alt+F10, Alt+F11 and Alt+Shift+F11 do the same), `Enter` opens or closes a peek, `[` and `]` go back and forward, `Escape` closes a peek. The canvas follows along as a trace: the path to the cursor solid, the cards you have read plain, the rest faded.

To have code explained, ask your agent to walk you through it, or run **Explain Selection with a Tour**: a tour moves from card to card, dims the rest and marks the lines it names, with a caption saying why. Press `?` on a card to point at it and ask the agent about it, and **Edit Selection with Agent…** hands a selection to one.

## Review what an agent changed, on the flow

Ask the agent to "show what you did in flow", or run **Show Git Changes in Flow**. One canvas holds the whole change set: every endpoint the changed code reaches, cut down to the changed methods, added lines in green and removed lines in red. Compare against your uncommitted work, the whole branch since `main`, the last commit, a branch or commit you name, or the point where the agent's session started. Test files and whitespace-only changes are left out, and so are comment-only changes in Java, Kotlin, C#, Go and Python (JavaScript and TypeScript need a parser to tell a comment from JSX text or a regex, so for now only their whitespace changes go); the root card says how many files were hidden.

A **Changes** rail lists the changed methods by file with their `+` and `−` counts; `j` and `k` step through them, `v` marks one viewed, and `f` finds a card by name. The reading pane reads a change in place, so peeks and stepping work in review too, with **Keep** and **Undo** on each changed method and **Keep this path** for the methods you have open there; it never keeps a method you have not opened. When a change touches an entity or a migration, the root card names the table and the endpoints that read or write it. After each prompt, the Agents dock lists the flows that turn touched.

## Run agents side by side, and know when they need you

Claude Code, Codex and any CLI you add run as their real tools, in terminals. The Agents dock shows each one at a glance and ranks what needs you first: an approval with its text, a question, an error, a finished turn you have not read. Each row carries the model and how full its context window really is, tokens and estimated cost, and the PR and CI state of its branch. The status bar shows what is left of your 5-hour and weekly limits. Questions from Home or the canvas go to the agent you pick, and Insilode remembers the choice.

- **Worktrees:** start an agent in its own git worktree, merge it back with one click, and get warned when two agents edit the same file, method or flow.
- **The Agents page** is a terminal workspace: drag sessions into splits, switch between Board and List views, search past sessions, and see a strip of every session that needs you. Alt+Shift+N (Ctrl+Option+N on a Mac) jumps to the next one. It also lists the sessions of your other Insilode windows, grouped by project, and shows, read-only, the sessions that other programs on this computer run.
- **Agents on their own:** the page opens in a window of its own. `insilode --agents-only` (or the **Insilode Agents** shortcut the Windows installer adds) starts with only that window; closing the editor window then hides it instead of ending the agents. [Details →](docs/agent-tools.md#the-agents-page)
- **Skeleton first** is opt-in: before an agent writes a plan's classes, it draws the design as a board and waits for your skeleton. [How it works →](docs/design/skeleton-first.md)
- **Outside the editor,** an optional app badge counts the agents waiting for you, and an optional status island at the top of the screen shows every agent's state with an avatar per agent. It never takes focus. On a Mac with a camera housing (the notch) it is on by default and sits on both sides of it; elsewhere turn it on with `flow.agents.desktop.overlay.enabled`.

## Boards and diagrams

An agent can draw a board when words are not enough: a flow, plan, class, ER, sequence, architecture (C4) or state diagram, or a free-drawing canvas. `board_from_code` makes a sequence or ER board from the index instead of from the agent's memory, and **Show DTO Diagram** and **Show Architecture Diagram** draw from the type graph. **Pin Flow as Board** keeps a flow, and **Copy Diagram as Mermaid** and **Export Board as Markdown…** take a diagram out of the editor. [Board format →](docs/boards.md)

## Keep your harness healthy

One Harness page for what shapes your agents: `CLAUDE.md` and `AGENTS.md`, rules, skills, subagents, hooks, MCP servers, permissions and the agents' own memory, with a health score and what each piece costs in tokens before you type. Its views are the Map, Permission requests and the Friction inbox.

- **Lint without an LLM:** rules whose paths match nothing, broken frontmatter, duplicated instructions across tools, hooks that never fire. The same lint runs in CI with `npm run harness:lint -- [--cwd <dir>] [--json] [--max-warnings <n>]` ([docs/harness-lint.md](docs/harness-lint.md)).
- **Why?:** the instructions, rules and permissions that apply to a file, and a simulator that tells you whether `Bash(git push --force)` would be allowed, asked or denied, and by which rule.
- **Hooks studio:** **Add Hook…** and **Run Hook with Sample Input**, to see what a hook does before an agent hits it.
- **Friction inbox:** permissions you keep granting, corrections you keep repeating and tool calls that keep failing become proposed rules, instructions and hooks, applied only when you say so.
- **MCP servers:** see, check, add, edit and remove the servers of Claude Code and Codex, with secrets kept out of view.

## Your agent can use the editor

Insilode ships an MCP server, `insilode`, that agents started from the dock get automatically (a `claude` you start yourself connects with **Insilode: Connect Claude Code Tools (MCP)**). Its 19 tools let an agent open files and diffs, find symbols, definitions and references, search endpoints, show a flow or read it as text, ask who is affected by a change to a method or a table, draw boards, run tours and search your past sessions. No tool writes a file. [All the tools →](docs/agent-tools.md)

## Works with your stack

C# / .NET · Java · Python · JavaScript / TypeScript · Go · PHP · Ruby · Rust, from ASP.NET and Spring to FastAPI, NestJS, Rails and axum. [Full support table →](docs/languages.md)

## Updates

A running Insilode checks the latest GitHub release and shows **Update available** (on the gear and under Help, Check for Updates). On Windows it downloads and installs the update and offers **Restart to Update**; on macOS and Linux the notification's button opens the release page. Set `update.mode` to `manual` or `none` to turn the automatic check down or off. [How it works →](packaging/README.md#updates)

## Build from source

You need Node 24.18 or newer (not 25) and git; the .NET 10 SDK is optional, for C# flows.

```bash
git clone https://github.com/bothuany/insilode.git
cd insilode
npm run setup    # the first run takes 10 to 20 minutes
npm start        # or: npm run web, to use the editor in a browser
```

[docs/building.md](docs/building.md) has the platform requirements and how to build the installers.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately ([SECURITY.md](SECURITY.md)).

Open source under the [GNU AGPL v3](LICENSE) (versions before 0.5.0: MIT); contributors sign a short [CLA](CLA.md). Insilode™ and its logo are trademarks of Recep Batuhan Dikmen; see the [trademark policy](TRADEMARKS.md). Insilode is built on [VS Code](https://github.com/microsoft/vscode) (Code - OSS) and is not affiliated with Microsoft; the Claude and Codex marks belong to their owners.
