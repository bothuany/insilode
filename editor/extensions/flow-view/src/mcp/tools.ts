/*---------------------------------------------------------------------------------------------
 *  Insilode agent bridge: the tools the `insilode` MCP server offers a model (they show up as mcp__insilode__*).
 *  The descriptions are written for the model: they say when to reach for each tool, in a few sentences
 *  (a test caps them at 600 characters); the rules and examples live in prompts.ts and the server instructions
 *  in protocol.ts. No tool writes a file. Keep draw_board's schema in sync with
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

/**
 * readOnlyHint is true on every tool, and here "read-only" means one thing: the tool never writes a file. It may still change
 * what Insilode shows (a board, a tour, the canvas, an opened diff). It does not mean the window stays as it was.
 */
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

/** The pen marks of one tour step: drawn on the step's card as its caption is read, in source terms (the host resolves lines and targets). */
const TOUR_MARKS = {
	type: 'array', maxItems: 6,
	description: "Pen marks drawn on this step's card, each appearing with the caption sentence it belongs to (`sentence`, default 1): ring (outline the `lines`) · underline (the words that matter) · strike (outdated or wrong code) · check / cross (right and wrong, beside the first line) · badge (the order number `n` beside the line) · connect (a curved arrow from this card to the code at `to`, with `label`: cause to effect). At most a few per step; a mark that cannot be placed is dropped and the answer says so.",
	items: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: ['ring', 'underline', 'strike', 'check', 'cross', 'badge', 'connect'] },
			lines: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', minimum: 1 }, description: 'ring, underline, strike, check, cross, badge: [from, to] or [line], current-file 1-based, inside the code of the step.' },
			n: { type: 'integer', minimum: 1, maximum: 99, description: 'badge: the number shown.' },
			to: {
				type: 'object',
				description: 'connect: the code the arrow ends at, named like a step (file + method, with a line hint).',
				properties: { file: str('Workspace file.'), method: str('Method or function.'), line: int('1-based line inside the method.') },
				required: ['file'],
				additionalProperties: false,
			},
			label: { type: 'string', maxLength: 40, description: 'connect: the words on the arrow.' },
			sentence: { type: 'integer', minimum: 1, maximum: 6, description: 'Which sentence of the caption the mark appears with (default 1).' },
		},
		required: ['kind'],
		additionalProperties: false,
	},
};

/** A hands-on step: the tour waits for the reader to do something before it goes on. */
const TOUR_WAIT = {
	type: 'object',
	description: "Makes this a hands-on step: the tour does not go on (Next is off) until the reader has done it. click: they click the step's card · command: a button with `prompt` runs `command` for them (only a few safe Insilode commands that open a view are allowed; anything else is refused and the answer says so) · continue: they press Continue after doing the work themselves. `prompt` is the button or hint text.",
	properties: {
		kind: { type: 'string', enum: ['click', 'command', 'continue'] },
		command: str('command: the Insilode command id to run (see the allowed list in the error if it is refused).'),
		prompt: { type: 'string', maxLength: 80, description: 'The button or hint text, e.g. "Open the test" or "Run it, then continue".' },
	},
	required: ['kind'],
	additionalProperties: false,
};

