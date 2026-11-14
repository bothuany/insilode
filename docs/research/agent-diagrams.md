# Agent-made diagrams in Axle: kinds, schema, quality, tours

Status: research; the board side (sections 3.3, 3.4, 7.1-7.3) is implemented, see docs/boards.md. Written 2026-10-21 against `main` at 20ebd55.
Not committed on purpose. Sources are marked: **[read]** I opened the code or the search result text; **[mem]** from general knowledge of the tool, not re-checked in this session; **[unverified]** a claim I could not confirm. For papers I only saw search summaries, not full texts, so numbers are as reported there.

## 0. Summary

1. Axle's board is a decent base (typed JSON spec, own layered layout, nested groups, search, focus, skeleton-first colours) but it is one *static graph* renderer. `sequence` is a kind in the enum with no sequence-specific rendering: no lifelines, no message order (grep finds `sequence` only in the enums, `ui/src/board/spec.ts:8`, `tools.ts:15`). It is laid out as an ordinary layered graph.
2. The biggest quality gap is not another kind. It is that `draw_board` accepts almost anything and says little back. Unknown enum values are dropped silently, an invalid `kind` silently becomes `flow` (`spec.ts:107`), nothing checks that `file`/`line` exist or that a symbol is real, and nothing flags a hairball. A **lint in the tool result** plus **`symbol` grounding** is the cheapest, highest-value change.
3. The most valuable new things for developers reading AI-written code, in order: **sequence done properly** (ordered messages, can be generated from `flow_text` with no LLM drawing at all), **steps/animation on a board** (reuse the tour player), **before/after (diff) boards**, **state machines**, **C4-style architecture levels**. Deployment and timelines are low priority.
4. Keep JSON as the wire format; do not switch to a text DSL. Optionally accept Mermaid text as an *import* for kinds where agents already write it fluently.
5. Do not let agents place nodes. Evidence says LLMs are poor at spatial layout; Axle already auto-lays-out, so spend effort on the layout engine's crossing metric and on grouping/labels instead.

## 1. What exists today (read)

`draw_board` / `update_board` (`editor/extensions/flow-view/src/mcp/tools.ts`, handler `handlers.ts:1070`), spec in `board-canvas/spec.ts` (one file for the host and the canvas).

| Aspect | Today |
| --- | --- |
| Kinds | `flow, plan, class, er, sequence, architecture`. Kind only affects defaults (direction) and the legend; layout is the same for all. |
| Node | `id, label, kind (14 role kinds), detail, group, file, line, status, note, members[]`. `status` and `note` are described for plans only. |
| Edge | `from, to, label, kind (13), fromCard, toCard`. No order, no style, no direction control. |
| Groups | `id, label, parent, collapsed`. Nested, collapsible, collapsed groups become a summary card with counts. |
| Layout | `ui/src/board/model.ts`: own Sugiyama-style layered layout per container, bottom-up for groups: DFS cycle breaking, longest-path layering, 6 barycenter sweeps, pool-adjacent-violators placement, wrap at 2600px, loose nodes in a grid. No crossing metric, no orthogonal routing besides `route.ts` for edges. |
| Limits | 400 nodes, 1200 edges, 60 members, 1.5 MB JSON. Over the node cap it throws a message the agent can act on. |
| Feedback to agent | Warnings only for: dropped edges (unknown ids), dropped nodes, dropped members, file outside workspace. Skeleton mode appends a check report. |
| Updates | `update_board` changes one node's `status`/`note`. Redraw with same `id` replaces the board (no history, no diff). |
| Links to code | `file` + `line` per node (clicking opens). Not verified to exist; no symbol; not re-anchored when code moves. Tours, by contrast, use `file`+`method` anchors with a resolution report (`docs/design/guided-tours.md` §1.3). |
| Live | Skeleton first (`docs/design/skeleton-first.md`) recomputes `check` colours (`matches/missing/differs/existing`) on class/er boards against the code index; host-only fields, `parseBoard` drops them from agents. |
| Tours | `tour` plays only on the flow canvas (cards of a traced flow, `table` cards). A board is not a tour target. |

