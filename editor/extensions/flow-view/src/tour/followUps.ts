/*---------------------------------------------------------------------------------------------
 *  Insilode: a tour's follow-up questions (`followUps`): up to three, each at most 120 characters, shown as chips after the last
 *  step. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

export const MAX_FOLLOW_UPS = 3;
export const MAX_FOLLOW_UP = 120;

/** `followUps` as the tool or a tour file sends them. Contract stub: the follow-ups part replaces this (strict: too many or too long is an error; otherwise cut). */
export function parseFollowUps(_raw: unknown, _strict: boolean): string[] | undefined {
	return undefined;
}
