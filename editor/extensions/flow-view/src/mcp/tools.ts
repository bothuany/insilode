/*---------------------------------------------------------------------------------------------
 *  Insilode agent bridge: the tools the `insilode` MCP server offers a model (they show up as mcp__insilode__*).
 *  The descriptions are written for the model: they say when to reach for each tool. All tools only
 *  read, open or display; none writes a file or runs a command. Keep draw_board's schema in sync with
 *  ../board/spec.ts (a test compares the enums).
 *--------------------------------------------------------------------------------------------*/

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export const BOARD_KINDS = ['flow', 'plan', 'class', 'er', 'sequence', 'architecture', 'state'] as const;
export const BOARD_LEVELS = ['context', 'container', 'component'] as const;
export const NODE_SHAPES = ['rect', 'round', 'diamond', 'cylinder', 'actor', 'cloud', 'initial', 'final', 'choice'] as const;
export const CHANGE_MARKS = ['added', 'removed', 'changed'] as const;
export const EDGE_LINES = ['solid', 'dashed', 'dotted'] as const;
export const GROUP_KINDS = ['boundary', 'lane', 'layer', 'alt', 'loop', 'opt'] as const;
export const NODE_KINDS = ['entry', 'controller', 'service', 'repository', 'entity', 'dto', 'enum', 'interface', 'class', 'external', 'step', 'decision', 'note', 'actor'] as const;
export const NODE_STATUSES = ['todo', 'doing', 'done', 'skipped', 'blocked'] as const;
export const EDGE_KINDS = ['calls', 'extends', 'implements', 'uses', 'has', 'has-many', 'depends', 'next', 'yes', 'no', 'reads', 'writes', 'message'] as const;

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description, minimum: 1 });

/** What the flow tools accept as the target: an id from find_entry_points, or a place in the code. */
const TARGET = {
	id: str('Entry point id exactly as find_entry_points printed it (preferred).'),
	file: str('Source file (absolute, or relative to the workspace folder). Use with `method` and/or `line`.'),
	method: str('Method or function name in `file`, e.g. "Delete" or "UserService.remove".'),
	line: int('1-based line inside the method (alternative to `method`).'),
};

const ro = (title: string, idempotent = true): ToolDef['annotations'] => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });

