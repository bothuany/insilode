/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: hiding what looks like a credential in a line of text the harness summary hands to another extension (summary.ts).
 *  A hook command, a permission rule or an MCP server's command line can carry a secret in more shapes than any list of them: so the
 *  rules go by NAME. The value of any flag, assignment, header, JSON or YAML key or URL parameter whose name looks like a secret (token,
 *  key, password, auth, cookie, session, code, …) is hidden, whatever it looks like, and known token shapes are hidden wherever they stand.
 *  The summary shows the shape of the line (the command, its flags) and never the secret.
 *  Pure: no `vscode`, no fs. Conservative on purpose: a harmless word may be hidden too (`mkdir -p dir`), a secret must never get through.
 *
 *  What a pattern cannot know: a secret standing alone with no name and no known shape (`mytool hunter2`, `--data "$(cat key)"`'s content),
 *  a value after a short flag of a program this does not know (`tool -k hunter2`), and a secret split by the 4x cut below.
 *--------------------------------------------------------------------------------------------*/

export const HIDDEN = '***';

/** A double-quoted string (escapes honoured; an unterminated one runs to the end), a single-quoted one, or a run of characters with backslash escapes. */
const DQ = String.raw`"(?:\\[\s\S]|[^"\\])*(?:"|$)`;
const SQ = String.raw`'[^']*(?:'|$)`;
/** A value: one quoted string, or a run of escaped or plain characters (`a\ b`). Not a mix of the two: a quote right after a plain run is more likely the end of an enclosing string (`"…&token=abc"`) than the start of another part, and it is kept. */
const VALUE = String.raw`(?:${DQ}|${SQ}|(?:\\[\s\S]|[^\s;&|"'\\])+)`;

/** Whether a name (a flag, a variable, a header, a key) says its value is a secret: by its words, so `--passWithNoTests` and `--author` are not and `DB_PASSWORD`, `x-api-key` and `_authToken` are. */
export function isSecretName(name: string): boolean {
	const words = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
	if (words.includes('exit')) {
		return false;
	}
	// The short words (pass, code, sig) count only as the last word of a name: `db_pass`, `--code`, but not `--passWithNoTests`.
	return words.some(w => /token|secret|passw|passphrase|pwd|credential|cookie|session|signature|bearer|jwt|private|apikey|key|auth(?!or(?:s|ed|ing|ity)?$)/.test(w)) || ['pass', 'pw', 'sig', 'code', 'otp', 'pin', 'cred', 'creds', 'sid'].includes(words[words.length - 1]);
}

/** Headers that are never a secret: the others, in a `-H` argument, are hidden. */
const SAFE_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'accept-charset', 'content-type', 'content-length', 'content-encoding', 'user-agent', 'cache-control', 'host', 'origin', 'referer', 'connection', 'pragma', 'range', 'if-none-match', 'if-modified-since', 'x-requested-with', 'dnt', 'expect']);

