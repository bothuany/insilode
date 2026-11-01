/*---------------------------------------------------------------------------------------------
 *  Insilode: what a failed install of an agent's extension means for the next one (agentExtensions.ts). Pure, so it is
 *  tested on its own (test/agentExtensions.test.mjs).
 *--------------------------------------------------------------------------------------------*/

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
