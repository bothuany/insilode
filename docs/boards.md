# Boards: the diagram format agents draw

An agent draws a board with the `draw_board` tool of the `insilode` MCP server (`editor/extensions/flow-view/src/mcp`). The board is JSON, checked by `parseBoard` (`src/board/spec.ts`, mirrored byte for byte in `ui/src/board/spec.ts`), laid out automatically (agents never send coordinates) and drawn by the board canvas (`ui/src/board`). The research behind the design is `docs/research/agent-diagrams.md`.

`version: 1` stays: every field below is optional and old boards parse unchanged.

## Board

| Field | Meaning |
| --- | --- |
| `kind` | `flow`, `plan`, `class`, `er`, `sequence`, `architecture`, `state`. An unknown kind is drawn as `flow` and the answer says so. |
| `title`, `description`, `direction` | As before (`LR` or `TB`). |
| `level` | `architecture` only (C4): `context`, `container`, `component`. |
| `legend` | `[{ key, text }]`: what an agent's own colours or edge kinds mean. |
| `focus` | Node or group id opened first. |
| `base` | Id of another board to compare with: the host marks what is added, removed or changed. Its own id compares the board with its previous draw. |
| `steps` | `[{ title, caption, nodes?, edges?: [from, to][], focus? }]`: played like a tour. |
| `highlight` | `[{ path: [id, ...], label? }]`: a route drawn bold, the rest dimmed. |
| `callouts` | `[{ node | edge: [from, to], text }]`: a note drawn as a bubble on a node or an edge. |

## Node

`id`, `label`, `kind`, `detail`, `group`, `file`, `line`, `status`, `members`, `note` as before; `status` and `note` work on every kind of board.

| Field | Meaning |
| --- | --- |
| `symbol` | A real code symbol (`OrderService.Place`). `draw_board` checks it against the index, fills `file` and `line` when the node has none, and suggests the closest symbols when it is not found. Leave it off for something that does not exist yet. |
| `tech` | C4: the technology, shown as `[tech]` under the label. |
| `shape` | `rect`, `round`, `diamond`, `cylinder`, `actor`, `cloud`, `initial`, `final`, `choice`. `initial`, `final` and `choice` are small marks without text (the label is the tooltip). |
| `change` | `added`, `removed`, `changed`. The host fills it for a board with a `base`; an agent may set it on a proposed design. |
| `lane` | Id of a group of kind `lane` (swimlane). |
| `zoom` | Id of the board that shows this box one level down (C4). |

## Edge

`from`, `to`, `label`, `kind`, `fromCard`, `toCard` as before.

| Field | Meaning |
| --- | --- |
| `order` | 1, 2, 3...: shown as a number badge; a sequence is drawn in this order; the default step order. |
| `style` | `solid`, `dashed` (a return or reply), `dotted`. |
| `async` | An asynchronous message: open arrow head. |
| `guard` | A state transition's condition, shown as `[guard]` before the label. |
| `change` | `added`, `removed`, `changed`. |
| `fragment` | Sequence: id of the `alt`, `loop` or `opt` group this message sits in. |

## Group

`id`, `label`, `parent`, `collapsed` as before.

| Field | Meaning |
| --- | --- |
| `kind` | `boundary` (C4), `lane`, `layer`, and the sequence fragments `alt`, `loop`, `opt`. |
| `tech` | C4: the technology of a boundary. |

A fragment boxes the messages whose `fragment` names it; its label is the condition. A group of the same kind whose `parent` is an `alt` group is that alt's else branch.

## What the answer of `draw_board` says

The first line names the board: `Board "id" drawn ...: kind, N nodes, M edges, V visible, ~C crossings.` Then a numbered `LINT` list (at most 10 lines, errors first):

- what `parseBoard` dropped or changed (an unknown kind, status, shape or style; an edge to a node that does not exist, with the nearest id; a duplicate id; a step or callout that names nothing);
- files that are outside the workspace or do not exist, a `line` past the end of the file, symbols that are not in the index (with the closest ones);
- orphan nodes, two nodes with the same label, unlabelled flow or sequence edges, a decision with fewer than two branches, a plan with a cycle, empty or single-node groups, nesting deeper than 2;
- more than 25 visible nodes, more than 35 edges, more than 12 estimated crossings, more than 8 lifelines, a sequence without `order`;
- hints: no initial state, no `tech` on a C4 container, no `steps` on a board of more than 6 nodes, nothing linked to code.