/** Programs whose `-p` is a project, a mode or a path and never a password; for any other program the word after `-p` is hidden. Programs that run another program (ssh, docker, env) are not here: what follows them may be anything. */
const SAFE_P = /(?:^|\/)(?:tsc|mkdir|cp|mv|rsync|install|tar|ls|cargo)$/;
/** Programs whose `-a` carries a password (redis-cli, httpie). */
const ARG_A = /(?:^|\/)(?:redis-cli|http|https|xh)$/;
/** The program of the simple command that contains `offset`: its first word that is not an assignment, a flag or a wrapper. */
function programAt(text: string, offset: number): string {
	const start = Math.max(text.lastIndexOf(';', offset), text.lastIndexOf('|', offset), text.lastIndexOf('&', offset), text.lastIndexOf('(', offset), text.lastIndexOf('\n', offset));
	return text.slice(start + 1, offset).split(/\s+/).find(w => w && !w.includes('=') && !w.startsWith('-') && !/^(?:sudo|env|time|nohup|exec|command|xargs|nice|doas)$/.test(w)) ?? '';
}

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
	// https://user:password@host and https://token@host: the user info goes (up to the last @ before the path, a password may hold one), the host stays.
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/'"]*@/gi, `$1${HIDDEN}@`],
	// Webhook URLs carry the secret in their path.
	[/\b(hooks\.slack\.com\/(?:services|workflows|triggers)\/|discord(?:app)?\.com\/api\/webhooks\/)[^\s'"]+/gi, `$1${HIDDEN}`],
	// -H "Name: value", --header=Name:value: the value of every header that is not on the short safe list.
	[new RegExp(String.raw`((?:^|\s)(?:-H|--header)(?:=|\s*))(?:"((?:\\[\s\S]|[^"\\])*)(?:"|$)|'([^']*)(?:'|$)|(\S+))`, 'g'), (m, pre, dq, sq, bare) => {
		const content = dq ?? sq ?? bare ?? '';
		const name = /^\s*([\w-]+)\s*:/.exec(content)?.[1];
		if (!name || SAFE_HEADERS.has(name.toLowerCase())) {
			return m;
		}
		const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
		return `${pre}${q}${name}: ${HIDDEN}${q}`;
	}],
	// A quoted body (-d "client_secret=x&grant=y"): the secret pairs in it, up to the & (a quote, not a space, comes before the first name).
	[new RegExp(`${DQ}|${SQ}`, 'g'), m => {
		if (!m.includes('=')) {
			return m;
		}
		const closed = m.length > 1 && m.endsWith(m[0]);
		const inner = m.slice(1, closed ? -1 : undefined).replace(/(^|&)([\w.%-]+)=((?:\\[\s\S]|"[^"]*"?|'[^']*'?|[^&"'\\])*)/g, (p: string, pre: string, name: string) => isSecretName(name) ? `${pre}${name}=${HIDDEN}` : p);
		return m[0] + inner + (closed ? m[0] : '');
	}],
	// ?token=abc&sig=def#access_token=ghi: the value of any URL parameter that names a secret.
	[/(?<=[?&#;])([\w.%-]+)=([^&\s'"#]*)/g, (m, name) => isSecretName(name) ? `${name}=${HIDDEN}` : m],
	// FOO=bar, export FOO=bar, FOO="bar baz", FOO=a\ b: an environment assignment keeps its name and loses everything after the `=`.
	[new RegExp(String.raw`(^|[\s;|(])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=)(?:${VALUE})?`, 'g'), `$1$2${HIDDEN}`],
	// --token=abc, -Dpassword=abc: a flag that names a secret, with its value in the same word.
	[new RegExp(String.raw`(?<![\w-])(-{1,2}[\w.-]+=)${VALUE}`, 'g'), (m, flag) => isSecretName(flag) ? `${flag}${HIDDEN}` : m],
	// --token abc, --password 'abc': a flag that names a secret, the next word is its value.
	[new RegExp(String.raw`(?<![\w-])(-{1,2}[\w.-]+)(\s+)(?!-)${VALUE}`, 'g'), (m, flag, space) => isSecretName(flag) ? `${flag}${space}${HIDDEN}` : m],
	// -p hunter2, -pHUNTER2, -P hunter2 (mysql, sshpass, zip, 7z): the short flags that carry a password, whatever program they are for.
	[new RegExp(String.raw`(?<![\w-])(-[pP])(\s*)(?!-)${VALUE}`, 'g'), (m, flag, space, ...rest) => SAFE_P.test(programAt(rest[rest.length - 1] as unknown as string, Number(rest[rest.length - 2]))) ? m : `${flag}${space}${HIDDEN}`],
	// -u user:pass, -uuser:pass, --user user:pass, --user=user:pass, --proxy-user.
	[new RegExp(String.raw`(?<![\w-])(-u|--user|--proxy-user)(=|\s*)(?!-)${VALUE}`, 'g'), `$1$2${HIDDEN}`],
	// redis-cli -a pass, http -a user:pass.
	[new RegExp(String.raw`(?<![\w-])(-a)(\s+)(?!-)${VALUE}`, 'g'), (m, flag, space, ...rest) => ARG_A.test(programAt(rest[rest.length - 1] as unknown as string, Number(rest[rest.length - 2]))) ? `${flag}${space}${HIDDEN}` : m],
	// "password": "x", 'api_key': 'x', "token": 123: JSON keys, and the same with = (a Python or properties literal).
	[new RegExp(String.raw`(["'])([\w.@ -]{1,64})\1(\s*[:=]\s*)(?:${DQ}|${SQ}|[^\s,}\]]+)`, 'g'), (m, q, name, sep) => isSecretName(name) ? `${q}${name}${q}${sep}"${HIDDEN}"` : m],
	// password: x, Authorization: Bearer x, Cookie: a=b; c=d, x-api-key: x: YAML and headers: a quoted value, or the rest of the line.
	[new RegExp(String.raw`(^|[\s{,("'])([\w.-]{1,64})(\s*:\s*)(?:${DQ}|${SQ}|[^\r\n"']*)`, 'g'), (m, pre, name, sep) => isSecretName(name) ? `${pre}${name}${sep}${HIDDEN}` : m],
	// password=x, client_secret=x, _authToken=x, aws_secret_access_key=x wherever they stand (not after a dash: flags are above).
	[new RegExp(String.raw`(?<![\w.%-])([A-Za-z_][\w.%-]*)(\s*=\s*)${VALUE}`, 'g'), (m, name, eq) => isSecretName(name) ? `${name}${eq}${HIDDEN}` : m],
	// Bearer abc / Basic abc anywhere.
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${HIDDEN}`],
	// Keys by their make: sk-…, sk_live_…, ghp_…, github_pat_…, xoxb-…, glpat-…, dop_v1_…, npm_…, AIza…, AKIA…, a JWT.
	[/\b(?:sk_(?:live|test)_|rk_(?:live|test)_|pk_live_|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[a-zA-Z]\d*-?|glpat-|dop_v1_|npm_|hf_|shpat_|pypi-|SG\.|AIza)[A-Za-z0-9_.-]{8,}/g, HIDDEN],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, HIDDEN],
	[/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, HIDDEN],
	// Any other long run of letters and digits with no separator but - and _: it is more likely a key than a word.
	[/(?<![\w/.~-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\w/.-])/g, HIDDEN],
];

/** The text with every credential-looking part replaced by `***`, cut to `max` characters (with an ellipsis). The input is cut first, so a huge line costs no more than a long one. */
export function redact(text: string, max = 200): string {
	// Longer than anything worth showing: the cut is at 4x so a secret that straddles `max` is still seen whole, then the result is cut.
	const cut = text.length > max * 4;
	let out = cut ? text.slice(0, max * 4) : text;
	for (const [pattern, replacement] of RULES) {
		out = out.replace(pattern, replacement as string);
	}
	// One line: a newline in a command is how a second command hides below the first.
	out = out.replace(/\s+/g, ' ').trim();
	if (cut && out.length <= max) {
		// The cut may have left the start of a token too short for its rule, and the hiding above made room for it to show: the last word goes.
		out = (out.endsWith(HIDDEN) ? out : out.replace(/\S*$/, '').trimEnd()) + '…';
	}
	return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
