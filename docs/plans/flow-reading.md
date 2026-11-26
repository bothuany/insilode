---
cycle: flow-reading
author: rbdikmen@gmail.com
phase: gather
branch: cycle/flow-reading
---

# Comfortable code reading on Flow

## Why

1. The Agents window (terminals, agent sessions) is unusable unless the main IDE window is open. It should work on its own, like Warp: open only that window and work there; the IDE window is optional.
2. Reading code on the Flow canvas (whole lines, inspecting, moving between cards) is uncomfortable. The idea stays; the design changes.
3. The user is open to wide changes elsewhere where the app feels wrong.

## Decisions

- Split (user, 2026-11-26): this cycle is the Flow reading redesign. The standalone Agents window is the next cycle, `agents-standalone`: a dedicated launch where the window itself is the Agents surface; closing it with agents running asks first ("N agents running, close?").
- Design is decided visually (user): the current Flow screen and the options go on a Design artifact (https://claude.ai/artifact/T1CSBo1Qfg479xoVgR8Rry); the user picks and approves there before the plan is written.
- Probe: `npm run setup` approved and running; the probe is web mode in the browser pane (PROBE.md). `site/` renders the same canvas on a fake host, so the site build and tests belong in the checks.
- Found (readers): lines clip at ~81 chars (`ui/src/layout.ts:170`, `webview.css:139-146`), call pill covers the line end, methods over 18 lines show a skeleton, zoomed-out code is scaled text, wheel over code pans the canvas, arrows move spatially, no back/forward, find matches card labels only.

## Rules

(gather)

## Items

(plan)

## Probe

(plan)

## Log

- gather: started from the user's request (2026-11-26); split into Flow (this cycle) and agents-standalone (next)