export const BOARD_SCHEMA = {
	type: 'object',
	description: 'The board to draw.',
	properties: {
		kind: { type: 'string', enum: [...BOARD_KINDS], description: 'flow: how a request/process runs · plan: ordered steps to do · class: classes and their relations · er: tables/entities · sequence: messages between actors in order (give every edge an `order`) · architecture: layers/services · state: the states of one thing and its transitions. An unknown kind is drawn as flow, and the answer says so.' },
		title: str('Short title shown above the diagram: the question it answers.'),
		description: str('Optional one or two sentences.'),
		direction: { type: 'string', enum: ['LR', 'TB'], description: 'Left-to-right (default for flows) or top-to-bottom (default for plans).' },
		level: { type: 'string', enum: [...BOARD_LEVELS], description: 'architecture only (C4): context = who uses the system and what it talks to · container = the deployable parts · component = the parts of one container. One board per level; link a box to the board below it with its `zoom`.' },
		legend: {
			type: 'array',
			description: 'What your own colours or edge kinds mean, e.g. [{"key":"writes","text":"persists to the database"}].',
			items: { type: 'object', properties: { key: str('Edge kind, node kind or word.'), text: str('What it means here.') }, required: ['key', 'text'] },
		},
		focus: str('Id of the node or group to open first, so the first view is the answer, not the whole system.'),
		base: str('Id of another board to compare this one with: what is added, removed or changed is coloured. Use it for "what did I change in the design".'),
		steps: {
			type: 'array',
			description: 'Explain the board by walking through it instead of writing a paragraph in chat: 3-10 steps, each lights up the nodes and edges it names and shows its caption, played like a tour. Caption says why and what to watch.',
			items: {
				type: 'object',
				properties: {
					title: str('Short step title.'),
					caption: str('Why this part matters, one or two sentences, plain text (`code` spans allowed).'),
					nodes: { type: 'array', items: { type: 'string' }, description: 'Node ids to light up.' },
					edges: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, description: 'Edges to light up as [from, to] node ids.' },
					focus: str('Group (or node) id to open for this step.'),
				},
				required: ['title'],
			},
		},
		highlight: {
			type: 'array',
			description: 'Routes drawn bold with the rest dimmed, e.g. [{"path":["api","svc","db"],"label":"happy path"}].',
			items: { type: 'object', properties: { path: { type: 'array', items: { type: 'string' }, description: 'Node ids in order (at least two).' }, label: str('Name of the route.') }, required: ['path'] },
		},
		callouts: {
			type: 'array',
			description: 'Notes drawn as a bubble on a node or an edge, e.g. [{"node":"svc","text":"Retries twice, then dead-letters"}].',
			items: {
				type: 'object',
				properties: {
					node: str('Node id to attach to.'),
					edge: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: 'Or an edge as [from, to] node ids.' },
					text: str('The note, one or two sentences.'),
				},
				required: ['text'],
			},
		},
		nodes: {
			type: 'array',
			description: 'At most 400. Each node needs a unique id. Required unless `source` (Mermaid) gives the nodes.',
			items: {
				type: 'object',
				properties: {
					id: str('Unique within the board; edges refer to it.'),
					label: str('Text on the node.'),
					kind: { type: 'string', enum: [...NODE_KINDS], description: 'Picks the shape/colour. For plans use step (default), decision or note.' },
					detail: str('One line under the label.'),
					group: str('Id of a group in `groups` this node belongs to.'),
					file: str('Source file the node stands for (workspace path); clicking it opens the file.'),
					line: int('1-based line in `file`.'),
					status: { type: 'string', enum: [...NODE_STATUSES], description: 'Progress of any node: a plan step, a stage of the work. Update later with update_board.' },
					note: str('Longer free text on any kind of board, e.g. what a plan step changes or why a box exists. For a note on one edge use `callouts`.'),
					symbol: str('The real code symbol this node stands for ("OrderService.Place"), taken from find_symbol or flow_text. Insilode checks it against the index and fills `file` and `line`; leave it out for something that does not exist yet (a proposed class).'),
					tech: str('C4: the technology under the label, e.g. "Spring Boot", "PostgreSQL".'),
					shape: { type: 'string', enum: [...NODE_SHAPES], description: 'Overrides the shape the kind gives: initial/final/choice for state boards, cylinder for a database, actor for a person, cloud for an outside service.' },
					change: { type: 'string', enum: [...CHANGE_MARKS], description: 'For a proposed design: added, removed or changed. With a `base` board Insilode fills this itself.' },
					lane: str('Swimlane: id of a group with kind "lane" this node sits in.'),
					zoom: str('C4: id of the board that shows this box one level down; a click on the box opens it.'),
					members: {
						type: 'array',
						description: 'Fields/methods listed inside a class or entity node, each an object: [{"text":"id: UUID"},{"text":"findByStatus(status: BillStatus): List<Bill>"}].',
						items: {
							type: 'object',
							properties: {
								text: str('e.g. "id: Guid" or "Save(order): void".'),
								kind: { type: 'string', enum: ['field', 'method', 'property'] },
								visibility: { type: 'string', enum: ['+', '-', '#', '~'] },
								ref: str('Id of the node this member refers to.'),
							},
							required: ['text'],
						},
					},
				},
				required: ['id', 'label'],
			},
		},
		edges: {
			type: 'array',
			description: 'Connections between node ids. Edges naming unknown nodes are dropped.',
			items: {
				type: 'object',
				properties: {
					from: str('Node id.'),
					to: str('Node id.'),
					label: str('Text on the arrow: a verb or the payload ("validates", "OrderPlaced event"), not "calls".'),
					kind: { type: 'string', enum: [...EDGE_KINDS], description: 'Carries meaning (reads vs writes, extends vs uses): use it instead of prose.' },
					fromCard: str('ER cardinality at the `from` end, e.g. "1".'),
					toCard: str('ER cardinality at the `to` end, e.g. "0..*".'),
					order: int('Order of a message or step (1, 2, 3...), shown as a number badge. Sequence boards are drawn in this order; it is also the default step order.'),
					style: { type: 'string', enum: [...EDGE_LINES], description: 'dashed is a return or reply, dotted a weak or optional link.' },
					async: { type: 'boolean', description: 'An asynchronous message (open arrow head): events, queues, fire-and-forget.' },
					guard: str('State transition condition, shown as [guard], e.g. "amount > 0".'),
					change: { type: 'string', enum: [...CHANGE_MARKS], description: 'For a proposed design: added, removed or changed. With a `base` board Insilode fills this itself.' },
					fragment: str('Sequence: id of the alt, loop or opt group this message sits in.'),
				},
				required: ['from', 'to'],
			},
		},
		groups: {
			type: 'array',
			description: 'Optional boxes around nodes (a layer, a service, a phase), at most 2 levels deep. On a sequence board a group of kind alt, loop or opt is a fragment that boxes the messages whose `fragment` names it; a group of the same kind whose `parent` is an alt group is its else branch.',
			items: {
				type: 'object',
				properties: {
					id: str('Group id.'),
					label: str('Title of the box; for a fragment its condition, e.g. "[card valid]".'),
					parent: str('Id of an enclosing group.'),
					collapsed: { type: 'boolean' },
					kind: { type: 'string', enum: [...GROUP_KINDS], description: 'boundary: a C4 system or container boundary · lane: a swimlane · layer · alt/loop/opt: a sequence fragment.' },
					tech: str('C4: the technology of a boundary.'),
				},
				required: ['id', 'label'],
			},
		},
	},
	required: ['title'],
} as const;

