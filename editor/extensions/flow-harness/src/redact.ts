/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: hiding what looks like a credential in a line of text the harness summary hands to another extension (summary.ts).
 *  A hook command, a permission rule or an MCP server's command line can carry a token as an environment assignment, a URL's user info,
 *  an Authorization header or a flag's value; the summary shows the shape of the line (the command, its flags) and never the secret.
 *  Pure: no `vscode`, no fs. Conservative on purpose: a harmless long identifier may be hidden too, a secret must never get through.
 *--------------------------------------------------------------------------------------------*/

export const HIDDEN = '***';

/** Words that make a flag, header or query parameter a credential. */
const SECRET_WORD = '(?:token|key|secret|passw(?:or)?d|passwd|pass|auth|credential|bearer|cookie|signature|jwt)';
/** The text of one argument: a quoted string or a run without spaces. */
const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

const RULES: [RegExp, string][] = [
	// https://user:password@host and https://token@host: the user info goes, the host stays.
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, `$1${HIDDEN}@`],
	// ?token=abc&key=def in a URL: the values of the parameters that name a credential.
	[new RegExp(String.raw`([?&;][\w.-]*${SECRET_WORD}[\w.-]*=)[^&\s'"#]*`, 'gi'), `$1${HIDDEN}`],
	// Authorization: Bearer abc, Proxy-Authorization, X-Api-Key: abc, Cookie: a=b, in a header argument or a plain line: the rest of the value, up to its closing quote.
	[/\b((?:proxy-)?authorization|x-[\w-]*(?:key|token|secret|auth)[\w-]*|api[-_]?key|(?:set-)?cookie)(\s*:\s*)(?:"[^"]*"|'[^']*'|[^\r\n"']*)/gi, `$1$2${HIDDEN}`],
	// The same joined by `=` (api_key=abc): the value is one word.
	[/\b((?:proxy-)?authorization|x-[\w-]*(?:key|token|secret|auth)[\w-]*|api[-_]?key|(?:set-)?cookie)(=)(?:"[^"]*"|'[^']*'|[^\s;&|"']*)/gi, `$1$2${HIDDEN}`],
	// Bearer abc / Basic abc anywhere.
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${HIDDEN}`],
	// FOO=bar, export FOO=bar, FOO="bar baz": an environment assignment keeps its name and loses everything after the `=`.
	[/(^|[\s;|(])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s;&|"']*)/g, `$1$2${HIDDEN}`],
	// --token=abc, -k=abc: a flag that names a credential, with its value in the same word.
	[new RegExp(String.raw`(--?[\w-]*${SECRET_WORD}[\w-]*=)${ARG}`, 'gi'), `$1${HIDDEN}`],
	// --token abc, --password 'abc': a flag that names a credential, the next word is its value.
	[new RegExp(String.raw`(--?[\w-]*${SECRET_WORD}[\w-]*\s+)(?!-)${ARG}`, 'gi'), `$1${HIDDEN}`],
	// curl -u user:password, --user user:password.
	[new RegExp(String.raw`(\s(?:-u|--user)\s+)${ARG}`, 'g'), `$1${HIDDEN}`],
	// Keys by their make: sk-…, ghp_…, github_pat_…, xoxb-…, AKIA…, glpat-…, AIza…, a JWT.
	[/\b(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abprs]-|glpat-|AIza)[A-Za-z0-9_-]{8,}/g, HIDDEN],
	[/\bAKIA[0-9A-Z]{12,}\b/g, HIDDEN],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, HIDDEN],
	// Any other long run of letters and digits with no separator but - and _: it is more likely a key than a word.
	[/(?<![\w/.~-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\w/.-])/g, HIDDEN],
];

/** The text with every credential-looking part replaced by `***`, cut to `max` characters (with an ellipsis). The input is cut first, so a huge line costs no more than a long one. */
export function redact(text: string, max = 200): string {
	// Longer than anything worth showing: the cut is at 4x so a secret that straddles `max` is still seen whole, then the result is cut.
	let out = text.length > max * 4 ? text.slice(0, max * 4) : text;
	for (const [pattern, replacement] of RULES) {
		out = out.replace(pattern, replacement);
	}
	// One line: a newline in a command is how a second command hides below the first.
	out = out.replace(/\s+/g, ' ').trim();
	return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
