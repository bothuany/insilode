/*---------------------------------------------------------------------------------------------
 *  Insilode: the command line a terminal Claude or Codex session is started with. Pure (no vscode), so the arguments are tested
 *  on their own (test/launch.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** Double quotes work in bash, zsh, PowerShell and cmd alike. */
const quote = (x: string) => `"${x}"`;

export interface ClaudeLaunch {
	resume: boolean;
	id: string;
	/** The hooks file, when the hook server is up. */
	settings?: string;
	/** The `insilode` MCP config; it goes last because --mcp-config takes any number of files. */
	mcp?: string;
	/** flow.agents.claude.allowBypassPermissions: "bypass permissions" joins Claude's own mode cycle, still not the mode it starts in. */
	allowBypass: boolean;
}

export function claudeCommand(o: ClaudeLaunch): string {
	// --allow-dangerously-skip-permissions (claude --help): offers bypass as an option without enabling it, unlike --dangerously-skip-permissions.
	return `claude ${o.resume ? '--resume' : '--session-id'} ${o.id}${o.allowBypass ? ' --allow-dangerously-skip-permissions' : ''}${o.settings ? ` --settings ${quote(o.settings)}` : ''}${o.mcp ? ` --mcp-config ${quote(o.mcp)}` : ''}`;
}

export interface CodexLaunch {
	resume: boolean;
	/** The Codex session to resume; typed into the shell, so anything that is not a uuid is left out (Codex's own picker opens instead). */
	id?: string;
	/** Insilode's Codex profile, when it could be made. */
	profile?: string;
	/** flow.agents.codex.neverAsk: Codex does not stop to ask before it edits files or runs commands, inside its workspace sandbox. */
	neverAsk: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codexStartCommand(o: CodexLaunch): string {
	// Codex has no "offer but do not enable" flag, so "never ask" is approval policy `never` with the sandbox kept (workspace-write). Never --dangerously-bypass-approvals-and-sandbox or danger-full-access.
	return `codex${o.resume ? ' resume' : ''}${o.profile ? ` -p ${o.profile}` : ''}${o.neverAsk ? ' --ask-for-approval never --sandbox workspace-write' : ''}${o.resume && o.id && UUID.test(o.id) ? ` ${o.id}` : ''}`;
}
