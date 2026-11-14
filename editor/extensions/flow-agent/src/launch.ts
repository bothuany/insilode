/*---------------------------------------------------------------------------------------------
 *  Insilode: the command line a terminal Claude session is started with. Pure (no vscode), so the arguments are tested
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
