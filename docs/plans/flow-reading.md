---
cycle: flow-reading
author: rbdikmen@gmail.com
phase: plan-review
branch: cycle/flow-reading
---

# Comfortable code reading on Flow

## Why

Reading code on the Flow canvas is uncomfortable: lines clip at ~81 chars, call pills cover line ends, long methods are skeletons, zoomed-out code is scaled text, the wheel pans the canvas, there is no history, find matches card names only. The idea (the flow as a canvas across services) stays; reading moves into a pane beside it. Three jobs weigh the same: read a path, see its shape, review an agent's change. (The standalone Agents window is the next cycle, `agents-standalone`.)

## Decisions

- Judged on the real canvas, not mockups: spike `spike/flow-reading-pane` (v1 → v3, five persona reviews twice; v3 scores: review 7, keyboard 6.5, design 6.5, newcomer 7). This branch starts at its last commit `bf26603`; the items below harden it into production code.
- The canvas is the map, the pane is the reading. While the pane is open a card is a one-line signature label, and the canvas draws the reading as a trace.
- The pane: read-only Monaco on the right, resizable, opens with the entry method, its open/closed state remembered. A call opens its callee as a peek under the call line, two deep; deeper, the callee takes the top and the chain above it stays as folded one-line headers (user, 2026-11-27). A cursor steps over / into / out of calls; the canvas follows it.
- A change reads in place in the same editor (added lines marked, removed lines under the line they followed), so peeks and stepping work in review. Keep/Undo live in the pane: per method on its peek and "Keep this path" with a "k of n kept" count in the pane header; Viewed in the pane shares the Changes rail's state; the card's own Keep/Undo hide while the pane is open (its +/− badge stays). (Lead's call, user delegated.)
- Keys only while the pane has the focus (the webview hands every key to the workbench too): j / l / h step over / into / out, plus Alt+F10 / Alt+F11 / Alt+Shift+F11 (user); Enter toggles the peek at the cursor; Escape closes the cursor's peek, at the top returns the focus to the card; [ ] back / forward, AltGr included. Bare F10/F11 and Alt+←/→ stay VS Code's. Alt+F10 is VS Code's "focus menu bar" (menubarControl.ts:308) and Alt+F11 is step-into on web+Windows (debugCommands.ts:517): inside the focused pane the pane's binding wins.
- Trace on the canvas: path to the cursor solid, read cards plain, the callee under the cursor full, the rest faded; in high-contrast themes borders instead of fading. (Lead's call, user delegated.)
- Look: VS Code theme tokens only (peek view, diff, debug stack-frame colours), no decoration.
- Probe on the site's production build (real `ui/` canvas, fake host over `site/demo`): `npm run setup` fails here (needs the Visual Studio 2022 C++ build tools), so an in-editor probe waits for them. The site dev server's blank canvas is pre-existing.
- Out of this cycle: payload/field view across HTTP and message hops ("follow the data"), service-lane layout, code search, stopping on branch lines.

## Rules

### RC01 Argument hints only when sure
- **Priority:** P1
- **Rule:** A peek header pairs call arguments with callee parameters by position only when the callee's name is a plain identifier, every argument is positional and every parameter a plain name; otherwise it shows no hint.
- **Source:** ui/src/read/reading.ts `bindings`; architect review (named args, kwargs, regex from labels).
- **Examples:**
  | call line | callee signature | hint |
  |---|---|---|
  | `billing.createInvoice(saved);` | `createInvoice(Order order)` | `order ← saved` |
  | `svc.issue(load(a, b), 2)` | `def issue(self, body, retries=3)` | `body ← load(a, b), retries ← 2` |
  | `s.f(b=1, a=2)` | `def f(self, a, b)` | none |
  | `s.f(x, y)` | `def f(a, **kwargs)` | none |
  | `f(opts)` | `function f({ a, b }: Opts)` | none |
  | `s.f(1)` | `void f(int a, int b)` | none (counts differ) |
  | label `X.get(` | any | none, no exception |
- **Test:**

### RC02 Keep this path keeps only the path's changed files
- **Priority:** P0
- **Rule:** "Keep this path" keeps the files of the changed methods in the pane's open document (the top method and its open peeks) and nothing else; it never undoes; the count says how many of those methods are kept.
- **Source:** decision above; keep is per file: ui/src/webview.tsx `keep` → `request('keep', { file })`.
- **Examples:**
  | open in the pane | changed methods (file) | Keep this path keeps | count after |
  |---|---|---|---|
  | `place` only | place (OrderService.java), applyDiscount (OrderService.java, not open) | OrderService.java | 2 of 2 kept (same file) |
  | `place` + peek `applyDiscount` | both in OrderService.java | OrderService.java once | 2 of 2 kept |
  | `place` | place (A.java), x (B.java, not open) | A.java only | 1 of 1 kept; B.java still pending |
  | nothing changed open | none | button hidden | — |
- **Test:**

### RC03 Pane keys
- **Priority:** P1
- **Rule:** The pane acts on j, l, h, Enter, Escape, [, ], Alt+F10, Alt+F11, Alt+Shift+F11 only while the focus is inside it; [ and ] count when typed with AltGr; any other key or modifier combination passes through untouched.
- **Source:** ui/src/read/ReadPane.tsx onKeyDown (v3 drops AltGr, line 166); ui/src/review/nav.ts:122-123 (AltGr rule); keyboard persona.
- **Examples:**
  | key | modifiers | focus | result |
  |---|---|---|---|
  | j | none | pane | step over |
  | j | none | canvas | not the pane's (canvas: next change) |
  | [ | Ctrl+Alt with AltGraph | pane | back |
  | [ | Ctrl (no AltGraph) | pane | passes through |
  | F11 | Alt | pane | step into |
  | F11 | none | pane | passes through (VS Code full screen) |
  | Enter | none, on a button | pane | the button's own |
- **Test:**

### RC04 Stepping
- **Priority:** P1
- **Rule:** Step over goes to the next call line of the method, and past its last call returns to the caller's next call; step into opens the callee at the cursor (a peek when the cursor's method is less than two deep, else the callee takes the top) and moves the cursor to its first call; step out returns to the calling line; several callees on one line are visited in order before the next line.
- **Source:** ReadPane.tsx stepOver/stepInto/stepOut; architect review (only the first callee on a line is reachable).
- **Examples:** (demo flow POST /orders)
  | cursor | step | cursor after |
  |---|---|---|
  | place (ctl) :20 | into | OrderService.place :23 (peek, depth 1) |
  | OrderService.place :25 (last call) | over → announce peek closed | ctl :20 has no next call: stays |
  | createInvoice :20 (depth 2) | into | create_invoice :11 at the top, folded chain `place:20 › place:24 › createInvoice:20` |
  | create_invoice :11 (top) | out | createInvoice :20 at the top |
  | line with calls a(), b() | into, out, over | a; back on the line; then b |
- **Test:**

### RC05 Pane state survives a re-trace
- **Priority:** P1
- **Rule:** History, open peeks and cursor follow a method by its file, first line and label, not by its card key; after a re-trace they stay on the same methods when those still exist, otherwise the pane reads the entry.
- **Source:** keys are positional `p${key++}` (editor/extensions/flow-view/src/poly/graph.ts:1293); architect review.
- **Examples:**
  | before | re-trace | after |
  |---|---|---|
  | reading BillingClient.createInvoice (key p3) | a call added earlier, now key p4 | still createInvoice |
  | peek applyDiscount open | applyDiscount removed by Undo | peek gone, cursor on its call line's method |
  | reading X | X no longer in the flow | the entry method |
- **Test:**

### RC06 The pane's open/closed choice
- **Priority:** P2
- **Rule:** The pane opens unless the user closed it last time; when storage is missing or throws it opens.
- **Source:** ui/src/webview.tsx paneStored/storePane.
- **Examples:** stored "closed" → closed; nothing stored → open; localStorage throws → open, closing still works for the page.
- **Test:**

## Items

- [ ] 1. Pure model for the pane: stepping (RC04), peek depth and re-rooting, open-set changes as add/remove lists, path/count for "Keep this path" (RC02), and the key map (RC03) in `ui/src/read/` modules without Monaco; ReadPane uses them.
  check: `cd ui && npm run typecheck && node --test test/reading.test.mjs test/read-model.test.mjs`
- [ ] 2. Stable identity (RC05): pane history, open peeks, cursor and the walked set keyed by file + first line + label; re-mapped on a new graph, reset to the entry when gone.
  check: `cd ui && node --test test/read-model.test.mjs`
- [ ] 3. Incremental peeks: one editor per open peek that persists; opening or closing adds or removes only its zone (layoutZone for height changes); measured header heights; peeks follow the pane's width; removed-line zones and a peek on the same line give correct cursor offsets.
  check: `cd ui && npm run typecheck && npm run build`
- [ ] 4. Folded chain above a re-rooted top: one line per ancestor with its call line, each a button back to it.
  check: `cd ui && npm run typecheck`
- [ ] 5. Keys per RC03, including Alt+F10/F11/Alt+Shift+F11 and AltGr; Escape closes the cursor's peek; the pane shows a visible focus ring (focusBorder; contrastActiveBorder in high contrast); the splitter is a focusable separator with aria-valuenow and arrow-key resize.
  check: `cd ui && node --test test/read-model.test.mjs && npm run typecheck`
- [ ] 6. Review in the pane: "Keep this path" with "k of n kept" (RC02), Viewed shared with the Changes rail, card Keep/Undo hidden while the pane is open, the "changed" marker in the gutter instead of after the line, the cursor drawn as an outline so it differs from added-line tint.
  check: `cd ui && node --test test/read-model.test.mjs && npm run typecheck`
- [ ] 7. Canvas trace without generated CSS: card and edge classes from data (path / read / next / dim), the callee under the cursor at full strength, borders instead of fading in high contrast; the signature card as a one-line label (no brace, no line number); `outline` passed to layout as an argument, not module state.
  check: `cd ui && npm test && npm run typecheck`
- [ ] 8. One centring helper for every pan on the flow canvas (tours included; the agent board has no pane and keeps its own) so none uses React Flow's stale size; panning frames the cursor's card and its callee.
  check: `cd ui && npm run typecheck && ! grep -n "rf.setCenter" src/tour/TourPlayer.tsx`
- [ ] 9. Hints: `serviceOf` uses paths relative to the flow's common folder; RC01 tests stay green.
  check: `cd ui && node --test test/reading.test.mjs`
- [ ] 10. Docs: README's canvas paragraph and the site's try page say how the pane, peeks, stepping keys and review in the pane work.
  check: `grep -q "reading pane" README.md`
- [ ] 11. Whole build and tests: ui, site build, flow-view tests, arch.
  check: `cd ui && npm test && npm run build && cd ../site && npm run build && cd ../editor/extensions/flow-view && npm test`

## Probe

Start: `cd site && npm run data && npm run build`, then the `site-preview` launch config (`vite preview`, .claude/launch.json) in the browser pane at 1440×900, `canvas.html`.
1. Load: the pane reads OrderController.place, cursor on :20; cards are one-line labels; the next callee card is not faded.
2. Click into the pane, press l, j: cursor on OrderService.place :24; canvas shows that card and BillingClient.createInvoice in view, the path solid.
3. Press l, l: create_invoice at the top with the HTTP strip and the folded chain `place:20 › place:24 › createInvoice:20`; click the first chain entry: back to ctl with the cursor on :20.
4. Press Alt+F11 / Alt+F10 / Alt+Shift+F11: same moves as l / j / h. Esc in a peek closes it.
5. ↻ re-trace: the pane stays on the same method.
6. `canvas.html?t=changes&mode=changed`: pane reads OrderService.place with its change in place; Enter on :23 opens applyDiscount's peek with its change; header shows "0 of 2 kept"; Keep this path → the change set is kept (fake host keeps all) and the count reads "2 of 2 kept".
7. Console: no errors.
Expected as written; AltGr cannot be pressed through the browser pane (covered by RC03's test). Not live: inside the editor (build tools missing).

## Log

- gather: started from the user's request (2026-11-26); split into Flow (this cycle) and agents-standalone (next)
- gather: design artifact with today's screens and options A/B/C, then as interactive prototypes; the user found them AI-slop and chose a spike in the real canvas
- gather: spike v1-v3 on spike/flow-reading-pane (bf26603), five persona reviews twice; decisions settled with the user (2026-11-27)
- plan: branch fast-forwarded to bf26603; plan written with RC01-RC06 and 11 items
- plan-review: started; reviewer on the plan file