export const TOOLS: ToolDef[] = [
	{
		name: 'open',
		description: "Open a file in the user's Insilode editor, scrolled to a line and optionally with a line range selected. Use this when the user asks you to open, show or go to a file or place in the IDE/editor. It does not take keyboard focus from the terminal. To show how a feature runs (an endpoint, a job) use show_flow instead.",
		inputSchema: {
			type: 'object',
			properties: {
				file: str('File to open: absolute, or relative to the workspace folder. Must be inside the workspace.'),
				line: int('1-based line to reveal.'),
				endLine: int('1-based last line to select (with `line`).'),
				preview: { type: 'boolean', description: 'Open as a preview tab that the next open replaces (default true). Pass false to keep the tab.' },
			},
			required: ['file'],
			additionalProperties: false,
		},
		annotations: ro('Open file in Insilode'),
	},
	{
		name: 'open_diff',
		description: "Show git changes in Insilode's diff view (a multi-file diff editor), so the user can REVIEW them. Use this when the user asks to open, show or review the diff or the changes in the IDE, including after you finished a piece of work (\"show what you did\"). By default the uncommitted changes against HEAD; `base` \"branch\" shows everything since the branch left main (committed or not), \"last_commit\" the last commit plus anything on top. It covers modified, staged, deleted and brand-new untracked files (no `git add -N` needed) and finds nested git repositories inside the workspace. Pass `files` (files or folders) to narrow it; without it every changed file of every repository is shown. Returns the list of files it opened.",
		inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Files or folders to show (absolute, or relative to the workspace folder). Omit for all changes.' }, base: { type: 'string', enum: ['uncommitted', 'branch', 'last_commit'], description: 'What to compare with: uncommitted (HEAD, default), branch (where this branch left main/master; on main itself, its upstream: the unpushed commits) or last_commit (HEAD~1). Use branch or last_commit when your work is already committed.' }, title: str('Title of the diff tab.'), flow: { type: 'boolean', description: "Also show the changes on Insilode's flow canvas, all on one canvas: every endpoint flow they reach, cut down to the changed methods, plus changed methods no endpoint reaches; each changed card shows added lines in green and removed lines in red. Use it when the user wants the diff or the work \"in flow\"." } }, additionalProperties: false },
		annotations: ro('Open diff in Insilode'),
	},
	{
		name: 'get_diagnostics',
		description: "The errors and warnings Insilode's language servers report right now (the Problems panel), for one file or the whole workspace, as `file:line:col severity [source] message`. Use it after editing to check your change compiles and lints, instead of running a build.",
		inputSchema: { type: 'object', properties: { file: str('File to check (absolute, or relative to the workspace folder). Omit for the whole workspace.'), severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Lowest-priority severity to include: error (only errors), warning (errors and warnings, default) or all (also info and hints).' }, limit: int('Maximum lines (default 100, at most 500).') }, additionalProperties: false },
		annotations: ro('Get diagnostics'),
	},
	{
		name: 'find_symbol',
		description: "Search the workspace's symbols (classes, methods, functions, fields) by name with the language servers, e.g. \"OrderService\" or \"Delete\". Returns kind, name, container and file:line. Faster and more precise than grep for \"where is X defined\".",
		inputSchema: { type: 'object', properties: { query: str('Symbol name or part of it.'), limit: int('Maximum matches (default 30, at most 100).') }, required: ['query'], additionalProperties: false },
		annotations: ro('Find symbol'),
	},
	{
		name: 'go_to_definition',
		description: "Where a symbol is defined, with its type/signature and the first lines of its definition, using the language servers (so it follows interfaces, imports and generics like the editor's F12). Give `file` and `line`, plus `symbol` (the identifier on that line) to pick which one.",
		inputSchema: { type: 'object', properties: { file: str('File that uses the symbol.'), line: int('1-based line of the usage.'), symbol: str('The identifier on that line (first occurrence). Without it the first token on the line is used.'), column: int('1-based column, instead of `symbol`.') }, required: ['file', 'line'], additionalProperties: false },
		annotations: ro('Go to definition'),
	},
	{
		name: 'find_references',
		description: "Every place that uses a symbol, with the line of code, using the language servers. Use it before changing or renaming something. Give `file` and `line`, plus `symbol` (the identifier on that line) to pick which one. For who calls a method through the whole flow (interfaces, mediators) prefer `impact`.",
		inputSchema: { type: 'object', properties: { file: str('File that declares or uses the symbol.'), line: int('1-based line.'), symbol: str('The identifier on that line (first occurrence).'), column: int('1-based column, instead of `symbol`.'), limit: int('Maximum references (default 40, at most 150).') }, required: ['file', 'line'], additionalProperties: false },
		annotations: ro('Find references'),
	},
	{
		name: 'find_entry_points',
		description: "Find the entry points (HTTP endpoints, jobs, listeners) of the open project by a free-text query such as \"delete user\" or \"POST orders\", using Insilode's code index. Returns each match with its HTTP verb and route, controller.method, file:line and an `id`. Use it first when the user names a feature (\"the delete-users flow\"), then pass the id to show_flow or flow_text. An empty query lists the entry points.",
		inputSchema: { type: 'object', properties: { query: str('Free text: verbs (delete, create, update, list), nouns (user, order), a route or a class name.'), limit: int('Maximum matches (default 10, at most 50).') }, additionalProperties: false },
		annotations: ro('Find entry points'),
	},
	{
		name: 'show_flow',
		description: 'Open the Insilode flow canvas for an entry point or method, so the user SEES the runtime call chain (callers on the left, the method, everything it calls on the right, with the database tables it touches), and return the same call chain as text. Use this when the user asks to open a flow in the IDE ("open the delete-users flow"). To explain how it works, walk the user through it with `tour`. Pass an `id` from find_entry_points, or `file` plus `method` or `line`.',
		inputSchema: { type: 'object', properties: { ...TARGET, depth: int('How many call levels to include in the returned text (default 6).') }, additionalProperties: false },
		annotations: ro('Show flow in Insilode'),
	},
	{
		name: 'flow_text',
		description: 'Return the runtime call chain of an entry point or method as indented text: each step with file:line, calls through interfaces and mediators resolved, and the database tables touched. Does not open anything. Call this BEFORE reading many files to understand how a feature works; one call replaces dozens of reads. To explain a feature to the user, do not paste this text: SHOW it with `tour`. Pass an `id` from find_entry_points, or `file` plus `method` or `line`.',
		inputSchema: { type: 'object', properties: { ...TARGET, depth: int('Call levels to include (default 6).') }, additionalProperties: false },
		annotations: ro('Flow as text'),
	},
	{
		name: 'impact',
		description: 'What breaks if this changes. For a method: who calls it (callers, up to `depth` levels) and which entry points (endpoints, jobs) reach it; pass `file` plus `method` or `line`, or an `id` from find_entry_points. For a table: pass `table` (a table name) or `entity` (an entity or model class) to get the endpoints that write it and the endpoints that read it, each with the method and database card it goes through; a guessed link (raw SQL, a naming default) is marked ~table?. It follows ORM calls and string SQL only, and says what it did not check (dynamic SQL, views, other services, migrations). A migration file or an entity file alone (`file` without `method` or `line`) gives the same for the tables it changes: what the migration does to each table (adds, drops, renames), the endpoints that use it, and the code that may still use a column it drops. Use it before editing shared code, an entity, a migration or a column to know the blast radius.',
		inputSchema: { type: 'object', properties: { ...TARGET, depth: int('Caller levels to include (default 3).'), table: str('A table name, e.g. "orders" (case and schema prefix ignored). Instead of a method.'), entity: str('An entity or model class name, e.g. "Order". Instead of a method.') }, additionalProperties: false },
		annotations: ro('Change impact'),
	},
	{
		name: 'get_context',
		description: 'What the user is looking at in Insilode right now: the active file with cursor and selected text, the flow shown on the canvas, open editor tabs, files changed in git, and a summary of editor errors and warnings. Use it when the user says "this", "here" or "the selected code", or to see which files are in play.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: ro('Editor context'),
	},
	{
		name: 'draw_board',
		description: 'Draw a diagram that Insilode shows to the user next to the editor, like an artifact. Use it in plan mode to show the flow or architecture you designed, when explaining a design, or to lay out a multi-step plan the user can follow. The answer carries a LINT list (dropped items, unknown ids, orphans, too many nodes, crossings): fix what it names by calling again with the same `id`. Rules: one question per board, said in `title`, about 15-20 visible nodes at most (split, or collapse `groups`) · pick the kind by the question: how does it run -> sequence (order matters) or flow, what is it made of -> architecture or class, how is data stored -> er, what states can it be in -> state, what will we do -> plan, what changed -> `base` · ground nodes: take names from find_symbol or flow_text and give `symbol` (and `file`) for real code, leave it off for proposed things · label edges with verbs or payloads, not "calls" · group by layer or service, 2 levels at most · edge `kind` carries meaning (reads vs writes, extends vs uses) · number messages with `order` · then EXPLAIN it with `steps` (3-10, each lights some nodes and edges with a caption) instead of a paragraph in chat. Kinds: flow, plan (ordered steps with status), class, er (tables), sequence, architecture (with `level` context/container/component for C4), state. Give every node a unique id and a short label; link nodes to code with symbol or file (+ line); connect them with edges; no coordinates, layout is automatic. Passing the same `id` again replaces that board (the previous version is kept for "what changed"), so redraw instead of drawing a second copy. The `diagram_guide` prompt has the full advice. Example: {"id":"order-flow","board":{"kind":"flow","title":"Place order","nodes":[{"id":"api","label":"POST /orders","kind":"entry","file":"src/OrdersController.cs","line":24},{"id":"svc","label":"OrderService.Place","kind":"service"},{"id":"db","label":"orders","kind":"entity"}],"edges":[{"from":"api","to":"svc"},{"from":"svc","to":"db","kind":"writes","label":"insert"}]}}. For a plan use kind "plan" with step nodes in order joined by "next" edges, then tick them off with update_board while you work.',
		inputSchema: {
			type: 'object',
			properties: {
				board: BOARD_SCHEMA,
				source: {
					type: 'object',
					description: 'Optional. A Mermaid diagram you already have (sequenceDiagram, stateDiagram-v2, flowchart or graph) instead of `board.nodes` and `board.edges`: Insilode turns it into a board, and `board` may still add title, steps, callouts and the like. The answer lists the lines it could not read. Draw JSON when you have no Mermaid yet: it can say more (symbol, file, status, kinds).',
					properties: { mermaid: str('The diagram text, at most 60,000 characters.') },
					required: ['mermaid'],
				},
				id: str('Stable name for the board (letters, digits, - _ . :). Reuse it to replace the board; omit for a new one.'),
			},
			additionalProperties: false,
		},
		annotations: ro('Draw a board', true),
	},
	{
		name: 'board_from_code',
		description: 'Generate a board FROM THE CODE and show it to the user, instead of drawing it with draw_board. Use it for the common diagrams, so no relation is invented: sequence (the calls of an endpoint or method in order, between classes; guessed hops are dotted and marked "?"), er (tables with columns, keys, relations and cardinality, from the entity and migration readers), architecture (modules or packages and their dependencies, C4 container level when there are several services), state (an enum and its transitions, only where the code assigns a value and checks the previous one; otherwise it says why it drew nothing). Nodes carry their symbol and file:line from the index, boards are capped in size and the result lists what was cut or guessed. You choose `kind` and `scope`; you may add `title`, `description` and `notes` ([{node, text}], node = id or symbol), never nodes or edges. Use draw_board for anything the code does not show (a plan, a proposed design). Scope per kind: sequence {id | file+method | file+line | symbol}; er {tables?: [names]}; architecture {module?}; state {enum?}. Passing the same `id` again replaces the board.',
		inputSchema: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['sequence', 'er', 'architecture', 'state'], description: 'sequence: calls in order · er: tables · architecture: modules/packages and dependencies · state: enum transitions.' },
				scope: {
					type: 'object',
					description: 'What to draw. sequence: id, or file with method or line, or symbol. er: tables. architecture: module. state: enum.',
					properties: {
						...TARGET,
						symbol: str('sequence: a method as "Class.method".'),
						tables: { type: 'array', items: { type: 'string' }, description: 'er: table or entity names; their directly related tables are drawn too. Omit for all tables (capped).' },
						module: str('architecture: a module (service) name, or a package name.'),
						enum: str('state: the enum, "OrderStatus" or "Order.status".'),
					},
					additionalProperties: false,
				},
				id: str('Stable name for the board (letters, digits, - _ . :). Reuse it to replace the board; omit for a new one.'),
				title: str('Replaces the generated title.'),
				description: str('Added in front of the generated description.'),
				notes: {
					type: 'array',
					description: 'Short notes pinned to nodes: [{"node": "svc", "text": "Retries twice"}]. A node that does not exist is reported, never created.',
					items: { type: 'object', properties: { node: str('Node id or symbol.'), text: str('The note.') }, required: ['node', 'text'], additionalProperties: false },
				},
				depth: int('sequence: call levels (default 6, at most 8).'),
				maxNodes: int('Participants, tables or boxes drawn (default: sequence 8, er 20, architecture 30; at most 60).'),
			},
			required: ['kind'],
			additionalProperties: false,
		},
		annotations: ro('Generate a board from the code', true),
	},
	{
		name: 'update_board',
		description: 'Update a board you drew with draw_board without redrawing it: set the status of a node (todo, doing, done, skipped, blocked), its note and/or its change mark (added, removed, changed); pass several nodes at once in `updates`; or light a route with `highlight` (e.g. to answer "what about the cache?" by lighting the path to it). Use it to tick plan steps as you work so the user sees progress on the board.',
		inputSchema: {
			type: 'object',
			properties: {
				id: str('Board id returned by draw_board.'),
				nodeId: str('Node id within that board (for one node; use `updates` for several).'),
				status: { type: 'string', enum: [...NODE_STATUSES], description: 'New status of the node.' },
				note: str('New note text for the node.'),
				change: { type: 'string', enum: [...CHANGE_MARKS], description: 'New change mark of the node.' },
				updates: {
					type: 'array',
					description: 'Several node updates in one call (at most 100).',
					items: {
						type: 'object',
						properties: { nodeId: str('Node id.'), status: { type: 'string', enum: [...NODE_STATUSES] }, note: str('Note text.'), change: { type: 'string', enum: [...CHANGE_MARKS] } },
						required: ['nodeId'],
					},
				},
				highlight: {
					type: 'array',
					description: 'Replaces the highlighted routes of the board ([] clears them): [{"path":["api","svc","db"],"label":"happy path"}].',
					items: { type: 'object', properties: { path: { type: 'array', items: { type: 'string' }, description: 'Node ids in order.' }, label: str('Name of the route.') }, required: ['path'] },
				},
			},
			required: ['id'],
			additionalProperties: false,
		},
		annotations: ro('Update a board node'),
	},
	{
		name: 'tour',
		description: "The way to EXPLAIN code to the user in Insilode: a narrated walkthrough on the flow canvas, where a cursor moves from card to card, dims the rest, highlights lines and shows your caption. Use it INSTEAD of a long text answer whenever the user asks how something works or to be walked through it (\"walk me through how an order is placed\", \"how does X work\", \"explain this flow\", \"show me\", \"anlat\", \"bana göster\", \"nasıl çalışıyor\"), after finishing work (\"explain what you changed\"), or to answer a question about code by SHOWING it; then keep your own message to one line. Get file:line from flow_text or find_symbol first. 3-12 steps, one idea each, in the order the code runs; captions say WHY and what to watch, not what the code says, in the user's language. Name each step's code by `file` + `method` (preferred: it survives edits) with a `line` hint, and `lines` for the few lines the caption talks about; a step with only a caption is an intro or an outro; `table` points at a database card. The tool returns at once with each step marked ok / moved / missing / offflow: fix a missing step by calling tour again with the same id. The user steps through it; questions they ask come back to you as a new message. Run the `tour_guide` prompt for the full advice.",
		inputSchema: {
			type: 'object',
			properties: {
				id: str('Stable name (letters, digits, - _ .). Reuse it to replace the tour.'),
				title: { type: 'string', maxLength: 120, description: 'What the tour is about.' },
				flow: {
					type: 'object',
					description: 'The canvas to play on. Omit to stay on the canvas the user has open, or to let Insilode open the flow of the first step. Use {"changes": true} for the current git changes.',
					properties: {
						id: str('Entry point id from find_entry_points.'),
						file: str('Source file of the method whose flow to show. Use with `method` or `line`.'),
						method: str('Method or function name in `file`.'),
						line: int('1-based line inside the method.'),
						changes: { type: 'boolean', description: 'Play on the change set (the flows the changed files reach, cut down to the changed cards).' },
						base: { type: 'string', enum: ['uncommitted', 'branch', 'last_commit'], description: 'With changes: what they are measured against (default uncommitted).' },
					},
					additionalProperties: false,
				},
				steps: {
					type: 'array', minItems: 1, maxItems: 30,
					items: {
						type: 'object',
						properties: {
							file: str('Workspace file of the code this step points at.'),
							method: str('Method or function, e.g. "OrderService.Place". Preferred: survives edits.'),
							line: int('1-based line inside the method (a hint when method is given).'),
							lines: { type: 'array', maxItems: 3, description: 'Line ranges to highlight, current-file 1-based, e.g. [[42,47]].', items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 2 } },
							table: str('A database card instead of code: the table name.'),
							title: { type: 'string', maxLength: 80, description: 'Short label for the step list; defaults to the method.' },
							caption: { type: 'string', maxLength: 600, description: 'What to say here: one or two sentences on WHY, not a restatement of the code. Short Markdown: `code`, **bold**, a list or a fenced block are shown formatted; HTML is not.' },
						},
						required: ['caption'],
						additionalProperties: false,
					},
				},
				start: int('Step to open on (default 1).'),
			},
			required: ['title', 'steps'],
			additionalProperties: false,
		},
		annotations: ro('Play a tour in Insilode'),
	},
	{
		name: 'check_skeleton',
		description: "Skeleton first, the developer's choice in Insilode (a switch per agent) to write the structure of a change themselves. Call it ONCE before your first edit for a request or an approved plan that adds or changes types, entities or interfaces (plan mode or not); it answers at once. A bug fix, a small edit or a question does not need it. If Insilode says skeleton first is off, implement as usual. If it is on, it tells you to draw the design with draw_board and stop. The developer then drives the rest by talking to you: call it with no step to check their skeleton against your design (a structured diff, each type and member matches, MISSING or DIFFERS, with what the code has) and explain it without fixing their code; pass step \"handover\" when they hand the skeleton over, \"just\" when they say just do it, \"accept\" with a warning number when they keep a signature you changed, \"finish\" when they are done. It never writes a file.",
		inputSchema: {
			type: 'object',
			properties: {
				step: { type: 'string', enum: ['handover', 'just', 'finish', 'accept'], description: 'Only when the developer asked for it in the chat: handover (fill the bodies), just (skip skeleton first, implement as usual), finish (done), accept (keep the signature change of `warning`). Omit to check.' },
				warning: { type: 'integer', minimum: 1, description: 'With step accept: the warning number check_skeleton listed.' },
			},
			additionalProperties: false,
		},
		annotations: ro('Check the skeleton', false),
	},
	{
		name: 'tour_control',
		description: "Drive the tour you started with `tour`, or answer the user's question during it. go: jump the user to a step (only while they are paused or waiting for your answer: the user paces the tour, so do not fight them) · note: pin your answer to a step's card, shown until the tour ends (plain text) · resume: continue after a question · end: close it. When the user asks a question during the tour it comes to you as a message: answer with note (for the step they asked about, and go to a step that answers it better), then resume; if the answer needs more than a note, start a new tour. Returns where the user is and whether they paused.",
		inputSchema: {
			type: 'object',
			properties: {
				id: str('Tour id.'),
				action: { type: 'string', enum: ['go', 'note', 'resume', 'end'] },
				step: int('go: the step to jump to; note: the step the note is for (default: the step the user is on). 1-based.'),
				text: { type: 'string', maxLength: 2000, description: 'note: your answer, as Markdown (short paragraphs, lists, `code`, fenced code blocks), a few sentences.' },
			},
			required: ['id', 'action'],
			additionalProperties: false,
		},
		annotations: ro('Control the tour', false),
	},
	{
		name: 'search_sessions',
		description: "Search this workspace's past Claude Code and Codex conversations for what the user asked and what the agent answered (not tool output), to find out whether something was done, decided or debugged before. All words of `query` must occur in one message, any case. Returns, newest session first, the agent, session id, date, the session's first prompt and a snippet around the match. Use it when the user says \"we did this before\" or before redoing a task; to find code use `find_symbol` or grep instead.",
		inputSchema: { type: 'object', properties: { query: str('Words that must all occur in a prompt or an answer, e.g. "rate limit alert".'), limit: int('Maximum sessions (default 10, at most 50).'), agent: { type: 'string', enum: ['claude', 'codex'], description: 'Only the sessions of this agent. Omit for both.' } }, required: ['query'], additionalProperties: false },
		annotations: ro('Search past sessions'),
	},
];

export const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
