# Assessment of the GitHub Copilot review of Axle

Checked on 2026-10-17 against `main` at 981e27d (release 0.2.0 plus the dock, worktree and harness work after it), the v0.2.0 release on GitHub, and current competitor documentation.

**Verdict.** The review's thesis is right and its scores are about right. It is out of date or wrong on setup (it mixes the contributor build with user installs), on worktrees and conflicts (they shipped), and partly on certain/guess labelling (HTTP links are marked). It misses three things that matter more. First, the canvas does not mark name-only guesses, and it silently drops calls that nothing resolved. Second, the 0.2.0 release is incomplete: it has no Intel macOS build and no `SHA256SUMS.txt`. Third, VS Code itself now runs Claude and Codex in background worktree sessions, which shrinks the dock's lead and strengthens the case for shipping Axle as extensions.

## 1. Claim by claim

| Review claim | Status | Evidence |
|---|---|---|
| Position Axle as the place that shows how code runs, what agents did, and harness health | **Right** | The README already says this ("Every editor shows where code is stored. Axle shows how it runs"). The work since 0.2.0 (Why?, friction inbox, needs-you, flows touched) follows that line. |
| Strengths: real CLIs, dock, needs-you, worktrees, plan boards, flows touched, Axle MCP | **Right, and more has shipped since** | `docs/agent-tools.md`. After 0.2.0: worktree per agent and cross-session conflict warnings (26f7b0a, d8d8614); needs-you chips, ranking, notifications, cost and PR per row (2e50148); change sets in flow (e686688); agent picker for questions (c70c2e8); harness Why?, friction inbox, lint, permission simulator, agents' memory (d709569, 5c0352e, 812960b, b0bbb78). |
| Architectural discipline (dependency-cruiser, semgrep, arch tests, wire types) | **Right** | `npm run arch`, `.semgrep/rules`, `test/arch/*.test.mjs`, `protocol/flow.ts`. CI pins actions to SHAs (57c0532). |
| W1: fork maintenance cost | **Partly right** | `editor/patches/flow-core.patch` is 847 lines, and about 520 of those are `flow.css` plus branding and icons. The functional changes are small: product.json identity and Open VSX gallery; agentHost Claude/Codex defaults off; the default chat session type; a language-model fallback; two watermark entries; the web-mode webview endpoint and service-worker degradation; skipping the Copilot build. The code-rebase cost is low. The real cost is operational: every VS Code bump means a 15–40 min, ~20 GB production build per OS, signing and notarization, and an update channel Axle does not have yet. |
| W2: 10–20 min setup, 15–40 min build, Node 24, .NET 10, native tools | **Outdated for users, right for contributors** | Users install a bundled file from Releases, with no Node, git or build tools needed (`docs/building.md` §Install). Only `npm run setup` (10–20 min) and `npm run installer`/`package` (15–40 min) cost that. One user-side requirement remains valid: **C# flows need the .NET 10 SDK**, which is a real barrier for the flagship language. |
| W3: v0.2.0, unsigned Windows, un-notarized macOS, untested macOS/Linux, no package manager | **Right, and worse than stated** | Everything listed is confirmed in `docs/building.md`. The review also missed that **the v0.2.0 release has no `darwin-x64` build and no `SHA256SUMS.txt`**. The Intel job failed on a network timeout fetching node headers (run 39024826022), so the Checksums job was skipped. The docs promise both. winget, brew and APT are prepared in `packaging/` but not submitted. The repo has 0 stars, 0 forks and 0 issues, and the v0.2.0 assets show 1 download in total (the Windows installer), so it has no visible users yet. |
| W4: call-flow accuracy is critical; separate certain, guessed and not found | **Right, and only partly addressed** | Done: HTTP links are dashed `HTTP?` edges (`ui/src/layout.ts:212`); interfaces with several implementations become `ambiguous` cards; the LSP verifies name-only guesses (`lspResolve.ts`). **Gaps:** (a) `FlowEdge.guess` is set for name-only links (`graph.ts:566`), but the canvas never reads it. Only `flow_text` prints `~guess`. (b) A call that neither the index nor the LSP resolves is removed: `pending` is deleted (`lspResolve.ts:28,76`), and nothing shows that a call was there. (c) Message, queue and event-bus links, and HTTP links for Go, PHP, Ruby and Rust, are **on unmerged branches** (`claude/message-links-bb5db8`, `claude/http-more-langs-cc14f9`), not on main. (d) DI and reflection are handled for C# (Roslyn, MediatR) and Spring, but not measured anywhere. |
| W4: some languages lack DB schema cards | **Right** | `docs/languages.md`: Go, PHP, Ruby and Rust have none; Prisma and TypeORM are untested; Java JDBC is in progress. |
| W5: agent UX behind Cursor/Windsurf (streaming, retrieval, edit apply, model choice, background/cloud, recovery, review) | **Right, but it is the wrong race** | Axle runs the vendors' own CLIs, so model choice, retrieval and edit application belong to Claude Code and Codex. The fair gaps are cloud and background agents (none), and review UX (the diff plus "Changes in flow" is a good start, but there are no review comments and no PR review flow). |

