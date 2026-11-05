# Canvas board: a free drawing engine for agents (design v2, approved; phases 0-5 built, probe pending)

v2 folds in a design review (19 findings). What changed is marked **(v2)**.

## Phase 0 outcome (2026-11-05)

Built: `board-canvas/` (canvas.ts, measure.ts, layout.ts, route.ts, paint.ts, lint.ts, parse.ts) for rect, ellipse,
diamond, text, frame and arrow; the `board-canvas-imports-nothing` rule and the package in `npm run arch`; the MCP
`ToolResult` image block, `draw_board`'s `image` flag and the `render` → `image` round trip between host and
board webview (`flow-view/test/canvas-route.test.mjs`, `mcp-protocol.test.mjs`).

Learned, and folded into the design below:
- **Routing** needs every pair of exit/entry sides, not the dominant axis: in seed 16 of the random test the only
  clear path leaves the source at the top and enters the target at the bottom. The router now scores every
  candidate (text crossing 100 000, box crossing 10 000, length, 40 per unnatural side, 80 for a detour) and takes
  the cheapest; 204 arrows over 40 random layouts cross no text.
- **A detour must leave and enter on the side it travels along**, or its end legs run through the neighbour of an
  end.
- **`{type:'frame', frame:{…}}` collided with the common `frame` (parent id)**: the frame's own settings are
  `frameData`.
- **Text measurement** by a glyph table works in both builds; the first golden-style assertions pass.
- Not verified yet: the webview's answer to `render` in the running app (web-mode probe in phase 5).

## Phases 1-5 outcome (2026-11-05)

Built in one session, with tests: the five widgets (`board-canvas/widgets/{table,json,chart,matrix,code}.ts`, each with `size()` and `paint()`, a golden SVG in `flow-view/test/canvas-expected` and a check that its primitives stay inside its box), the 42 icons, `path`, port-addressed arrows, scenes (`show`/`open`/`lit`, `stepsSignature`), moves (hash per frame, dropped and reported when stale), `CanvasView` in the webview, the `move`/`note`/`resetMoves` messages, the overrides in workspaceState (`src/board/overrides.ts`), `draw_board`/`update_board` with `elements`, `read_board`, the schemas, `diagram_guide` and docs/boards.md.

