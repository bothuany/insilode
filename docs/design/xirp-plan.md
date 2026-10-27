# Plan: Xirp-inspired features and the harness flow diagram

This plan builds what `xirp-inspired.md` decided. The work runs in two phases with the `/fan-out` flow. Each part is one `implementer` subagent in its own worktree, with at most 5 running at once. The branch is `claude/xirp-ideas`, cut from `claude/fan-out-setup` because the implementer agent lives there.

## Step 0: the contract (main session, one commit)

Every file that more than one part would touch changes here, before any implementer starts.

- `docs/design/xirp-inspired.md` and this plan. Commit explicit paths only: `playground/` and the branding PNGs stay untracked.
- **`flow-agent/package.json` contributes.** New settings:
  - `flow.agents.pr.autoSend`: on by default.
  - `flow.agents.pr.events`: a map from event to on/off. On by default: `checkFailed`, `changesRequested`, `conflict`. Off by default: `comment`, `review`.
  - `flow.agents.pr.maxAutoSends`: the most automatic sends per PR per day, default 5.
  - `flow.agents.pr.pollSeconds`: default 120.
  - `flow.agents.notify.digestMinutes`: 0 sends each notification on its own; default 5.

  New commands:
  - `flow.cleanupWorktrees`: Clean Up Agent Worktrees…
  - `flow.runWorktreeSetup`: Run Worktree Setup Again
- **`flow-harness/package.json`.**
  - New setting `flowHarness.limitAlerts`: on by default.
  - New command `flowHarness.flowModel`: internal, returns the diagram model.
- **`flow-view/package.json`.** New command `flow.showHarnessFlow`: Harness Flow.
- **Seams in `flow-agent/src/agents.ts`.** No part edits this file except Part C.
  - `onDidTurnEnd: Event<AgentSession>` fires on `Stop`, `StopFailure` and the `idle_prompt` notification.
  - `deliver(id, text): boolean` wraps `typeInto` and refuses while the session's terminal is active and the window is focused, because the user may be typing there.
  - `HookPayload` gains `agent_id`.
- **Stub modules.** Both `extension.ts` files call `register(context, …)` in stubs: `prEvents.ts`, `worktreeCleanup.ts`, `limitAlerts.ts`, and a stub `flowHarness.flowModel` handler. Each part fills in its own stub, so no implementer edits either `extension.ts`. The commands arch test passes with the stubs.
- **`protocol/harness.ts`.** The types the diagram's host sends the canvas, and the messages both ways, type-only:
  - `Stage` ids follow the lifecycle: sessionStart, load, promptSubmit, model, preTool, permission, permissionRequest, run, postTool, subagent, stop, sessionEnd.
  - `HarnessFlowItem`: kind, label, scope, file and line, the stage it sits at, and its matcher or path globs.
  - `PreviewEvent`: a tool, its input, and a file.
  - `PathHit`: an item id, a verdict, and whether it was `observed` or `predicted`.
  - `ReplayStep`.
- **`ui/` build entry.** `vite.harness.config.ts` and its entry in `ui/package.json` `build`, so Phase 2 Part B does not touch `ui/package.json`.

## Phase 1 (5 parts at once)

**A. PR events become work for the agent (flow-agent).**
- Files: `prState.ts`, `prEvents.ts` and its tests.
- Mechanism:
  - Add `reviewDecision,mergeable,headRefOid,comments,reviews` to `PR_FIELDS`.
  - Run a timer for sessions whose PR is open.
  - Compare each poll with the previous one to find events. Dedupe by head SHA plus check name, or by comment id.
  - The first poll after a reload only records a baseline and sends nothing.
  - `mergeable: UNKNOWN` does not count as a conflict.
  - Ignore bots (`[bot]`, `-bot`) and actions by the PR author.
  - Queue up to 10 events per session. Deliver them on `onDidTurnEnd`, or at once if the session is already idle, as one message through `deliver`.
  - Cap automatic sends at `maxAutoSends`. Once the cap is reached, show a "Send to agent" button on the dock row instead.
  - The setting's text says that this spends tokens.
- Scope: terminal agents only. ACP sessions come later.
- Done when: pure tests pass for event diffing, baseline, dedupe, the bot filter and the cap; `npm run arch` passes.

**B. Worktree setup and cleanup (flow-agent).**
- Files: `worktrees.ts`, `worktreeFlow.ts`, `worktreeActions.ts`, `worktreeCleanup.ts` and their tests.
- The repo file `.insilode/worktree.json`, for example:
  ```json
  {
    "copy": [".env"],
    "setup": [["npm", "ci"]],
    "teardown": []
  }
  ```
  - Commands are argument arrays, never run through a shell.
  - The file is read only in a trusted workspace.
  - Setup runs after the worktree is created and before the agent starts. It shows no terminal and takes no focus; output goes to the log. If it fails, the user chooses to continue or stop.
