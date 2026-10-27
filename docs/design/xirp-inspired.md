# Ideas taken from Xirp (decided 2026-10-28)

Xirp is Spotify's desktop app for running Claude Code and Codex sessions in parallel. We read the code of version 0.61.0; we did not run it. The notes on how each feature works are in `C:\development\xirp-opus\xirp-mekanizmalar.md`, outside this repo. This page records which ideas Insilode takes, and which it leaves and why.

## Taken

- **PR/CI events become work for the agent.** `flow-agent/src/prState.ts` already polls `gh` for the PR state and the CI result. We add the rest of the loop:
  - compare each poll with the last one to find what changed
  - queue up to 10 events per session
  - ignore comments from bots and actions by the PR author
  - when the agent goes idle, send the queued events as one message
  - Each event type can be switched on or off. On by default: CI failure, changes requested, merge conflict.
  - Sending is **automatic**, as the user decided. The setting text must say that this spends tokens.
- **Worktree setup script.** The setup and teardown commands live in a file in the repo, so a team can share them. They run only when the workspace is trusted.
- **Worktree cleanup.**
  - The scan fetches with `--prune` first, so branches that were squash-merged count as merged.
  - Every guard is checked again just before a worktree is deleted: uncommitted changes, unpushed commits, running sessions, and the Windows junction risk.
- **Telling subagent permissions apart.** When the `session_id` in a hook payload is not the session's own id, the request comes from a subagent.
- **Notification digest.** While the window is in the background, events are collected and sent as one notification ("3 sessions need input, 2 finished").
- **Plan limit notifications.** A notification fires at 75% and again at 90% of a plan limit. Tokens used by subagents are counted from their transcripts. There is no dollar price table.
- **Transcript search, as an `insilode` MCP tool only.** The agent can check "was this done before?" itself.

## The harness flow diagram (our own idea)

The harness map today is a tree grouped by kind. The diagram shows the same pieces along one turn's lifecycle instead, each under the step where it acts:

SessionStart → instructions, rules and memory load → UserPromptSubmit → model → tool call → PreToolUse → permission rules → PermissionRequest → tool (built-in, MCP, subagent) → PostToolUse → Stop

The diagram works in three modes:

1. **Static map.** Every hook, rule, skill, MCP server and permission rule sits at its step. A hook's matcher shows which tools it fires on.
2. **Preview.** The user picks a sample event, such as editing a file or running a command, and the path it takes lights up. This reuses `permmatch.ts`, `effective.ts` and `why.ts`.
3. **Live replay.** A real session's transcript plays step by step on the same diagram.

It is drawn on the canvas (React Flow), so it needs new wire types in `protocol/flow.ts` and a command through flow-view.

## Left out

| Idea | Why we left it out |
|---|---|
| Dollar spend alerts | Subscription users do not pay per token, and a price table needs constant upkeep. |
| statusArbiter | It is an internal refactor. We will do it if session status turns out to be wrong. |
| Stacked sessions, session-to-session messaging | Too large. Claude Code's own subagents and agent teams cover most of the need. |
| Importing outside sessions, embedded browser, prompt templates, skill CLI | `resume.ts`, VS Code's Simple Browser and skills/slash commands already cover these. |
| Portal, Auth0 | Specific to Spotify. |
| Delivering messages with tmux send-keys | Insilode uses ACP and VS Code terminals. |
