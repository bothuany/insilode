---
cycle: agents-standalone
author: rbdikmen@gmail.com
phase: gather
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
- Desktop behaviour is tested only in Docker (`npm run docker:e2e -- --probe`) or Windows Sandbox, never by opening a window on this machine (CLAUDE.md, PROBE.md).
- This branch starts at the end of `cycle/flow-reading` (`1c85996`), which is not merged into `main` yet; the cycle's PR carries those commits until it is.

## Rules

Open until gather picks a direction.

## Items

Written in `plan`, after the user picks a direction.

## Probe

Written in `plan`. For the spikes: the same script for both, in Docker under xvfb: launch Agents-only, start a shell and an agent, close the window, reopen it, check the process is alive, then Open in IDE, with a screenshot at each step.

## Log

- gather: started 2026-11-27 from `cycle/flow-reading` `1c85996`; spikes (a) and (b) under way.
