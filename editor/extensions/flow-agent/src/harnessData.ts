/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents page's Harness panel shows. Types only, no vscode.
 *
 *  The summary is the answer of flow-harness's `flowHarness.summary` command (flow-harness/src/summaryCore.ts). Extensions never import each
 *  other's source, so the shape is copied here: keep the two in step (a field that one adds and the other does not know is dropped by the
 *  page, never a crash: the page reads every list with a fallback).
 *--------------------------------------------------------------------------------------------*/

export type HarnessScope = 'user' | 'project' | 'local' | 'directory';
export type HarnessSeverity = 'error' | 'warning' | 'info';

export interface HarnessFile {
	/** The file as shown: relative to the folder, or `~/…` for the user's own. */
	where: string;
	/** Its absolute path. The page never sends one the summary did not name (agentsMessage.ts, harnessBridge.ts). */
	file: string;
}

export interface HarnessInstruction extends HarnessFile {
	name: string;
	kind: 'instructions' | 'rules';
	scope: HarnessScope;
	detail: string;
	tokens?: number;
}

export interface HarnessHook extends HarnessFile {
	event: string;
	matcher?: string;
	/** Redacted by flow-harness: no secret values. */
	command: string;
	scope: HarnessScope;
	line?: number;
}

export interface HarnessRule extends HarnessFile {
	pattern: string;
	scope: HarnessScope;
}

export interface HarnessPermissions {
	mode?: string;
	modeWhere?: string;
	counts: { allow: number; ask: number; deny: number };
	allow: HarnessRule[];
	ask: HarnessRule[];
	deny: HarnessRule[];
}

export interface HarnessMcp extends HarnessFile {
	name: string;
	transport: string;
	scope: HarnessScope;
	state: 'on' | 'off' | 'pending';
	target: string;
}

export interface HarnessNamed {
	name: string;
	scope: HarnessScope;
	file?: string;
	where?: string;
}

export interface HarnessNames {
	count: number;
	items: HarnessNamed[];
}

export interface HarnessFinding extends HarnessFile {
	severity: HarnessSeverity;
	message: string;
	line?: number;
	code?: string;
}

export interface HarnessSummary {
	root: string;
	score: number;
	startupTokens: number;
	instructions: HarnessInstruction[];
	hooks: HarnessHook[];
	permissions: HarnessPermissions;
	mcp: HarnessMcp[];
	skills: HarnessNames;
	agents: HarnessNames;
	commands: HarnessNames;
	findings: HarnessFinding[];
	counts: Record<HarnessSeverity, number>;
	notes: string[];
}

/** What `flowHarness.summary` answers. */
export type HarnessSummaryResult = { ok: true; summary: HarnessSummary } | { ok: false; message: string };

/** Host → page: the summary of the project the page asked about. `cwd` is the page's own, as it sent it (none for "this window's folder"), so a late answer to an earlier ask can be told apart. */
export interface AgentsPageHarnessData {
	type: 'harnessData';
	cwd?: string;
	summary: HarnessSummary;
}

export interface AgentsPageHarnessFailed {
	type: 'harnessFailed';
	cwd?: string;
	message: string;
}
