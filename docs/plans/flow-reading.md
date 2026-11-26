---
cycle: flow-reading
author: rbdikmen@gmail.com
phase: code-review
branch: cycle/flow-reading
---

# Comfortable code reading on Flow

## Why

Reading code on the Flow canvas is uncomfortable: lines clip at ~81 chars, call pills cover line ends, long methods are skeletons, zoomed-out code is scaled text, the wheel pans the canvas, there is no history, find matches card names only. The idea (the flow as a canvas across services) stays; reading moves into a pane beside it. Three jobs weigh the same: read a path, see its shape, review an agent's change. (The standalone Agents window is the next cycle, `agents-standalone`; its gather tries both a VS Code core patch and a native Rust Agents app side by side, user 2026-11-27.)

## Decisions

- Judged on the real canvas: spike `spike/flow-reading-pane` (v1 → v3, five persona reviews twice; v3: review 7, keyboard 6.5, design 6.5, newcomer 7). This branch starts at its last commit `bf26603`; the items harden it into production code.
- The canvas is the map, the pane is the reading. While the pane is open a card is a one-line signature label and the canvas draws the reading as a trace: path to the cursor solid, read cards plain, the callee under the cursor full, the rest faded (borders instead of fading in high contrast).
- The pane: read-only Monaco on the right, resizable, opens with the entry method, its open/closed choice remembered. A call opens as a peek under its line, two deep; deeper, the callee takes the top and the chain above stays as folded one-line headers (user, 2026-11-27). A cursor steps over / into / out of calls; the canvas follows it.
- Where the pane opens: in the editor and on the site's try page; not on the site's home hero (a scrolling page, the canvas is a picture there). While a tour plays the pane hides and cards show their code; it comes back when the tour ends.
- A change reads in place (added lines marked, removed lines under the line they followed), so peeks and stepping work in review. Keep/Undo live in the pane: per method on its header or peek, and "Keep this path" with a "k of n kept" count. Keep in the pane is always `keepCard` on the method's own lines (user, 2026-11-27, after code review): the canvas knows only the changed methods drawn in the flow, so a whole-file keep could keep an unread change; the host forgets the file itself once nothing is left in it (agentDiff.ts keepInRange). Viewed in the pane shares the Changes rail's state; the card's Keep/Undo hide while the pane is open (its +/− badge stays). (Lead's call, user delegated.)
- Keys only while the pane has the focus (the webview hands every key to the workbench too): j / l / h and Alt+F10 / Alt+F11 / Alt+Shift+F11 step over / into / out (user); Enter toggles the peek at the cursor; Escape closes the cursor's peek, at the top returns the focus to the card; [ ] back / forward, AltGr included. Bare F10/F11 and Alt+←/→ stay VS Code's. Inside the focused pane Alt+F10 (VS Code: focus menu bar, menubarControl.ts:308) and Alt+F11 (step into on web+Windows, debugCommands.ts:517) are the pane's.
- Look: VS Code theme tokens only (peek view, diff, debug stack frame), no decoration.
- Probe on the site's production build (real `ui/` canvas, fake host over `site/demo`): `npm run setup` fails here (needs the Visual Studio 2022 C++ build tools); an in-editor probe waits for them. The site dev server's blank canvas is pre-existing.
- Out of this cycle: the payload view across HTTP/message hops ("follow the data"), service lanes, code search, stopping on branch lines, one centring helper for tours (TourPlayer.tsx:378 keeps React Flow's setCenter; separate fix).

## Rules

### RC01 Argument hints only when sure
- **Priority:** P1
- **Rule:** A peek header pairs call arguments with callee parameters by position only when the callee's name is a plain identifier, every argument is positional and every parameter a plain name; otherwise it shows no hint.
- **Source:** ui/src/read/reading.ts `bindings`; architect review.
- **Examples:**
  | call line | callee signature | hint |
  |---|---|---|
  | `billing.createInvoice(saved);` | `createInvoice(Order order)` | `order ← saved` |
  | `svc.issue(load(a, b), 2)` | `def issue(self, body, retries=3)` | `body ← load(a, b), retries ← 2` |
  | `s.f(b=1, a=2)` / `s.f(x, y)` into `f(a, **kwargs)` / `f(opts)` into `f({ a, b })` | — | none |
  | `s.f(1)` | `void f(int a, int b)` | none (counts differ) |
  | label `X.get(` | any | none, no exception |
- **Test:** ui/test/reading.test.mjs, the six `flow-reading/RC01 bindings …` tests (pairs Java arguments; reads Python and keeps nested calls whole; drops annotations and generics; gives nothing when counts or names differ; nothing for named/keyword/spread/destructured; never throws on regex-syntax labels)

### RC02 Keep this path keeps exactly the open changed methods
- **Priority:** P0
- **Rule:** "Keep this path" keeps each changed method open in the pane (the top method, its open peeks and the folded chain above) by its own lines only (`keepCard`); it never keeps a method that is not open and never undoes; the count is open changed methods kept of open changed methods.
- **Source:** editor/extensions/flow-view/src agentDiff.ts:666 (`keep` forgets the whole file) and :672 (`keepCard`, keepInRange); code review 2026-11-27 (the canvas sees only drawn methods; ui/src/agentEdit/AgentEditActions.tsx:21-24 has the same blind spot, pre-existing).
- **Examples:**
  | open in the pane | changed methods | Keep this path does | count |
  |---|---|---|---|
  | `place` only | place, applyDiscount (both OrderService.java) | keepCard place's lines | 1 of 1; applyDiscount still pending |
  | `place` + peek `applyDiscount` | same | keepCard both | 2 of 2 |
  | `place` | place (A.java, only change there), x (B.java, not open) | keepCard place (host then forgets A.java) | 1 of 1; B.java pending |
  | `place` | place, plus z in OrderService.java not on the flow | keepCard place | 1 of 1; z pending |
  | top `create_invoice`, chain `place › place › createInvoice`, place and applyDiscount changed | place (in the chain) | keepCard place | 1 of 1; applyDiscount pending |
  | nothing changed open | — | button hidden | — |
- **Test:** ui/test/read-model.test.mjs, `flow-reading/RC02 …`: one of two changed methods open keeps its own lines; method and peek both open; the only changed method of a file keeps the whole file and an unopened one is never kept; a changed method of the file that is not on the flow; a method in the folded chain; nothing changed open

### RC03 Pane keys
- **Priority:** P1
- **Rule:** The pane acts on j, l, h, Enter, Escape, [, ], Alt+F10, Alt+F11, Alt+Shift+F11 only while the focus is inside it; [ and ] count when typed with AltGr; any other key or modifier combination passes through untouched.
- **Source:** ui/src/read/ReadPane.tsx onKeyDown (v3 drops AltGr, line 166); ui/src/review/nav.ts:122-123.
- **Examples:**
  | key | modifiers | focus | result |
  |---|---|---|---|
  | j | none | pane / canvas | step over / not the pane's (canvas: next change) |
  | [ | Ctrl+Alt with AltGraph / Ctrl only | pane | back / passes through |
  | F11 | Alt / none | pane | step into / passes through (VS Code full screen) |
  | Enter | none, on a button | pane | the button's own |
- **Test:** ui/test/read-model.test.mjs, `flow-reading/RC03 …`: j/l/h/Enter/Escape only in the pane; brackets with AltGr and not with Ctrl or Alt alone; Alt+F10, Alt+F11, Alt+Shift+F11 and bare F10/F11; any other combination passes; buttons and text fields keep their own keys

### RC04 Stepping
- **Priority:** P1
- **Rule:** Over goes to the next call line of the cursor's method; past its last call it closes that peek and goes to the caller's next call; at the top method's last call it stays. Into opens the callee on the cursor's call line (a peek under two deep, else the callee takes the top with the chain folded above) and puts the cursor on its first call; a callee without code opens its peek and the cursor stays; on a line without a call, into is over. Out returns to the calling line; at the top it reads the caller (if any) with the cursor on the calling line, else stays. Several callees on one line are visited in order before the next line.
- **Source:** ReadPane.tsx stepOver/stepInto/stepOut (:134-160); architect review (only the first callee on a line is reachable).
- **Examples:** (demo POST /orders)
  | cursor | step | cursor after |
  |---|---|---|
  | ctl place :20 | into | OrderService.place :23 (peek, depth 1) |
  | OrderService.place :23 (`orders.save`, a table) | into | table peek opens, cursor stays :23 |
  | OrderService.place :25 (last call) | over | peek closed, cursor ctl :20 (top, no next call: stays) |
  | ctl place :18 (no call) | into | over: :20 |
  | createInvoice :20 (depth 2) | into | create_invoice :11 at the top, chain `place:20 › place:24 › createInvoice:20` |
  | create_invoice :11 (top) | out | createInvoice :20 at the top |
  | ctl place :20 (top, no caller) | out | stays |
  | line with calls a(), b() | into, out, over | a; back on the line; then b |
- **Test:** ui/test/read-model.test.mjs, `flow-reading/RC04 …`: into opens a peek on the first call; a callee without code; over past the last call (and on to the caller's next call); into on a line without a call is over; into past the second peek with the chain, and out at the top reads the caller; out of a peek and at the top; several callees on one line in order; Enter toggles the peek

### RC05 Pane state survives a re-trace
- **Priority:** P1
- **Rule:** History, open peeks, cursor and the walked set follow a method by its path from the entry (each step: callee label and its call's position among the caller's calls), not by card key or line numbers; after a re-trace they stay on the methods whose path still exists, otherwise the pane reads the entry.
- **Source:** keys are positional `p${key++}` (editor/extensions/flow-view/src/poly/graph.ts:1293); line numbers move on Undo (site/demo changed OrderService.java: announce 54 → 45).
- **Examples:**
  | before | re-trace | after |
  |---|---|---|
  | reading createInvoice (key p3) | a call added earlier, key now p4 | still createInvoice |
  | reading announce (:54) | Undo of applyDiscount, announce now :45 | still announce, cursor on its :46 call |
  | peek applyDiscount open | applyDiscount call removed | peek gone, cursor on place |
  | the same method reached twice | — | each occurrence its own path |
  | reading X | X no longer in the flow | the entry |
- **Test:** ui/test/read-model.test.mjs, `flow-reading/RC05 …`: a call added earlier moves every key; line numbers move on Undo; a peek whose call was removed; the same method reached twice; a method that left the flow; history and walked paths pruned

### RC06 The pane's open/closed choice
- **Priority:** P2
- **Rule:** The pane opens unless the user closed it last time; when storage is missing or throws it opens; the site's home hero never opens it.
- **Source:** ui/src/webview.tsx paneStored/storePane (:90-101).
- **Examples:** stored "closed" → closed; nothing stored → open; localStorage throws → open; home hero → closed.
- **Test:** ui/test/read-model.test.mjs, `flow-reading/RC06 …`: opens unless closed last time; storage missing or throwing; the home hero never opens it and a tour hides it

## Items

- [x] 1. Pure model in `ui/src/read/model.ts` (no Monaco): stepping (RC04), paths (RC05), the key map (RC03), Keep-this-path targets and count (RC02), open-set changes as add/remove lists, the folded chain; ReadPane and webview use it; RC01 tests renamed `flow-reading/RC01 …`.
  check: `cd ui && npm run typecheck && node --test --test-name-pattern "flow-reading/RC0[1-5]" test/reading.test.mjs test/read-model.test.mjs`
- [x] 2. Stable paths in the pane and webview (RC05): history, open peeks, cursor, walked set re-mapped on a new graph.
  check: `cd ui && node --test --test-name-pattern "flow-reading/RC05" test/read-model.test.mjs`
- [x] 3. Incremental peeks: one editor per open peek that persists; open/close adds or removes its zone only; measured header heights (layoutZone); peeks follow the pane's width; removed-line zones and a peek on one line give correct offsets (zone order in a tested pure function).
  check: `cd ui && node --test --test-name-pattern "peek zones" test/read-model.test.mjs && npm run build`
- [x] 4. Folded chain above a re-rooted top, one line per ancestor with its call line, each a button back to it.
  check: `cd ui && node --test --test-name-pattern "folded chain" test/read-model.test.mjs`
- [x] 5. Keys per RC03; Escape closes the cursor's peek; visible focus ring (focusBorder, contrastActiveBorder); the splitter a focusable separator with aria-valuenow and arrow-key resize.
  check: `cd ui && node --test --test-name-pattern "flow-reading/RC03" test/read-model.test.mjs && grep -q "aria-valuenow" src/webview.tsx`
- [x] 6. Review in the pane per RC02: Keep / Undo per method, Keep this path with its count, Viewed shared with the rail, card Keep/Undo hidden while the pane is open, the "changed" marker in the gutter, the cursor as an outline.
  check: `cd ui && node --test --test-name-pattern "flow-reading/RC02" test/read-model.test.mjs && npm run typecheck`
- [x] 7. Canvas trace from data (card and edge classes path / read / next / dim, no generated CSS), high-contrast borders, the signature card as a one-line label, `outline` as a layout argument; pane closed on the home hero and hidden while a tour plays (RC06).
  check: `cd ui && ! grep -n "^let outline" src/layout.ts && ! grep -n "readingCss" src/webview.tsx && node --test --test-name-pattern "flow-reading/RC06" test/read-model.test.mjs && npm test`
- [x] 8. Hints: `serviceOf` relative to the flow's common folder, tested with Windows paths (drive letter, backslashes, case).
  check: `cd ui && node --test --test-name-pattern "serviceOf" test/reading.test.mjs`
- [x] 9. Docs: README's canvas paragraph (README.md:34 no longer promises editable code on every card) and the try page describe the pane, peeks, stepping keys and review in the pane.
  check: `grep -q "reading pane" README.md && grep -q "reading pane" site/try/index.html && ! grep -q "each with its real, editable code" README.md`
- [x] 10. Whole build and tests (root deps via `npm ci` first if missing).
  check: `npm run arch && cd ui && npm test && npm run build && cd ../site && npm run build && npm run test:e2e && cd ../editor/extensions/flow-view && npm test`

## Probe

Start: `cd site && npm run data && npm run build`, then the `site-preview` launch config in the browser pane at 1440×900, `canvas.html`.
1. Load: the pane reads OrderController.place, cursor on :20; cards are one-line labels; OrderService.place (the callee) is not faded.
2. Click into the pane, press l, j: cursor on OrderService.place :24, both cards in view, path solid; the createInvoice peek after l shows `(order ← saved)`.
3. Press l: create_invoice at the top with the HTTP strip and the chain `place:20 › place:24 › createInvoice:20`; click the first entry: ctl with the cursor on :20.
4. Alt+F11 / Alt+F10 / Alt+Shift+F11 do what l / j / h do; Esc in a peek closes it.
5. `canvas.html?t=changes&mode=changed`: OrderService.place with its change in place; Enter on :23 opens applyDiscount with its change; header "0 of 2 kept"; Keep this path → the fake host keeps the whole change set and the changes view says there are no changes to show (host.ts:28-29).
6. The home page (`/`): the hero canvas shows no pane. Console: no errors.
Not covered live: AltGr (RC03 test), re-trace with moved keys (RC05 test; the fake host returns the same keys), in-editor behaviour (build tools missing).

## Log

- gather: started from the user's request (2026-11-26); split into Flow (this cycle) and agents-standalone (next)
- gather: design artifact (options A/B/C, then interactive); the user found them AI-slop and chose a spike in the real canvas
- gather: spike v1-v3 on spike/flow-reading-pane (bf26603), five persona reviews twice; decisions settled with the user (2026-11-27)
- plan: branch fast-forwarded to bf26603; plan written with RC01-RC06 and 11 items
- plan-review: reviewer found 9 (RC02 kept unread methods, RC04/RC05 examples wrong, weak checks, hero/tour scope, fake-host probe step); all settled: RC02 reuses keepCard, RC04/RC05 rewritten, checks use test-name patterns, tour centring split out, 10 items; waiting for the user's approval
- plan-review: approved by the user (2026-11-27) after the plan screens on the design board (page "Plan: son hal")
- build: started; writer on the plan
- build: writer ticked 10/10; plan-check PASS 10/10 · rules 5/5; ui 200 pass, site e2e 20 pass, flow-view 793 pass / 15 skipped, arch green
- code-review: started
- code-review: 13 findings (2 reproduced: RC02 whole-file keep keeps unread changes, RC05 occurrence re-maps a removed call's peek); RC02 changed to always keepCard with the user's approval (2026-11-27); all findings sent to the writer
