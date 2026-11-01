/*---------------------------------------------------------------------------------------------
 *  Insilode: what "Show Flow at Cursor" tells the user when it cannot draw a flow where the cursor is, or when it fell
 *  back to another engine, and which engine the canvas names for a flow it drew. Pure, so the wording is unit-tested;
 *  extension.ts and panel.ts only show what this returns.
 *--------------------------------------------------------------------------------------------*/

/** Why the cursor did not give a flow from the first engine asked. */
export type CursorReason = 'outside-function' | 'index-not-ready' | 'no-solution';

export interface CursorNoticeInput {
	languageId: string;
	reason: CursorReason;
	/** True when a language server will draw the flow anyway, so the notice only says which engine did. */
	falling: boolean;
}

/** Languages the code index (the same set as POLY_LANGUAGES in poly/client.ts) or, for C#, the Roslyn analyzer is the first engine for: only for these is a language server a fall-back. */
const FIRST_ENGINE = new Set(['csharp', 'java', 'python', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'go', 'php', 'ruby', 'rust']);

/**
 * The sentence to show, or nothing when the flow draws from the first engine and there is nothing to say.
 * A language that has no index and no analyzer starts at its language server, so "no solution" is not news there.
 */
export function cursorNotice(input: CursorNoticeInput): string | undefined {
	const { reason, falling, languageId } = input;
	if (reason === 'outside-function') {
		return falling
			? 'The cursor is not inside a function the index knows: showing the language server\'s flow for what is under it instead. Move the cursor into a function to use the index.'
			: 'The cursor is not inside a function: move it into one to see its flow.';
	}
	if (reason === 'index-not-ready') {
		return falling
			? 'The index is still building: showing the language server\'s flow instead.'
			: 'The index is still building: try again in a moment.';
	}
	// no-solution: only C# has a solution to be missing; any other language without an index goes to its language server by design.
	if (languageId !== 'csharp') {
		return falling && FIRST_ENGINE.has(languageId) ? 'The index has no flow for this file: showing the language server\'s flow instead.' : undefined;
	}
	return falling
		? 'No C# solution is open: showing the language server\'s flow instead. Open a .sln or .csproj folder to use Roslyn.'
		: 'No C# solution is open: open a folder with a .sln or .csproj to see this flow.';
}

/** The engine that traced a flow, as the canvas names it, and what to tell the reader when it is the weaker one. */
export interface Engine {
	name: 'Index' | 'Roslyn' | 'Language server';
	/** Set for a language server where the index or Roslyn would normally trace this language. */
	hint?: string;
}

/** `kind`: the FlowTarget kind. A change set has no single engine. */
export function engineOf(kind: string, languageId?: string): Engine | undefined {
	if (kind === 'poly') {
		return { name: 'Index' };
	}
	if (kind === 'roslyn') {
		return { name: 'Roslyn' };
	}
	if (kind === 'lsp') {
		const fallback = languageId !== undefined && FIRST_ENGINE.has(languageId);
		return { name: 'Language server', ...(fallback ? { hint: 'The code index did not trace this flow, so calls it cannot see may be missing.' } : {}) };
	}
	return undefined;
}