Decisions made on the way, differing from or filling in the text above:
- **`spec.ts` stays pure.** It carries the canvas types by `import type` only (`BoardSpec.elements`, `purpose`, `layout`, `columns`, `BoardStep.show/open/lit`). The two copies differ in the path of that one import, so a test compares them with the path normalised. Parsing a canvas board, its steps and the patching live in `flow-view/src/board/canvas.ts` (no `vscode`, unit-tested), and `parseBoardWithNotes` refuses kind canvas with a pointer to it.
- **Painting is shared, the host draws too.** `paintCanvas` takes a palette and a scene; the webview resolves its theme tokens into one, the host uses the shared dark or light one for the lint, the boxes and the SVG it falls back to. `primitives.ts` sits below widgets and paint so widgets do not import layout.
- **Arrows name ports** (`{ el, port }`): the end is the row of that port, an input entered on the left, the output left on the right.
- **Moves.** The webview posts only `{ id, x, y }`; the host computes the frame hash (`moveHash`) from the tab's own spec. A moved element grows the picture; negative places are clamped to 0. `resetMoves` is a third message (the plan named move and note).
- **View-only collapse** is a `flip` option of the layout (a double click on a frame header); a scene's `open` still wins.
- **Limits** beyond the plan's: 12 table columns, 40 table rows kept, 200 points per series, 6 series, 200 KB of JSON value, 600 characters per note, 300 moves and 100 notes per board, 40 boards remembered.
- **Not done:** the lint "arrow touching a box edge" (the router keeps 8px clear, so it cannot happen); a PNG of a board that is not open in a tab (the host's SVG is the fallback); "open as canvas" of a structured board (stays Later).
- **Not verified yet:** the running app. The web-mode probe (drag, notes, steps, the render round trip in a real webview, light and dark themes) is phase 5's remaining part and is done in the main session.

## Goal

Give the agent Excalidraw-level freedom on a board: any shape, any place, any text, plus data widgets (table,
JSON tree, chart, matrix/heatmap, code), while the structured boards (flow, class, er, sequence, C4, state,
plan) keep their auto-layout, lint and symbol grounding. The agent must be able to look at what it drew.

Two uses drive every decision: **(A) teaching** a concept (text → tokens → embedding matrix → attention →
pooling → normalize, with typed inputs and outputs and honest origin labels) and **(B) explaining real
architecture and code** (services, calls, what a function returns, code tied to files, C4 boxes).

## Decisions

- **New board kind `canvas`.** Structured kinds stay as they are; "open as canvas" is a later phase.
- **(v2) One shared pure package, `board-canvas/`**, next to `protocol/`: types, parse, measure, layout, route,
  paint and SVG. It imports nothing, and both `ui/` and flow-view consume it (`.dependency-cruiser.cjs` rule, an
  arch test that it has no imports). So the host lays out, lints geometry and renders SVG itself, and the webview
  only draws and screenshots. This replaces v1's "geometric lint in the webview" and the duplicated `spec.ts`
  for canvas types: `board-canvas/canvas.ts` is the single source, `spec.ts` re-exports it with `export type`.
- **(v2) One width table everywhere.** Text is measured with a per-glyph width table in both host and webview
  (today's board already estimates with `LABEL_W`), so layouts are deterministic and golden-testable. The
  webview never re-measures.
- **v1 interaction: view, move, note.** No resize, free drawing or undo.
- **Clean style only**, on the existing `--fl-*` tokens, light and dark.
- **Pure SVG, no `foreignObject`.** Primitives (rect, text, path, circle, image) feed the screen (React), the SVG
  export and the PNG. **(v2)** The code widget is coloured by a ~3 KB tokenizer (keyword / string / comment /
  number for C-like, Python, SQL), not Monaco: `board.js` is 478 KB and the Monaco bundle 5.3 MB.

## Spec (`board-canvas/canvas.ts`)

**(v2) Discriminated union.** Common fields outside, widget data in a sub-object named after the type, so no field
names collide and the MCP schema is a `oneOf`.

```ts
type BoardKind = ... | 'canvas'
interface BoardSpec { ...; purpose?: 'concept' | 'code'; layout?: Layout; elements?: CanvasElement[] }
// kind 'canvas': `elements` required, `nodes`/`edges` ignored (lint info). parseBoard branches to parseCanvas.

interface Common {
  id: string; frame?: string
  x?: number; y?: number; w?: number; h?: number     // absolute, relative to the parent's content box
  label?: string; detail?: string                    // `code` spans allowed, as in captions
  style?: { fill?: Color; stroke?: Color; line?: 'solid' | 'dashed' | 'dotted'; text?: Color; weight?: 'normal' | 'bold'; size?: 's' | 'm' | 'l'; opacity?: number }
  link?: { symbol?: string; file?: string; line?: number; board?: string }   // board: zoom into another board
  origin?: 'source' | 'illustrative' | 'runtime'; source?: string           // runtime needs `source` ("test output", "log line 42"); missing → info
  note?: string; span?: number                        // span: grid columns taken
}
type CanvasElement = Common & (
  | { type: 'rect'; kind?: NodeKind; icon?: string; inputs?: Port[]; output?: Port; members?: BoardMember[] }  // (v2) kind colours like class boards; icon from the bundled set; io rows
  | { type: 'ellipse' } | { type: 'diamond' }
  | { type: 'text' }                                                         // wraps at w (default 240)
  | { type: 'frame'; frameData?: { layout?: Layout; columns?: number; gap?: number; pad?: number; align?: 'start' | 'center' | 'stretch'; collapsed?: boolean } }  // `frame` is the parent id on every element
  | { type: 'path'; path: { points?: [number, number][]; d?: string; closed?: boolean; smooth?: boolean } }
  | { type: 'arrow'; arrow: { from: End; to: End; route?: 'straight' | 'elbow' | 'curve'; head?: 'arrow' | 'open' | 'none' | 'both'; at?: number; data?: { type?: string; shape?: string } } }  // data drawn as a badge: "float[seq, d]"
  | { type: 'table'; table: { columns: { key: string; label?: string; align?: 'left' | 'right'; mono?: boolean; link?: boolean }[]; rows: Record<string, unknown>[]; maxRows?: number } }
  | { type: 'json'; json: { value?: unknown; schema?: SchemaNode; open?: number; maxItems?: number } }  // schema: a typed tree without values; value: an instance; both together: values under types
  | { type: 'chart'; chart: { kind: 'bar' | 'line' | 'scatter' | 'points2d'; series: Series[]; axes?: Axes } }   // (v2) no `vector`: use a 1×n matrix; projection goes in `detail`
  | { type: 'matrix'; matrix: { cells: number[][]; rowLabels?: string[]; colLabels?: string[]; dims?: string; scale?: 'diverging' | 'sequential'; range?: [number, number]; showValues?: boolean } }
  | { type: 'code'; code: { file?: string; lines?: [number, number]; text?: string; language?: string; highlight?: number[] } }  // host resolves file+lines into text at parse time (like symbols); text wins when both are given
)
type Port = { id: string; name: string; type?: string; value?: string; origin?: Origin; link?: Link }
type End = string | { el: string; side?: Side; port?: string } | { x: number; y: number }
type SchemaNode = { name: string; type: string; origin?: Origin; link?: Link; children?: SchemaNode[]; unknown?: boolean }  // unknown: type known, value not
type Series = { label: string; points: number[] | [number, number][]; labels?: string[]; color?: Color }
type Axes = { x?: { label?: string; range?: [number, number] }; y?: { label?: string; range?: [number, number] } }
type Layout = 'row' | 'column' | 'grid'
type Color = 'accent' | 'teal' | 'amber' | 'green' | 'violet' | 'red' | 'ink' | 'muted' | 'card' | 'canvas' | `#${string}`
interface BoardStep { ...; show?: string[]; open?: string[]; lit?: string[] }   // (v2) lit: element ids; nodes/edges are refused on a canvas (lint)
```

Limits: 300 elements, 60 frames, depth 3, 12 code lines, 24×24 matrix cells shown, 400 JSON nodes, 2000 chars
of text, 12 ports per element. Hex colours pass with an info note.

**(v2) Removed:** the `logo` element (now `rect.icon`), `purpose: 'runtime'` (until a debugger source exists),
chart `vector` and `projection`. The icon set (~40 MIT/CC0 marks, no cloud vendor icons) is listed in
`diagram_guide`; an unknown name draws a text chip and lints as info.

## Layout (`board-canvas/layout.ts`)

- Default sizes **(v2)**: rect 160×64 (+18 per io row / member), ellipse 120×72, diamond 140×80, text wraps at
  240, widgets from `size(el)`. A frame has a 28px header when labelled, `pad` 14, `gap` 16, radius 8; collapsed
  200×64 with "n elements".
- A frame is either flow or absolute **(v2)**: if any child has `x`/`y`, all its children are absolute (missing
  coordinates lint as warning and default to a column). Root default is `grid` **(v2)**, 3 columns.
- Layout always runs on the full element set; hidden elements keep their place **(v2)**.
- User moves are absolute `{x, y}` per element, relative to its frame, stored with a hash of that frame's layout
  input **(v2)**; when the hash changes the move is dropped and the toolbar says "n moves reset".

## Arrows (`board-canvas/route.ts`)

Anchors by dominant axis unless `side`/`port`; `straight` and `curve` (today's bezier); `elbow` **(v2)** routes
through channels: the gap between rows/columns or the margin outside the frame, never through a sibling. Two
arrows between the same pair are offset 9px. An arrow to a child of a collapsed frame attaches to the frame
(like `litVisible`/`rep` today) **(v2)**. Labels and `data` badges sit on the longest segment with a canvas halo.
Lint: through text → warning; touching a box edge → info.

## Scenes

`show`: visible elements (absent: all; an arrow is hidden when an end is hidden; a collapsed frame hides its
children). `open`: frames expanded for the step. `lit`: highlighted, the rest dimmed. Positions never move
between steps; the frame opening is the only animation (250ms). `stepsSignature` includes show/open/lit **(v2)**.

## Interaction (v1)

Pan/zoom, select, click a linked element or port to open its file, drag to move, hover "+ note" → popover,
double-click a frame header to collapse/expand (view only), "Reset positions", steps and export as today. Purpose
shows as a toolbar chip; origin as a pill on the element or port.

## Messages

ToHost adds `{type:'move', id, x, y}`, `{type:'note', id, text}`, `{type:'image', seq, png}`. ToWebview adds
`{type:'render', seq, step?}` and `overrides` on bootstrap/board. These are `switch` cases in `boardPanel.ts`,
not command ids: the Semgrep allowlist is unaffected; the webview-security-reviewer agent checks the handlers
**(v2)**. The `png` is capped at 1600px wide, 1× scale.

## MCP

- **(v2)** `ToolResult.content` gains `{type:'image', data, mimeType}` through `protocol.ts` → `http.ts` →
  `stdio.ts` → `mcp/insilode-mcp.ts`.
- `draw_board` accepts the canvas kind; `image?: boolean | { step: number }` (default true) asks for a PNG; the
  result carries structural + geometric lint, the final boxes `{id: {x, y, w, h}}` **(v2)** and the PNG. On a
  10s timeout: the host's own SVG as text and a note.
- `update_board` gains `elements` patches: `{id, ...fields}` merges, `{id, remove: true}` removes, a new id adds.
- `read_board(id)` returns the spec, the boxes and the overrides `{moves: {id: {x, y}}, notes: {id: text}}`.
- `diagram_guide` gets a canvas section: frames instead of coordinates, scenes with `show`/`lit`, `origin` on
  every value, `purpose` first, the icon list.

## Lint (all on the host, `board-canvas/lint.ts`)

Errors (element dropped): unknown frame/arrow/port id, arrow to itself, frame cycle or depth > 3, ragged matrix,
series length mismatch. Warnings: code > 12 lines or file missing, mixed flow/absolute frame, unknown symbol
(today's groundBoard), arrow through text, overlapping boxes, element outside its frame, `nodes`/`edges` on a
canvas step. Info: hex colour, `purpose: code` with no link, `origin: runtime` without `source`, unknown icon,
arrow touching a box, `nodes` on a canvas board.

## Phases and estimates (v2: roughly doubled)

| # | Phase | Where | Est. |
|---|---|---|---|
| 0 | Prototype: `board-canvas/` skeleton, channel routing over 20 random layouts, PNG round trip; go/no-go | main | 2 h |
| 1 | Contract: types + parseCanvas, `Primitive` and `Widget` (`size`, `paint`) interfaces, one example widget (table), golden fixture format, structural lint, MCP schema + image content, messages, guide text; committed before fan-out | main | 3 h |
| 2a | Layout + routing + paint + SVG, golden tests | main | 4 h |
| 2b | CanvasView: drag, notes, overrides, render/image round trip, export | main | 4 h |
| 3 | Widgets: json · chart · matrix · code (table is the phase-1 example) | 4 implementers | 2 h |
| 4 | Scenes, breadcrumb, purpose/origin, read_board, boxes in results | main | 2 h |
| 5 | Verify: arch, semgrep, flow-view tests, ui build, web-mode probe, architecture + webview-security reviewers | — | 2 h |

About 19 hours of agent time; phase 3 runs four implementers in parallel.

## Later

Open a structured board as a canvas; resize, free drawing, undo; verified small computations (normalize, dot,
softmax, matmul) with editable inputs; `purpose: runtime` with values from a debugger.
