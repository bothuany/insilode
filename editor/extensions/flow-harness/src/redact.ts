/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: hiding what looks like a credential in a line of text the harness summary hands to another extension (summary.ts).
 *  A hook command, a permission rule or an MCP server's command line can carry a secret in more shapes than any list of them: so the
 *  rules go by NAME. The value of any flag, assignment, header, JSON or YAML key or URL parameter whose name looks like a secret (token,
 *  key, password, auth, cookie, session, code, …) is hidden, whatever it looks like, and known token shapes are hidden wherever they stand.
 *  The summary shows the shape of the line (the command, its flags) and never the secret.
 *  Pure: no `vscode`, no fs. Conservative on purpose: a harmless word may be hidden too (`FOO=bar cmd`), a secret must never get through; but an
 *  everyday command (`npx tsc -p .`, `npm run auth:check`) stays readable.
 *
 *  What a pattern cannot know: a secret standing alone with no name and no known shape (`mytool hunter2`, `--data "$(cat key)"`'s content),
 *  a value after a short flag of a program this does not know (`tool -k hunter2`: a short flag is hidden only for the programs known to take a
 *  secret there, `takesSecret`, because `-p` is a port, a project or a path for most), and a secret split by the 4x cut below.
 *--------------------------------------------------------------------------------------------*/

export const HIDDEN = '***';

/** A double-quoted string (escapes honoured; an unterminated one runs to the end), a single-quoted one, or a run of characters with backslash escapes. */
const DQ = String.raw`"(?:\\[\s\S]|[^"\\])*(?:"|$)`;
const SQ = String.raw`'[^']*(?:'|$)`;
const BACKTICK = String.raw`\`[^\`]*(?:\`|$)`;
/** Stands for one `$(…)` while the rules run (see `shield`): a value that holds a substitution is one value, and a character no rule treats as a separator. */
const OPEN = '\uE000';
const CLOSE = '\uE001';
const SHIELDED = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
/** How many substitutions deep `shield` looks before it hides the rest. */
const MAX_NEST = 32;
/** A value: one quoted string, or a run of escaped or plain characters and substituted `$(…)` (`a\ b`). Not a mix of quotes and plain: a quote right after a plain run is more likely the end of an enclosing string (`"…&token=abc"`) than the start of another part, and it is kept. */
const VALUE = String.raw`(?:${DQ}|${SQ}|(?:\\[\s\S]|${BACKTICK}|\$(?!\()|[^\s;&|"'\\$\`])+)`;

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

/** Where a simple command ends: `;`, `|`, `&` (not the one of `2>&1` or `&>`), a newline, an opening parenthesis. */
const SEPARATOR = /[;|\n(]|(?<!>)&(?!>)/g;
/** The text of the simple command that contains `offset`, up to it. */
function segmentBefore(text: string, offset: number): string {
	const head = text.slice(0, offset);
	let start = 0;
	for (const m of head.matchAll(SEPARATOR)) {
		start = m.index + 1;
	}
	return head.slice(start);
}
/**
 * The words of the simple command that contains `offset`, up to it, that may be the program the flag belongs to: all of them but the ones that are
 * the value of a long flag (`--name mysql`), with quotes and a path taken off. The program is not always the first word (`sudo mysql`, `npx tsc`, `docker exec
 * db mysql`, `ssh host mysql`, `bash -c "mysql …"`), so every one is a candidate: a secret-taker anywhere before the flag counts.
 */
function programsBefore(text: string, offset: number): string[] {
	const words = segmentBefore(text, offset).split(/\s+/).filter(Boolean);
	const programs = words.filter((w, i) => !(i > 0 && /^--[^-=]+$/.test(words[i - 1]) && !/^["']/.test(w)) && !w.startsWith('-')).map(w => w.replace(/^["'(]+|["')]+$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase());
	// `docker --debug login -p x`: the subcommand is a word of its own wherever it stands.
	return words.includes('login') ? [...programs, 'login'] : programs;
}
/** Whether the short flag `-<flag>` carries a secret for one of these programs: only the programs known to take one there. For any other it is a port, a project, a mode or a path (`ssh -p 2222`, `mvn -pl x`, `git add -p`). */
function takesSecret(flag: string, programs: string[]): boolean {
	const any = (re: RegExp) => programs.some(p => re.test(p));
	switch (flag) {
		case 'p': return any(/^(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb|mariadb-dump|mariadb-admin|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport|sshpass|7z|7za|7zz|twine)$/) || (any(/^(?:docker|podman|nerdctl|buildah|skopeo|az|oc|cf)$/) && programs.includes('login'));
		case 'P': return any(/^(?:zip|unzip|sqlcmd|bcp)$/);
		case 'u': return any(/^(?:curl|lftp)$/);
		case 'U': return any(/^(?:curl|smbclient)$/);
		case 'a': return any(/^(?:redis-cli|http|https|xh)$/);
		case 'w': return any(/^ldap(?:search|add|modify|delete|compare|modrdn|passwd)$/);
		default: return false;
	}
}
/** Whether a command line names a secret flag (`--password-stdin`, `--with-token`): what it reads from standard input is then a secret. */
const hasSecretFlag = (command: string): boolean => [...command.matchAll(/(?:^|\s)--?([\w.-]+)/g)].some(m => isSecretName(m[1]));
/** The flags that name a secret but take no value (the value comes in on standard input). */
const NO_VALUE = /^(?:--with-token|-{1,2}[\w.-]*-stdin)$/;

/** The words after `set` (`aws configure set aws_secret_access_key X`, `npm config set //r/:_authToken X`): the value after a word that names a secret is hidden. */
function maskSet(tail: string): string {
	const words = [...tail.matchAll(/\S+/g)];
	const value = new RegExp(VALUE, 'y');
	let out = '';
	let at = 0;
	for (let i = 0; i < words.length - 1; i++) {
		const [name, next] = [words[i][0], words[i + 1]];
		if (!name.startsWith('-') && !next[0].startsWith('-') && isSecretName(name)) {
			value.lastIndex = next.index;
			out += tail.slice(at, next.index) + HIDDEN;
			at = next.index + (value.exec(tail)?.[0].length ?? next[0].length);
			while (i + 1 < words.length && words[i + 1].index < at) {
				i++;
			}
		}
	}
	return out + tail.slice(at);
}

/**
 * Every `$(…)` of `text` (any depth, balanced by a counter, one pass) replaced by a placeholder, so the rules see it as one plain value; its inside is redacted
 * on its own and put back by `redactText`. A `$(` that is never closed runs to the end, and what is in it is still redacted by name. Past `MAX_NEST` levels the inside is hidden.
 */
function shield(text: string, spans: string[], depth: number): string {
	let out = '';
	let at = 0;
	let i = 0;
	while (i < text.length) {
		if (text[i] === '\\') {
			i += 2;
		} else if (text[i] !== '$' || text[i + 1] !== '(') {
			i++;
		} else {
			let end = i + 2;
			let open = 1;
			while (end < text.length && open) {
				if (text[end] === '\\') {
					end++;
				} else if (text[end] === '(') {
					open++;
				} else if (text[end] === ')') {
					open--;
				}
				end++;
			}
			const inner = text.slice(i + 2, open ? text.length : end - 1);
			spans.push('$(' + (depth < MAX_NEST ? redactText(inner, depth + 1) : HIDDEN) + (open ? '' : ')'));
			out += text.slice(at, i) + OPEN + (spans.length - 1) + CLOSE;
			at = i = open ? text.length : end;
		}
	}
	return out + text.slice(at);
}

/** `name:value`, `name: value`: `name` is a word of its own. */
const COLON = String.raw`(^|[\s{,("'])([\w.-]{1,64})(\s*:\s*)`;
/**
 * Whether the word at `at` is the script of `npm|pnpm|yarn|bun run <script>` (`npm run auth:check`): a script name, not a `name:value`. The package manager
 * is found as any program of the command is (`npx pnpm run x`, `sudo npm run x`), the script is the first word after `run` that is not a flag or a flag's value.
 */
function isScriptName(text: string, at: number): boolean {
	const words = segmentBefore(text, at).split(/\s+/).map(w => w.replace(/^["'(]+|["')]+$/g, '')).filter(Boolean);
	const run = words.findLastIndex(w => w === 'run' || w === 'run-script');
	return run >= 0 && programsBefore(text, at).some(p => /^(?:npm|pnpm|yarn|bun)$/.test(p)) && words.slice(run + 1).every((w, i, after) => w.startsWith('-') || (i > 0 && after[i - 1].startsWith('-') && !after[i - 1].includes('=')));
}
/** The value of every `secretName:value` is hidden, except a script name after `run`; for any other name the text after the colon is looked at as text of its own. */
function maskColons(text: string): string {
	const re = new RegExp(`${COLON}(?:${DQ}|${SQ}|[^\\r\\n"']*)`, 'g');
	let out = '';
	let at = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const [all, pre, name, sep] = m;
		const nameAt = m.index + pre.length;
		const colon = nameAt + name.length + sep.indexOf(':') + 1;
		if (isSecretName(name) && !isScriptName(text, nameAt)) {
			out += text.slice(at, nameAt + name.length + sep.length) + HIDDEN;
			at = m.index + all.length;
		} else {
			re.lastIndex = colon;
		}
	}
	return out + text.slice(at);
}

const RULES: ([RegExp, string | ((...m: string[]) => string)] | ((text: string) => string))[] = [
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
	[new RegExp(String.raw`(?<![\w-])(-{1,2}[\w.-]+)(\s+)(?![-<>])${VALUE}`, 'g'), (m, flag, space) => isSecretName(flag) && !NO_VALUE.test(flag) ? `${flag}${space}${HIDDEN}` : m],
	// docker login --password-stdin <<< hunter2: the here-string is the secret when the command names a secret flag.
	[new RegExp(String.raw`(<<<\s*)${VALUE}`, 'g'), (m, pre, ...rest) => {
		const text = rest[rest.length - 1] as unknown as string;
		const offset = Number(rest[rest.length - 2]);
		const after = text.slice(offset + m.length).split(/[;|\n]/, 1)[0];
		return hasSecretFlag(segmentBefore(text, offset) + ' ' + after) ? `${pre}${HIDDEN}` : m;
	}],
	// aws configure set aws_secret_access_key X: a word that names a secret, then its value, after `set`.
	[/(?<![\w-])set(?=\s)[^;&|\n]*/g, m => 'set' + maskSet(m.slice(3))],
	// -p hunter2, -phunter2, -P x, -u user:pass, -a pass, -w pass: a short flag carries a secret only for the programs known to take one there (mysql -p, sshpass -p, docker login -p, curl -u, redis-cli -a, …).
	[new RegExp(String.raw`(?<![\w-])(-[pPuUaw])(\s*)(?!-)${VALUE}`, 'g'), (m, flag, space, ...rest) => {
		return takesSecret(flag[1], programsBefore(rest[rest.length - 1] as unknown as string, Number(rest[rest.length - 2]))) ? `${flag}${space}${HIDDEN}` : m;
	}],
	// --user user:pass, --user=user:pass, --proxy-user: for the programs that take a login there, or whatever has a `name:secret` value (`pip install --user`, `systemctl --user`, `docker run --user 1000:1000` stay readable).
	[new RegExp(String.raw`(?<![\w-])(--user|--proxy-user)(=|\s+)(?!-)(${VALUE})`, 'g'), (m, flag, sep, value, ...rest) => {
		const login = programsBefore(rest[rest.length - 1] as unknown as string, Number(rest[rest.length - 2])).some(p => /^(?:curl|wget|lftp|http|https|xh|svn)$/.test(p));
		return login || (/:/.test(value) && !/^\d+:\d+$/.test(value)) ? `${flag}${sep}${HIDDEN}` : m;
	}],
	// "password": "x", 'api_key': 'x', "token": 123: JSON keys, and the same with = (a Python or properties literal).
	[new RegExp(String.raw`(["'])([\w.@ -]{1,64})\1(\s*[:=]\s*)(?:${DQ}|${SQ}|[^\s,}\]]+)`, 'g'), (m, q, name, sep) => isSecretName(name) ? `${q}${name}${q}${sep}"${HIDDEN}"` : m],
	// password: x, password:x, Authorization: Bearer x, Cookie: a=b; c=d, x-api-key: x, {token:'x'}: YAML, headers and object literals: a quoted value, or the rest of the line (maskColons).
	maskColons,
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

/** The rules applied to `text`: its substitutions are redacted first and set aside (`shield`), then the rest, then they are put back. */
function redactText(text: string, depth: number): string {
	const spans: string[] = [];
	let out = shield(text, spans, depth);
	for (const rule of RULES) {
		out = typeof rule === 'function' ? rule(out) : out.replace(rule[0], rule[1] as string);
	}
	return out.replace(SHIELDED, (_, n: string) => spans[Number(n)] ?? '');
}

/** The text with every credential-looking part replaced by `***`, cut to `max` characters (with an ellipsis). The input is cut first, so a huge line costs no more than a long one. */
export function redact(text: string, max = 200): string {
	// Longer than anything worth showing: the cut is at 4x so a secret that straddles `max` is still seen whole, then the result is cut.
	const cut = text.length > max * 4;
	let out = redactText(cut ? text.slice(0, max * 4) : text, 0);
	// One line: a newline in a command is how a second command hides below the first.
	out = out.replace(/\s+/g, ' ').trim();
	if (cut && out.length <= max) {
		// The cut may have left the start of a token too short for its rule, and the hiding above made room for it to show: the last word goes.
		out = (out.endsWith(HIDDEN) ? out : out.replace(/\S*$/, '').trimEnd()) + '…';
	}
	return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