/** One step of a tour: the same object in `tour` and in `tour_control` edit. */
const TOUR_STEP = {
	type: 'object',
	properties: {
		file: str('Workspace file of the code this step points at.'),
		method: str('Method or function, e.g. "OrderService.Place". Preferred: survives edits.'),
		line: int('1-based line inside the method (a hint when method is given).'),
		lines: { type: 'array', maxItems: 3, description: 'Line ranges to highlight, current-file 1-based, e.g. [[42,47]].', items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 2 } },
		table: str('A database card instead of code: the table name.'),
		title: { type: 'string', maxLength: 80, description: 'Short label for the step list; defaults to the method.' },
		caption: { type: 'string', maxLength: 600, description: 'What to say here: one or two sentences on WHY, not a restatement of the code. Never "simply" or "just"; do not end on a yes/no question. Short Markdown: `code`, **bold**, a list or a fenced block are shown formatted; HTML is not.' },
		marks: TOUR_MARKS,
		wait: TOUR_WAIT,
	},
	required: ['caption'],
	additionalProperties: false,
};

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
		description: "Show git changes in Insilode's diff view so the user can REVIEW them. Use it when the user asks to open, show or review the diff or the changes in the IDE, including after you finished a piece of work (\"show what you did\"). By default the uncommitted changes against HEAD; `base` \"branch\" shows everything since the branch left main, \"last_commit\" the last commit plus anything on top. New untracked files and nested git repositories are included; `files` (files or folders) narrows it. Returns the list of files it opened.",
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
		description: "What breaks if this changes: who calls a method (up to `depth` levels) and which entry points (endpoints, jobs) reach it. Pass `file` plus `method` or `line`, or an `id` from find_entry_points. With `table` or `entity`, or a migration or entity file alone, it gives the endpoints that write that table and the endpoints that read it instead. Use it before editing shared code, an entity, a migration or a column; it says what it did not check (dynamic SQL, views, other services, migrations).",
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
		description: "Draw a diagram that Insilode shows to the user next to the editor, like an artifact. Use it in plan mode to show the flow or architecture you designed, when explaining a design, or to lay out a multi-step plan the user can follow. Give every node a unique id and a short label, link real code with `symbol` or `file`, send no coordinates. The same `id` again replaces that board. The answer carries a LINT list: fix what it names by drawing again. The `diagram_guide` prompt has the rules and an example.",
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
		description: "Generate a board FROM THE CODE and show it to the user, instead of drawing it with draw_board, so no relation is invented. `kind` is sequence (the calls of an endpoint or method), er (tables, columns, keys, relations), architecture (modules and their dependencies) or state (an enum and its transitions). You choose `kind` and `scope` and may add `title`, `description` and `notes`, never nodes or edges. Use draw_board for anything the code does not show (a plan, a proposed design). The `diagram_guide` prompt says more.",
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
		description: "Explain code to the user in Insilode as a narrated walkthrough on the flow canvas: a cursor moves from card to card, the rest dims, lines light up and your caption is shown. Use it when the user asks how something works, to be walked through it, or what you changed. Get file:line from flow_text or find_symbol first. Also write a 3 to 5 line summary of the answer in chat, so a reader without the canvas still gets it. Steps come back ok / moved / missing / offflow: fix missing ones by calling tour again with the same id. See the `tour_guide` prompt (`marks`, `wait`, `followUps`).",
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
					items: TOUR_STEP,
				},
				start: int('Step to open on (default 1).'),
				followUps: { type: 'array', maxItems: 3, description: 'Up to three questions that go deeper than the tour (not yes/no questions), shown as chips after the last step; the reader taps one to ask it.', items: { type: 'string', maxLength: 120 } },
			},
			required: ['title', 'steps'],
			additionalProperties: false,
		},
		annotations: ro('Play a tour in Insilode'),
	},
	{
		name: 'check_skeleton',
		description: "Skeleton first, the developer's choice (a switch per agent) to write the structure of a change themselves. Call it ONCE before your first edit for a request or approved plan that adds or changes types, entities or interfaces; a bug fix, small edit or question does not need it. Off: implement as usual. On: it tells you to draw the design with draw_board and stop. The developer then drives the rest by chat: pass their reply as `step` (handover, just, finish, or accept with a warning number), or no step to check their skeleton. See the `skeleton_first` prompt. It never writes a file.",
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
		description: "Drive the tour you started with `tour`, or answer the user's question during it. go: jump to a step · note: pin a plain-text answer to a step's card · edit: fix or extend the tour with `steps` plus `replace` or `insert` · resume: continue after a question · end: close it. `go` and `edit` are accepted only while the reader is paused or waiting for your answer. Returns where the user is and whether they paused. The `tour_guide` prompt says how to answer a question.",
		inputSchema: {
			type: 'object',
			properties: {
				id: str('Tour id.'),
				action: { type: 'string', enum: ['go', 'note', 'edit', 'resume', 'end'] },
				step: int('go: the step to jump to; note: the step the note is for (default: the step the user is on). 1-based.'),
				text: { type: 'string', maxLength: 2000, description: 'note: your answer, as Markdown (short paragraphs, lists, `code`, fenced code blocks), a few sentences.' },
				steps: { type: 'array', minItems: 1, maxItems: 10, description: 'edit: the new steps, in the same shape as the steps of `tour`.', items: TOUR_STEP },
				replace: int('edit: the 1-based step that the given steps replace (one step may become several).'),
				insert: int('edit: the 1-based position the given steps are inserted at (before the step now there; after the last step to append).'),
			},
			required: ['id', 'action'],
			additionalProperties: false,
		},
		annotations: ro('Control the tour', false),
	},
	{
		name: 'search_sessions',
		description: "Search this workspace's past Claude Code and Codex conversations (what was asked and answered, not tool output) to find out whether something was done, decided or debugged before. All words of `query` must occur in one message. Returns, newest first, the agent, session id, date, first prompt and a snippet. Use it when the user says \"we did this before\" or before redoing a task; for code use `find_symbol` or grep. Returns past conversation text verbatim from this machine's agent transcripts; it can contain secrets you typed. Use it to find what was decided, not to copy text.",
		inputSchema: { type: 'object', properties: { query: str('Words that must all occur in a prompt or an answer, e.g. "rate limit alert".'), limit: int('Maximum sessions (default 10, at most 50).'), agent: { type: 'string', enum: ['claude', 'codex'], description: 'Only the sessions of this agent. Omit for both.' } }, required: ['query'], additionalProperties: false },
		annotations: ro('Search past sessions'),
	},
];

export const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
