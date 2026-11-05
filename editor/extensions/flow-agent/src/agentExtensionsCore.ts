/*---------------------------------------------------------------------------------------------
 *  Insilode: what a failed install of an agent's extension means for the next one (agentExtensions.ts). Pure, so it is
 *  tested on its own (test/agentExtensions.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** The extensions Insilode installs, by Open VSX id, and what the notice calls each. */
const NAMES: Record<string, string> = { 'anthropic.claude-code': 'Claude Code', 'openai.chatgpt': 'Codex' };

/** Where the once-only mark of the install notice is kept (globalState). */
export const INSTALL_NOTICE_KEY = 'flow.agents.installNoticeShown';

/** `A`, `A and B`, `A, B and C`. */
function joined(names: string[]): string {
	return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The one notification after an install run that installed something, or undefined when nothing was installed or the
 * notice was shown before (a later install, a second extension, does not repeat it). It names what was installed and the
 * setting that turns the install off.
 */
export function installNotice(installed: readonly string[], alreadyShown: boolean): string | undefined {
	if (!installed.length || alreadyShown) {
		return undefined;
	}
	const names = installed.map(id => NAMES[id] ?? id);
	return `Insilode installed ${joined(names)} for VS Code from Open VSX. Turn this off with the setting flow.agents.installAgentExtensions.`;
}

/**
 * `stop`: this Insilode has no extension gallery (web mode is given none), so every install fails the same way; the
 * next start tries again. `skip`: Open VSX does not have it, so it is never tried again. `retry`: anything else (no
 * network, a cancelled install), tried again at the next start.
 */
export function agentExtensionStep(error: unknown): 'stop' | 'skip' | 'retry' {
	const e = error as { name?: unknown; code?: unknown; message?: unknown } | undefined;
	if (typeof e?.message === 'string' && /no extension gallery/i.test(e.message)) {
		return 'stop';
	}
	if (e?.name === 'NotFound' || e?.code === 'NotFound' || (typeof e?.message === 'string' && /not found/i.test(e.message))) {
		return 'skip';
	}
	return 'retry';
}
