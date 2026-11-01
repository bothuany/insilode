/*---------------------------------------------------------------------------------------------
 *  Insilode: what "Show Flow at Cursor" tells the user when it cannot draw a flow where the cursor is, or when it fell
 *  back to another engine. Pure, so the wording is unit-tested; extension.ts only shows what this returns.
 *--------------------------------------------------------------------------------------------*/

/** Why the cursor did not give a flow from the first engine asked. */
export type CursorReason = 'outside-function' | 'index-not-ready' | 'no-solution';

export interface CursorNoticeInput {
	languageId: string;
	reason: CursorReason;
	/** True when a language server will draw the flow anyway, so the notice only says which engine did. */
	falling: boolean;
}

/** The sentence to show, or nothing when the flow draws as expected and there is nothing to say. */
export function cursorNotice(input: CursorNoticeInput): string | undefined {
	// Today only the C# case speaks; the review fixes widen this to every reason, with the engine named.
	if (input.reason === 'outside-function' && !input.falling && input.languageId === 'csharp') {
		return 'Insilode: put the cursor inside a method.';
	}
	return undefined;
}
