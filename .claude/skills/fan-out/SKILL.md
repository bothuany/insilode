---
name: fan-out
description: Split an approved plan into independent parts, run each as a parallel `implementer` subagent (Sonnet, own worktree), then merge and verify the result in the main session. Use when the user says "/fan-out", "paralel yap", "subagent'lara dağıt" or asks to run a plan's parts in parallel.
disable-model-invocation: true
argument-hint: "[plan file or the parts to run]"
---

You are the orchestrator. You keep the design, the shared contract, the merge and the verification; the `implementer` subagents (.claude/agents/implementer.md) only build their part. Read their diffs, not just their reports.

## 1. Split

Take the plan from `$ARGUMENTS`, the plan file it names, or the plan approved in this conversation. List each part with the files it will create or change. A part qualifies for fan-out only when:

- no other part touches its files, and
- it needs no other part's result, only the shared contract.

The usual shared files in this repo are `protocol/flow.ts`, each extension's `package.json` (`contributes`, activation events), command registration in each extension's `extension.ts`, `ui/src/types.ts` and the arch tests. A part that needs one of them either gets its piece of the contract from step 2 or stays in the main session.

Fewer than 3 qualifying parts: say so and implement in the main session instead. More than 5: run 5 and queue the rest for when one finishes.

Show the split as a short table (part, files owned, contract it uses) and wait for the user's go-ahead.

## 2. Contract

Write the shared pieces yourself, in the main session: wire types in `protocol/flow.ts`, new command ids registered (a stub handler is fine), `package.json` contributes, any shared type a part reads. Run `npm run arch`, then commit on the current branch. Worktrees branch from this HEAD (`worktree.baseRef: "head"` in .claude/settings.json), so an uncommitted contract is invisible to the workers.

## 3. Spawn

Spawn every part in one message, as `implementer` subagents running in the background. Each brief is self-contained, since the worker sees nothing of this conversation:

```
Part: <one-line goal>
Files you own: <paths; create or change only these>
Contract (already committed): <types / command ids / settings the part uses, with file paths>
Behaviour: <what it must do, edge cases>
Done when: <tests to add or pass, e.g. flow-view `npm test`>; `npm run arch` passes.
Do not touch: <the other parts' files and the contract files>
```

The SubagentStart hook links the main checkout's `node_modules` and `editor/vscode` into each worktree, so workers run tests without `npm install`. The SubagentStop hook (`.claude/hooks/implementer-gate.mjs`) sends a worker back once if its work is uncommitted or arch / the type check fails.

## 4. Merge

As each worker reports: read its branch's diff (`git diff HEAD...<branch>`), check it stayed in its files and kept the contract, then `git merge --no-ff <branch>`. Merge one at a time and run `npm run arch` after each, so a break points at one part. A worker that reports a question or a missing contract piece: answer it with SendMessage to that worker, or fix the contract, commit, and spawn a new worker for the part.

## 5. Verify

After the last merge, run the `quality-gate` steps that cover what changed, the reviewer agents that match (`architecture-reviewer`; `webview-security-reviewer` for webview, MCP or hook/permission code; `golden-diff-reviewer` after snapshot changes), and the `probe` skill for anything visible in the canvas.

Report one line per part (merged / not, branch, tests), then what the checks found. Remove each merged worktree with `node .claude/hooks/implementer-gate.mjs --remove <path>`, never with a plain `git worktree remove` or `rm -rf`: a worker's worktree may still hold junctions to the main checkout's `node_modules` and `editor/vscode`, and Git for Windows deletes through them. Delete a branch only after it is merged. Do not push or open a PR unless asked.
