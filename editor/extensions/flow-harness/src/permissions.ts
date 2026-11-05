/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: permission inbox. Every permission an agent asked for, in one list, with what
 *  was answered; any of them can become a standing rule so it is never asked again.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { inboxState, INBOX_KEY, MAX_REQUESTS, PERMISSIONS_EMPTY, sanitizeInbox, type PermissionRequest } from './friction';
import { arrayAt, objectAt, previewAndWrite } from './settings';
import { claudeDir } from './dirs';

export type { PermissionRequest };

/**
 * Programs that run whatever they are given next (shells, interpreters, launchers, network clients), and ones whose
 * every use is destructive: `Bash(bash:*)` or `Bash(rm -rf:*)` would allow far more than the one command that was asked.
 * Those only ever get an exact rule.
 */
const EXACT_ONLY = new Set([
	'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'wsl',
	'sudo', 'su', 'doas', 'runas', 'env', 'xargs', 'nohup', 'time', 'timeout', 'watch', 'nice', 'command', 'exec', 'eval', 'source', '.', 'find',
	'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'py', 'ruby', 'perl', 'php', 'lua', 'osascript',
	'npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'telnet',
	'rm', 'rmdir', 'del', 'erase', 'mv', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'taskkill', 'shred', 'truncate', 'format',
]);
/** Package managers' subcommands that fetch and run code, and git subcommands that change history or a remote: exact only. */
const RUNNERS = new Set(['exec', 'x', 'dlx', 'create', 'init', 'run-script']);
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show']);