### Competitors (checked October 2026)

- **VS Code + Copilot**: this is the biggest change since the review. Since 1.109 it runs Claude (via the Claude Agent SDK) and Codex alongside Copilot, as local, background (Git worktree) or cloud sessions in an Agent Sessions view ([blog](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development), [harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [third-party agents](https://code.visualstudio.com/docs/copilot/agents/third-party-agents), [cloud agents](https://code.visualstudio.com/docs/agents/agent-types/cloud-agents)). Axle's patch turns exactly that agentHost off. VS Code is now the upstream competitor for the dock, not only for the ecosystem.
- **Cursor**: worktrees in the Agents Window, parallel agents each in its own worktree, and cloud background agents that open a PR ([forum](https://forum.cursor.com/t/worktrees-in-agents-window/158956/3); the version and date details come from third-party posts such as [DataCamp on Cursor 3](https://www.datacamp.com/zh/blog/cursor-3)).
- **Windsurf**: Wave 13 added worktrees, multi-pane Cascade sessions and Cascade Hooks ([Wave 13](https://devin.ai/blog/windsurf-wave-13), [Neowin](https://www.neowin.net/news/windsurf-wave-13-introduces-the-new-swe-15-model-and-git-worktrees/)). The review is right that this is closest to Axle's agent idea.
- **Zed**: runs Claude Agent, Codex, Gemini CLI and Copilot over ACP from an agent registry ([docs](https://zed.dev/docs/ai/external-agents), [Codex in Zed](https://zed.dev/blog/codex-is-live-in-zed)). This is the same "real CLI" approach as Axle, in a fast native editor.
- **Cline**: a VS Code extension with worktree windows and a CLI ([docs](https://docs.cline.bot/features/worktrees)). It shows that the no-fork path works.

**Conclusion.** Worktrees, parallel sessions, hooks and "real CLIs inside the editor" are now standard everywhere. None of these tools draws the call flow of an endpoint, maps the flows an agent's edit touched, or audits the agent harness (lint, permission simulator, friction inbox). That is Axle's moat; the dock is not.

## 2. Scores

| Category | Review | Mine | Why I differ |
|---|---|---|---|
| Idea / differentiation | 9.0 | 8.5 | The flow and harness ideas are unique, but the agent-dock part of the idea is now shared with VS Code, Cursor and Windsurf. |
| Architecture | 8.5 | 8.5 | Agree: enforced boundaries, one wire contract, small functional patch. |
| Agent integration | 7.5 | 7.5 | Agree. Rich observe-only hooks for Claude Code, but Codex needs a manual `/hooks` trust and custom CLIs get no status. |
| Code understanding | 8.0 | 6.5 | The accuracy is unmeasured, guesses are invisible on the canvas, unresolved calls vanish, and queue links are not on main. |
| General IDE | 6.5 | 6.5 | Agree. The base is full VS Code, but on Open VSX, so no Pylance, C# Dev Kit or Remote extensions, which are licensed to Microsoft builds only ([Cursor forum](https://forum.cursor.com/t/the-c-dev-kit-extension/76226), [HN quote](https://hn.svelte.dev/item/42438918)). This hurts C# users in particular. |
| Performance / setup | 5.5 | 6.5 | Users get bundled installers that need no toolchain, and the tree-sitter index opens instantly. Deductions: the SmartScreen and Gatekeeper prompts, and the .NET SDK for C#. |
| Security / governance | 7.5 | 7.5 | Agree. Webview CSP, command allowlists, loopback MCP with a token, read-only MCP tools, hooks that never answer permissions, Semgrep in CI. Unsigned binaries keep it from going higher. |
| Ecosystem / maturity | 4.5 | 3.5 | No users yet (0 stars and issues), no package manager, an incomplete 0.2.0 release, macOS and Linux never run on real machines. |
| Production readiness | 5.5 | 4.5 | No auto-update, no signing, missing release assets, no crash or telemetry channel. |
| Future potential | 9.0 | 8.5 | High if the flow is shown to be accurate and Axle reaches users of the editors they already have. |
| **Overall** | 7.4 | **6.8** | Same story, with the gaps measured more strictly. |

## 3. The strategy suggestions

- **"Don't try to be the best AI editor; win at observability and call-flow intelligence"**: agree, strongly. The competitor check above makes this more urgent than the review says.
- **"Interoperate with Cursor/VS Code/Cline/Codex/Claude Code"**: partly done already. The `axle` MCP server works with any `claude` (Connect command), and the dock runs Codex and custom CLIs. The next step is publishing the MCP server for use outside Axle (item 6).
- **"Offer an extension or companion so the fork is not mandatory"**: **agree, and it is cheaper than the review implies.**

**What depends on the core patch:**

| Patch piece | Needed by | Without the fork |
|---|---|---|
| product.json identity, Open VSX gallery, icons, `flow.css` look | branding only | Not needed; ship `flow-theme` as an optional theme |
| agentHost Claude/Codex defaults off; default chat session = `flow-claude` | stopping VS Code's own agents from competing with the dock | Coexist instead: the dock is terminal-based and does not need the chat panel |
| Language-model fallback in `extHostLanguageModels.ts` | the ACP chat panel (`flow.agents.showChat`, **off by default**) | Drop or gate the ACP chat in the extension build |
| Watermark entries "Show Flow at Cursor" / "Trace an Endpoint" | discoverability | Use a welcome view or a walkthrough contribution |
| Web-mode webview endpoint + service-worker degradation | `npm run web` only (offline webviews) | Not needed in desktop VS Code or Cursor |
| Copilot build skips | Axle's own build | Not needed |

**Extension readiness.** `flow-view` and `flow-harness` declare no `enabledApiProposals`. `flow-agent` declares chat proposals, but they are only used by `sessionType.ts` and `models.ts`, the ACP chat path that is off by default. `registerPlaceholderModels()` runs unconditionally, so that call needs a guard. No extension imports another (an enforced rule), and all declare `engines.vscode ^1.100.0`. The polyglot index uses `@vscode/tree-sitter-wasm` (wasm, not a native module), so one VSIX works on every host and every OS. **So the flow canvas, the harness map and the terminal Agents dock can ship today as an Open VSX and Marketplace extension pack for VS Code, Cursor and Windsurf.**

**Cost and benefit.**
- *Benefit*: users keep their editor, their Microsoft-only extensions (C# Dev Kit, Pylance) and their auto-update. There is no signing or notarization for the extension channel, and no 40-minute builds to reach users.
- *Cost*: CI to package, test and publish VSIXs (M). Testing on Cursor and Windsurf, whose API levels lag VS Code (M). The look and the "editor that opens on a flow" first impression are lost. Two channels to support. Possible conflicts with each host's own agent panel. A specific clash: `src/ide.ts` is a Claude Code `/ide` bridge (a lock file in `~/.claude/ide`), and Anthropic's own Claude Code extension writes one too. In stock VS Code or Cursor both would answer `claude`, so the extension build must detect the official extension and step aside (or leave the bridge off by default).
- *Recommendation*: make the extension pack the **main way in** and keep the fork as the "full Axle" showcase. The fork's extra value (theme, layout, defaults) is small next to the cost of distributing it.

## 4. Top 10 actions

| # | Action | Evidence | Size | Kind |
|---|---|---|---|---|
| 1 | **Fix the 0.2.0 release**: rerun the Intel macOS job; make Checksums run on `always()` over what built (or add a retry for the node-headers fetch); attach `SHA256SUMS.txt`. | Run 39024826022: `ConnectTimeoutError` fetching node headers, Checksums skipped; v0.2.0 assets list | S | distribution |
| 2 | **Show certain, guess and not found on the canvas**: style `guess` edges (e.g. dotted with a "by name" label); keep LSP-unresolved calls as grey "unresolved: name()" stubs instead of deleting `pending`; add a per-flow summary ("14 certain · 3 guessed · 2 unresolved"); carry the same labels in `flow_text` and `impact`. | `graph.ts:566` sets `guess`; `ui/src` never reads it; `lspResolve.ts:28,76` drops `pending` | M | product |
| 3 | **Call-flow accuracy benchmark** (plan below) in CI, with numbers published in `docs/languages.md`. | Golden files are snapshots of the index, not ground truth; no Spring fixture; no C# analyzer tests | L | engineering |
| 4 | **Extension pack for VS Code, Cursor and Windsurf** on Open VSX and the Marketplace: flow-view, flow-harness, flow-agent (ACP chat gated off), flow-theme optional. | §3; no proposals in flow-view and flow-harness | M | distribution |
| 5 | **Sign and notarize**: Windows Authenticode (or Azure Trusted Signing), Apple Developer ID + notarization; then submit winget and the brew tap from `packaging/`. | `docs/building.md` SmartScreen/Gatekeeper notes; `packaging/` not submitted | M | distribution |
| 6 | **Publish the `axle` MCP server standalone** (`npx`), headless flow and impact over the index without the editor, so Claude Code, Codex, Cursor and Cline users get `flow_text` and `impact` anywhere. Today `src/mcp/stdio.ts` only forwards calls over the loopback bridge to an open Axle window (`registry.ts`), so a headless mode means running the poly worker inside the server. The worker is already `vscode`-free (arch rule), which makes this feasible | L | product |
| 7 | **Merge message/queue links and HTTP for Go, PHP, Ruby and Rust**, labelled as guesses (`topic?`, `HTTP?`), with fixtures. | Branches `claude/message-links-bb5db8`, `claude/http-more-langs-cc14f9` unmerged | S–M | engineering |
| 8 | **Run macOS and Linux for real**: a smoke test on a real Mac and a Linux desktop, plus a headless CI check that launches the built app and opens a fixture flow (web mode). | "have not been run on a Mac or a Linux desktop yet" (`docs/building.md`) | M | engineering |
| 9 | **Lower the C# barrier**: detect the SDK and offer a one-click install link; fall back to a tree-sitter index for C# when the SDK is missing (marked as guesses), instead of having no C# flow. | `docs/building.md`: C# flows need the .NET 10 SDK; `src/poly` has no C# extractor yet, so the fallback means writing one | L (the SDK prompt alone is S) | product |
| 10 | **First users and feedback**: a demo repo, issue templates, opt-in crash reporting, a short "Axle vs. VS Code agent sessions" page that leads with flow and harness, not the dock. Update the README with what is new since 0.2.0. | 0 stars and issues; competitors now ship worktrees and parallel agents | S | product |

Also worth doing: an update check in-app (no auto-update today), and DB schema cards for Go (GORM) and Rails (ActiveRecord), the most common gaps in `docs/languages.md`.

### Benchmark plan (item 3)

1. **Ground truth per fixture.** Next to each `test/fixtures/<name>`, add `truth.json` listing, per entry point, the expected edges `{from, to, callLine, kind}`, written by hand (or by an agent and then reviewed), never generated from Axle's own output. Mark each edge as one of:
   - `static`: resolvable from the declared type;
   - `dynamic`: DI, reflection, interface dispatch, event bus or queue, HTTP between services;
   - `external`: a library call, which should not be followed.
2. **Coverage.** At least one fixture per language and framework in `docs/languages.md`. Add the missing ones: Spring Boot with DI and an interface with two implementations, ASP.NET with MediatR (for the analyzer), NestJS DI, Django signals, Celery/Kafka listeners, and cross-service HTTP with a base URL in config. Add 2–3 real OSS repos per main language (e.g. Spring PetClinic, eShopOnWeb, the FastAPI full-stack template), pinned by commit, as a slow nightly tier.
3. **Labels Axle must emit.** Every edge is `certain` (resolved from a declared type, by Roslyn, or confirmed by the LSP), `guess` (by name or path matching), or `unresolved` (a call site seen with no target). This depends on action 2.
4. **Metrics per language and per edge class.**
   - Precision and recall overall.
   - Precision of `certain` edges: this should be ≥ 0.98, because a wrong edge marked certain is the worst failure.
   - The share of `guess` edges that are right.
   - The unresolved rate: true edges reported as `unresolved` vs. silently missing. Silent misses should go to zero.
   - Entry-point recall: routes and jobs found.
   - Run with and without the LSP, to show what the language server adds.
5. **In CI.** A `npm run bench` in flow-view prints a table and writes `bench/results.json`. CI fails when a number drops below its checked-in baseline (a ratchet). Publish the table in `docs/languages.md` in place of "checked on small sample projects only".
6. **Fixtures for misleading code.** Add fixtures for same-named methods in different packages, overloads, generated code, `getattr` or reflection calls, and dynamic routes. These keep the guess labels honest.
