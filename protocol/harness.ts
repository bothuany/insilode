// The harness flow diagram: what flow-harness computes (`flowHarness.flowModel`), what flow-view's panel sends the canvas
// (ui/src/harness) and what the canvas asks back. Types only and imports nothing, like flow.ts: both sides reach it with
// `import type`, so it is erased from both bundles.

/** The steps of one agent turn, left to right on the diagram. Every harness piece sits under the step where it acts. */
export type HarnessStage =
	| 'sessionStart'       // SessionStart hooks
	| 'load'               // instructions, always-on rules, memory, the skill and subagent listings, MCP servers connecting
	| 'promptSubmit'       // UserPromptSubmit hooks
	| 'model'              // path-scoped rules and skills read on demand
	| 'preTool'            // PreToolUse hooks
	| 'permission'         // allow / ask / deny rules and the permission mode
	| 'permissionRequest'  // PermissionRequest hooks
	| 'run'                // the tool itself: built-in, an MCP server's tool, a subagent
	| 'postTool'           // PostToolUse and PostToolUseFailure hooks
	| 'subagent'           // SubagentStop hooks
	| 'stop'               // Stop and StopFailure hooks
	| 'sessionEnd'; // SessionEnd hooks; Notification and PreCompact sit here too

export type HarnessFlowKind = 'instructions' | 'rules' | 'skills' | 'agents' | 'hooks' | 'mcp' | 'permissions' | 'memory';

export type HarnessAgent = 'Claude' | 'Codex' | 'Cursor';

/** One harness piece placed on the diagram. */
export interface HarnessFlowItem {
	/** Stable across rebuilds of the same harness, so a highlight survives a refresh. */
	id: string;
	kind: HarnessFlowKind;
	stage: HarnessStage;
	label: string;
	detail: string;
	scope: 'user' | 'project' | 'local' | 'directory';
	agents: HarnessAgent[];
	/** Where it is written, to open on click. */
	file?: string;
	line?: number;
	/** Hooks: the hook event and the tool matcher ("Edit|Write", "*"); permission rules: the pattern ("Bash(npm test:*)"). */
	matcher?: string;
	/** Permission rules: what the rule decides. */
	effect?: 'allow' | 'ask' | 'deny';
	/** Path-scoped rules: the globs that load it. */
	paths?: string[];
	/** Startup cost in tokens, when known. */
	tokens?: number;
	/** Errors and warnings the harness map shows for this piece, as plain sentences. */
	issues?: string[];
}

/** A made-up event for the preview mode: "what would happen if the agent did this". */
export interface PreviewEvent {
	/** The tool's name as the agent calls it: Bash, Edit, Read, Write, WebFetch, mcp__server__tool, Task. */
	tool: string;
	/** Bash: the command line. */
	command?: string;
	/** Edit, Read, Write: the file, absolute or relative to the workspace root. */
	file?: string;
	/** Anything else of the tool's input (a URL, an MCP tool's arguments). */
	input?: Record<string, unknown>;
}

/**
* One piece on an event's path. `observed`: a recorded hook event or transcript line shows it happened; `predicted`: only
* matching the harness's rules says it would. The diagram draws the two differently and never shows a prediction as fact.
*/
export interface PathHit {
	itemId: string;
	how: 'observed' | 'predicted';
	/** Permission rules: the verdict; hooks: whether the recorded run allowed or blocked (when observed). */
	verdict?: 'allow' | 'ask' | 'deny' | 'blocked';
	/** One sentence on why it is on the path ("matches Bash(npm *)", "PreToolUse matcher Edit|Write"). */
	why: string;
}

/** One step of a replayed session: a tool call and the path it took. */
export interface ReplayStep {
	at: number;
	/** "Bash: npm test", "Edit src/app.ts", "Prompt". */
	label: string;
	/** Set when a subagent made this call. */
	subagent?: string;
	event: PreviewEvent;
	hits: PathHit[];
}

/** A session the replay mode can pick. */
export interface ReplaySession {
	id: string;
	agent: HarnessAgent;
	title: string;
	at: number;
}

export type HarnessFlowMode = 'static' | 'preview' | 'replay';

/** What `flowHarness.flowModel` takes. */
export interface HarnessFlowRequest {
	mode: HarnessFlowMode;
	agent?: HarnessAgent;
	event?: PreviewEvent;
	session?: string;
}

/** What `flowHarness.flowModel` answers. */
export interface HarnessFlowModel {
	root: string;
	items: HarnessFlowItem[];
	/** Preview: the path of the event asked about. */
	hits?: PathHit[];
	/** Preview: the permission mode the verdict assumed (default, acceptEdits, plan, bypassPermissions). */
	mode?: string;
	/** Replay: the steps of the session asked about. */
	steps?: ReplayStep[];
	/** Replay: the sessions there are to pick from. */
	sessions?: ReplaySession[];
}

export type HostToHarnessCanvas =
	| { type: 'model'; request: HarnessFlowRequest; model: HarnessFlowModel }
	| { type: 'error'; message: string };

export type HarnessCanvasToHost =
	| { type: 'ready' }
	| { type: 'request'; request: HarnessFlowRequest }
	| { type: 'open'; itemId: string };
