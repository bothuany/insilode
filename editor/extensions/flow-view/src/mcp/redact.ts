/*---------------------------------------------------------------------------------------------
 *  Insilode agent bridge: blanks the obvious secrets in text that is about to leave the machine through the MCP server
 *  (`search_sessions` returns what a developer once typed or pasted, verbatim). Modelled on flow-harness/src/friction.ts `redact`,
 *  which the MCP server must not import, and widened to the forms a past conversation holds: key=value, key: value, JSON, Bearer
 *  headers and private key blocks. It is a net for the obvious, not a guarantee: a password in plain prose stays. Pure: no `vscode`,
 *  never throws, and every pattern is bounded so a huge or binary-looking text is read in linear time.
 *--------------------------------------------------------------------------------------------*/

export const REDACTED = '[redacted]';

/** Text beyond this is cut off, not returned unread: a secret past the cap must not slip through. */
export const MAX_REDACT_CHARS = 1_000_000;

const BEGIN_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const END_MARK = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** Private key blocks, also a block whose END line is outside the text (an excerpt cut in the middle): then the rest is blanked. */
function pemBlocks(text: string): string {
	let out = '';
	let from = 0;
	for (;;) {
		const rest = text.slice(from);
		const begin = BEGIN_KEY.exec(rest);
		if (!begin) {
			return out + rest;
		}
		out += rest.slice(0, begin.index) + REDACTED;
		const after = rest.slice(begin.index + begin[0].length);
		const end = END_MARK.exec(after);
		if (!end) {
			return out;
		}
		from += begin.index + begin[0].length + end.index + end[0].length;
	}
}

/** Names that hold a secret. Matched as the end of a longer name too (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, client_secret). */
const SECRET_NAME = '(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)';
// `name`, the closing quote of a JSON key and the separator, then the value: quoted, or bare up to a space, quote, comma, semicolon or &.
const KEY_VALUE = new RegExp(`(${SECRET_NAME})(["']?[ \\t]*)([:=])([ \\t]*)("[^"\\n]{0,2000}"|'[^'\\n]{0,2000}'|[^\\s"',;&]{1,500})`, 'gi');
const SYMBOL = /[^A-Za-z]/;

/** A bare value after a colon: prose ("token: how it works") stays, a value that looks like a secret goes. */
const looksSecret = (value: string) => SYMBOL.test(value) || value.length >= 12;

const TOKEN_PATTERNS: RegExp[] = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat)_[A-Za-z0-9_]{16,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** A long hex or base64-looking run right after a word that says it is a key or token ("the api key is 3f9a..."). */
const AFTER_KEY_WORD = /\b((?:key|token|secret|password|credential)s?\b(?:[ \t]+(?:is|was|are|value))?[ \t:="'`]{1,6})([A-Za-z0-9+/_=-]{32,})/gi;

function scrub(text: string): string {
	let t = pemBlocks(text);
	for (const p of TOKEN_PATTERNS) {
		t = t.replace(p, REDACTED);
	}
	t = t.replace(/\bBearer[ \t]+([A-Za-z0-9._~+/=-]{8,})/gi, (all, token: string) => /\d/.test(token) || token.length >= 24 ? `Bearer ${REDACTED}` : all);
	t = t.replace(KEY_VALUE, (all, name: string, quote: string, sep: string, space: string, value: string) => {
		if (value === REDACTED || value === `"${REDACTED}"`) {
			return all;
		}
		const quoted = value[0] === '"' || value[0] === "'";
		if (sep === ':' && !quoted && !looksSecret(value)) {
			return all;
		}
		return `${name}${quote}${sep}${space}${quoted ? `${value[0]}${REDACTED}${value[0]}` : REDACTED}`;
	});
	return t.replace(AFTER_KEY_WORD, (_all, lead: string) => `${lead}${REDACTED}`);
}

/** The text with its obvious secrets replaced by `[redacted]` (a key name stays, so the line still reads). Never throws. */
export function redact(text: unknown): string {
	if (typeof text !== 'string' || !text) {
		return '';
	}
	try {
		return scrub(text.length > MAX_REDACT_CHARS ? `${text.slice(0, MAX_REDACT_CHARS)}...` : text);
	} catch {
		return REDACTED;
	}
}