- Cleanup:
  - Fetch with `--prune` first, then classify each candidate by merged / remote gone / unmerged, commits ahead, uncommitted changes, an attached session, and age.
  - Show a QuickPick for the user to choose.
  - Just before deleting, check every guard again.
- Before deleting a worktree, find any junctions or symlinks inside it and unlink them first. A junction must never be followed into the main checkout; that would be data loss.
- Done when: tests cover classification, the second guard check, and junction unlinking (a Windows-only test may skip elsewhere).

**C. Notifications: digest and subagent permissions (flow-agent).**
- Files: `notify.ts`, `attention.ts`, `agents.ts` (only the body of `hook()`), and tests.
- A hook payload that carries `agent_id` comes from a subagent. Claude Code's hook documentation calls `agent_id` and `agent_type` common fields; `agent_type` alone only means the session was started with `--agent`.
  - A subagent's permission request becomes a separate kind, `subagentInput`.
  - The row and the notification read "Explore (subagent) wants to: …".
- While the window is in the background, notifications are collected for `digestMinutes`. Then one notification counts distinct sessions: "3 sessions need input, 2 finished", with a button that opens the dock.
- Done when: `attention` tests cover the subagent case and the digest grouping is tested as a pure function.

**D. Plan limit alerts and subagent tokens (flow-harness, flow-agent).**
- Files: `flow-harness/src/budget.ts`, `limitAlerts.ts`, `flow-agent/src/cost.ts`, and tests.
- Limit alerts:
  - Notify where `budget.ts` already computes the 75% and 90% colours, so the thresholds stay in one place.
  - Each threshold notifies once per limit window, keyed by the reset time.
- Subagent tokens:
  - Read `<session>/subagents/agent-*.jsonl` (lines have `isSidechain: true` and `agentId`) and show them as a separate "subagents" figure next to the session's tokens.
  - Dedupe by message id.
- Done when: tests cover dedupe and the per-window threshold keys.

**E. Transcript search as an MCP tool (flow-view).**
- Follow the `add-mcp-tool` skill. Files: `src/mcp/transcripts.ts`, `tools.ts`, `handlers.ts`, `docs/agent-tools.md`, and tests.
- The tool `search_sessions(query, limit)`:
  - searches this workspace's Claude sessions (`~/.claude/projects/<cwd key>/*.jsonl`) and Codex sessions, filtering Codex sessions by `cwd`
  - matches all words, case-insensitive
  - reads JSONL as a stream
  - returns a snippet per hit with the session id, date and first prompt
- Use `fs` only; nothing here may reach `vscode`, even transitively.
- Done when: tests run against fixture transcripts and the dependency rules pass.

## Phase 2: the harness flow diagram (2 parts at once, after Phase 1 is merged)

**F. Model and host (flow-harness and flow-view).**
- Files: `flow-harness/src/harnessFlow.ts`, its tests, and `flow-view/src/harnessFlowPanel.ts`.
- `flowHarness.flowModel` takes `{mode: 'static' | 'preview' | 'replay', event?, session?}` and returns `HarnessFlowItem[]` and `PathHit[]`.
  - Each item from `scan.ts` is placed at its stage. Hooks go to their event and keep their matcher. Permission rules go to `permission`. Always-on rules, instructions and memory go to `load`; path-scoped rules go to `model`. MCP servers and subagents go to `run`.
  - **Preview** uses `permmatch.ts` for the permission verdict, `effective.ts` for the rules that load for the event's file, and hook matchers for the hooks that fire. Every hit is marked `predicted`.
  - **Replay** walks the session's tool calls from `transcript.ts`. Events the hooks recorded (`live.ts`) are marked `observed`; anything only rule matching predicts stays `predicted`.
- The flow-view panel follows `boardPanel.ts`:
  - it reads `ui/dist-webview/harness.js`
  - it sets a CSP
  - it gets the model through the command
  - a click on an item opens its file and line; the command id from the webview is checked against an allowlist
- Done when: model tests cover static placement, preview verdicts and replay marks.

**G. The canvas (ui/).**
- Files: `ui/src/harness/*`.
- React Flow lays the stages out left to right. Item cards sit in each stage's column, coloured by kind as in the harness map.
- A mode switch picks Static, Preview or Replay.
  - Preview offers a tool (Bash, Edit, Read, an MCP tool), a command or a file, and highlights the path. The permission card shows the verdict (allow/ask/deny).
  - Replay has a step slider. Observed hits are drawn solid and predicted hits dashed.
- No Node built-ins.
- Done when: `npm run typecheck` and `npm run build` pass; the main session checks it in the browser pane (probe).

## Checks after each merge

1. Read each branch's diff, then merge one at a time.
2. Run `npm run arch`, `cd editor/extensions/flow-view && npm test` and the flow-agent and flow-harness tests.
3. Run the `architecture-reviewer` agent. Also run `webview-security-reviewer` after Phase 1 for E and after Phase 2 for the panel.
4. Probe in web mode with screenshots: the dock rows (PR events, subagent permission), the worktree cleanup QuickPick, and all three modes of the diagram.
5. Open one PR per phase.
