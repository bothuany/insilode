/*---------------------------------------------------------------------------------------------
 *  Insilode: a tour's follow-up questions (`followUps`): up to three, each at most 120 characters, shown as chips after the last
 *  step. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

export const MAX_FOLLOW_UPS = 3;
export const MAX_FOLLOW_UP = 120;

/** A bad `followUps` in a tool call. Its own class: validate.ts's TourFileError would make an import cycle; handlers.ts reports any Error's message. */
export class FollowUpError extends Error { }

/** Control characters become spaces and runs of whitespace one space, so a question is a single line. */
function clean(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `followUps` as the tool or a tour file sends them (strict: too many or too long is an error; otherwise cut). */
export function parseFollowUps(raw: unknown, strict: boolean): string[] | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!Array.isArray(raw)) {
		if (strict) {
			throw new FollowUpError('`followUps` is a list of questions (strings).');
		}
		return undefined;
	}
	if (strict && raw.length > MAX_FOLLOW_UPS) {
		throw new FollowUpError(`\`followUps\` has ${raw.length} entries; at most ${MAX_FOLLOW_UPS} are shown.`);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	raw.forEach((entry, i) => {
		if (typeof entry !== 'string') {
			if (strict) {
				throw new FollowUpError(`\`followUps[${i}]\` is not a string.`);
			}
			return;
		}
		let text = clean(entry);
		if (!text) {
			if (strict) {
				throw new FollowUpError(`\`followUps[${i}]\` is empty.`);
			}
			return;
		}
		if (text.length > MAX_FOLLOW_UP) {
			if (strict) {
				throw new FollowUpError(`\`followUps[${i}]\` is ${text.length} characters long; at most ${MAX_FOLLOW_UP} are shown.`);
			}
			text = text.slice(0, MAX_FOLLOW_UP).trim();
		}
		const key = text.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			out.push(text);
		}
	});
	const kept = out.slice(0, MAX_FOLLOW_UPS);
	return kept.length ? kept : undefined;
}
