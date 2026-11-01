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

## Boards survive a reload

The store (`src/board/store.ts`) saves its boards in the workspace state (`flow.boards.v1`) a moment after every change, and loads them when the window starts. A loaded board is held, not shown: no tab opens until you run **Show Board…**. Only what is needed to draw a board again is saved (spec, origin, session, plan file, times); the previous draw that **Changes** compares with stays in memory. A saved board that is damaged is skipped.

- At most 30 boards are kept, oldest first. A board that comes from a plan, or is open in a tab, is never removed; if everything is protected, the store holds more than 30. The first time the limit removes a board in a session, a message names it.
- A board drawn again with `draw_board`, or changed with `update_board`, does not come to the front: the tab opens (without taking focus) when the board is first drawn, and later draws and updates only redraw it. **Show Board…** and a click on a C4 box that zooms into a board do bring the tab forward.
- **Show Board…** (`flow.board.show`) opens a board on the canvas: with no board named it asks which one (the only board is opened without asking). **Export Board as Markdown…** (`flow.board.exportMarkdown`) writes the Markdown stand-in (diagram and node table) to one file per board in the workspace storage, overwritten on every export, and opens it in the Markdown preview.
- When an agent draws a board, a short message `Board drawn: <title>` has an **Open** button.

## DTO diagram

The DTO diagram (`kind: er`, drawn by `src/types/boards.ts` from the type graph) shows the DTOs of the workspace, an edge for each field that refers to another drawn type (cardinality `1`, `0..1` or `0..*`), and the enums those fields use. A type is a DTO when its name ends with one of `flow.types.dtoSuffixes`, or when the type graph finds another reason (a record, a request body, a type another DTO refers to); each card says why. Entities are left out unless `flow.types.includeEntities` or the **Entities** switch asks for them.

Settings that apply: `flow.types.dtoSuffixes`, `flow.types.includeEntities`, `flow.types.includeEnums`, `flow.types.maxNodes` (default 120: the most connected types stay and the description says "Showing the N most connected of M types").

- **Empty diagram.** With no DTO found the canvas says so and offers **Include entities** (draws the board again with entities) and **Edit DTO suffixes** (opens the setting). With a search, a focus or hidden kinds on, the one action is **Clear filters**.
- **Export.** **Copy Diagram as Mermaid** and the canvas's Export menu give Mermaid, PlantUML, PNG, SVG or JSON. A diagram cut by `flow.types.maxNodes` starts its Mermaid with `%% showing N of M types` (PlantUML: `' showing N of M types`, after `@startuml`), so a pasted diagram does not look complete when it is not.
- **One type.** **Show Type in DTO Diagram** (`flow.types.focusType`) focuses the type at the cursor, the type named by a file clicked in the Explorer, or a name you type; a DTO, enum or entity opens the DTO diagram, any other type opens the architecture diagram.

## Architecture diagram

The architecture diagram (`kind: architecture`) is the layers of the repository: a group per module (closed until opened), a group per role inside it (controllers, handlers, services, repositories, entities, DTOs, interfaces, classes), and edges for inheritance, constructor injection (`depends`), field or parameter types (`uses`) and class-to-class calls where nothing else links two types. DTOs and enums are hidden by default (switch them on with the role chips and **Enums**); search only highlights.

Settings that apply: `flow.types.defaultCollapseLevel` (0 modules closed, 1 modules open and roles closed, 2 or more everything open) and `flow.types.maxNodes` (default 120, the same setting as the DTO diagram: the most connected types stay and the description says how many were cut).

### The agent's architecture board versus Show Architecture Diagram

They are two different diagrams of the same type graph, made for different readers.

| | **Show Architecture Diagram** (you) | `board_from_code` with `kind: architecture` (an agent) |
| --- | --- | --- |
| Boxes | Every type (role groups inside module groups) | Modules or packages: one box each |
| Levels | One diagram, collapsed by module | C4: container level with two or more modules, component level (the packages) for one module or a `scope.module` |
| Edges | Inheritance, injection, field and parameter types, calls | "Some type of this box refers to a type of that box" or "calls it", counted; HTTP and message links between services are not drawn and the answer says so |
| Settings | `flow.types.defaultCollapseLevel`, `flow.types.maxNodes`, the toolbar (roles, entities, enums) | None of `flow.types.*`: the agent passes `scope.module` and `maxNodes` (default 30, at most 60) |
| Result | Redrawn when the code changes; focus, search and export on the canvas | A board in the store (saved with the others, `zoom` into the next level), annotated with `title`, `description` and `notes`, never nodes or edges |

The agent cannot open the DTO diagram: `board_from_code` has no DTO kind. Ask for `er` (tables) or draw a class board with `draw_board`, or open the DTO diagram yourself. Every `board_from_code` answer carries a note when the code index was still building or some relations are guesses, so the agent can try again instead of trusting a partial board.

The command **Board from Code…** asks for the kind and then offers the tables, enums or modules the index knows (plus "Whole project") in a quick pick; a Sequence needs a flow that is open on the canvas, and the list says so.

## Finding the diagrams

| Where | What |
| --- | --- |
| Command palette | **Show DTO Diagram**, **Show Architecture Diagram**, **Copy Diagram as Mermaid**, **Show Type in DTO Diagram**, **Show Board…**, **Board from Code…**, **Pin Flow as Board**, **Export Board as Markdown…** (all in the Insilode category) |
| Endpoints view toolbar | The DTO diagram and the architecture diagram icons |
| Editor context menu | **Show Type in DTO Diagram** (a selection or the word at the cursor) |
| Explorer context menu | **Show Type in DTO Diagram** on a file: the type the file is named for |
| Home | The Boards row opens **Show Board…** |

