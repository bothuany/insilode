# Skeleton first (variant A)

Status: built on `claude/skeleton-first-067ed6`, on top of guided tours (PR #8). Written 2026-10-20.

Research: `docs/research/skeleton-first-landscape.md` and `skeleton-first-council.md` (in the main checkout, not committed).

## The problem

AI writes so much code that developers lose the know-how of their own system. Skeleton first is an opt-in mode in which the developer writes the *structure* of a change themselves: the types, entities, interfaces and signatures. The agent designs it, checks it, explains it and fills the bodies.

## The user's decisions

1. **Variant A order.** After a plan is approved, the agent draws the target design (class or ER) with `draw_board`. The developer then writes the skeleton in the editor: types, entities, interfaces, signatures, empty bodies.
2. **The diagram is corrected by talking.** "Make DiscountPolicy an interface", "remove the repository": the agent redraws the same board. This repeats until the developer accepts it. Nothing is edited by dragging.
3. **An on/off switch, never imposed, per agent.** Each agent row in the dock has one "Skeleton" button (pressed when on), explained in its tooltip, and nothing else. The setting `insilode.skeletonFirst.enabled` (default off) is only the starting value for an agent nobody has switched. When it is on for an agent, the mode is offered only when the plan adds or changes types, entities or interfaces. "Just do it" is always one sentence to the agent. Turning it off takes effect at once.
4. **Live plan vs actual.** While the developer writes, the board is recomputed from the real type index on every save. Each type and member is marked **matches**, **missing** or **differs**; a type or member that was already in the code when the design was drawn is **existing** (neutral). The diagram is the plan and the code is the truth; nothing round-trips.
5. **Check.** The developer says "check"; the MCP tool `check_skeleton` returns the structured diff. The agent explains each difference with a reason and does not fix the code. When the developer answers "mine is better", the agent argues its case or updates the plan.
6. **Hand over.** The agent fills the bodies. There is **no lock, only a warning**: if the agent changes a signature, a name or a relation the developer wrote, a passive warning shows on the board and in the agent's own reply, with the before and after text; keep or revert is the developer's call.
7. **A closing tour** of what was filled, with the `tour` tool.
8. **No scores, no metrics, nothing leaves the machine.**

The council's main objection: in variant A the developer types out a design they have already seen, which is transcription rather than generation. The user chose A knowingly, so it is built as decided. The way to test the objection later is to swap steps 1 and 2: the developer sketches first and the agent reveals its design afterwards.

## The gate: an MCP handshake before the first edit, in any mode

Claude Code keeps working in the same turn after the user approves `ExitPlanMode`. Insilode's hooks only observe, so `PostToolUse ExitPlanMode` fires after the agent is already on its way to its first edit. The dock cannot type into a working session either. A dock-only gate would therefore come too late. Hooking `ExitPlanMode` is also version-dependent, and Codex has no such tool. And many requests never go through plan mode at all.

So the gate is something the agent does **before its first edit**, plan mode or not: it calls `check_skeleton`.

- The server instructions (`src/mcp/protocol.ts`) and the `skeleton_first` MCP prompt say: before your first edit for a request or an approved plan that adds or changes types, entities or interfaces, call `check_skeleton` once. A bug fix, a small edit or a question does not need it.
- The tool reads the live setting in the window, not anything fixed when the MCP server started, so turning the mode off works at once:
  - **Off:** "Skeleton first is off: implement the plan as usual." One fast call, nothing else.
  - **On, no design yet:** "Draw the design with `draw_board` (id `skeleton-…`, kind class or er, and on every type you add or change the members the developer is to write, as `{"text": "name(param: Type): Return"}` objects), then STOP." The agent tells the developer, in a few lines, which types are new and which existing types get which members, and what to say next.
  - **The design itself** is answered by `draw_board`, not by a later check: its result says which types are new, which existing types get which members, and which are context only, so the agent can tell the developer at once. A design with a new type that has no members is turned down there ("redraw with members"), and the stage stays `design`.
  - **Later:** the diff (see Check).
- After that the developer drives the stages by talking to the agent: "check", "hand over", "just do it", "done", "keep it", "revert". The agent passes the reply to `check_skeleton` as its `step` (`handover`, `just`, `finish`, `accept` with a warning number); the window moves the stage. Every answer repeats what the next replies map to, and the prompt-time reminder says the same, so a small model stays in step.

The instructions alone are not enough. In the first probe, Haiku went straight from plan approval to writing `Order.ts` and never called the tool. So for Claude Code the dock adds two reminders while the switch is on for that agent (`flow-agent/src/skeleton.ts`, `HOOK_CONTEXT`):
- **With every prompt** (`UserPromptSubmit`): "skeleton first is ON. If this request makes you add or change types, entities or interfaces, call `check_skeleton` once before your first edit… For a bug fix, a small edit or a question, go ahead as usual." This is what makes it work outside plan mode. It is under 400 characters, since it rides along with each prompt.
- **When a plan is approved** (`PostToolUse` on `ExitPlanMode`): the same rule for the plan just approved.

The hooks still decide nothing. They are not a lock and never deny; they only hand the agent text to read. The hook script (`flow-agent/src/hookScript.ts`, tested end to end in `test/hookScript.test.mjs`) is strict about what it prints:
- only those two exact texts, each for its own event;
- a reply over 8000 characters is dropped whole;
- any other text, a reminder on the wrong event, or a decision field prints nothing.

So whatever else answers on the hook port cannot put words into the agent's context. With the agent's switch off, every event answers `{}` as before.

In the probes, Haiku called the tool before its first edit, both after plan approval and for a plain request outside plan mode.

Codex gets neither reminder (its hooks are separate and not wired for this), so it relies on the server instructions alone. The limit for any agent: one that skips the call just implements the plan as usual. Nothing is forced, and the tool's answer is the only thing that stops the agent.

## Stages

Per agent session, held in the window's memory (`src/skeleton/sessions.ts`) and written to the workspace state under `flow.skeleton.sessions.v1` (`src/skeleton/persist.ts`) every time it changes, so a window reload keeps them. Only `{session, stage, boardId, skipped}` is stored, at most 20 sessions, and damaged data is ignored. The plan board is kept by the board store, not here. On start each saved session past the design stage comes back at its stage, attached to its board, when that board is still in the store; an entry whose board is gone is dropped without a word. The comparison with the code is recomputed. The baseline is not stored, so after a reload a type the developer already wrote reads as existing code instead of as a match, and in the hand-over the developer's declarations are read again from the code as it stands then (a change the agent made to one of them before the reload is not reported).

| Stage | Entered by | `check_skeleton` answers |
| --- | --- | --- |
| (none) | | Off, or "draw the design and stop, and tell the developer what to say" (the stage becomes `design`) |
| `design` | The agent's first `check_skeleton` while its switch is on | The same, until a class or ER board is drawn |
| `skeleton` | The agent drew the design and every new type has members (the board colours it at once: new things missing until written, existing types neutral) | The diff, "explain, do not fix", and the replies mapped to steps |
| `handover` | Step `handover` (the developer said "hand over") | The diff, numbered warnings, "fill the bodies, keep the signatures, report each warning, close with a tour" |

- Step `just` drops the stage ("implement as usual") and remembers, per session, that the developer chose it. `flow.skeleton.stage(session)` then answers `{stage: undefined, skipped: true}`, so the dock can show a "skipped" badge on the agent's row. The badge is kept in the workspace state too, and goes at the session's next design step (its next `check_skeleton` that starts a stage), when `finish` is sent, or when the agent's switch goes off. While a session has a stage, the command answers `{stage, skipped: false}`.
- Step `finish` drops the stage at the end.
- Turning an agent's switch off ends its stage at once (the board loses its colours); other agents keep theirs. `check_skeleton` asks the dock for that agent's switch (`flow.agents.skeletonOn`); an agent Insilode did not start has no switch and follows the setting.

## Plan vs actual: the matcher

`src/skeleton/match.ts` is pure (no `vscode`). It takes the plan board (a `BoardSpec` of kind class or er) and the `TypeGraph`, and returns one result per node and per member.

- **Types** are matched by name: case-insensitive, with the qualified prefix ignored.
  - When two types share the name, the one in a file changed since the design was drawn wins. Otherwise the result says it is ambiguous; it never picks silently.
  - A type with no exact name match may be a rename: an unplanned type of a similar name, in which the planned members mostly appear, **and** that the developer wrote since the design was drawn (in a file saved since, and not in the baseline). It is then marked **differs (renamed?)**. Anything else is **missing**: in a real project a planned `BillReportDTO` was taken for the old `BillResponseDTO`, which shares a word and eight of its fields.
- **Kinds.** A planned `interface` or `enum` must be one. All the class-like roles are the same here: class, service, controller, repository, entity and dto may be a class, record or struct. Any other combination **differs**.
- **Members.** The planned text is parsed in either style: `name(T a, U b): R`, `R name(T a)`, `name: T` or `T name`.
  - A field and a property are the same thing. A planned property also matches a Java getter (`getName`/`isName`).
  - Parameter names and package qualifiers are ignored, as is whitespace.
  - Types are compared by the identifiers they are made of. Collection wrappers are equal to each other (`List<T>`, `T[]`, `IEnumerable<T>`, `Set<T>`, `Sequence[T]`), and so are optional ones (`T?`, `Optional<T>`, `T | null`, `Optional[T]`).
  - A different parameter count or type, or a different return or field type, is **differs**, and the actual text is shown.
  - An unmatched planned member and an unmatched actual member with the same shape are a rename: **differs (renamed?)**. A member the type already had before the design is never a rename of a new one, and in a type that existed only a close name counts.
  - Extra members are fine: private ones, constructors and accessors are ignored, and extra public members are listed but never coloured.
- **Relations.** `extends`/`implements` edges are checked against the type's supers. `has`/`has-many`/`uses`/`depends` edges are checked against the graph's edges between the two types (field, method, constructor or generic). A missing relation makes its node **differs**.
- **The baseline.** When the design is first drawn and the index is complete, the window keeps each type's id with the names of its members (`baselineOf`); if the index is still loading, it is taken at the first complete recompute, leaving out files saved since. A redraw keeps it, so the developer's new types never turn into old ones.
- **Node colour.**
  - **differs** when anything differs.
  - A type in the baseline is **existing** (neutral: a grey stripe and an outlined badge) until everything the plan adds to it is written, then **matches**. Its members that were already there are **existing** too; only the new ones are coloured. Before this, a type that only existed read as "matches", and the developer took it for something the agent had written.
  - Otherwise **missing** when the type or any planned member is missing.
  - Otherwise **matches**.
- When the index is still building, the answer is "not checked yet", never "missing". False reds would teach people to ignore the colours.

The board is recomputed from the index after every save of a file the index reads (`TypeService.refreshFiles`). The plan stays as the agent drew it in `BoardStore`. A decorator adds `check` and `checkNote` to the copy that is shown. These fields are host-only: `parseBoard` drops them, so an agent cannot paint its own board green.

`parseBoard` is lenient about how agents write a board: a member may be plain text (`"members": ["id: UUID"]`) as well as `{ "text": … }`, and `name` stands for a missing `label`; `draw_board` also takes the board id from inside `board`. Each of these was lost in a real session (Sonnet 5.5), which left every type without members. Members that are still dropped are counted in `draw_board`'s answer.

Languages: whatever the type graph covers, which is Java, TypeScript/JavaScript, Python, Go, PHP, Ruby and Rust through the code index, and C# through the analyzer. Golden tests cover Java, TypeScript, Python and C#.

## Check and "mine is better"

The developer says "check". The agent calls `check_skeleton`, explains each difference with a reason phrased as a trade-off, and does not edit any file. If the developer says theirs is better, the agent argues its case or, if it agrees, redraws the plan with the same board id. The board recolours from the new plan straight away.

## Hand over and the signature warning

The developer says "hand over"; the agent calls `check_skeleton` with step `handover`. The window records the developer's own declarations: for each planned type and member that exists in the code now, its file and header text (the declaration lines up to `{`, `;`, `=>` or a trailing `:`). The answer tells the agent to fill the bodies and keep every signature, name and relation.

- After each agent edit (flow-agent's `flow.agent.edited`, after the tool ran), the files it touched are re-read.
- A recorded header that is no longer in its file is a **warning**: changed, renamed, or removed, numbered, with the before text and the after text.
- When the developer saves a file in the editor, the recorded headers in that file are taken from it again. The developer's own changes are never warned about.
- Warnings are passive. They never block, steal focus or pop up. They show:
  - **on the board**, as an amber mark on the member, its tooltip naming the change and how to put it back;
  - **in the agent's reply**: after filling, the agent calls `check_skeleton` again, which lists the numbered warnings, and tells the developer each one, before → after, and why.
- The developer answers in the chat. "Keep it" → step `accept` with the warning number (the new header becomes the recorded one). "Revert" → the agent puts the recorded header back, keeping the body.
- **Revert without the agent:** the command **Insilode: Revert an Agent's Change to Your Declaration** lists the warnings. It writes the recorded header back over the current declaration lines only, never the whole file, and refuses a file with unsaved changes or one that moved on since the warning. It is a command the developer runs, never an MCP tool, because tools write nothing.

## The closing tour

The hand-over answer ends with "play a closing tour with `tour` on `{"changes": true}`: one step per filled method". The developer can ask for it again in the chat.

## Pieces

| Piece | Where |
| --- | --- |
| Matcher, header guard, stages (pure) | `flow-view/src/skeleton/{match,guard,sessions}.ts` |
| Host: graph refresh, board decorator, steps, the Revert command | `flow-view/src/skeletonHost.ts` |
| `check_skeleton` tool (with `step`), `skeleton_first` prompt, instructions | `flow-view/src/mcp/{tools,handlers,prompts,protocol,register}.ts` |
| `check` and `checkNote` on board nodes and members | `flow-view/src/board/spec.ts` = `ui/src/board/spec.ts`, rendered in `ui/src/board/cards.tsx` |
| The Skeleton button, the per-agent switch, the hook reminders | `flow-agent/src/{skeleton,hookScript,dockMessage,dockPage,dock,agents}.ts`, the setting in `flow-agent/package.json` |

Commands across the boundary (all registered, checked by `test/arch/commands.test.mjs`):
- flow-view → flow-agent: `flow.agents.skeletonOn` (this agent's switch).
- flow-agent → flow-view: `flow.skeleton.finish` (the switch went off).

## Out of scope

- Locks.
- Diagram editing and stub generation (variant B).
- Levels.
- Team policy.
- Any record that outlives the window.
- The council's sketch-first ordering.

## Probe (2026-10-20)

The probe ran in web mode with a real Claude Code session (Haiku 5.5, set in the demo project's `.claude/settings.json`) on a TypeScript change to the demo shop. All eight steps worked:

1. **Switch on.**
2. **Plan, then the design.** The plan was approved, then Haiku called `check_skeleton`, drew a 6-type class board and stopped. This needed the approval-time reminder: without it, Haiku went straight to writing.
3. **Change by talking.** "Rename Receipt to CheckoutResult" redrew the same board.
4. **Live colours.** After a save, the board showed matches, missing and differs per type and member.
5. **Check.** The agent explained each difference as a trade-off and edited nothing. When told "mine is better", it agreed and redrew the plan, and the type turned green.
6. **Hand over.** The agent filled the bodies without touching a signature. When asked to add a parameter, the dock and the board showed the warning. Revert put the header back and kept the body. The agent then noticed the body still used the removed parameter.
7. **Closing tour.** It ran on the change set: 5 steps.
8. **Switch off.** The row and the colours went at once, and `check_skeleton` answered "off".

Fixed after the probe:
- A planned `constructor(...)` now matches the language's constructor.
- An empty workspace counts as checked.
- "Just do it" is now styled like "Write the skeleton".

## The dock: one button per agent

At the user's request the dock row has a single "Skeleton" button and nothing else.
- It is pressed (`aria-pressed`, filled) when skeleton first is on for that agent.
- Its tooltip explains what it does and what to say to the agent.
- It is reachable with the keyboard; Enter and Space press it.
- There are no status lines, stage labels, counts, choice buttons or warning blocks on the row: the stages are talked through with the agent.
- The board's plan-vs-code colours stay.

## Probe outside plan mode (2026-10-20, Haiku 5.5, auto mode)

- **Switch on, "add discount codes to orders":** the reminder arrived with the prompt, then `check_skeleton` and `draw_board` ran with no edit. The design came first.
- **Switch on, "fix the typo in CONFIRMATION":** the reminder arrived, and the agent made a direct edit. The design offer stayed open for the other change.
- **Switch off, "add a Coupon type":** no reminder. The agent called `check_skeleton` from the server instructions, got "off" and wrote the file.
- **Board colours re-checked on a partial skeleton:** DiscountCode matches, applyDiscount is missing, Order differs (`discount` against the planned `discountCode`), and DiscountRepository has one member missing.

## Chat-driven flow: trust and probe (2026-10-20)

- **Steps rest on the agent's honesty.** A step from the agent (`handover`, `just`, `accept`, `finish`) is taken on the agent's word that the developer asked for it. Every step is logged with the session. A keep (`accept`) never disappears silently: the board still marks it, as "Kept (the agent was told to keep it)".
- **Agents Insilode did not start** have no switch: they may check, but their steps are refused.
- **Probe**, Haiku 5.5 in auto mode, outside plan mode:
  - The button rendered off, on hover and on.
  - Turned on, "add loyalty points": the agent called `check_skeleton`, drew the design and stopped. The board was already comparing the design with the code, and the agent told the developer in the chat what to say next.
  - "Check" explained the one difference, `earn` without `amount`, as a trade-off, with no edits.
  - "Hand over, and add reason to redeem": step `handover`, then the bodies, then `check_skeleton`, then a 3-step tour. The reply listed "Warning 1: redeem signature changed", before → after, and asked keep or revert.
  - "Keep it, we are done": step `accept` (warning 1), then step `finish`; the board went plain.
  - Turned off, "add a Referral type": `check_skeleton` answered off, and the agent wrote the file.

## Real-project fixes (2026-10-20, Sonnet 5.5)

A developer used it on a CRM's billing service ("a bill report with the customer in it"). The agent drew the right types, stopped, and said what to do, but:
- **No members on the board.** The agent sent `members` as plain strings (and `name` for the label, the board as JSON text, the id inside it). `parseBoard` kept only `{ text }` members and dropped the rest without a word. Now plain strings are members, `name` is a label, the id is read from either place, dropped members are counted, and a new type without members is turned down with an example of the form.
- **Existing types read as done.** With no members, every type that already existed matched, and the developer asked why the agent had created files (it had not). Now they are **existing** and only their new members are coloured, and `draw_board` tells the agent which types are new and which existing types get what.
- **BillReportDTO read as differs.** The empty plan let the rename rule take the old BillResponseDTO. Renames now need a type written since the design; golden test `skeleton-expected/billing-report-java.txt` (fixture `types-fixtures/skeleton-billing`, the agent's own payload).

Probe on a copy of that project (web mode, Claude Code 2.1.304, Sonnet 5.5, the same request):
- Before, on main, the agent's original payload through the old matcher: five existing types "matches" with no members, BillReportDTO "differs (renamed? BillResponseDTO)". On this branch: five "existing" with their new methods missing, BillReportDTO missing.
- Live: Sonnet sent members as objects this time. draw_board answered with the new type (BillUserReportDTO), the methods each existing type gets, and three context types; the agent's reply split them the same way, and no file was touched.
- The board: the header read "0 match · 1 missing · 0 differ · 6 existing"; existing types had a neutral EXISTING badge with only their new methods marked missing, and the new DTO was MISSING with its five fields.
- The developer wrote BillUserReportDTO and saved it in the editor: it turned MATCHES with every field ticked at once, and the existing types stayed neutral.

Review follow-ups in the same change:
- A design turned down for empty types is taken on the second try, still naming the empty types, so a marker interface never traps the agent in a redraw loop. A new type the developer has written no longer counts as empty.
- The baseline keeps every type id (what a rename may not be) but member names only for the types the plan names; a redraw that names more types adds theirs from the code as it is then.
- `draw_board` will not replace another agent session's skeleton design: an id that belongs to one draws a new board, and the answer says so.
- If reading the index fails while the design is drawn, the board is still drawn and the answer just has no summary.
- At the hand-over, members that were already there are kept as the developer's declarations too, as before (they used to read as "matches"): an agent that changes an existing signature gets a warning.

## Where each file goes, and live updates (2026-10-21)

A developer used it on a CRM (analytics-service) and had to ask the agent which path to create the controller in; and a file they had created still read MISSING. The exact file of that report was not available, so the second case was not reproduced as such: what follows is what was found to drop or delay a written type, and what was made faster.

**Paths** (`src/skeleton/paths.ts`, pure). Every planned type that is new gets a target file, worked out from the layout the project already has, never invented:
- **Module**: the one the plan's existing types live in (a `CustomerClient` that three services have is taken in the module the plan is about: the plan's types that exist, then a module named in the title, then the module of the file the developer has open).
- **Package**: that of the siblings of the same kind in the module (by the name's last word: Controller, Service, Impl, Dto, Client, Config, ...; by the node kind when the name says nothing). An `Impl` goes where the project keeps its impls, else under its interface's package in `impl`. With no sibling, the module's base package plus a folder spelled the way the module spells its own (`controllers` against `controller`).
- **File**: the directory of a sibling with its package path swapped, a file name in the siblings' style. A label that is not an identifier gets no path. The layout is the code as it was when the design was drawn (the baseline), so a type the developer wrote in the wrong place never becomes the convention.
- The board shows the path on the node (`＋ …/controller/BillUserReportController.java`, the whole path and why in the tooltip); `draw_board`'s answer and `check_skeleton` list them, and the agent is told to pass them on and not invent its own.
- **Clicking** a new type sends the node id to the host, which works out the path again from the diff, refuses a path outside the open folders, never overwrites a file, and offers "Create file" (the package line and an empty declaration: Java, C#, TypeScript, Python) or "Copy path". The developer writes the members. The webview never names a path, and an agent cannot send one (`target` is host-only, like `check`).
- **A new type written in another module, or in another package than its siblings'**, is DIFFERS with the reason. The package check applies only when the path came from siblings, not from the fallback convention.

**Live.** Verified: a file that does not parse lost its type (the first item). Improved: the other two.
- **A file that does not parse lost its type.** tree-sitter turns a file with a broken import or a call cut off mid-typing into one ERROR node whose tokens are flat, so `class_declaration` is gone and the type was not in the index at all. `src/poly/javaRecover.ts` now reads the declarations and members of the text itself when the tree has an error, and only adds what the tree did not find. The members are not taken for accessors, since their bodies were never read.
- **A file written outside the editor** (IntelliJ, a formatter, git, the shell) fires no save in this window. The index's own watcher did catch it, but only after it re-listed every entry point, and the file never counted as "written since the design" (which the rename rule and the choice between same-named types depend on). The skeleton host now watches code files itself (create, change, delete), marks them as written, re-reads them and recolours, about a second after the write.
- **Nothing happened while typing.** The index read only the disk. A new worker op, `overlay`, reads an editor buffer as the file's content until the next save (its mtime never equals a file's, so it is never cached); the host sends the buffers of the files being typed in after a 500 ms pause (`ChangeBatcher`, `src/skeleton/changes.ts`). Closing a file without saving reads the disk again.

Probe (web mode, Claude Code 2.1.306, Haiku 5.5 from the demo copy's `.claude/settings.json`, auto mode; a copy of the two-service CRM fixture):
- The request "a bill + user report in analytics-service" through the dock (Skeleton on): the agent called `check_skeleton`, drew four new types and stopped. Every node shows `＋ …/controller/BillUserReportController.java` and so on (1).
- A click on the controller offers "Create file" or "Copy path" (2); "Create file" wrote the package line and an empty class and opened it.
- A write from the shell, as another tool would (3): the members of the controller ticked within two seconds; the DTO written the same way turned MATCHES (4, "1 matches · 3 missing").
- Found while probing: a first board of only new types, with no module on it, got no paths. It now takes the module from any text on the board, then from the open file, and otherwise `draw_board` tells the agent to put the module in the title (test `a plan that names no module`).
- Not probed live: typing without saving (covered by the `overlay` test only), and the terminal-started Claude (no dock row, so no reminders: it skipped the design and wrote the files, as the design doc says an agent that skips the call does).

**Differs, not missing.** A planned method that is not there by name but has the same parameters under another name (`getReportById` for `getReportByCustomerId`), or a name that is close, pairs with it and shows DIFFERS with the code's text.

Tests: `test/skeleton-paths.test.mjs` (golden `paths-crm`, `broken-java`; fixture `types-fixtures/skeleton-crm`: a file with errors, a newly created file, an unsaved buffer, a deleted one, wrong module and package, the batcher with mock timers).

## Known gaps

- A redraw while the developer writes the skeleton becomes the plan even when it has new types without members; the answer asks for members, but the board follows the agent. If the index is still loading when the design is drawn, the turn-down cannot happen then; `check_skeleton` names the empty types later.
- TypeScript interface method signatures are not in the type graph, so a planned interface method shows as missing. This needs work in the poly index.
- Codex gets no approval-time reminder; it has only the server instructions.
- A reload keeps the stages (workspace state), but not the baseline or the developer's kept declarations: see Stages. A saved session of an agent that is gone stays until its switch is turned off or it is finished; it counts toward the 20 sessions.
- Only Java is read from a file that does not parse; the other languages rely on tree-sitter's own recovery.
- Revert leaves a body that may use the reverted parameter. The agent is not told automatically; the warning text says what changed.
