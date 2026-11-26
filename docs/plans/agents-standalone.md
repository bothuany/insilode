---
cycle: agents-standalone
author: rbdikmen@gmail.com
phase: plan-review
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
- Desktop behaviour is tested only in Docker (`npm run docker:e2e -- --probe`) or Windows Sandbox, never by opening a window on this machine (CLAUDE.md, PROBE.md).
- This branch starts at the end of `cycle/flow-reading` (`1c85996`), which is not merged into `main` yet; the cycle's PR carries those commits until it is.

## Rules

### RC01 Closing the IDE hides it while the Agents window is open
- **Priority:** P1
- **Rule:** Closing the IDE window (its X, Ctrl+W on an empty window, File > Close Window) while the Agents window is open hides the IDE window instead; the app, its extension host and every agent keep running.
- **Source:** `lifecycleMainService.ts:440-444` (the window close runs `unload(window, CLOSE)`, which a renderer veto stops); spike (a) probe, run 4: "IDE window hides instead of closing", "agent keeps running with the IDE hidden: 20 ticks in 10 s".
- **Examples:**

| Agents window | Action | Result |
|---|---|---|
| open | close the IDE window | IDE hidden, Agents window open, agents running |
| not open | close the IDE window | IDE closes as today (the app quits when it was the last window) |
| open | Quit (Ctrl+Q / File > Exit) | the app quits; nothing is hidden |

- **Test:**

### RC02 Closing the Agents window asks only when agents would end
- **Priority:** P0
- **Rule:** Closing the Agents window while the IDE window is hidden and at least one agent session is live asks "N agents running, close?" (Close / Cancel); with the IDE visible, or with no live agent, it closes without asking.
- **Source:** user, 2026-11-27 (ask only when the agents would end); `auxiliaryWindowService.ts:172-187` (an `onBeforeUnload` veto keeps the window); live sessions are flow-agent's `agents.sessions`.
- **Examples:**

| IDE window | Live agents | Close the Agents window | Result |
|---|---|---|---|
| hidden | 2 | Close | the app quits, the agents end |
| hidden | 2 | Cancel | nothing changes |
| hidden | 1 | - | asks "1 agent running, close?" |
| hidden | 0 | - | the app quits without asking |
| visible | 3 | - | the Agents window closes without asking; the agents keep running in the IDE |

- **Test:**

### RC03 The hidden IDE comes back when it is needed
- **Priority:** P1
- **Rule:** The hidden IDE window shows again when an editor opens in it (Open in IDE, a file from quick open, Show in Flow), when "Show IDE Window" runs, or when Insilode is started again without `--agents-only`.
- **Source:** spike (a) contribution (`editorService.onDidEditorsChange`, EDITOR_OPEN in the main part); user, 2026-11-27 (the IDE is optional).
- **Examples:**

| Trigger, IDE hidden | Result |
|---|---|
| Ctrl+P in the Agents window, open `hello.txt` | IDE shown with `hello.txt` |
| "Show IDE Window" | IDE shown, focused |
| `insilode` from a shell | IDE shown |
| `insilode --agents-only` from a shell | IDE stays hidden, Agents window focused |

- **Test:**

### RC04 Workbench UI follows the Agents window while the IDE is hidden
- **Priority:** P1
- **Rule:** While the IDE window is hidden, quick open, the command palette, notifications and dialogs show in the Agents window.
- **Source:** spike (a) probe, run 4: "quick input widgets: agents window 0 IDE window 1" (FAIL); `quickInputController.ts:157` places the widget in `layoutService.activeContainer`.
- **Examples:**

| IDE window | Ctrl+P / Ctrl+Shift+P in the Agents window | Result |
|---|---|---|
| hidden | either | the widget shows in the Agents window |
| visible, Agents window focused | either | the widget shows in the Agents window (as today) |

- **Test:**

### RC05 An agents-only start never shows the IDE
- **Priority:** P1
- **Rule:** `insilode --agents-only` and the "Insilode Agents" Start-menu shortcut start with only the Agents window; the IDE window is never visible during the start.
- **Source:** user, 2026-11-27 (flag and shortcut); spike (a) showed the IDE for a moment before hiding it; `windowImpl.ts:352` shows the window after restoring its state.
- **Examples:**

