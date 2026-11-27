---
cycle: agents-standalone
author: rbdikmen@gmail.com
phase: code-review
branch: cycle/agents-standalone
---

# Agents window on its own

## Why

The Agents page (`editor/extensions/flow-agent`, opened by `flow.agents.openPage`) is a webview in an exclusive VS Code auxiliary window that the main workbench window owns, and every agent terminal is a terminal of the main window's extension host (`agents.ts` createTerminal, mirrored by `termHost.ts`). Close the IDE window and the agents go with it. The goal: the Agents window opens and works on its own, like Warp, and the IDE window is optional.

## Decisions

- Closing the Agents window while agents run asks first: "N agents running, close?" (user, 2026-11-27).
- Gather builds two spikes side by side and compares them on a running build, not on mockups (user, 2026-11-27):
  - (a) `spike/agents-core`: a VS Code core patch (`editor/patches/flow-core.patch`, `_insilode.agents.openWindow`, `createAuxiliaryEditorPart`) that keeps the exclusive auxiliary Agents window alive without the main workbench window.
  - (b) `spike/agents-native`: a native Rust Agents app (a terminal engine such as alacritty_terminal or the wezterm crates, a shell such as Tauri or GPUI) that runs agents in its own ptys, keeps them alive after its window closes, and connects to the IDE when it is open (Open in IDE, show in Flow, the insilode MCP bridge).
- Cost and time are not constraints for the spikes (user, 2026-11-27).
- Direction: (a), the core patch: the existing Agents window, the IDE window hides instead of closing (user, 2026-11-27, after the spike comparison). Known work: route the quick input, notifications and dialogs to the Agents window while the IDE is hidden; no IDE flash on an agents-only start. Agents still end when the Agents window closes (after the confirmation).
- Agents-only start: the flag `insilode --agents-only` and an "Insilode Agents" Start-menu shortcut (user, 2026-11-27). VS Code's own `--agents` opens its Sessions window, so the flag is a new one.
- The close confirmation asks only when closing would end agents: the IDE is hidden and at least one agent runs (user, 2026-11-27).
- While the IDE is hidden: a reload or renderer crash shows the IDE; Ctrl+W on the Agents tab counts as closing the Agents window; Quit does not ask (user, 2026-11-27, plan review).
- Desktop behaviour is tested only in Docker (`npm run docker:e2e -- --probe`) or Windows Sandbox, never by opening a window on this machine (CLAUDE.md, PROBE.md).
- This branch starts at the end of `cycle/flow-reading` (`1c85996`), which is not merged into `main` yet; the cycle's PR carries those commits until it is.

## Rules

"Live agent" everywhere below: a flow-agent session whose `state !== 'ended'` (ended sessions stay in `agents.sessions`, `agents.ts:1153`, until `:1085` removes them).

### RC01 Closing the IDE hides it while the Agents window is open
- **Priority:** P1
- **Rule:** Closing the IDE window that owns the Agents window (X, File > Close Window) hides it instead; the app, its extension host and every agent keep running. Quit is never turned into a hide.
- **Source:** `lifecycleMainService.ts:440-444` (close runs `unload(window, CLOSE)`, a renderer veto stops it); spike (a) probe run 4 ("IDE window hides instead of closing", "20 ticks in 10 s").
- **Examples:**

| Agents window | Action | Result |
|---|---|---|
| open | close its IDE window | IDE hidden, Agents window open, agents running |
| not open | close the IDE window | closes as today |
| open in IDE window 1 | close IDE window 2 | window 2 closes as today |
| open | Quit (Ctrl+Q / Exit), agents live | quits without asking (user, 2026-11-27); unsaved files: the IDE shows and its save dialog asks there |

- **Test:** probe test/e2e-desktop/probes/agents-alone.mjs, steps `agents-standalone/RC01 open: close its IDE window -> IDE hidden, Agents window open, agents running`, `agents-standalone/RC01 open in IDE window 1: close IDE window 2 -> window 2 closes as today`, `agents-standalone/RC01 not open: close the IDE window -> closes as today`, `agents-standalone/RC01 open, Quit (Ctrl+Q / Exit), agents live: quits without asking`, `agents-standalone/RC01 open, Quit (Ctrl+Q / Exit), agents live, unsaved files: the IDE shows and its save dialog asks there`

### RC02 Closing the Agents window asks only when agents would end
- **Priority:** P0
- **Rule:** Closing the Agents window, or its tab with Ctrl+W, while its IDE window is hidden and N >= 1 agents are live asks "N agents running, close?" (singular for 1; Close / Cancel) over the Agents window; on Close, or with N = 0, the hidden IDE window closes too (the app then quits when it was the last window, except on macOS). With the IDE visible it closes without asking.
- **Source:** user, 2026-11-27 (ask only when agents would end; Ctrl+W counts as closing); `auxiliaryWindowService.ts:172-187` (an `onBeforeUnload` veto keeps the window).
- **Examples:**