Draw again with the same `id` to fix it. The previous version of a board is kept in memory (`StoredBoard.previous`).

`update_board` changes a node's `status`, `note` or `change`, takes several nodes in `updates`, and sets the `highlight` routes, without a redraw.

The `diagram_guide` MCP prompt (`src/mcp/prompts.ts`) holds the full advice an agent gets.

## Kinds and how they are drawn

- **sequence** (`ui/src/board/sequence.ts`): lifelines in node order, messages top to bottom by `order` (those without come last), a dashed `style` is a reply, `async` an open head, a call opens an activation bar its reply closes, groups of kind `alt`/`loop`/`opt` box the messages whose `fragment` names them (a same-kind child of an `alt` is its else), callouts become notes. At most 8 lifelines read well; the lint says so.
- **state**: rounded states, `shape` `initial`/`final`/`choice` marks, transitions labelled `[guard] event`, self transitions.
- **architecture** with `level`: boundary groups are dashed frames with their `tech`, `tech` shows under the label, `zoom` makes a double click (or the badge) open the board with that id, and a board that other boards zoom into shows an up chip. Draw one board per level.
- **flow, class, er, plan**: as before, plus edge order badges, `style`, `async`, callouts, `shape`.

## Steps, routes and compare

- `steps` play through the shared tour player (`ui/src/tour`: reducer, bar and caption are the flow canvas's own): each step lights its `nodes` and `edges`, fades the rest, opens the groups around them and moves the camera; arrow keys, space and Esc work as on the flow canvas. A board without `steps` but with at least two `order`ed edges offers a "Walk through" in message order (never started by itself). `highlight` routes stay bold until a walk starts; the chip next to the title switches them off.
- A board with a `base` is drawn compared with that board (`src/board/compare.ts`): nodes and edges that are new or different get `change` `added` or `changed`, and what the base had and this board lacks is drawn again as `removed` (struck through). The same colours as skeleton first: green, amber, red. When a board is redrawn with its id, the toolbar offers **Changes**: the board against its previous draw (kept in memory). The toolbar counts `+added −removed ~changed`.

## Mermaid in

`draw_board` takes `source: { mermaid }` instead of `board.nodes` and `board.edges`: a `sequenceDiagram` (participants, actors, messages with `->>`, `-->>`, `-)`, notes, `alt`/`else`/`opt`/`loop`), a `stateDiagram-v2` (`[*]`, transitions with `[guard]`, `state "x" as y`, `<<choice>>`, composite states, notes) or a `flowchart`/`graph` (shapes, `-->|text|`, `-- text -->`, `-.->`, `&` lists, chains, subgraphs). `board` may still carry `title`, `steps`, `callouts` and the like, but not nodes or edges. What cannot be read is said with line numbers (`src/board/mermaidImport.ts`, input capped at 60,000 characters and 800 lines); styling lines are ignored. `toMermaid` writes the same subset, so a board round-trips.

## Symbol grounding

A node's `symbol` is looked up in the methods of the node's own `file` (the code index, the C# analyzer or a language server, so it works while the workspace symbol search is still loading) and in the workspace symbol search (3 seconds, and not asked again once it fails to answer; at most 25 symbols per board and 10 seconds in all). A hit fills `file` and `line` when the node has none; a miss lists the closest symbols (`find_symbol` style) in the lint. If the search did not answer at all, the lint says symbols were checked against the named files only.


## Canvas boards

Kind `canvas` is the free drawing: for teaching a concept (text, tokens, an embedding matrix, attention, pooling, with typed inputs and outputs and honest origin labels) and for explaining real architecture and code side by side. The structured kinds above keep their auto-layout, lint and symbol grounding; a canvas board has `elements` instead of `nodes` and `edges` (the spec carries empty arrays). The engine is `board-canvas/` (types, parse, measure, layout, route, paint, lint, the widgets and the icons), a package that imports nothing, so the extension host (the picture and the lint an agent gets) and the canvas webview (what the user sees) lay out and draw with the same code. The design is [plans/canvas-board.md](plans/canvas-board.md).

| Field | Meaning |
|---|---|
| `purpose` | `concept` (teaching an idea) or `code` (explaining real code); shown as a chip. |
| `layout`, `columns` | How the root places elements: `row`, `column` or `grid` (default, 3 columns). |
| `elements` | At most 300: `{ id, type, frame?, x?, y?, w?, h?, label?, detail?, style?, link?, origin?, source?, note?, span? }` plus the data of the type, in a sub-object named after it. |
| `steps[].show`, `open`, `lit` | A step's scene: the element ids drawn (absent: all), the collapsed frames opened, the elements kept at full strength while the rest dims. Nothing moves between steps. |

Element types: `rect` (label, detail, `kind` colour, `icon`, typed `inputs` and `output` rows, `members`), `ellipse`, `diamond`, `text`, `frame` (`frameData`: `layout`, `columns`, `gap`, `pad`, `align`, `collapsed`; frames hold elements by `frame` and lay them out as a row, a column or a grid, so an agent rarely needs coordinates; a frame whose children have `x`/`y` is absolute), `path` (`points` or sanitised `d`), `arrow` (`from`, `to` as an id, `{ el, side?, port? }` or a point; `route` elbow, straight or curve; `head`; `at`; `data: { type, shape }` drawn as a badge; an elbow arrow runs along the gaps and never through text) and the widgets below.

| Widget | Data | Limits |
|---|---|---|
| `table` | `columns` (`key`, `label`, `align`, `mono`, `link`), `rows`, `maxRows` | 12 columns, 40 rows kept, 8 drawn by default |
| `json` | `value`, a typed `schema` (`name`, `type`, `origin`, `unknown`, `children`), or both; `open`, `maxItems` | 400 nodes, 200 KB of value |
| `chart` | `kind` bar, line, scatter or points2d; `series` (`label`, `points` as numbers or pairs, `labels`, `color`); `axes` | 6 series, 200 points; bar and line series need equal lengths |
| `matrix` | `cells`, `rowLabels`, `colLabels`, `dims`, `scale` diverging or sequential, `range`, `showValues` | 24 x 24 cells drawn, rows must be equal in length |
| `code` | `text`, or `file` + `lines` (the host reads them inside the workspace); `language`, `highlight` | 12 lines; coloured by a small tokenizer (C-like, Python, SQL), not Monaco |

Every value an agent shows should say where it comes from: `origin` is `source` (in the code or the data), `illustrative` (made up to teach) or `runtime` (observed; give `source`, e.g. "test output"), drawn as a pill on the element or a tag on the port row. `link` (`symbol`, `file` + `line`, or `board`) makes a click open code or zoom into another board; a symbol is checked against the index like a node's. The icon set is 42 outline glyphs (`board-canvas/icons.ts`); an unknown name is drawn as a text chip.

**The answer** of `draw_board` and `update_board` on a canvas board says: what the parser dropped (an unknown or duplicate id, an arrow to nothing or to an unknown port, a ragged matrix, series of different lengths, a widget without its data), the lint (warnings: more than 12 lines of code or a file that could not be read, overlapping boxes, an element outside its frame, an arrow through text, a frame that mixes placed and unplaced children; hints: hex colours, `origin: runtime` without `source`, an unknown icon, `purpose: code` with no link), the final box of every element, and a PNG of the board tab (`image: false` skips it, `image: { step: n }` draws step n; when the tab does not answer in 10 seconds the answer carries the host's own SVG instead).

`update_board` takes `elements` patches: `{ id, ...fields }` merges into that element (`style` one level deep), `{ id, remove: true }` removes it and the arrows that end there, an unknown id adds an element; the merged board is parsed again, so a patch is checked like a drawing.

**What the user does by hand.** Pan and zoom, drag an element (its place is stored per board id in the workspace state with the hash of its frame's layout input; when the agent changes that input the move is dropped and the toolbar says "n moves reset"), "Reset positions", a note on any element (hover, "+ note"), a click on an element or a port row that links to code or a board, a double click on a frame header to collapse or expand it (view only). The webview posts `move`, `note` and `resetMoves`; each is a case in `boardPanel.ts` that checks the element id against the board and bounds the numbers and text, and the host computes the frame hash itself. `read_board(id)` gives an agent the spec, the boxes and `{ moves, notes }`, so it can answer a note and keep what the user placed when it redraws.
