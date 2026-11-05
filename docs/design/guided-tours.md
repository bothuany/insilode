# AI-assisted code reading: guided tours, the agent's gaze, point-and-ask

Status: the player, the `tour` tools, ask during a tour, point-and-ask and the gaze are built, and so are Save, the key legend and the tour's screen-reader support (3.5, 5); anchors and hash, Markdown export and CodeTour interop (phase 5) are not. Written 2026-10-19 against `main` at 4a8959a. The playground part was read from `origin/HEAD` (70b29bc), which the local `main` does not have yet.

## The problem

An agent writes more code than a person can read line by line. Insilode already draws the code as a call flow, and the agent can already open things through the `insilode` MCP server: `show_flow`, `open`, `open_diff` and `draw_board`. What is missing is reading the code *together*. The agent should be able to point at the canvas and say "this is where it starts, this is the part I changed, this is why". The user should be able to point back and ask.

There are three features, and all of them build on one player on the flow canvas:

| # | Feature | Who drives | Source of the steps |
| --- | --- | --- | --- |
| 1 | **Tour + "Explain this"** | the agent, through MCP `tour` | the agent's own selection; for "Explain this", the turn's change set |
| 2 | **The agent's gaze** | the agent, without knowing it | its Read/Edit/Grep tool calls, as hook and ACP events |
| 3 | **Point-and-ask** | the user | a card or lines the user points at; the agent then answers with a tour |

## What already exists and gets reused