| IDE window | Live agents | Close the Agents window (or Ctrl+W on its tab) | Result |
|---|---|---|---|
| hidden | 2 | Close | IDE window closes, agents end, app quits (last window, not macOS) |
| hidden | 2 | Cancel | nothing changes |
| hidden | 1 | - | asks "1 agent running, close?" |
| hidden | 0 | - | IDE window closes without asking |
| visible | 3 | - | Agents window closes without asking; agents keep running in the IDE |
| hidden, macOS | 0 | - | IDE window closes, app stays in the Dock |

- **Test:** `agents-standalone/RC02 counts live agents` (unit test, editor/extensions/flow-agent/test/desktop.test.mjs); probe test/e2e-desktop/probes/agents-alone.mjs, steps `agents-standalone/RC02 hidden, 1 agent: asks "1 agent running, close?"`, `agents-standalone/RC02 hidden, 2 agents, Cancel: nothing changes`, `agents-standalone/RC02 hidden, 2 agents: Ctrl+W on the Agents tab asks the same`, `agents-standalone/RC02 hidden, 2 agents, Close: IDE window closes, agents end, app quits`, `agents-standalone/RC02 hidden, 0 agents: IDE window closes without asking`, `agents-standalone/RC02 visible, 3 agents: Agents window closes without asking; agents keep running in the IDE`, `agents-standalone/RC02 hidden, Close, then the save question is cancelled: the IDE hides again on close and the Agents close asks again`

### RC03 The hidden IDE comes back when it is needed
- **Priority:** P1
- **Rule:** The hidden IDE window shows (`show()` then focus) when an editor opens in it (Open in IDE, quick open, Show in Flow), when "Show IDE Window" runs, when Insilode is started again without `--agents-only`, when it reloads or its renderer restarts, and when it must ask about unsaved files.
- **Source:** spike (a) (`onDidEditorsChange`, EDITOR_OPEN in the main part); `windowImpl.ts:459-470` (`doFocusWindow` only focuses, never shows); user, 2026-11-27 (reload shows the IDE).
- **Examples:**

| Trigger, IDE hidden | Result |
|---|---|
| Ctrl+P in the Agents window, open `hello.txt` | IDE shown with `hello.txt` |
| "Show IDE Window" | IDE shown, focused |
| `insilode` from a shell | IDE shown |
| `insilode --agents-only` from a shell | IDE stays hidden, Agents window focused |
| Reload Window / renderer crash | IDE shown (the Agents window is not restored) |
| the renderer stops responding for a while | IDE stays hidden (no focus stealing) |
| click an agent in the status island | the agent opens in the Agents window, which comes forward; IDE stays hidden (user, 2026-11-28) |
| macOS: click the Dock icon | IDE shown |

- **Test:** `agents-standalone/RC03 a click on an agent in the status island shows it in the open page, which comes forward` (unit test, editor/extensions/flow-agent/test/agentsPanel.test.mjs); probe test/e2e-desktop/probes/agents-alone.mjs, steps `agents-standalone/RC03 Ctrl+P in the Agents window, open hello.txt -> IDE shown with hello.txt`, `agents-standalone/RC03 "Show IDE Window" -> IDE shown, focused`, `agents-standalone/RC03 insilode --agents-only from a shell -> IDE stays hidden, Agents window focused`, `agents-standalone/RC03 insilode from a shell -> IDE shown`, `agents-standalone/RC03 Reload Window / renderer crash -> IDE shown (the Agents window is not restored): crash`, `agents-standalone/RC03 macOS: click the Dock icon -> IDE shown (the activate event, emitted by hand)`, `agents-standalone/RC03 Reload Window / renderer crash -> IDE shown (the Agents window is not restored): reload`, `agents-standalone/RC03 the renderer stops responding for a while -> IDE stays hidden (no focus stealing)`, `agents-standalone/RC03 click an agent in the status island -> the agent opens in the Agents window, which comes forward; IDE stays hidden`, `agents-standalone/RC03 click an agent in the status island -> the agent opens in the Agents window, which comes forward; IDE stays hidden`