/** `Bash(...)` for this command: a prefix rule only where the first two words clearly bound what is allowed, else the exact command, else nothing. */
function bashRule(command: string): string | undefined {
	const text = command.trim();
	// Chained, piped, redirected or expanded commands, and characters that would turn into wildcards, get no rule.
	if (!text || /[;&|<>`$*()\r\n]/.test(text)) {
		return undefined;
	}
	const [first, second] = text.split(/\s+/);
	const program = first.replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
	const words = text.split(/\s+/).length;
	const exact = `Bash(${text})`;
	if (EXACT_ONLY.has(program) || words < 2 || second.startsWith('-') || /[\\/]/.test(second)) {
		return exact;
	}
	if (program === 'git' && !GIT_READ_ONLY.has(second)) {
		return exact;
	}
	if (/^(?:npm|pnpm|yarn|bun)$/.test(program) && RUNNERS.has(second)) {
		return exact;
	}
	return `Bash(${first} ${second}:*)`;
}

/** The project folder `file` sits in, relative to `root` and written with `/` on every platform (comparison follows the file system's case rules); undefined for a file outside the project or directly in its root, where the alternative would be a rule for everything. */
function projectDir(file: string | undefined, root: string | undefined): string | undefined {
	if (!file || !root) {
		return undefined;
	}
	const rel = path.relative(root, path.resolve(root, file));
	if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		return undefined;
	}
	const dir = path.dirname(rel);
	return dir === '.' ? undefined : dir.split(path.sep).join('/');
}

/** The Claude Code permission rule that would cover this request next time; undefined when the only rule available would be broader than the request. */
export function ruleFor(r: PermissionRequest, root: string | undefined): string | undefined {
	const input = r.rawInput ?? {};
	const command = typeof input.command === 'string' ? input.command : undefined;
	const file = r.files[0] ?? (typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : undefined);
	if (r.kind === 'execute' || command) {
		// Never built from the title: that is prose for people, not the command.
		return command ? bashRule(command) : undefined;
	}
	if (r.kind === 'edit' || r.kind === 'delete' || r.kind === 'move') {
		const dir = projectDir(file, root);
		return dir ? `Edit(${dir}/**)` : undefined;
	}
	if (r.kind === 'read' || r.kind === 'search') {
		// A bare `Read` would allow every file read.
		const dir = projectDir(file, root);
		return dir ? `Read(${dir}/**)` : undefined;
	}
	if (r.kind === 'fetch') {
		const url = typeof input.url === 'string' ? input.url : undefined;
		try {
			return url ? `WebFetch(domain:${new URL(url).hostname})` : undefined;
		} catch {
			return undefined;
		}
	}
	return /mcp__[\w-]+__[\w-]+/.exec(r.title)?.[0];
}

type Row = { type: 'req'; r: PermissionRequest } | { type: 'empty' };

export class PermissionInbox implements vscode.TreeDataProvider<Row> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	readonly requests: PermissionRequest[] = [];

	/** `state` is the workspace's storage: without one (no folder open) the inbox lives in memory only. */
	constructor(private readonly root: () => string | undefined, private readonly onRule: () => void, private readonly state?: vscode.Memento) {
		// Checked field by field: damaged data in storage must not break the view.
		this.requests.push(...sanitizeInbox(state?.get<unknown>(INBOX_KEY)));
	}

	record(r: PermissionRequest) {
		this.requests.unshift(r);
		this.requests.splice(MAX_REQUESTS);
		// Redacted and bounded on the way out: a command typed with a token in it never reaches storage.
		void this.state?.update(INBOX_KEY, inboxState(this.requests));
		this.changed.fire();
	}

	getChildren(row?: Row): Row[] {
		if (row) {
			return [];
		}
		return this.requests.length ? this.requests.map(r => ({ type: 'req', r })) : [{ type: 'empty' }];
	}

	getTreeItem(row: Row): vscode.TreeItem {
		if (row.type === 'empty') {
			const t = new vscode.TreeItem(PERMISSIONS_EMPTY);
			t.tooltip = `${PERMISSIONS_EMPTY}. One click turns a request into a rule.`;
			return t;
		}
		const r = row.r;
		const t = new vscode.TreeItem(r.title);
		const colors = { allowed: 'flowHarness.allow', auto: 'flowHarness.allow', denied: 'flowHarness.deny', cancelled: 'descriptionForeground' } as const;
		const icons = { allowed: 'pass', auto: 'pass-filled', denied: 'circle-slash', cancelled: 'circle-outline' } as const;
		t.iconPath = new vscode.ThemeIcon(icons[r.decision], new vscode.ThemeColor(colors[r.decision]));
		t.description = `${r.agent}  ${r.decision === 'auto' ? 'auto-allowed' : r.decision}  ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
		const rule = ruleFor(r, this.root());
		t.tooltip = new vscode.MarkdownString(`**${r.title}**\n\n${r.files.map(f => `\`${vscode.workspace.asRelativePath(f)}\``).join('  \n')}${rule ? `\n\nAs a rule: \`${rule}\`` : ''}`);
		t.contextValue = rule ? 'request.promotable' : 'request';
		(t as vscode.TreeItem & { req?: PermissionRequest }).req = r;
		return t;
	}

	/** Turn a request into an allow (or deny) rule in the settings file the user picks. */
	async promote(arg: unknown, effect: 'allow' | 'deny' = 'allow') {
		const r = (arg as { r?: PermissionRequest })?.r ?? (arg as { req?: PermissionRequest })?.req;
		const root = this.root();
		if (!r) {
			return;
		}
		const suggested = ruleFor(r, root);
		const rule = await vscode.window.showInputBox({
			title: effect === 'allow' ? 'Always allow' : 'Always deny',
			value: suggested,
			prompt: 'Claude Code permission rule, e.g. Bash(npm test:*), Edit(src/**), WebFetch(domain:github.com)',
		});
		if (!rule) {
			return;
		}
		const where = await vscode.window.showQuickPick([
			{ label: 'This repo, just me', detail: '.claude/settings.local.json', file: root && path.join(root, '.claude', 'settings.local.json') },
			{ label: 'This repo, shared', detail: '.claude/settings.json (committed)', file: root && path.join(root, '.claude', 'settings.json') },
			{ label: 'All my projects', detail: '~/.claude/settings.json', file: path.join(claudeDir(), 'settings.json') },
		].filter(x => x.file), { title: `Where should "${rule}" live?` });
		if (!where?.file) {
			return;
		}
		const written = await previewAndWrite(where.file, `${effect === 'allow' ? 'Allow' : 'Deny'} ${rule}`, (s: object) => {
			// A "permissions" or a list of another shape must be reported, not silently rewritten.
			const list = arrayAt<unknown>(objectAt(s, 'permissions'), effect);
			if (!list.includes(rule)) {
				list.push(rule);
			}
		});
		if (written) {
			this.onRule();
		}
	}
}