| Start | IDE visible at any 100 ms sample | Agents window |
|---|---|---|
| `insilode --agents-only` | never | open, focused |
| `insilode` | yes | as today |

- **Test:**

## Items

- [ ] 1. Hide instead of close (RC01, RC03): port spike (a) from `spike/agents-core` into `editor/patches/flow-desktop.patch` (its new files only, spliced as new-file sections), drop the `INSILODE_AGENTS_ONLY` env path, keep "Show IDE Window" and the editor-open trigger; a second start without `--agents-only` shows the hidden IDE.
  check: `node --test test/update/*.test.mjs && grep -q setWindowHidden editor/patches/flow-desktop.patch`
- [ ] 2. UI in the Agents window (RC04): when the IDE hides, focus the Agents window so `activeContainer` is its container; if quick input still goes to the hidden window, place it by the visible window instead. Notifications and dialogs follow the same rule.
  check: `grep -q "agents-alone" editor/patches/flow-desktop.patch && node --test test/update/*.test.mjs`
- [ ] 3. `--agents-only` (RC05): a CLI flag (argv.ts) that creates the main window without showing it, opens the Agents window once the extensions are up, and, sent to a running instance, focuses the Agents window. Its help text says the IDE stays hidden until needed.
  check: `grep -q "agents-only" editor/patches/flow-core.patch && node --test test/update/*.test.mjs`
- [ ] 4. Start-menu shortcut "Insilode Agents" (RC05): `build/win32/code.iss` adds it with `--agents-only`; uninstall removes it.
  check: `grep -q "Insilode Agents" editor/patches/flow-core.patch`
- [ ] 5. Live agent count (RC02): flow-agent sets the context key `insilode.agentsRunning` to the number of live sessions whenever it changes; a unit test in flow-agent named `agents-standalone/RC02`.
  check: `cd editor/extensions/flow-agent && npm run build && npm test`
- [ ] 6. Close confirmation (RC02): the exclusive Agents window vetoes its unload when the IDE is hidden and `insilode.agentsRunning` > 0, asks "N agents running, close?" (Close / Cancel, singular for 1), and closes on Close.
  check: `grep -q "running, close" editor/patches/flow-desktop.patch`
- [ ] 7. Probe in the repo: `test/e2e-desktop/probes/agents-alone.mjs` (from the spike's probe) with one step per card, each named `agents-standalone/RCnn`, plus the visibility sampling for RC05; it passes in Docker.
  check: `npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-alone.mjs`
- [ ] 8. Docs: `docs/agent-tools.md` says how to start Agents only (flag, shortcut), what closing each window does, and how to get the IDE back.
  check: `grep -q -- "--agents-only" docs/agent-tools.md`
- [ ] 9. Architecture and harness: `npm run arch` and `npm run test:e2e-unit` pass.
  check: `npm run arch && npm run test:e2e-unit`

## Probe

Docker only (PROBE.md): `npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-alone.mjs` (a patch change rebuilds the VS Code checkout, 20-40 min). Expected: every RC step PASS; RC05 samples the IDE window's visibility every 100 ms from launch and never sees it visible; screenshots of the Agents window with the IDE hidden, of the confirmation, and of the palette in the Agents window. A fake ticking `claude` on PATH stands in for a real one (no login). The Start-menu shortcut (item 4) is Windows-only: `npm run sandbox:e2e` if the Windows Sandbox feature is on, otherwise log `not run live` for it.

## Log

- gather: started 2026-11-27 from `cycle/flow-reading` `1c85996`; spikes (a) and (b) under way.
- gather: spike (b) `spike/agents-native` 4fdc63d, Docker probe 8/8 pass (close asks, agent lives after window close, scrollback on reopen, Open in IDE argv); window ~400 MB RSS + daemon 2.4 MB, start 0.3 s. Spike (a) `spike/agents-core` 3b8d432 (flow-desktop.patch), Docker probe: IDE hides instead of closing, agent runs with IDE hidden, agents-only start, quit when Agents closes PASS; quick open / palette open in the hidden IDE window FAIL; ~2.4 GB RSS, 11 s cold start. Comparison: https://claude.ai/artifact/3DiCBxZ26xLaVQtHXV4anf; waiting for the user to pick.
- plan: the user picked (a), the core patch (2026-11-27); spike (b) stays on `spike/agents-native` for reference.
- plan: rules RC01-RC05 and items 1-9 written; next plan-review.