## 2. Q1: which kinds and shapes are missing

Ranking criterion: a developer reading code an agent wrote, who needs to answer "what does this do, what changed, is it right". Effort is in terms of the existing renderer.

| Kind / shape | Value for Axle users | Why / evidence | Effort |
| --- | --- | --- | --- |
| **Sequence (real)** | Very high | The kind exists but is a graph. Reading "who calls whom in what order, sync vs async, what returns" is the most common explanation need. Flow data already exists (`flow_text`), so Axle can *generate* it deterministically. Reverse-engineered sequence diagrams' comprehension value is thinly validated though (a master's thesis cited it as not well validated [read, search result](https://www.sa.comp.isct.ac.jp/en/?p=1776)), so keep them short (≤ 8 lifelines). | M |
| **Step animation / highlight a path** | Very high | Cheapest way to make a static diagram explain something: the agent says "follow these edges in this order" and the board lights them one by one. Same player as tours. | M (reuses tour player) |
| **Before / after (compare)** | High | "What did the agent change in the design" is the review question. Skeleton-first already has the colour language (added = missing, existing = neutral). Generalise to `change: added/removed/changed` and a `base` board. | M |
| **State machine** | High for entities with lifecycles (order status, bill state) | Fits the `status` enums that are common in CRM/billing code (the user's real project). Nodes + labelled transitions with `guard`; initial/final shapes. Layered layout works fine. | S-M |
| **C4 levels (context, container, component)** | Medium-high | `architecture` is one flat layer/service view. C4's value is *level discipline*: one board per level, boundary boxes, technology line per box ([Structurizr's model enforces the hierarchy of abstractions and rules per view](https://docs.structurizr.com/ai), search result). Needs `level`, `tech`, boundary groups. | M |
| **Data flow (what data goes where)** | Medium-high | Axle already knows tables read/written per endpoint (`impact`). A data-flow board is a generated view: endpoint -> service -> table with `reads/writes` edges and payload labels. | M, mostly generation |
| **ER with cardinality** | Done in part | `fromCard/toCard` exist. Missing: crow's-foot glyphs (check `edges.tsx`, I did not verify glyphs), PK/FK markers on members. | S |
| **Swimlanes** | Medium | A group with `lane: true` stacking vertically; good for "user / API / worker / DB" processes and for multi-service flows (the user's microservices project). | M |
| **Annotated callouts** | Medium-high, cheap | Note attached to a node or edge, not a node of its own. Today `note` is plan-only. | S |
| **Decision tree** | Medium | `decision` node + `yes`/`no` edges already exist; just docs and the lint. | S |
| **Deployment** | Low-medium | Needs infra facts (compose, k8s, CI); Axle's index does not carry them. Only worth it if generated from manifests. | L |
| **Timeline** | Low | Rarely the question in code reading. Plans cover ordering. | M |

## 3. Q2: what the agent should send

### 3.1 JSON vs text DSL

| Option | For | Against |
| --- | --- | --- |
| Structured JSON (today) | Schema-validated by the MCP client; ids stable; `file`/`line`/`status` fit naturally; `update_board` can patch one node; Axle already normalises sloppy input (`name` for `label`, string members). | Verbose; agents write less of it per token than a DSL; relations spread over two arrays. |
| Mermaid / PlantUML text | Models are very fluent in them **[mem, unverified]**; compact. Benchmarks exist: [MermaidSeqBench](https://arxiv.org/abs/2511.14967) (132 samples, LLM-as-judge on syntax, activation, error handling, usability; reports large gaps between small models). | No code links, no status, no ids you can update; syntax errors are the main failure (below); each tool's renderer limits what you can say. |
| Structurizr DSL | One model, many views, C4 rules enforced; [its docs argue text DSLs suit LLMs and diff cleanly](https://docs.structurizr.com/ai/dsl-generation). | Heavy for a canvas that is not C4-only. |
| D2 | Clean syntax, several layout engines selectable ([layouts](https://d2lang.com/tour/layouts/)). | Another toolchain; same limits as Mermaid for code links. |
| Coordinates (Excalidraw, tldraw "make real") | Maximum control. | Poor fit: see 4.2. Excalidraw/tldraw details are **[mem]**, my search returned nothing on them. |

Recommendation: **keep JSON as the canonical format**, since Axle's differentiators (links to code, status, live comparison, tours) all need ids and fields. Add an **optional `source` import** for text the agent already has (a Mermaid `sequenceDiagram` or `stateDiagram-v2` pasted from a doc or README), converted to a `BoardSpec` on the host. This is a spike, not a commitment: whether a Node-side Mermaid parser without a DOM exists for these diagram types is **[unverified]** (Maid, a parser-based validator for agents without a browser, exists per [this search result](https://awesome.ecosyste.ms/projects/github.com%2Fprobelabs%2Fmaid); its coverage of sequence/state was not checked).

### 3.2 Layout engines

- **Do not ask the agent for positions.** Spatial reasoning is a known weak spot: [PlanarBench](https://arxiv.org/pdf/2606.02010) tests crossing-free drawings as a spatial-reasoning task, and layout papers report LLMs lack intrinsic spatial understanding ([arXiv 2509.16891](https://arxiv.org/html/2509.16891v3)). I found no head-to-head of coordinates vs DSL; treat "auto-layout beats LLM coordinates" as well supported in direction, **unquantified**.
- **Engines.** Axle's own layered layout is a competent Sugiyama variant. ELK is the production-grade open option: a dedicated crossing-minimisation phase (barycenter or median sweep) plus orthogonal routing and ports ([ELK layered overview](https://eclipse.dev/elk/blog/posts/2025/25-08-21-layered.html)); D2 documents ELK as good at crossings with some unnecessary bends, dagre as strictly hierarchical, and TALA as an orthogonal engine aimed at architecture diagrams, not long DAGs ([D2 TALA post](https://d2lang.com/blog/tala-is-open-source/)). I found **no quantitative crossing comparison** of ELK vs dagre vs TALA; do our own on Axle fixtures.
- Recommendation: do not swap engines now. First add a **crossing counter and a size/density check to the lint** so we know how bad we are. Spike `elkjs` behind a flag only if the numbers are bad (ports for member rows and compound-node layout are what ELK does that ours does not; effort L).

### 3.3 What makes an agent-authored diagram good (the guidance to put in the tool)

Derived from the evidence below and from how Axle renders. Put it in the `draw_board` description (short) and in an MCP prompt `diagram_guide` (full), like `tour_guide`:

1. **One question per board.** Say in `title` what it answers. Over ~15-20 visible nodes, split or use collapsed `groups`.
2. **Pick the kind by the question:** how does it run -> `sequence` (order matters) or `flow`; what is it made of -> `architecture`/`class`; how is data stored -> `er`; what states can it be in -> `state`; what will we do -> `plan`; what changed -> `compare`.
3. **Ground it:** take names from `find_symbol`/`flow_text`, give `symbol` (and `file`) for every node that is real code. Mark invented things (a proposed class) with no `symbol` and `kind` as new, so real and planned are distinguishable.
4. **Label edges with verbs or payloads** ("validates", "OrderPlaced event"), not "calls".
5. **Group by layer/service/package**, never more than 2 nesting levels.
6. **Edge kinds carry meaning** (reads vs writes, extends vs uses); use them instead of prose. Let the legend say it.
7. **Order with `order`**, not with array position or labels like "1.".
8. **Then explain it:** a board should come with `steps` (section 6), not a paragraph in chat.

### 3.4 Validation and repair loop

The pattern that works in the wild is: validate, feed the precise error back, cap retries. One write-up validated by rendering with Mermaid CLI, sent faulty code plus error plus the syntax reference to the LLM, retried up to three times, and reports success rising from about 70% to 95% ([HU Berlin report](https://llm-enabled-development-41d6d8.pages.cms.hu-berlin.de/en/experiments/diagram/diagram-long); self-reported, single case). Axle's `draw_board` is already half of this: it returns warnings. Make it a real **lint** that returns a numbered list the agent can fix by calling again with the same `id`:

| Lint | Today | Proposed |
| --- | --- | --- |
| Unknown node/edge kind, unknown `kind` of board | dropped or defaulted silently | warn: "node `x`: kind `repo` is not one of ...; drawn as class" |
| Edge to unknown id | warned (count only) | list the first 5 offending edges and the nearest existing ids |
| `file` missing on disk / `line` past EOF | not checked | warn per node |
| `symbol` not found in the index | no such field | warn with the closest matches from `find_symbol` |
| Orphan nodes (no edges, not a note) | grid at bottom, no warning | warn |
| Too dense: >20 visible nodes, >35 edges, estimated crossings > N | no warning | warn with "split by ..." hint |
| Unlabelled edges on a `flow`/`sequence`; decision with <2 outgoing | no | warn |
| Two nodes with the same label | ids made unique silently (`id_`) | warn |
| Sequence without `order` | n/a | warn, order by array |
| Cycle in a `plan` | not checked | warn |
| Empty groups / group with one node | no | info |

Keep the result short: errors first, at most ~10 lines, each with the fix. Axle's existing error style ("A board shows at most 400 nodes; split it into several boards.") is the model.

## 4. Q3: quality, what the evidence says

### 4.1 Evals and papers (all from search summaries, full texts not read)

- **Syntax is the first failure; semantics the second.** [MermaidSeqBench](https://arxiv.org/abs/2511.14967) scores syntax correctness, activation handling, error handling and usability, with an LLM judge (six small models evaluated; large gaps reported). [NOMAD](https://arxiv.org/abs/2511.22409v1) proposes precision/recall/F1 against a gold UML class diagram and the first error taxonomy for LLM UML: structural, relationship and semantic/logical; fine-grained attributes stay weak.
- **Retrieval helps syntax but can invite hallucination** in UML state diagrams ([ESEM 2026 paper](https://drops.dagstuhl.de/storage/00lipics/lipics-vol394-esem2026/LIPIcs.ESEM.2026.19/LIPIcs.ESEM.2026.19.pdf), search summary: automated validation cannot replace human correctness assessment).
- **Architecture views from code.** [LLM-based Automated Architecture View Generation: Where Are We Now?](https://arxiv.org/pdf/2603.21178) (340 repos, 13 configurations, 3 LLMs, 3 prompting techniques, 2 agentic setups) reports prompting strategy gives only marginal improvement. [ArchAgent](https://arxiv.org/pdf/2601.13007) reports an ablation where dependency context from static analysis improves accuracy. [Code2UML](https://www.alphaxiv.org/abs/2605.24453) compacts intermediate representations with a deterministic, non-LLM step to fit context. Pattern: **facts from static analysis, LLM for naming/grouping/narration.**
- **Spatial layout:** see 3.2. Discretising positions to a coarse grid helps LLMs ([SSR](https://arxiv.org/pdf/2603.00409)); declarative DSLs constrain output ([GraphiMind](https://arxiv.org/pdf/2401.13245)). Neither is a controlled comparison.
- **Do diagrams help readers?** Controlled experiments on node-link/graph visualisations report better correctness, with speed mixed: [graph-based visualisation](https://ingenieria.ute.edu.ec/index.php/revista/article/view/134) (+21% correctness, no time gain, 20 students), [CodeCity](https://2011.icse-conferences.org/content/software-systems-cities-controlled-experiment.html), [Hunter](https://conf.researchr.org/details/icpc-2020/icpc-2020-research/29/Evaluating-a-Visual-Approach-for-Understanding-JavaScript-Source-Code) (16 devs, faster and more accurate; eye tracking shows the diagram draws most attention). Small studies; none on AI-written diagrams. I found no study on state machines or on hallucinated relations in code-grounded diagrams specifically (**gap**).

### 4.2 Tricks, ranked by fit to Axle

1. **Ground in the index (biggest).** Add `symbol` and verify it; where possible let Axle *derive* nodes and edges from code and let the agent only choose, group and annotate (section 7, `board_from_code`). Follows the "static analysis + LLM" pattern above.
2. **Ids tied to real symbols.** Use the tour anchor scheme (file + qualified method + line hint, re-resolved) for boards. Poly ids are positional and move with lines (`guided-tours.md` Decision 2), so do not use them as the stable key.
3. **Validate and return a lint** (3.4).
4. **Size limits that match a human page, not the parser.** The 400-node cap is a safety cap; add a *soft* limit (~25 visible nodes) in the lint and the guidance. Progressive disclosure already exists in the UI (collapsed groups, focus + depth, search); expose it to the agent: `collapsed: true` on groups by default for boards over the soft limit, and a `focus` field so the first view is the answer, not the whole system.
5. **Constrain the vocabulary.** The enum approach works; add `shape` and fewer, clearer edge kinds rather than free text.
6. **Short prompts beat long ones.** Prompting strategy gave marginal gains in the architecture-view study, so spend effort on tool structure, not prompt wording.

## 5. Competitive notes (what to copy, what not)

Sources are **[mem]** unless linked; re-check before quoting.

| Tool | Idea worth taking | Not for Axle |
| --- | --- | --- |
| [Mermaid](https://mermaid.js.org) | Shortest syntax for sequence/state/ER; huge model familiarity (unverified); `parse()` error loop. | Layout quality is limited; no code links. |
| [D2](https://d2lang.com) | Pluggable layout engines (dagre, ELK, TALA); containers; themes; "sketch" mode. | Separate toolchain. |
| PlantUML | The full UML kind set; stereotypes. | Layout via Graphviz; ugly defaults. |
| [Structurizr DSL](https://docs.structurizr.com/ai) | One model, many views, level rules. This is the C4 reference. | |
| Excalidraw / tldraw "make real" | Hand-drawn feel signals "sketch, not truth"; useful for *proposed* designs. | Coordinates and screenshots-to-code are off-topic. |
| [Eraser DiagramGPT](https://www.eraser.io/diagramgpt) | LLM first picks the diagram type, then emits its diagram-as-code ([per its FAQ](https://www.eraser.io/archived/diagramgpt-32k)); editable output. This "classify then generate" step maps to our guidance 3.3 #2. | |
| Napkin, Whimsical AI | Text to stylised visual; lots of polish. **[mem]** | Not code-grounded. |
| Claude artifacts / inline SVG | Agent writes whole pictures; flexible. | Can't link to code, can't update one node, nothing live; quality varies per answer. Axle's structured board is the right trade for code. |

## 6. Q4: diagrams x tours x canvas

What the three existing pieces give: the **tour player** (cursor, spotlight, caption, step bar, `tour_control` notes), **boards** (spec + layout + search/focus), **skeleton-first** (plan vs code matcher with live colours). They are not connected: a tour cannot play on a board, and a board has no steps.

1. **Board steps (highest leverage).** Add `steps` to the board: each step names `nodes` and/or `edges` to light, a caption, optional `focus` (group to open). Play with the existing tour UI (the `TourPlayer`, `guided-tours.md` §3). Result: `draw_board` + steps = "walk me through this design" with no code on the canvas, which fits plan mode and design discussions. Edge `order` doubles as the default step order for sequence/flow.
2. **Highlight a path.** `highlight: [{ path: ['api','svc','db'], label: 'happy path' }]` draws a bold route and dims the rest; the same renderer as a step.
3. **Tour step on a board node.** Let a code tour step say `board: {id, node}` so the tour can jump from the canvas card to the design box ("this class is box X in the design"). And the reverse: board node with `symbol` has "Show in flow" using `show_flow` resolution.
4. **Live diagrams.** Skeleton-first proves the loop: the plan is the agent's, the colours come from the code index. Generalise from "class/er type exists" to **any node with a `symbol`**: host sets `check` (exists / missing / moved) on every board refresh and shows a "stale" badge when the code changed since drawing (the `bill_behavior` card in the user's screenshot already shows "Can't find this code any more" for tour steps; boards should do the same). Also for edges: a `calls` edge whose call no longer exists in the index is `differs`.
5. **Diffs between versions.** `draw_board` with the same `id` replaces and loses history today. Keep the previous spec; the canvas offers "Show what changed since the last draw" (added/removed/changed by node id + edge key) with the `change` colours. For agent-requested comparison: `compare: { base: '<board id or "code">' }`.
6. **Generated sequence from a flow.** A tool or a canvas action turns `flow_text`'s call chain into a sequence board and a tour at once. The agent then only adds captions.
7. **Answer questions in the diagram.** `tour_control` `note` already pins an answer to a step; extend `update_board` with `note` on any node (already supported by the handler but described only for plans) and `highlight`, so the agent can answer "what about the cache?" by lighting the cache box.

## 7. Q5: recommendation

### 7.1 Quick wins (S, days)

1. **Lint in the `draw_board` result** (table in 3.4). Start with: silent drops of unknown kinds, unresolved `file`/`line`, orphans, density, same-label nodes, unlabelled flow edges. Add tests next to `parseBoard`'s.
2. **`symbol` on nodes**, checked against the index; warn with `find_symbol` suggestions; autofill `file`/`line`.
3. **Description + `diagram_guide` prompt** with the 8 rules (3.3), and a line in `INSTRUCTIONS` (`src/mcp/protocol.ts`) that says: after drawing, explain with `steps`, not chat.
4. **`note` and `status` documented for all kinds**; callouts as an `attach` note (node/edge id) rendered as a bubble.
5. **Fix the silent `kind` fallback** (`spec.ts:107`): throw or warn when `kind` is present and unknown.
6. **Edge `order`** (integer) shown as a number badge; used by steps later.
7. **Keep the previous version** of a board per id (memory only) as groundwork for diffs.

### 7.2 Roadmap

| # | Item | Size | Depends on | Value |
| --- | --- | --- | --- | --- |
| 1 | Lint + `symbol` grounding + guide (quick wins 1-4) | S | none | Quality of every board |
| 2 | **Real sequence renderer** (lifelines, ordered messages by `order`, sync/async/return styles, activation bars, `alt/loop` as groups) | M | 7.1 #6 | Largest missing kind |
| 3 | **Board steps + path highlight** playing in the tour UI | M | tour player (PR #8) | Explaining, not just drawing |
| 4 | **Compare / change colours** (`change` on node/edge, `base` board, "since last draw") | M | 7.1 #7, skeleton-first colours | Review of design changes |
| 5 | **Generate from code** (`board_from_code`, or a canvas action): flow -> sequence, tables -> er, package deps -> architecture, enum + transitions -> state; the agent passes scope and optional annotations | M-L | index (poly) | Removes hallucination for the common cases |
| 6 | `state` kind (+ `shape` initial/final/choice, edge `guard`) | S-M | none | Lifecycle code |
| 7 | **C4 levels**: architecture `level` (context/container/component), `tech`, boundary groups, "zoom into this box" opening the lower level board | M | 7.1 #1 | System explanations |
| 8 | Live boards: refresh `check` for any `symbol`, stale badge | M | symbol, skeleton matcher | Trust |
| 9 | Swimlanes (`group.lane`), ER crow's-foot and PK/FK | M | none | Polish |
| 10 | Mermaid/`source` import spike (sequence, state) | S spike, M build | 7.2 #2, #6 | Agent ergonomics |
| 11 | ELK spike behind a flag, if the crossing numbers are bad | L | lint metrics | Layout |
| 12 | Deployment from compose/k8s; timelines | L | new index | Low |

Order logic: 1 makes everything after it safer; 2 and 3 are what users *see* improve; 5 is the structural bet and can start in parallel with 3 because it only needs the index.

### 7.3 Concrete schema changes (all additive, `version: 1` stays; old boards still parse)

```jsonc
{
  "board": {
    "kind": "flow|plan|class|er|sequence|architecture|state",   // + state
    "level": "context|container|component",                      // architecture only
    "legend": [{ "key": "writes", "text": "persists to the database" }],
    "focus": "svc",                                              // node or group opened first
    "base": "order-flow",                                        // compare against this board id
    "steps": [                                                   // played with the tour UI
      { "title": "Validate", "caption": "Why this runs first ...",
        "nodes": ["api","svc"], "edges": [["api","svc"]], "focus": "grp-core" }
    ],
    "highlight": [{ "path": ["api","svc","db"], "label": "happy path" }],
    "callouts": [{ "node": "svc", "text": "Retries twice, then dead-letters" }],
    "nodes": [{
      "symbol": "OrderService.Place",       // verified against the index; fills file/line
      "tech": "Spring Boot",                // c4 line under the label
      "shape": "rect|round|diamond|cylinder|actor|cloud|initial|final",
      "change": "added|removed|changed",    // host fills it for compare; agent may set it
      "lane": "api"                         // swimlane: id of a group with kind "lane"
    }],
    "edges": [{
      "order": 3,                           // sequence/flow order, also default step order
      "style": "solid|dashed|dotted",       // dashed = return / async by convention
      "async": true,
      "guard": "amount > 0",                // state transitions
      "change": "added|removed|changed"
    }],
    "groups": [{ "kind": "boundary|lane|layer", "tech": "..." }]
  }
}
```

Host rules that go with it: `change`, `check`, `warn` stay host-only except `change` on a *proposed* board; every new string field is capped like the existing ones in `parseBoard`; `symbol` is resolved only inside the workspace (same rule as `file`); counts stay capped; `BOARD_KINDS`/`NODE_KINDS`/`EDGE_KINDS` in `tools.ts` and `spec.ts` move together (the existing enum test catches drift); `board-canvas/spec.ts` is the one copy.

`draw_board` result shape (text, as today): first line "Board `id` drawn: kind, N nodes, M edges", then `LINT` with numbered items, then for plans the update hint. `update_board` gains `highlight` (node ids / path) and `change`, and may take an array of node updates in one call.

### 7.4 Risks and open questions

- **Steps vs tours overlap.** Board steps and `tour` do the same job on different canvases. Decide whether a board step is a tour with `flow: {board: id}` (one player, one set of tools) or a second field. I lean to the first: `tour` accepts `board` as its canvas, and `draw_board` `steps` is sugar for it.
- **Sequence from `flow_text`** needs call order; the index may not know branch order or async hops. Mark such edges "unordered" rather than pretend.
- **Mermaid import** may not be worth it if no DOM-free parser covers sequence and state; the spike should settle that before any design.
- **Evidence gap:** no study found on whether AI-drawn diagrams reduce review errors, or on hallucination rates for code-grounded diagrams. Axle could measure it itself: lint-warning counts per board and "agent re-drew after lint" rate are free signals.
- **Layout numbers:** no public crossing comparison of ELK/dagre/TALA was found; gather our own on a few real boards before choosing.
- **TALA licence**: a secondary source says it became open source (MPL-2.0); the [D2 post](https://d2lang.com/blog/tala-is-open-source/) is titled "tala is open source" but I did not read the licence text. **[unverified]**.