| Piece | Where | Reused for |
| --- | --- | --- |
| "Review N changes" tour: `tour` index state, `goTo`, `]` `[` `←` `→` `Esc` keys behind `editingRef`, and the `.tour` toolbar | `ui/src/webview.tsx` (≈ lines 146, 520–568, 679–735) | The player **generalises this**. The review tour becomes one *source* of steps instead of a second, competing mechanism. |
| `followCursor(file, line)`: the innermost drawn card that holds a line | `ui/src/webview.tsx:243` | Mapping a step or a gaze hit to a card. It is pulled out as `cardAt(file, line)`, which does not select or pan. |
| `proposedCss`: per-card CSS by `data-id` | `ui/src/webview.tsx` | Spotlight and trail styling, without touching `nodes.tsx` layout. |
| `resolve(a)`: entry `id`, or `file` with `method` or `line`, to a flow target | `src/mcp/handlers.ts:678` | Step-target resolution on the host. |
| `PolyIndex.methodsIn(file)` (id, name, startLine, endLine) | `src/poly/graph.ts:1739` | Re-anchoring a method that moved. |
| `askInDock` → `flow.agents.ask` (the user's chosen agent) | `src/askAgent.ts`, flow-agent `ask.ts` | Point-and-ask and tour interruptions. |
| `TurnImpact` (`methods` with file and line, `flows`, `tables`), kept on the session as `s.impact` | `src/mcp/turnImpact.ts`, flow-agent `agents.ts:1183` | The input to "Explain this". |
| Change-set canvas (`{ kind: 'changes' }`) | `src/changeSet.ts`, `changeSetTree.ts` | The canvas a change tour plays on. |
| PostToolUse hook with matcher `*`; ACP `tool_call.locations` | flow-agent `agents.ts:427,1082`, `sessionType.ts:509` | Gaze events. |
| Dock sends indices, never ids (`data-flow="i"`) | flow-agent `dock.ts:257`, `dockMessage.ts` | The "Explain this" button. |

## Decisions that shape everything else

1. **MCP tools stay read/display-only.** `tour` never writes `.insilode/tours/*.json`, and the agent cannot pin a note to disk. The window writes a tour file only when the **user** clicks Save on the canvas. That rule comes from the add-mcp-tool skill: "a tool writes no files and runs no commands". Until the user saves, a tour lives in window memory, the way boards do. Whether the agent may save without a click is open question Q2.
2. **No card keys in schemas or files.** Poly card keys are positional (`p${key++}`, `poly/graph.ts:1270`), and the change set re-prefixes them (`rekey`). Entry ids are not stable either: a poly id is `file#Owner.name@line` (`java.ts:191`, `python.ts:227`…), so it changes when a line above it moves. Targets are **anchors**: file, qualified symbol, a line hint and a text anchor. Resolution happens twice. The host maps the anchor to the current file and range, and the canvas maps that file+line to the innermost drawn card.
3. **`tour` returns at once.** It cannot block until the user is done. Anything the user does later (asks a question, exits) reaches the agent as a **new prompt** through `flow.agents.ask`. The agent reacts with `tour_control`.
4. **One player.** The existing review tour, agent tours, saved tours, a gaze-trail replay and point-and-ask answers all play through the same `TourPlayer` in `webview.tsx`.
5. **No focus stealing.** A tour started by an agent may open the canvas with `preserveFocus` (as `show_flow` does today). Gaze **never** opens, reveals or switches anything: it paints only on a canvas that is already open.

## 1. MCP tools

### 1.1 `tour`

The agent sends a tour, and the window resolves it, shows it and answers with a resolution report. Sending the same `id` again replaces the tour, as `draw_board` does.

```jsonc
{
  "name": "tour",
  "description": "Play a narrated walkthrough on Insilode's flow canvas: a cursor moves from card to card, dims the rest, highlights lines and shows your caption. Use it when the user asks you to explain, walk through or show code, after finishing work (\"explain what you changed\"), or to answer a question about code by SHOWING it. Get file:line from flow_text or find_symbol first. 3–12 steps, one idea each, in the order the code runs. The tool returns at once with each step marked ok / moved / missing: fix missing steps by calling tour again with the same id. The user steps through it; questions they ask come back to you as a new message.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Stable name (letters, digits, - _ .). Reuse it to replace the tour." },
      "title": { "type": "string", "maxLength": 120 },
      "flow": {
        "type": "object",
        "description": "The canvas to play on. Omit to stay on the canvas the user has open, or to let Insilode pick the flow of the first step. Use {\"changes\": true} for the current change set.",
        "properties": {
          "id": { "type": "string", "description": "Entry point id from find_entry_points." },
          "file": { "type": "string" }, "method": { "type": "string" }, "line": { "type": "integer", "minimum": 1 },
          "changes": { "type": "boolean" },
          "base": { "type": "string", "enum": ["uncommitted", "branch", "last_commit"] }
        },
        "additionalProperties": false
      },
      "steps": {
        "type": "array", "minItems": 1, "maxItems": 30,
        "items": {
          "type": "object",
          "properties": {
            "file": { "type": "string", "description": "Workspace file of the code this step points at." },
            "method": { "type": "string", "description": "Method or function, e.g. \"OrderService.Place\". Preferred: survives edits." },
            "line": { "type": "integer", "minimum": 1, "description": "1-based line inside the method (a hint when method is given)." },
            "lines": {
              "type": "array", "maxItems": 3, "description": "Line ranges to highlight, current-file 1-based, e.g. [[42,47]].",
              "items": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 1, "maxItems": 2 }
            },
            "table": { "type": "string", "description": "A database card instead of code: the table name." },
            "title": { "type": "string", "maxLength": 80, "description": "Short label for the step list; defaults to the method." },
            "caption": { "type": "string", "maxLength": 600, "description": "What to say here: one or two sentences on WHY, not a restatement of the code. Short Markdown: `code`, **bold**, a list or a fenced block are shown formatted; HTML is not." }
          },
          "required": ["caption"],
          "additionalProperties": false
        }
      },
      "start": { "type": "integer", "minimum": 1, "description": "Step to open on (default 1)." }
    },
    "required": ["title", "steps"],
    "additionalProperties": false
  },
  "annotations": { "title": "Play a tour in Insilode", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
}
```

Every step needs `file` (with `method` or `line`) or `table`. A step with only a caption is allowed and acts as an intro or outro: the cursor stays put and the caption is centred.

**The result is text the model can act on:**

```
Tour "place-order" (7 steps) playing on POST /orders. The user is on step 1.
1 ok      OrdersController.Place  src/Orders/OrdersController.cs:24-41
2 ok      OrderService.Place      src/Orders/OrderService.cs:58-90  (highlight 71-76)
3 moved   PriceCalculator.Total   src/Pricing/PriceCalculator.cs:30-52  (you said line 12; the method is now at 30)
4 missing InventoryClient.Reserve: no such method in src/Inventory/InventoryClient.cs (closest: ReserveAsync)
5 offflow OutboxWriter.Write      src/Infra/OutboxWriter.cs:10-25  (not on this flow: shown as a side card)
...
```

`offflow` matters because a tour may point at code no drawn flow reaches. Such a step shows a temporary **peek card** next to the spotlight: the method's code from `methodsIn` plus its file. The canvas does not switch flows under the user (see 3.4).

### 1.2 `tour_control`

```jsonc
{
  "name": "tour_control",
  "description": "Drive the tour you started with `tour`, or answer the user's question during it. go: jump to a step · note: pin your answer to a step's card (shown until the tour ends; the user may save it) · resume: continue after a question · end: close it. Returns where the user is and whether they paused.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Tour id." },
      "action": { "type": "string", "enum": ["go", "note", "resume", "end"] },
      "step": { "type": "integer", "minimum": 1 },
      "text": { "type": "string", "maxLength": 2000, "description": "note: the answer, as Markdown." }
    },
    "required": ["id", "action"],
    "additionalProperties": false
  },
  "annotations": { "title": "Control the tour", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
}
```

There is no `next`/`back` for the agent: the user paces the tour. An agent that keeps calling `go` would be fighting the user. The host therefore accepts `go` only while the tour is paused after a `tourAsk` (3.6). At any other time it returns "the user is on step N; go is for answering a question".

There is no separate `explain` tool. "Explain this" and point-and-ask are **prompts** that make the agent call `tour` (see 4 and 6).

### 1.3 How targets are resolved when code moved

All of this is on the host, in a new pure module `src/tour/resolve.ts`. It has no `vscode` import, so it is testable on its own. A thin host wrapper feeds it file text and `methodsIn` results.

1. **Path.** `safeFile()` from handlers.ts: the file must be inside a workspace folder. If it is not, the step is `missing`.
2. **Symbol, when `method` is given.** Look in `methodsIn(file)`, falling back to the LSP's document symbols for Roslyn files. Match the qualified name, then the last segment. With several overloads, take the one whose range is nearest the `line` hint. If found, the step is `ok`, or `moved` when the hint lay outside the method.
3. **Text anchor** (saved tours only, see 5). Each saved step keeps `anchor`: the trimmed text of the method's signature line and of each highlighted line's first line. If the symbol is gone, search the file for the signature anchor and take the nearest match to the old line. Highlight ranges are re-placed by their line anchors relative to the method start. If a highlight anchor cannot be found, that highlight is dropped and the step is still shown.
4. **Line only.** Use the innermost method holding the line.
5. **Drift check.** Saved steps keep `hash`, a short hash of the method's normalised text. If it changed, the step plays with a small "code changed since this tour was made" badge. It is not hidden: the caption may still be right.
6. Otherwise the step is `missing`. The canvas shows its caption greyed with "can't find this code any more" and never points at a wrong card.

Canvas side: the host sends each step as `{ file, startLine, endLine, highlights }`. The canvas runs `cardAt(file, startLine)` over the drawn trees (the `followCursor` logic). If no drawn card holds the step, it is shown as a peek card. A step that lands inside a folded subtree unfolds that path, the way `goTo` already reveals cards.

### 1.4 Limits

| Thing | Limit | Why |
| --- | --- | --- |
| Steps per tour | 30 (`maxItems`); the instructions ask for 3–12 | Longer is a document, not a tour. |
| Caption | 600 chars, Markdown | Fits three lines in the bubble. |
| Highlights per step | 3 ranges, each ≤ 80 lines | |
| Note text | 2000 chars; 10 notes per step | |
| Active tours per window | 1. A new tour replaces the old one, and the toolbar says "replaced by <title>". | |
| Tours kept in memory | the last 10 per window (for "replay") | |
| Resolution budget | 5 s for the whole tour. After that, the remaining steps resolve lazily as the user reaches them. | Roslyn answers one request at a time. |

The MCP server validates the limits in `handlers.ts` (`case 'tour'`), as other tools do, and returns an error result naming the bad field.

## 2. Wire types (protocol/flow.ts)

These are types only, as today. `Tour`, `TourStep` and `GazeEvent` are added to the `WIRE` list in `test/arch/wire-types.test.mjs`, so no other file declares them a second time. `.dependency-cruiser.cjs` needs no change: its `protocol-imports-nothing` and `protocol-is-type-only` rules already cover new types.

These types are the **canvas** wire only. flow-agent does not import `protocol/`. Across a command boundary it declares its own payload, the way it keeps its own copy of `TurnImpact` (`agents.ts:76`). For gaze it sends `AgentLook` (7.2), and flow-view maps that to `GazeEvent`. Today the host↔canvas messages are ad-hoc unions in `panel.ts` and `webview.tsx`. The new messages are declared here once as unions. The old messages can move into these unions later; that is not part of this work.

```ts
/** One resolved step, as the canvas receives it: current-file lines, never a card key. */
export interface TourStep {
	title: string;
	caption: string;
	/** Absent for an intro/outro step. */
	at?: { file: string; startLine: number; endLine: number; label: string; table?: string };
	highlights?: [number, number][];
	state: 'ok' | 'moved' | 'missing' | 'offflow';
	/** The method changed since a saved tour was made. */
	drift?: boolean;
	/** The method's code, for a peek card when no drawn card holds it. */
	peek?: { code: string; startLine: number };
	notes?: TourNote[];
}

export interface TourNote { question?: string; text: string; by: 'agent' | 'user'; at: number }

export interface Tour {
	id: string;
	title: string;
	/** Who made it, shown in the toolbar: "Claude Code (terminal)", "Saved tour", "Review changes". */
	origin: string;
	source: 'agent' | 'file' | 'review' | 'gaze';
	steps: TourStep[];
	start: number;
}

/** One thing an agent looked at or changed, for the gaze. A file and lines only: never content or search text. */
export interface GazeEvent {
	session: string;
	/** The dock's colour and name for that agent. */
	agent: { label: string; color: string };
	act: 'read' | 'edit' | 'search';
	file: string;
	startLine?: number;
	endLine?: number;
	at: number;
}

export type HostToCanvasTour =
	| { type: 'tour'; tour: Tour }
	| { type: 'tourStep'; id: string; index: number; step?: TourStep } // the agent moved it, or a lazily resolved step arrived
	| { type: 'tourNote'; id: string; index: number; note: TourNote }
	| { type: 'tourEnd'; id: string; reason: 'agent' | 'replaced' }
	| { type: 'gaze'; events: GazeEvent[] }
	| { type: 'gazeClear'; session?: string };

export type CanvasToHostTour =
	| { type: 'tourState'; id: string; index: number; paused: boolean } // the host keeps this for tour_control's answer
	| { type: 'tourAsk'; id: string; index: number; question: string }
	| { type: 'tourSave'; id: string }
	| { type: 'tourExit'; id: string }
	| { type: 'pointAsk'; file: string; startLine: number; endLine: number; label: string; question: string }
	| { type: 'gazeReplay'; session: string };
```

The canvas never sends a card key or a command id. Everything it sends is checked by `panel.ts`:

- files go through `workspaceFile()`;
- line numbers must be positive integers;
- question text is capped (1000 chars);
- the tour `id` must match a tour the host itself sent.

## 3. Canvas player UX

The player lives in `ui/src/tour/`: `player.ts` is a pure state reducer, `Cursor.tsx`, `Caption.tsx` and `TourBar.tsx` are the visuals, and `webview.tsx` mounts them. The existing review tour is rewritten as `tourFromChanges(changed)`, which yields a `Tour` with `source: 'review'`. Its Keep/Undo buttons stay as extra toolbar actions for that source only.

### 3.1 Ghost cursor

- It is a small pointer, an inline SVG drawn in the agent's dock colour (flow-agent `avatars.ts` colour), with the agent's name in a tag. It is rendered with `@xyflow/react`'s `ViewportPortal`, so it lives in flow coordinates and pans and zooms with the canvas.
- **Moving to a step:**
  1. If the target card is off-screen, `setCenter` to the card (≈ 450 ms, the same easing `goTo` uses).
  2. The cursor glides along a slight curve to the card's header, then to the first highlighted line (≈ 600 ms, CSS `transform` transition).
  3. The spotlight comes up (150 ms) and the caption fades in.
- Each move happens once. The cursor never idles or wiggles.
- With `prefers-reduced-motion: reduce`, there is no glide and no fade: the cursor jumps, `setCenter` uses `duration: 0`, and the spotlight appears at once. The same applies when the canvas is hidden (`document.hidden`).

### 3.2 Spotlight and highlights

- A root class `.wv-touring` dims every card, edge and frame to about 35 % opacity. The current card gets `data-spot`, which keeps full opacity and adds an outline in `--fl-signal`. The edges into and out of it stay at 70 %, so the reader still sees where the card sits in the flow. This uses per-key CSS like `proposedCss`, so `nodes.tsx` layout is untouched.
- Highlighted lines get a background band on the card's code rows, the same rows `focusLine` scrolls to. A card that is collapsed or partly shown is expanded (`toggleFull`) for the step, and folds back after the step.
- If the user clicks a dimmed card, the tour pauses and the spotlight lifts. "Resume" puts it back. The user is never locked in.

### 3.3 Caption bubble

- It is anchored to the card's right edge, and flips to the left or below when there is no room. It is at most 360 px wide and three lines tall, with "more" when longer.
- It shows the caption as **Markdown** (`ui/src/tour/mdparse.ts`, `Markdown.tsx`): paragraphs, lists, headings, quotes, fenced code, `` `code` ``, bold, italic and http(s)/mailto links, built into React elements. There is no HTML and no images; a tag in the text is shown as text, and any other link address (`javascript:`, `command:`) stays plain text.
- The bubble has a largest size (the canvas height above the bar, at most 440px) and scrolls inside it. "more" appears only when the caption really overflows its three lines. Under the notes sits an "Ask about this step…" box, the same as the bar's.
- Under the caption sit the step's pinned notes: Q in italics, A as Markdown, and a "from Claude" tag.
- Cards are read-only while a tour plays (the review of changes included) and editable again when it ends.
- `aria-live="polite"` on the bubble lets screen readers read each caption as it appears.

### 3.4 Steps that are not on the drawn flow

A **peek card** is a lighter, dashed card with the method's code. It is placed next to the spotlight with a dotted connector to the nearest drawn caller, if there is one. It has an "Open flow" link the user may click; the tour never switches the flow itself. A tour that has no `flow` and starts somewhere else opens the canvas on the first step's method. That is the same as `show_flow`, with `preserveFocus`.

### 3.5 Tour bar and keyboard

The bar replaces today's `.tour` toolbar:

```
[◀] 3 / 7 ▶  [⏸]   OrderService.Place — "Prices are frozen here…"   [Ask about this step…]  [Save] [✕]
```

| Key | Action | Notes |
| --- | --- | --- |
| `→` `]` | next | as today |
| `←` `[` | back | as today |
| `Space` | pause / resume | only when focus is on the canvas, not the card editor or the ask box |
| `/` | focus the ask box | an agent's tour only (a review of changes has no author to ask) |
| `?` | open the key legend | with lines selected, `?` is point-and-ask's |
| `Esc` | in the ask box: blur; with the step list or the legend open: close it; otherwise: exit the tour | the first `Esc` closes the pop-up and the tour stays |
| `1`–`9` | jump to step | |

All keys keep today's `editingRef` guard: while a card is being edited in Monaco, the tour ignores keys and pauses itself. The step list ("3 / 7" is a button) opens a small list of step titles with state icons (ok, moved, missing, drift).

**Built (the rest of the bar):**

- **Key legend.** A `?` button in the bar, and the `?` key, open a small dialog (`role="dialog"`, "Tour keys") that lists the keys above. The list is not written twice: `ui/src/tour/legend.ts` holds one table that the key handler in `TourPlayer.tsx` reads (`keyAction`) and the legend prints, and a test checks that every listed key does what its row says. The dialog closes with `Esc` and on a click outside, and focus returns to the `?` button. The first caption of a tour also shows one line, "Right arrow: next · ?: all keys · Esc: exit", which is gone from the second step on.
- **The step list and `Esc`.** A click outside the list closes it, `Esc` closes it before it exits the tour, and focus returns to the "3 / 7" button (the state is a small pure reducer in `player.ts`).
- **A blocked Next is said.** When Next, a number key or a step in the list is refused because a hands-on step is not done, the caption's status region says "Finish this step first" and focus moves to that step's button (Continue, the command's button, or Skip). The Next button is `aria-disabled` with the same text as its title, so it can still be reached and pressed.
- **Marks for a screen reader.** The pen marks are drawn in an `aria-hidden` layer. The caption's live region holds a visually hidden summary of them from `markSummary` (`ui/src/tour/marks.ts`): "Marked on this card: ring lines 12 to 14; check beside line 20; arrow to Foo.bar labelled calls", in the order the caption brings them in, cut at 240 characters with "and N more".
- **Waiting for an answer.** After 20 seconds in the "asking" state the caption adds "Press Space to continue without an answer", and Space resumes (the ask box is let go of when a question is sent, so Space reaches the tour). The timing is a pure function of the two times (`askHintDue`), and the hint goes away on a resume or another step.
- **Save.** An agent's or a gaze tour has a Save button in the bar. It sends `{ type: 'tourSave', id }`, and only the tour the host is playing is saved (see 5). A tour that already came from a file has no button, and neither does the canvas's own review of changes, which the host does not hold.

**Pacing:** by default the user steps through by hand. ⏵ Autoplay is a toggle, and it dwells `clamp(words × 0.3 s, 3 s, 12 s)` per step. It pauses on any interaction and is off under reduced-motion. The default is open question Q1.

### 3.6 Interrupting with a question

1. The user types in the ask box. The tour pauses, the step shows "asking <agent>…", and the canvas sends `tourAsk`.
2. The host builds a prompt:
   > The user is on step 3 of your tour "place-order" (OrderService.Place, src/Orders/OrderService.cs:58-90) and asks: "…". Answer with `tour_control` action "note" for step 3 (and "go" if another step answers it better), then "resume". Keep it short; if it needs more than a note, start a new tour.
3. The host sends it with `askInDock(prompt, submit = true, 'tour', [file])`. That goes to the agent that made the tour when the host knows it (see Q5 and 8.3), and otherwise to the user's chosen ask target.
4. The agent calls `tour_control note`. The note appears under the caption, and the tour resumes when the agent sends `resume` or the user presses ▶.

## 4. "Explain this" in the agent dock

- **Explain this** is a button on the session row of the dock, shown once a turn has ended (`Stop`) and the turn edited at least one file (`touched`). It does not depend on the "This turn touched N flows" line, which only appears when there are flows or tables. The page posts `{ type: 'explain', session: <index> }` with the index of a row the host drew, following `dockMessage.ts`.
- flow-agent looks up the session and its `s.impact`, the stored `TurnImpact` with the methods (file, line, name), the flows and the tables. It builds the prompt from that data, so the agent does not have to re-derive what it touched:
  > Explain the change you just made as a tour on the change set. Use `tour` with `flow: {"changes": true}` and one step per changed method below, in the order a request runs through them (entry first), plus the tables. Caption each with why it changed and what could break. Changed: OrderService.Place (src/Orders/OrderService.cs:71), PriceCalculator.Total (…), table orders (migration AddDiscount). Flows: POST /orders, PUT /orders/{id}.
- The prompt goes to **that same session**, through the existing "send to a running session" path of `flow.agents.ask`, because the author explains its own change. While the agent is still working, the button is disabled.
- If there is no `s.impact` (Codex without hooks, or the impact timed out), the button still works and the prompt says "the files you edited this turn: …".
- **v1 explains the latest turn only.** `s.impact` is cleared on `UserPromptSubmit` (`agents.ts:1051`), so older turns have no impact on the session. Older turns can be explained from the canvas timeline instead: the per-turn data that `timeline` / `undoFrom` already have in `agentDiff.ts` (prompt, files, line ranges). A timeline entry gets an "Explain" action that builds the same prompt from that turn's files and ranges. This is phase 5 work, and it is Q10.
- The same prompt ships as an **MCP prompt**, `explain_change` (today `prompts/list` returns `[]`). In Claude Code that gives the user `/mcp__insilode__explain_change` from the terminal too.

## 5. Tour files and replay

Location: `.insilode/tours/<id>.tour.json`. It is written **only** by the window, on the user's Save click (see Decision 1). Whether the folder is committed or ignored is Q3.

```jsonc
{
  "insilodeTour": 1,
  "id": "place-order",
  "title": "How an order is placed",
  "description": "Optional.",
  "createdAt": "2026-10-19T14:02:00Z",
  "author": "Claude Code (terminal)",
  "commit": "4a8959a",                 // HEAD when saved, for "made on <commit>"
  "flow": { "file": "src/Orders/OrdersController.cs", "method": "OrdersController.Place" },   // or { "changes": true, "base": "branch" }
  "steps": [
    {
      "title": "Prices are frozen",
      "caption": "Prices are copied onto the order here so a later price change does not alter it.",
      "file": "src/Orders/OrderService.cs",
      "method": "OrderService.Place",
      "line": 58,
      "lines": [[71, 76]],
      "anchor": { "signature": "public async Task<Order> Place(PlaceOrder cmd)", "lines": ["var frozen = cart.Items.Select("] },
      "hash": "a1f3c9e0",
      "notes": [{ "question": "Why not snapshot the cart?", "text": "…", "by": "agent", "at": 1760882520000 }]
    }
  ]
}
```

- **Saving, as built** (`editor/extensions/flow-view/src/tourSave.ts`). Save writes `.insilode/tours/<id>.tour.json` under the first workspace folder that holds the tour's files (the first folder when none does), creating the folders. The id is cleaned to ASCII letters, digits, `-` and `_` (no separators, no dots, no names Windows reserves), and the file's own `id` is the cleaned one. Saving the same tour again replaces its file; a file whose own id is another one, or that is not a tour, is never overwritten: the new tour gets `-2`, `-3` and so on. The content is what `parseTourFile` accepts, spelled as a hand-written file spells it: paths relative to the first folder (a file of another folder in full), `method`, `line`, `lines`, `marks`, `wait` of kind click or continue, `start` (1-based) and `followUps`. A command wait is saved as a plain step, and the reader's notes, `agent`, the origin and `drift` are not saved. A step that was `moved` is saved at its new place and a `missing` one at the line it was last seen, so playing the file reports the drift. Before writing, the content is read back with `parseTourFile`; a tour that would not load is not written. The result is a notification with an Open button that opens the written file (and only that path), or the reason it failed: no folder open, not writable. `anchor`, `hash` and `notes` below are phase 5 and not written yet.
- The file reuses the `tour` step schema and adds `anchor`, `hash` and `notes`. That way a saved tour can be **pasted back into `tour`** by an agent, and `tour` accepts the extra fields when they come from a file. The anchors are what make replay work after edits (1.3).
- **No `commands`, no URIs, no HTML.** CodeTour has step `commands` and arbitrary `uri` steps. These are deliberately absent, and unknown fields are dropped on load.
- **Replay:** use the command "Insilode: Play Tour…" (a quick pick over `.insilode/tours`), or a "▶ Tours" chip on the canvas when the current flow has saved tours that touch it.
- **CodeTour interop** comes later (phase 5). The importer reads `.tours/*.tour` steps that have `file`/`line`/`description`/`pattern`, and skips the rest. Check the current CodeTour schema before building it. The exporter writes the reverse, so people without Insilode can still follow a tour in VS Code.
- **PR attachment** comes later (phase 5). "Copy tour as Markdown" writes a numbered list of `file:line` links with captions for the PR body. A committed tour file travels with the PR, and Insilode replays it on checkout. Saving a tour never pushes or posts anything.
- **A tour file from someone else's PR is untrusted input.** It goes through the same validation as an MCP call: workspace-only paths, limits, plain-text captions. A file that fails validation is listed as broken with the reason and is not played.

## 6. Point-and-ask

1. **Point.** On any card, the header's "Ask…" action (or `Alt+click` a card, or select lines in a card's code view and press `?`) opens an inline ask box anchored to the card. A line selection is shown as a band, the same style as highlights.
2. **Send.** The canvas posts `pointAsk { file, startLine, endLine, label, question }`. The host validates the file with `workspaceFile()` and checks the line numbers. It builds:
   > The user points at OrderService.Place, lines 71-76 of src/Orders/OrderService.cs, on the flow "POST /orders", and asks: "…". Answer by showing: call `mcp__insilode__tour` with 1–5 steps starting at that code (flow: the same entry point), captions answering the question; then a one-paragraph answer in chat.
3. The host sends it with `askInDock(prompt, true, 'canvas', [file])`, to the agent the user picked. The existing picker and remembered-target logic in flow-agent `ask.ts` / `askTarget.ts` stays unchanged.
4. **Show.** The agent's `tour` call plays on the same canvas, so the user watches the answer where they asked. The question is kept as the tour's first note.
5. A chat-only agent with no `insilode` MCP (the chat panel, or the clipboard target) still answers in text. The prompt says "if you cannot call mcp__insilode__tour, answer in text".

"Ask about this flow" (the existing toolbar button) gets the same "answer by showing" sentence added to its prompt.

## 7. The agent's gaze

### 7.1 Events in

| Source | Event | What we take | Where |
| --- | --- | --- | --- |
| Claude Code terminal (hooks) | `PostToolUse`, matcher `*` (already installed) | `Read`: `file_path`, `offset`/`limit` → lines. `Edit`/`Write`/`MultiEdit`: `file_path` (lines from the edit's position when cheap, else the file). `Grep`/`Glob`: `path` only, `act: 'search'`. | flow-agent `agents.ts:1082` |
| ACP sessions (Claude Code / Codex over ACP) | `tool_call` / `tool_call_update` | `locations[].path` and `.line`, `kind` (read/edit/search) | flow-agent `sessionType.ts:509` |
| Codex terminal (hooks) | `PostToolUse` | `apply_patch`: the patch's file list (`patch.ts`). Reads come through `exec` and are not parsed. | flow-agent `codexHooks.ts` |

`PreToolUse` is **not** widened beyond its current `Edit|Write|MultiEdit|NotebookEdit|ExitPlanMode|AskUserQuestion` matcher. Widening it would add a hook round-trip before every tool call. Post events are enough for a trail, and they arrive only a moment later.

### 7.2 Pipeline

```
flow-agent (hook / ACP) ──normalise──▶ AgentLook ──throttle──▶ executeCommand('flow.agent.gaze', looks[])
                                                                 │ (registered by flow-view; commands.test.mjs)
flow-view extension.ts ─▶ validates each look (workspace file, integer lines) and maps it to GazeEvent
                        ─▶ GazeLog (per session ring buffer, 300 events, memory only)
                        └▶ if the canvas panel exists: postMessage({ type: 'gaze', events })
canvas ─▶ cardAt(file, line) for each event ─▶ marker + trail; misses go to the "elsewhere" list
```

- **Normalise** (new pure module in flow-agent, `gaze.ts`). It produces `AgentLook { session, agent, color, act, file, startLine?, endLine?, at }`, flow-agent's own copy of the shape. Map tool to `act`; turn a path relative to `cwd` into an absolute one; keep only workspace files. Drop: `Bash`, `WebFetch`, MCP tools, the agent's own `.claude/` files, and anything under `node_modules`, `.git` or `out`.
- **Throttle.** Per session, coalesce events on the same file within 300 ms, so a range of reads becomes one, and send at most 4 batches a second. Mark a batch "burst" when more than 20 events arrive in one second: the canvas then shows the trail without animating each one.
- **Privacy.** A `GazeEvent` holds a file and lines only, never content, grep patterns or commands. The log is held in memory and never written to disk. Saving a trail is an explicit user action, and it becomes an ordinary tour file. The setting `flow.agents.gaze` (default on, Q4) turns the whole pipeline off in flow-agent, so nothing is sent.

### 7.3 Canvas

- **Live marker.** A small dot in the agent's colour sits on the card being read. It glides between cards (instantly under reduced-motion) and pulses once on an edit. With several agents there are several dots, each with its colour and initial.
- **Trail.** Every visited card gets a thin left bar in the agent's colour that fades over about 60 s: 100 % for the newest, 20 % at the oldest. A small counter on the card shows the read count ("×3"). Edited cards keep a solid bar.
- **Elsewhere.** Reads of files that no drawn card holds go into a collapsible "Claude is also reading: OutboxWriter.cs, appsettings.json…" list in the corner. A click opens that file in the editor, as a user gesture. The canvas never follows on its own.
- **Toggle.** An eye button in the toolbar turns the gaze on or off for this canvas.

### 7.4 Afterwards: replay

When the session's turn ends (`Stop`), the dock row and the canvas both offer **Replay trail**. The host turns the session's buffered events since its last `UserPromptSubmit` into a `Tour` with `source: 'gaze'`. Consecutive reads of one method merge into one step, and each step is captioned "Read ×2", "Edited" or "Searched in". The player then plays it. If the user wants the agent's explanation of its path, they press "Explain this", which is feature 1 with this tour's steps as the input.

## 8. Agent guidance: how the agent learns to make good tours

### 8.1 Server instructions

`INSTRUCTIONS` in `src/mcp/protocol.ts` gets one line:

> To explain or walk the user through code, SHOW it with `tour`: get file:line from `flow_text` first, 3–12 steps in the order the code runs, one idea per step, captions that say why, not what. The user's questions during a tour come back to you; answer them with `tour_control` (note), then resume.

### 8.2 The guide (an MCP prompt and the tool description)

The full guide ships as an MCP prompt, `tour_guide`, and is summarised in the `tour` description, so it reaches every client:

- Start at the entry point, or at the user's question, and follow the call order. Do not jump around the file system.
- One step per idea. If a caption needs "and also", split the step.
- Captions say **why** and **what to watch**: invariants, side effects, what breaks. Do not restate the code.
- Highlight only the lines the caption talks about.
- For a change: say what changed, why, and what you did not test. End with a step on risks.
- Write captions in the user's language.
- Prefer `method` over `line`. Read the resolution report, and fix `missing` steps by calling `tour` again with the same id.
- Keep it under 12 steps. Offer a second tour instead of a longer one.

### 8.3 Who asked: knowing which agent made a tour

Today flow-agent writes **one shared** `insilode-mcp.json` with only `INSILODE_WORKSPACE` (`agents.ts` `mcpConfig()`), so the window cannot tell which session called `tour`. The proposal:

- `mcpConfig(cwd)` takes the session id and writes `insilode-mcp-<session>.json` with `INSILODE_SESSION=<id>`.
- `stdio.ts` passes it as a header on the bridge call (`http.ts`).
- `handlers.ts` stores it on the tour as its `origin`.

Tour questions then go back to the author with `flow.agents.ask`, using a "to session" option. Sessions started outside Insilode (`claude mcp add` by hand) have no id, and fall back to the ask picker. This is Q5.

## 9. Security

| Risk | Rule |
| --- | --- |
| Model text in the webview (captions, notes, titles) | Titles are plain text. Captions and notes are Markdown parsed to a tree and rendered as React elements: no HTML, links limited to http(s)/mailto. Control characters (not line breaks) are stripped and lengths capped on the host. |
| Paths from MCP calls, tour files, canvas messages | `safeFile()` / `workspaceFile()`: inside a workspace folder or dropped. The canvas never gets file content for a path the host has not resolved itself. |
| Command ids | None in the tool schemas, the tour file or any canvas message. Every action of the new canvas messages is a fixed `type` the host switches on, so `insilode-command-id-not-allowlisted` stays satisfied. Its fixture gains the `tourAsk`/`pointAsk` handlers as `ok:` cases. |
| Dock "Explain this" | The page sends a row index; flow-agent looks the session up itself (as with `data-flow`). |
| CSP | Unchanged: the cursor is inline SVG, and there are no new fonts, images or frames. |
| Tours from a PR | Untrusted, and validated exactly like MCP input (5). No auto-play on open: the user starts a saved tour. |
| Prompt injection through code | A tour is the agent's opinion. The bar says who made it, and drift/missing states keep it from pointing at the wrong code. Questions the canvas sends are the user's own text, labelled as such in the prompt. |
| MCP read-only rule | `tour` and `tour_control` write nothing. The Save click (in the window, a user gesture) writes the file. |
| Gaze privacy | File and lines only. Memory only. One setting turns it off at the source. |
| Focus | No `reveal` or `show` from gaze, ever. A tour opens the canvas with `preserveFocus` only. |

The `webview-security-reviewer` agent reviews each phase that touches `panel.ts`, the dock page or `src/mcp`.

## 10. Tests

| Piece | Test | Where |
| --- | --- | --- |
| Tool schemas | Tool-name list, a `tour` call, limit errors (31 steps, a long caption, an unknown field, a path outside the workspace) | `flow-view/test/mcp-protocol.test.mjs` |
| Resolver | Fixtures: a method moved down 20 lines (`moved`), renamed (`missing`, with the closest-name hint), overloads by hint, a signature-anchor fallback, highlight re-placement, a hash drift flag, a line-only step | new `flow-view/test/tour-resolve.test.mjs` on `src/tour/resolve.ts` (pure) |
| Tour file | Round trip; drops `commands`/`uri`/unknown fields; rejects bad versions; a path traversal (`../../etc`) marks the step missing | new `flow-view/test/tour-file.test.mjs` |
| Panel messages | `tourAsk`/`pointAsk` validation: a wrong tour id, a non-workspace file, a long question | flow-view node tests, with the `panel.ts` handler pulled into a pure validator |
| Player reducer | next/back/pause/ask/replace/resume, lazily arriving steps, the review source with Keep/Undo shrinking the list (today's effect at `webview.tsx:550`) | `ui/src/tour/player.ts`. `ui/` has **no test runner today**: add `npm test` with `node --test --experimental-strip-types` for pure files (new, small). Otherwise test it through playground e2e only. |
| Player in a browser | Plays a canned tour: the cursor reaches each card, the spotlight class is set, the caption text is shown, keys work, reduced-motion makes no transition | `playground/test/e2e.test.mjs` (headless Chrome, already in CI) |
| Gaze normalise and throttle | Hook payload → `GazeEvent` per tool (Read offset/limit, Edit, Grep path-only, Bash dropped, outside-workspace dropped); ACP locations; coalescing and burst | new `flow-agent/test/gaze.test.mjs` on pure `gaze.ts` |
| Command contract | `flow.agent.gaze` is registered | `test/arch/commands.test.mjs` (automatic) |
| Wire types | `Tour`, `TourStep` and `GazeEvent` are declared once, in `protocol/flow.ts` only | `test/arch/wire-types.test.mjs` (add them to `WIRE`) |
| Headless rule | `src/tour/resolve.ts` reaches no `vscode` | `npm run arch` / `.dependency-cruiser.cjs` |
| End to end | `/probe`: web mode on the demo project; ask Claude "walk me through POST /orders"; screenshots of steps 1 and 3; ask a question mid-tour; Explain this after an edit | `.claude/skills/probe` |

## 11. Build order

Each phase ships on its own, and each phase is demoable.

| Phase | Builds | Demo |
| --- | --- | --- |
| **0. Player** | Wire types; `ui/src/tour/*`; the review tour rewritten onto it; cursor, spotlight, caption, bar, keys, reduced-motion; host `playTour(tour)` with a dev command "Insilode: Play Tour from File…" that reads a hand-written JSON | "Review 3 changes" now has a gliding cursor and captions; a hand-written tour plays on POST /orders. |
| **1. MCP `tour`** | `tour` + `tour_control` (go/end), `src/tour/resolve.ts`, handler and limits, instructions, the `tour_guide` prompt, docs/agent-tools.md, register.ts list | In Claude Code: "walk me through how an order is placed" → the canvas opens beside the editor and plays 6 steps; the agent fixes a `missing` step by itself. |
| **2. Explain this** | The dock button, the prompt from `s.impact`, the `explain_change` MCP prompt, change-set flow targets | After an agent edit: click **Explain this** → a tour of the change set, with risks as the last step. |
| **3. Ask during a tour + point-and-ask** | The ask box, `tourAsk` / `pointAsk`, `tour_control note/resume`, notes in the bubble, the INSILODE_SESSION routing (8.3) | Mid-tour: "why is this not in a transaction?" → the note appears on the card and the tour resumes. Select 3 lines → ask → the answer is played as a 2-step tour. |
| **4. Gaze** (independent of 1–3; it can run in parallel after 0) | flow-agent `gaze.ts`, `flow.agent.gaze`, GazeLog, marker, trail, "elsewhere" list, toggle, setting, Replay trail | With the canvas open, give Claude a task: watch its dot move over the cards it reads, then replay its path. |
| **5. Files and sharing** | Save on the canvas, `.insilode/tours`, "Play Tour…", the "▶ Tours" chip, anchors and hash, drift badge, Markdown export, CodeTour import/export | Save a tour, edit the code above it, replay: steps show `moved` and `drift` correctly. Paste the Markdown into a PR. |
| **6. Playground** | A canned tour (see 12) | The site shows "the agent explains its change" as a live tile. |

## 12. The browser playground

The playground already runs the real `ui/src/webview.tsx` on a fake host (`playground/src/host.ts`). It already starts the canvas's own review tour from `Tiles.tsx` (`startReview`). A canned tour is therefore the fake host posting the same messages:

- `scripts/playground-data.mjs` writes `public/data/tour.json`, a `Tour` for the demo's change (POST /orders on the Java part). The steps are resolved at build time with the same `src/tour/resolve.ts` over the demo copy, so they cannot drift from the demo code. The captions come from a hand-written file, `playground/demo/tour.captions.json`, in English, and the README marks them as written, not generated.
- `host.ts` answers `tourState`/`tourExit` locally. On a `play-tour` message from the page around it, it posts `{ type: 'tour', tour }` into the canvas. A scripted "question" posts a `tourNote` after 1.5 s, showing the interrupt-and-resume loop with a fixed answer.
- `story.ts` adds a chapter after the change, "Ask the agent to explain": the dock's **Explain this** chip starts the tour on the change tile. The tile's corner says "scripted replay" for the agent's words, like the other tiles.
- Gaze can be shown the same way: `story.ts` already has the agent's steps, and their reads become `gaze` messages to the first canvas tile.
- `playground/test/e2e.test.mjs` plays the tour and checks the spotlight and the caption on each step. That makes it the browser test for the player as well.
- `playground/` may import `ui/` and `protocol/` only, which this respects: `resolve.ts` runs in the Node build script, not in the page.

## 13. Open questions for the user

1. **Pacing.** Should tours step by hand by default (recommended), or autoplay with a timer?
2. **Saving.** Only by the user's Save click (recommended, and it keeps the MCP rule "tools write no files"), or may the agent save a tour (`save: true`) without a click?
3. **Tour files in git.** Should `.insilode/tours/` be committed and travel with the PR (recommended), or be local only and gitignored? For the PR: a Markdown list in the PR body, the committed file, or both?
4. **Gaze default.** On by default for agents started in Insilode (recommended), or opt-in? Should a search (Grep) show *which folder* only (recommended), or also the search text?
5. **Who answers a tour question.** The agent that made the tour (needs per-session MCP config, see 8.3; recommended), or always the ask picker?
6. **Peek cards vs switching flows.** A step not on the drawn flow shows a peek card (recommended). Should the tour instead switch the canvas to that method's flow?
7. **Boards and the editor.** Tours on the flow canvas only (recommended for v1), or also on `draw_board` boards and as editor decorations (a CodeTour-like comment in the file)?
8. **Ghost cursor look.** The agent's dock avatar and colour (recommended), or a plain pointer?
9. **Narration language.** Should captions follow the user's language automatically (recommended: the guide says so), or follow an Insilode setting?
10. **Older turns.** v1's "Explain this" covers only the agent's latest turn. Should explaining older turns from the canvas timeline come in phase 5 (recommended), or is it needed sooner?

## 14. Answers (2026-10-19)

The user took the recommended option for every open question: tours step by hand; only the user's Save click writes a tour, and `.insilode/tours/` is committed and travels with the PR (Markdown in the PR body as well); gaze is on by default for agents started in Insilode, and a search shows its folder only; a question during a tour goes to the agent that made it; a step off the drawn flow opens a peek card; tours play on the flow canvas only in v1; the ghost cursor uses the agent's dock avatar and colour; captions follow the user's language; older turns come in phase 5. Build order: phase 0 first, then phases 1-3 in one session and phase 4 (gaze) in another, in parallel.