### RC04 Workbench UI follows the Agents window while the IDE is hidden
- **Priority:** P1
- **Rule:** While the IDE window is hidden, quick open, the command palette, notification toasts and dialogs (RC02's confirmation included) show in the Agents window.
- **Source:** spike (a) probe run 4 ("quick input widgets: agents window 0 IDE window 1"); `quickInputController.ts:157` (`activeContainer`); `notificationsToasts.ts:238` (toasts laid out against `mainContainer`).
- **Examples:**

| IDE window | What opens | Where |
|---|---|---|
| hidden | Ctrl+P / Ctrl+Shift+P | Agents window |
| hidden | a notification toast | Agents window |
| hidden | a confirmation dialog | over the Agents window |
| visible, Agents window focused | Ctrl+P | Agents window (as today) |
| visible | a notification | IDE window (as today) |

- **Test:** probe test/e2e-desktop/probes/agents-alone.mjs, steps `agents-standalone/RC04 hidden: the Agents window has the focus after the editor window hides (focus evidence)`, `agents-standalone/RC04 hidden: Ctrl+P / Ctrl+Shift+P -> Agents window`, `agents-standalone/RC04 hidden: a notification toast -> Agents window`, `agents-standalone/RC04 hidden: a confirmation dialog -> over the Agents window`, `agents-standalone/RC04 visible, Agents window focused: Ctrl+P -> Agents window (as today)`, `agents-standalone/RC04 visible: a notification -> IDE window (as today)`

### RC05 An agents-only start never shows the IDE
- **Priority:** P1
- **Rule:** `insilode --agents-only` and the "Insilode Agents" Start-menu shortcut start with only the Agents window; the IDE window is never visible during the start, a source build included.
- **Source:** user, 2026-11-27 (flag and shortcut); `windows.ts:147` (a normal window is created visible), `windowImpl.ts:352` (maximized/fullscreen show), `windowImpl.ts:1299-1306` (a source build force-shows a window still hidden 10 s after load).
- **Examples:**

| Start | IDE visible at any 100 ms sample | Agents window |
|---|---|---|
| `insilode --agents-only` | never (also after 10 s in a source build) | open, focused |
| `insilode --agents-only`, window state maximized | never | open |
| `insilode` | yes | as today |
| `insilode --agents-only`, two IDE windows restored from the last session | never, neither of them (user, 2026-11-28) | open |

- **Test:** probe test/e2e-desktop/probes/agents-alone.mjs, steps `agents-standalone/RC05 insilode --agents-only: IDE never visible (also after 10 s in a source build), Agents window open, focused`, `agents-standalone/RC05 insilode --agents-only, window state maximized: IDE never visible, Agents window open`, `agents-standalone/RC05 insilode --agents-only, window state maximized: the state is applied when the window shows (the seeded state was read)`, `agents-standalone/RC05 insilode --agents-only, two IDE windows restored from the last session: never, neither of them; Agents window open`, `agents-standalone/RC05 insilode: IDE visible, as today`

## Items

Only item 7 proves behaviour (Docker, a patch change rebuilds VS Code: 20-40 min, run it once the patch items are done). Items 1-6 check what can be checked here: no file in two patches, the change is in the right patch, and for item 5 the named unit test. A patch is regenerated as docs/building.md says, or spliced like the spike did for flow-desktop.patch's new files; never edit `editor/vscode` by hand and leave it as it was.

- [x] 1. Hide instead of close (RC01, RC03): port spike (a) (`spike/agents-core` 3b8d432, flow-desktop.patch) without its `INSILODE_AGENTS_ONLY` path. Fix its two faults: `setWindowHidden(hidden)` takes no window id and acts only on the calling window (from the IPC context, like nativeHost), and restores the window's own background-throttling value when shown (`windows.ts:265` turns it off for workbench windows). Show the IDE on reload/renderer restart, on unsaved-files prompts, and when a start without `--agents-only` reaches the running instance (`doFocusWindow` must `show()` a hidden window).
  check: `! (grep -h "^diff --git" editor/patches/*.patch | sort | uniq -d | grep -q .) && grep -q "setWindowHidden(hidden: boolean)" editor/patches/flow-desktop.patch`
- [x] 2. UI in the Agents window (RC04): while the IDE is hidden, the quick input, notification toasts and dialogs use the Agents window's container (focus the Agents window on hide; move what `activeContainer`/`mainContainer` does not cover).
  check: `! (grep -h "^diff --git" editor/patches/*.patch | sort | uniq -d | grep -q .) && grep -q "notificationsToasts" editor/patches/flow-core.patch editor/patches/flow-desktop.patch`
- [x] 3. `--agents-only` (RC05): the flag in `argv.ts` (node and common types); the main process creates the window hidden (`windows.ts:147`, `windowImpl.ts:352`), skips the source-build force-show for it (`windowImpl.ts:1299-1306`), and a second instance started with the flag focuses the Agents window; the workbench side (open the Agents page, keep the IDE hidden) lives in flow-desktop.patch's contribution. Name in the item which patch each file went to.
  check: `! (grep -h "^diff --git" editor/patches/*.patch | sort | uniq -d | grep -q .) && grep -q "agents-only" editor/patches/flow-core.patch && grep -q "agents-only" editor/patches/flow-desktop.patch`
- [x] 4. Start-menu shortcut "Insilode Agents" (RC05): `build/win32/code.iss` (flow-core.patch) adds it with `--agents-only`; uninstall removes it.
  check: `grep -q "Insilode Agents" editor/patches/flow-core.patch`
- [x] 5. Live agent count (RC02): flow-agent sets the context key `insilode.agentsRunning` to the number of live agents (`state !== 'ended'`) whenever it changes; a unit test named `agents-standalone/RC02 counts live agents` covers 0, 1, 2 and ended sessions.
  check: `cd editor/extensions/flow-agent && npm run build && npm test 2>&1 | tee /tmp/fa.log && grep -q "agents-standalone/RC02" /tmp/fa.log`
- [x] 6. Close confirmation (RC02): the exclusive Agents window vetoes its unload, and its Agents tab's close (Ctrl+W), when the IDE is hidden and `insilode.agentsRunning` > 0; asks over the Agents window; on Close closes the IDE window.
  check: `! (grep -h "^diff --git" editor/patches/*.patch | sort | uniq -d | grep -q .) && grep -q "running, close" editor/patches/flow-desktop.patch`
- [ ] 7. Probe in the repo: `test/e2e-desktop/probes/agents-alone.mjs`, starting from the spike's (`git show spike/agents-core:test/e2e-desktop/probes/agents-alone.mjs`), one step per example row it can drive, each step named `agents-standalone/RCnn <row>`; RC05 samples visibility every 100 ms for 15 s. The fake ticking `claude` on PATH stands in for a real one.
  check: `npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-alone.mjs --out "$(mktemp -d)"`
- [x] 8. Docs: `docs/agent-tools.md` says how to start Agents only (flag, shortcut), what closing each window does, and how to get the IDE back.
  check: `grep -q -- "--agents-only" docs/agent-tools.md`
- [x] 9. Architecture and harness: `npm run arch` and `npm run test:e2e-unit` pass.
  check: `npm run arch && npm run test:e2e-unit`

## Probe

Docker only (PROBE.md): `npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-alone.mjs --out <scratchpad dir>`. Expected: every `agents-standalone/RCnn` step PASS, among them the IDE hiding on close, the agent ticking with the IDE hidden, the palette and a toast in the Agents window, the confirmation over the Agents window with Cancel and Close, Ctrl+W asking the same, reload showing the IDE, and RC05 never seeing the IDE visible; screenshots of each. Not covered in Docker: macOS rows (no macOS runner), several IDE windows beyond one row, and the Windows hide itself; the Start-menu shortcut runs in `npm run sandbox:e2e` if the Windows Sandbox feature is on, otherwise `not run live`.

## Log

- gather: started 2026-11-27 from `cycle/flow-reading` `1c85996`; spikes (a) and (b) under way.
- gather: spike (b) `spike/agents-native` 4fdc63d, Docker probe 8/8 pass (close asks, agent lives after window close, scrollback on reopen, Open in IDE argv); window ~400 MB RSS + daemon 2.4 MB, start 0.3 s. Spike (a) `spike/agents-core` 3b8d432 (flow-desktop.patch), Docker probe: IDE hides instead of closing, agent runs with IDE hidden, agents-only start, quit when Agents closes PASS; quick open / palette open in the hidden IDE window FAIL; ~2.4 GB RSS, 11 s cold start. Comparison: https://claude.ai/artifact/3DiCBxZ26xLaVQtHXV4anf; waiting for the user to pick.
- plan: the user picked (a), the core patch (2026-11-27); spike (b) stays on `spike/agents-native` for reference.
- plan: rules RC01-RC05 and items 1-9 written; next plan-review.
- plan-review: reviewer found 12 (hidden-window show paths and the source-build force-show, IPC hiding any window id, throttling restore, ended sessions counted, toasts on mainContainer, missing probe, grep-only checks, reload, Ctrl+W, Quit, macOS/multi-window rows); all settled in the cards and items, three by the user; spike probe committed on spike/agents-core 284263a.
- build: the user approved the plan and rule cards RC01-RC05 (2026-11-27); writer started.
- code-review: round 1, 7 findings (closing flag stuck after a cancelled save, any focus() showing the hidden IDE, a second restored window visible, probe steps that pass vacuously, toasts scheduled on the hidden window, the macOS Dock, an IPC comment); the user decided the island click (Agents window) and restored windows (all hidden), the lead decided unresponsive (stays hidden) and the Dock (shows the IDE), rows added to RC03 and RC05. Docker run of plan-check 1 was cut off by a machine shutdown, no result.
