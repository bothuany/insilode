/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the MCP server manager. One page lists every server Claude Code and Codex would load
 *  for this folder (mcpconfig.ts), with where it comes from, whether it is on, how often the agents
 *  called it, and, after a "Check" click and never before, whether it starts and what its tools cost.
 *  Adding, editing, turning off and removing go through native inputs and one confirmation that
 *  shows the exact change: a diff of only the server's part of the file, or the exact CLI command.
 *
 *  The page is a webview with a Content-Security-Policy (page.ts) that renders with textContent only.
 *  It never receives a secret: env and header values stay in this host; it gets names, and for each
 *  value whether it is set or which variable it reads. Its messages name a server by id, checked
 *  against the list read here; no message runs a command or names a file.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { claudeDir, codexDir } from './dirs';
import { checkHttp, checkStdio, expandVars, parseClaudeGet, runCli, type CheckResult } from './mcpcheck';
import { maskArgs, maskText, maskUrl, publicView, readMcp, secretsOf, type McpConfig, type McpHarness, type McpServer } from './mcpconfig';
import { claudeAddArgs, claudeEntry, claudeRemoveArgs, codexAddArgs, codexEntry, codexRemoveArgs, commandLine, defOf, excerpt, findExecutable, jsonList, NAME, setCodexEnabled, setServer, splitCommandLine, targetFile, type ClaudeCliScope, type ServerDef } from './mcpedit';
import { page } from './page';
import { previewAndWriteFiles, type FileChange } from './settings';

/** What the page keeps of a check: no stderr (it may print a secret the server was given), only the outcome. */
export interface StoredCheck {
	ok: boolean;
	how: CheckResult['how'];
	status: string;
	toolCount?: number;
	tools?: string[];
	schemaTokens?: number;
	at: number;
	ms: number;
}

const CHECKS_KEY = 'flowHarness.mcpChecks';
const MASK = '••••';
const isFile = (p: string) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

export interface McpUsage {
	label: string;
	week: number;
	month: number;
	last?: number;
}

export class McpManager implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private config: McpConfig | undefined;
	private readonly busy = new Set<string>();
	private focus: string | undefined;
	/** The page posts 'ready' once its listener is up; a render before that is lost, so the focus waits for it. */
	private ready = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly state: vscode.Memento,
		private readonly root: () => string | undefined,
		private readonly usage: (toolPrefix: string) => McpUsage | undefined,
		private readonly refreshMap: () => Promise<void>,
	) { }

	dispose() {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/** The checks done so far, by server id: the map shows tool counts and schema costs from them. */
	checks(): Record<string, StoredCheck> {
		return this.state.get<Record<string, StoredCheck>>(CHECKS_KEY) ?? {};
	}

	/** Reads both agents' configs for the open folder. */
	async load(): Promise<McpConfig | undefined> {
		const root = this.root();
		if (!root) {
			return undefined;
		}
		return readMcp({
			root, home: os.homedir(), platform: process.platform, claudeDir: claudeDir(), codexDir: codexDir(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
			read: f => fs.readFile(f, 'utf8').catch(() => undefined),
			list: d => fs.readdir(d).catch(() => [] as string[]),
		});
	}

	/** Opens the page, optionally with one server scrolled to and highlighted. */
	async show(id?: string) {
		this.focus = id;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('flowHarness.mcp', 'MCP Servers', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
			this.ready = false;
			this.panel.webview.html = html();
			this.panel.onDidDispose(() => this.panel = undefined, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => void this.message(m).catch(e => void vscode.window.showErrorMessage(`MCP servers: ${(e as Error).message}`)), null, this.disposables);
		} else {
			this.panel.reveal();
		}
		await this.render();
	}

	/** After the map rescanned (a file changed on disk): the page shows the same state. */
	async changed() {
		if (this.panel) {
			await this.render();
		}
	}

	private async render() {
		if (!this.panel) {
			return;
		}
		this.config = await this.load();
		const checks = this.checks();
		const cli = { claude: !!this.claudeCli(), codex: !!this.codexCli() };
		const servers = (this.config?.servers ?? []).map(s => ({ ...publicView(s), usage: this.usage(s.toolPrefix), check: checks[s.id], busy: this.busy.has(s.id) }));
		void this.panel.webview.postMessage({
			type: 'data', servers, cli, focus: this.focus, trusted: vscode.workspace.isTrusted,
			problems: (this.config?.problems ?? []).map(p => ({ file: p.file.replace(os.homedir(), '~'), message: p.message })),
			files: this.config && { claudeJson: this.config.files.claudeJson.replace(os.homedir(), '~'), codexUser: this.config.files.codexUser.replace(os.homedir(), '~') },
		});
		if (this.ready) {
			this.focus = undefined;
		}
	}

	private server(id: unknown): McpServer | undefined {
		return typeof id === 'string' ? this.config?.servers.find(s => s.id === id) : undefined;
	}

	private async message(m: { type?: unknown; id?: unknown }) {
		// Add and edit walk through several inputs: a second click while one is open would interleave two of them.
		if ((m.type === 'add' || m.type === 'edit' || m.type === 'toggle' || m.type === 'remove') && this.flow) {
			return;
		}
		if (m.type === 'add' || m.type === 'edit' || m.type === 'toggle' || m.type === 'remove') {
			this.flow = true;
			try {
				return await this.act(m);
			} finally {
				this.flow = false;
			}
		}
		return this.act(m);
	}

	private flow = false;

	private async act(m: { type?: unknown; id?: unknown }) {
		switch (m.type) {
			case 'ready':
				this.ready = true;
				return this.render();
			case 'refresh':
				return this.render();
			case 'add':
				return this.add();
			case 'checkAll':
				return this.checkAll();
		}
		const s = this.server(m.id);
		if (!s) {
			return;
		}
		switch (m.type) {
			case 'check':
				return this.check([s]);
			case 'edit':
				return this.edit(s);
			case 'toggle':
				return this.toggle(s);
			case 'remove':
				return this.remove(s);
			case 'open':
				return this.open(s);
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Check

	/** A server's command as the confirmation shows it, secrets masked. */
	private describe(s: McpServer): string {
		return s.transport === 'stdio' ? commandLine(s.command ?? '', maskArgs(s.args)) : maskUrl(s.url ?? '');
	}

	/**
	 * Everything a check of `s` runs or sends, for the confirmation: the command with its folder and the names of the
	 * variables it is given (flagging the ones that change what runs), or the URL with the headers and the variables from
	 * your environment that go with it.
	 */
	private explain(s: McpServer): string {
		const reads = [s.url ?? '', s.command ?? '', ...s.args, ...Object.values(s.env), ...Object.values(s.headers)].flatMap(v => [...v.matchAll(/\$\{([A-Za-z_]\w*)/g)].map(m => m[1]));
		const lines = [`• ${s.name} (${s.harness}, ${s.scope}): ${this.describe(s)}`];
		if (s.transport === 'stdio') {
			lines.push(`   in ${s.cwd ?? (vscode.workspace.isTrusted ? 'this folder' : 'your home folder')}`);
			const names = Object.keys(s.env);
			const risky = names.filter(n => /^(NODE_OPTIONS|PATH|PATHEXT|PYTHONPATH|PYTHONSTARTUP|LD_\w+|DYLD_\w+|COMSPEC)$/i.test(n));
			if (names.length) {
				lines.push(`   with ${names.join(', ')}${risky.length ? ` (${risky.join(', ')} change${risky.length === 1 ? 's' : ''} what runs)` : ''}`);
			}
		} else {
			const headers = [...Object.keys(s.headers), ...Object.keys(s.envHeaders), ...(s.bearerEnv ? ['Authorization'] : [])];
			if (headers.length) {
				lines.push(`   sending ${headers.join(', ')}`);
			}
		}
		const fromEnv = [...new Set([...reads, ...Object.values(s.envHeaders), ...(s.bearerEnv ? [s.bearerEnv] : [])])];
		if (fromEnv.length) {
			lines.push(`   reading ${fromEnv.map(v => '$' + v).join(', ')} from your environment`);
		}
		return lines.join('\n');
	}

	private async checkAll() {
		const all = (this.config?.servers ?? []).filter(s => !s.shadowedBy && s.state !== 'off');
		if (!all.length) {
			return;
		}
		const ok = await vscode.window.showInformationMessage(`Check ${all.length} MCP server${all.length === 1 ? '' : 's'}?`, {
			modal: true,
			detail: `Each one is started once (or contacted over HTTP), asked for its tools, and stopped.\n\n${all.map(s => this.explain(s)).join('\n')}`,
		}, 'Check');
		if (ok === 'Check') {
			await this.check(all, true);
		}
	}

	private async check(list: McpServer[], confirmed = false) {
		const root = this.root();
		if (!root) {
			return;
		}
		// A repository's .mcp.json or .codex/config.toml names a program to run, or a URL to send headers and variables to:
		// only in a trusted folder, and only once the user saw exactly what.
		const repo = list.filter(s => s.scope === 'project');
		if (repo.length && !vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('This folder is not trusted: Insilode does not start or contact the servers its .mcp.json or .codex/config.toml names. Trust the folder first.');
			list = list.filter(s => !repo.includes(s));
		} else if (repo.length && !confirmed) {
			const ok = await vscode.window.showWarningMessage(`${repo[0].transport === 'stdio' ? 'Run' : 'Contact'} ${repo[0].name} to check it?`, { modal: true, detail: `It comes from this repository (${path.basename(repo[0].file)}), so the repository chose what runs or where it goes:\n\n${this.explain(repo[0])}\n\nIt is checked once and stopped.` }, 'Check');
			if (ok !== 'Check') {
				return;
			}
		}
		await Promise.all(list.map(async s => {
			this.busy.add(s.id);
			await this.render();
			try {
				const r = await this.run(s, root);
				// A server may echo what it was given in an error: hide the values it got from the environment too.
				const expanded = [...Object.values(s.env), ...Object.values(s.headers), ...s.args].map(v => expandVars(v, process.env));
				const fromEnv = [...Object.values(s.envHeaders), ...s.envVars, ...(s.bearerEnv ? [s.bearerEnv] : [])].map(v => process.env[v] ?? '');
				const secrets = [...secretsOf([s]), ...secretsOf([{ env: Object.fromEntries(expanded.map((v, n) => [String(n), v])), headers: {}, args: [], url: expandVars(s.url ?? '', process.env) }]), ...fromEnv.filter(v => v.length >= 4)];
				const stored: StoredCheck = { ok: r.ok, how: r.how, status: maskText(r.status, secrets).slice(0, 300), toolCount: r.tools?.length, tools: r.tools?.slice(0, 200).map(t => t.name.slice(0, 100)), schemaTokens: r.schemaTokens, at: r.at, ms: r.ms };
				await this.state.update(CHECKS_KEY, { ...this.checks(), [s.id]: stored });
			} finally {
				this.busy.delete(s.id);
			}
		}));
		await this.render();
		await this.refreshMap();
	}

	private async run(s: McpServer, root: string): Promise<CheckResult> {
		const notRun = (status: string): CheckResult => ({ ok: false, how: 'not run', status, ms: 0, at: Date.now() });
		const viaClaude = async (): Promise<CheckResult | undefined> => {
			const exe = this.claudeCli();
			// A name read from a file goes on a command line: only names the CLI takes as one (a repo's "--scope" must not become an option).
			if (!exe || s.harness !== 'Claude' || !(NAME.test(s.name) || /^plugin:[\w-]+:[\w-]+$/.test(s.name))) {
				return undefined;
			}
			const t0 = Date.now();
			const r = await runCli(exe, ['mcp', 'get', s.name], { cwd: this.cliCwd() ?? root, timeoutMs: 60_000 });
			const parsed = parseClaudeGet(r.out);
			return parsed ? { ...parsed, how: 'claude mcp get', ms: Date.now() - t0, at: Date.now() } : undefined;
		};
		if (s.transport === 'stdio') {
			if (!s.command) {
				return notRun('No command to run');
			}
			// The agent starts it in the folder; in an untrusted folder the home folder, so nothing in the folder gets to run.
			const r = await checkStdio({ command: s.command, args: s.args, env: s.env, cwd: s.cwd }, { cwd: vscode.workspace.isTrusted ? root : os.homedir(), isFile });
			// Claude Code starts a .cmd shim itself; Insilode does not start cmd.exe, so Claude Code's own check answers for it.
			return r.needsShell ? (await viaClaude()) ?? { ...r, status: `${r.status}: check it from ${s.harness === 'Codex' ? 'Codex' : 'Claude Code'}` } : r;
		}
		if (s.transport === 'http') {
			const headers = { ...s.headers };
			for (const [h, v] of Object.entries(s.envHeaders)) {
				if (process.env[v]) {
					headers[h] = process.env[v]!;
				}
			}
			if (s.bearerEnv && process.env[s.bearerEnv]) {
				headers.Authorization = `Bearer ${process.env[s.bearerEnv]}`;
			}
			const r = await checkHttp({ url: s.url ?? '', headers });
			// Claude Code keeps the OAuth sign-in for a server itself: its own health check says whether that works.
			return r.needsAuth ? (await viaClaude()) ?? r : r;
		}
		return (await viaClaude()) ?? notRun(s.harness === 'Claude' ? `${s.transport.toUpperCase()} servers are checked with \`claude mcp get\`, and Claude Code was not found on PATH` : 'Codex has no such transport');
	}

	// ---------------------------------------------------------------------------------------------
	// Add, edit, on/off, remove

	private claudeCli = () => findExecutable('claude', process.env, process.platform, isFile);
	private codexCli = () => findExecutable('codex', process.env, process.platform, isFile);

	private async add() {
		const c = this.config ?? await this.load();
		const root = this.root();
		if (!c || !root) {
			return;
		}
		const harness = await vscode.window.showQuickPick([
			{ label: 'Claude Code', h: ['Claude'] as McpHarness[] },
			{ label: 'Codex', h: ['Codex'] as McpHarness[] },
			{ label: 'Both', description: 'the same server for Claude Code and Codex', h: ['Claude', 'Codex'] as McpHarness[] },
		], { ignoreFocusOut: true, title: 'Add an MCP server: for which agent?' });
		if (!harness) {
			return;
		}
		const both = harness.h.length > 1;
		const scopes = [
			{ label: 'User', scope: 'user' as const, description: both ? 'every project: ~/.claude.json and ~/.codex/config.toml' : harness.h[0] === 'Claude' ? 'every project: .claude.json' : 'every project: config.toml' },
			{ label: 'Project', scope: 'project' as const, description: both ? 'shared with the repository: .mcp.json and .codex/config.toml' : harness.h[0] === 'Claude' ? 'shared with the repository: .mcp.json' : 'this repository: .codex/config.toml (trusted projects)' },
			...(harness.h.includes('Codex') ? [] : [{ label: 'Local', scope: 'local' as const, description: 'this folder only, private to you: .claude.json' }]),
		];
		const scope = await vscode.window.showQuickPick(scopes, { ignoreFocusOut: true, title: 'Add an MCP server: where?' });
		if (!scope) {
			return;
		}
		const taken = (n: string) => c.servers.some(s => s.name === n && harness.h.includes(s.harness) && s.scope === scope.scope);
		const name = await vscode.window.showInputBox({ ignoreFocusOut: true,
			title: 'Add an MCP server: name', prompt: 'Letters, digits, - and _ (the agents name its tools mcp__<name>__…)',
			validateInput: v => !NAME.test(v) ? 'Use letters, digits, - and _ only' : taken(v) ? `There is a ${scope.label.toLowerCase()} server called ${v} already: edit that one` : undefined,
		});
		if (!name) {
			return;
		}
		const transport = await vscode.window.showQuickPick([
			{ label: 'stdio', description: 'a program the agent starts', t: 'stdio' as const },
			{ label: 'HTTP', description: 'a URL (streamable HTTP)', t: 'http' as const },
			...(both || harness.h[0] === 'Codex' ? [] : [{ label: 'SSE', description: 'a URL (deprecated SSE transport)', t: 'sse' as const }]),
		], { ignoreFocusOut: true, title: `Add ${name}: how does the agent reach it?` });
		if (!transport) {
			return;
		}
		const def: ServerDef = { transport: transport.t, env: {}, headers: {} };
		if (!await this.askTarget(def, name)) {
			return;
		}
		if (!await this.editVars(def, transport.t === 'stdio' ? 'env' : 'headers', name)) {
			return;
		}
		await this.write(harness.h.map(h => ({ harness: h, scope: scope.scope, name, def })), `Add MCP server ${name}`, 'Add');
	}

	/** Asks for the command and arguments, or the URL. Typed secrets in arguments are kept, and masked wherever they are shown. */
	private async askTarget(def: ServerDef, name: string, old?: McpServer): Promise<boolean> {
		if (def.transport === 'stdio') {
			const masked = old ? maskArgs(old.args) : [];
			const hidden = masked.some((a, n) => a !== old!.args[n]);
			const line = await vscode.window.showInputBox({ ignoreFocusOut: true,
				title: `${name}: command and arguments`, prompt: hidden ? `Arguments shown as ${MASK} keep their value unless you change them` : 'For example: npx -y @modelcontextprotocol/server-filesystem .',
				value: old ? commandLine(old.command ?? '', masked) : '',
				validateInput: v => splitCommandLine(v).length ? undefined : 'Type the program to run',
			});
			if (line === undefined) {
				return false;
			}
			let [command, ...args] = splitCommandLine(line);
			// The arguments that were shown masked, in order, take their old values back.
			const secrets = old ? old.args.filter((a, n) => masked[n] !== a) : [];
			args = args.map(a => a === MASK ? secrets.shift() ?? a : a.includes(MASK) && secrets.length ? a.replace(MASK, secrets.shift()!.replace(/^--?[\w-]+=/, '')) : a);
			def.command = command;
			def.args = args;
			return true;
		}
		const hidden = !!old?.url && maskUrl(old.url) !== old.url;
		const url = await vscode.window.showInputBox({
			title: `${name}: URL`, prompt: hidden ? 'The old URL holds a secret, so it is not shown: type the whole URL again' : 'For example: https://mcp.example.com/mcp',
			value: hidden ? '' : old?.url ?? '', ignoreFocusOut: true,
			validateInput: v => {
				try {
					return /^https?:$/.test(new URL(v.replace(/\$\{[^}]+\}/g, 'x')).protocol) ? undefined : 'An http:// or https:// URL';
				} catch {
					return 'An http:// or https:// URL';
				}
			},
		});
		if (url === undefined) {
			return false;
		}
		def.url = url;
		return true;
	}

	/** Names and values of environment variables or headers. Values are typed into a password box and never shown again. */
	private async editVars(def: ServerDef, kind: 'env' | 'headers', name: string): Promise<boolean> {
		const map = def[kind] ??= {};
		const noun = kind === 'env' ? 'environment variable' : 'header';
		const aNoun = kind === 'env' ? 'an environment variable' : 'a header';
		for (; ;) {
			const items: (vscode.QuickPickItem & { act: 'done' | 'add' | 'item'; key?: string })[] = [
				{ label: '$(check) Done', act: 'done' },
				{ label: `$(add) Add ${aNoun}…`, act: 'add' },
				...Object.entries(map).map(([k, v]) => ({ label: k, description: /^\$\{([^}:]+)/.exec(v)?.[1] ? `from $${/^\$\{([^}:]+)/.exec(v)![1]}` : v ? 'set (hidden)' : 'empty', act: 'item' as const, key: k })),
			];
			const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title: `${name}: ${noun}s (${Object.keys(map).length})`, placeHolder: Object.keys(map).length ? 'Pick one to change or remove it' : `Add one, or Done if it needs none` });
			if (!pick) {
				return false;
			}
			if (pick.act === 'done') {
				return true;
			}
			let key = pick.key;
			if (pick.act === 'add') {
				key = await vscode.window.showInputBox({ ignoreFocusOut: true,
					title: `${name}: ${noun} name`, prompt: kind === 'env' ? 'For example: API_KEY' : 'For example: Authorization',
					validateInput: v => !(kind === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9-]+$/).test(v) ? `Not a valid ${noun} name` : v in map ? 'Already there: pick it in the list to change it' : undefined,
				});
				if (!key) {
					continue;
				}
			} else {
				const what = await vscode.window.showQuickPick([{ label: 'Change the value…', a: 'set' }, { label: `Remove ${key}`, a: 'remove' }], { ignoreFocusOut: true, title: `${name}: ${key}` });
				if (what?.a === 'remove') {
					delete map[key!];
				}
				if (what?.a !== 'set') {
					continue;
				}
			}
			const value = await vscode.window.showInputBox({
				title: `${name}: value of ${key}`, password: true, ignoreFocusOut: true,
				prompt: `Hidden as you type and never shown again. \${VAR} reads it from the agent's environment instead of writing it into the file${kind === 'headers' ? ' (Codex: written as a static header)' : ''}.`,
			});
			if (value !== undefined) {
				map[key!] = value;
			}
		}
	}

	private async edit(s: McpServer) {
		if (s.readOnly) {
			void vscode.window.showInformationMessage(`${s.name}: ${s.readOnly}.`);
			return;
		}
		const def = defOf(s);
		for (; ;) {
			const kind = def.transport === 'stdio' ? 'env' : 'headers';
			const vars = Object.keys(def[kind] ?? {});
			const pick = await vscode.window.showQuickPick([
				{ label: '$(save) Save…', a: 'save' },
				def.transport === 'stdio'
					? { label: 'Command and arguments', description: commandLine(def.command ?? '', maskArgs(def.args ?? [])), a: 'target' }
					: { label: 'URL', description: maskUrl(def.url ?? ''), a: 'target' },
				{ label: kind === 'env' ? 'Environment variables' : 'Headers', description: vars.length ? vars.join(', ') : 'none', a: 'vars' },
			], { ignoreFocusOut: true, title: `Edit ${s.name} (${s.harness}, ${s.scope})`, placeHolder: 'Pick what to change, then Save' });
			if (!pick) {
				return;
			}
			if (pick.a === 'save') {
				break;
			}
			if (pick.a === 'target') {
				const cur = { ...s, command: def.command, args: def.args ?? [], url: def.url } as McpServer;
				await this.askTarget(def, s.name, cur);
			} else {
				await this.editVars(def, kind, s.name);
			}
		}
		const entry = s.harness === 'Claude' ? claudeEntry(def, s.raw) : codexEntry(def, s.raw);
		await this.files(`Edit MCP server ${s.name}`, [{ file: s.file, format: s.format, paths: [s.keyPath], change: t => setServer(t, s.format, s.keyPath, entry) }], [def], 'Save');
	}

	private async toggle(s: McpServer) {
		const c = this.config;
		if (!c) {
			return;
		}
		if (s.readOnly) {
			void vscode.window.showInformationMessage(`${s.name}: ${s.readOnly}.`);
			return;
		}
		const on = s.state === 'off';
		const verb = on ? 'Turn on' : 'Turn off';
		if (s.harness === 'Codex') {
			await this.files(`${verb} ${s.name}`, [{ file: s.file, format: 'toml', paths: [s.keyPath], change: t => setCodexEnabled(t, s.keyPath, on) }], [], verb);
			return;
		}
		if (s.scope === 'project') {
			// Off: rejected in your own settings.local.json (any rejection wins). On: every rejection goes, and the approval is yours.
			const local = c.files.settings.local;
			const changes: Change[] = [{ file: local, format: 'json', paths: [['enabledMcpjsonServers'], ['disabledMcpjsonServers']], change: t => jsonList(jsonList(t, ['disabledMcpjsonServers'], s.name, !on), ['enabledMcpjsonServers'], s.name, on) }];
			if (on) {
				for (const f of [c.files.settings.project, c.files.settings.user]) {
					changes.push({ file: f, format: 'json', paths: [['disabledMcpjsonServers']], change: t => t.trim() ? jsonList(t, ['disabledMcpjsonServers'], s.name, false) : t });
				}
				changes.push({ file: c.files.claudeJson, format: 'json', paths: [['projects', c.projectKey, 'disabledMcpjsonServers']], change: t => t.trim() ? jsonList(t, ['projects', c.projectKey, 'disabledMcpjsonServers'], s.name, false) : t });
			}
			await this.files(`${verb} ${s.name} in this folder`, changes, [], verb);
			return;
		}
		const list = ['projects', c.projectKey, 'disabledMcpServers'];
		await this.files(`${verb} ${s.name} in this folder`, [{ file: c.files.claudeJson, format: 'json', paths: [list], change: t => jsonList(t, list, s.name, !on) }], [], verb);
	}

	private async remove(s: McpServer) {
		if (s.readOnly) {
			void vscode.window.showInformationMessage(`${s.name}: ${s.readOnly}.`);
			return;
		}
		// A local server filed under another spelling of this folder is out of the CLI's reach from here: edit the file.
		const otherKey = s.scope === 'local' && s.keyPath[1] !== this.config?.projectKey;
		const cli = otherKey || !NAME.test(s.name) ? undefined : s.harness === 'Claude' ? this.claudeCli() : s.scope === 'user' ? this.codexCli() : undefined;
		if (cli && s.scope !== 'profile') {
			const args = s.harness === 'Claude' ? claudeRemoveArgs(s.name, s.scope as ClaudeCliScope) : codexRemoveArgs(s.name);
			await this.cli([{ program: cli, args, shown: commandLine(path.basename(cli, '.exe'), args) }], `Remove MCP server ${s.name}?`, `From ${s.file.replace(os.homedir(), '~')} (${s.scope}).`, 'Remove');
			return;
		}
		await this.files(`Remove MCP server ${s.name}`, [{ file: s.file, format: s.format, paths: [s.keyPath], change: t => setServer(t, s.format, s.keyPath, undefined) }], [], 'Remove');
	}

	/** New servers: through the agent's CLI where one starts without a shell and can say it all, else by editing the file. */
	private async write(targets: { harness: McpHarness; scope: 'user' | 'project' | 'local'; name: string; def: ServerDef }[], title: string, button: string) {
		const c = this.config!;
		const runs: { program: string; args: string[]; shown: string }[] = [];
		const changes: Change[] = [];
		for (const t of targets) {
			const claude = t.harness === 'Claude' ? this.claudeCli() : undefined;
			const codex = t.harness === 'Codex' && t.scope === 'user' ? this.codexCli() : undefined;
			const codexArgs = codex ? codexAddArgs(t.name, t.def) : undefined;
			// What the dialog shows is built from a masked copy, so no secret depends on being found again inside the quoted JSON.
			const shownDef = masked(t.def);
			if (claude) {
				runs.push({ program: claude, args: claudeAddArgs(t.name, t.def, t.scope), shown: commandLine('claude', claudeAddArgs(t.name, shownDef, t.scope)) });
			} else if (codex && codexArgs) {
				runs.push({ program: codex, args: codexArgs, shown: commandLine('codex', codexAddArgs(t.name, shownDef) ?? []) });
			} else {
				const target = targetFile(t.harness, t.scope, c.files, c.projectKey);
				const keyPath = [...target.keyPath, t.name];
				const entry = t.harness === 'Claude' ? claudeEntry(t.def) : codexEntry(t.def);
				changes.push({ file: target.file, format: target.format, paths: [keyPath], change: text => setServer(text, target.format, keyPath, entry) });
			}
		}
		const defs = targets.map(t => t.def);
		if (changes.length && !await this.files(title, changes, defs, button)) {
			return;
		}
		if (runs.length) {
			await this.cli(runs, `${title}?`, '', button, defs);
		}
	}

	/** Runs CLI commands after one confirmation that shows them exactly, with typed secrets masked; never logs a value. */
	private async cli(runs: { program: string; args: string[]; shown: string }[], question: string, intro: string, button: string, defs: ServerDef[] = []): Promise<boolean> {
		const root = this.cliCwd();
		if (!root) {
			return false;
		}
		const secrets = secretsOf([...(this.config?.servers ?? []), ...defs.map(d => ({ env: d.env ?? {}, headers: d.headers ?? {}, args: d.args ?? [] }))]);
		const ok = await vscode.window.showInformationMessage(question, { modal: true, detail: `${intro ? `${intro}\n\n` : ''}This runs:\n\n${runs.map(r => maskText(r.shown, secrets)).join('\n\n')}\n\nin ${root}. Secrets are shown as ${MASK}; the command gets the real values.` }, button);
		if (ok !== button) {
			return false;
		}
		for (const r of runs) {
			const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: maskText(r.shown, secrets).slice(0, 120) }, () => runCli(r.program, r.args, { cwd: root, timeoutMs: 60_000 }));
			if (out.code !== 0) {
				void vscode.window.showErrorMessage(`${path.basename(r.program)} failed${out.timedOut ? ' (timed out)' : ''}: ${maskText(out.out, secrets).slice(0, 400)}`);
				await this.after();
				return false;
			}
		}
		vscode.window.setStatusBarMessage(`$(check) ${question.replace(/\?$/, '')}: done`, 4000);
		await this.after();
		return true;
	}

	/** File edits after the preview: the diff shows only the server's part of each file, with every secret masked. */
	private async files(title: string, changes: Change[], defs: ServerDef[], button: string): Promise<boolean> {
		const secrets = secretsOf([...(this.config?.servers ?? []), ...defs.map(d => ({ env: d.env ?? {}, headers: d.headers ?? {}, args: d.args ?? [] }))]);
		const wrapped: FileChange[] = changes.map(ch => ({
			file: ch.file,
			change: text => {
				try {
					return ch.change(text);
				} catch (e) {
					void vscode.window.showErrorMessage(`${path.basename(ch.file)}: ${(e as Error).message}. Nothing was changed.`);
					return undefined;
				}
			},
			show: (before, after) => ({ before: maskText(excerpt(before, ch.format, ch.paths), secrets), after: maskText(excerpt(after, ch.format, ch.paths), secrets) }),
		}));
		const written = await previewAndWriteFiles(title, wrapped, button);
		if (written) {
			await this.after();
		}
		return written;
	}

	/**
	 * Where the CLI runs: the folder spelled as .claude.json already knows it. Claude Code files local and project state
	 * under its working directory exactly as given, and VS Code spells the drive "c:" where a terminal says "C:", so
	 * running from the editor's spelling would start a second entry for the same folder.
	 */
	private cliCwd(): string | undefined {
		const root = this.root();
		const key = this.config?.projectKey;
		if (!root || process.platform !== 'win32') {
			return root;
		}
		const win = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '');
		return key && win(key).toLowerCase() === win(root).toLowerCase() ? win(key) : root.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
	}

	private async after() {
		await this.refreshMap();
		await this.render();
	}

	/** Opens the file at the server's entry. */
	private async open(s: McpServer) {
		let line = 0;
		const text = await fs.readFile(s.file, 'utf8').catch(() => '');
		if (s.format === 'json') {
			const node = findNodeAtLocation(parseTree(text) ?? { type: 'null', offset: 0, length: 0 }, s.keyPath);
			line = node ? text.slice(0, node.parent?.offset ?? node.offset).split('\n').length - 1 : 0;
		} else {
			const header = s.keyPath.map(k => /^[\w-]+$/.test(k) ? k : JSON.stringify(k)).join('.');
			line = Math.max(0, text.split(/\r?\n/).findIndex(l => l.trim() === `[${header}]`));
		}
		await vscode.window.showTextDocument(vscode.Uri.file(s.file), { selection: new vscode.Range(line, 0, line, 0), preview: true });
	}
}

/** A definition with every literal env and header value, secret-looking argument and URL secret replaced by the mask. */
function masked(def: ServerDef): ServerDef {
	const hide = (m?: Record<string, string>) => m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, /^\$\{[^}]+\}$/.test(v.trim()) ? v : MASK]));
	return { ...def, env: hide(def.env), headers: hide(def.headers), args: def.args && maskArgs(def.args), url: def.url && maskUrl(def.url) };
}

interface Change {
	file: string;
	format: 'json' | 'toml';
	/** What the preview shows of the file. */
	paths: string[][];
	change: (text: string) => string;
}

function html(): string {
	return page('MCP Servers', `
<div class="head"><h1 class="who">MCP servers</h1>
<div class="actions"><button id="add" class="primary">Add server…</button><button id="checkAll">Check all</button><button id="refresh">Refresh</button></div></div>
<p class="sub">Every server Claude Code and Codex load for this folder, with where it is written. Check starts one once (or contacts its URL), lists its tools and stops it; nothing runs until you click.</p>
<div id="problems"></div>
<div id="list"></div>`, SCRIPT, STYLE);
}

const STYLE = `
.srv { scroll-margin: 40px; }
.srv.focus { outline: 1px solid var(--accent); }
.srv.shadowed { opacity: .65; }
.name { font-weight: 600; margin-right: 4px; }
.chip { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--line); margin-right: 4px; white-space: nowrap; }
.on { color: var(--allow); } .off { color: var(--deny); } .pending { color: var(--ask); }
/* A title and its buttons: in a narrow panel the buttons wrap onto a line of their own under the title instead of squeezing it (and, as inline buttons taller than the line, drawing over it). */
.head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 10px; }
.head .who { flex: 1 1 12em; min-width: 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 4px; }
.kv { margin: 4px 0 0; overflow-wrap: anywhere; }
.kv span + span::before { content: ' · '; color: var(--muted); }
.issue { font-size: 12px; margin-top: 4px; }
.issue.error { color: var(--deny); } .issue.warning { color: var(--ask); } .issue.info { color: var(--muted); }
.status { margin-top: 4px; font-size: 12px; }
.tools { color: var(--muted); font-size: 12px; margin-top: 2px; }
`;

const SCRIPT = /* js */ `
const post = (type, id) => vscode.postMessage({ type, id });
const seen = new Map();
document.getElementById('add').onclick = () => post('add');
document.getElementById('checkAll').onclick = () => post('checkAll');
document.getElementById('refresh').onclick = () => post('refresh');
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
const SCOPE = { user: 'user', local: 'local', project: 'project', plugin: 'plugin', managed: 'managed', profile: 'profile' };
function vars(list, noun) {
	if (!list.length) return null;
	return el('span', {}, noun + ': ', list.flatMap((v, i) => [i ? ', ' : '', el('span', { class: 'mono' }, v.name), v.from ? el('span', { class: 'muted' }, ' ← $' + v.from) : v.set ? el('span', { class: 'muted' }, ' (set)') : el('span', { class: 'muted' }, ' (empty)')]));
}
function row(s, cli, trusted) {
	const target = s.transport === 'stdio' ? [s.command || '', ...s.args].join(' ') : s.url || '';
	const c = s.check;
	const canEdit = !s.readOnly;
	const runsRepoCode = s.scope === 'project';
	return el('div', { class: 'card srv' + (s.shadowed ? ' shadowed' : ''), id: 's-' + s.id },
		el('div', { class: 'head' },
			el('div', { class: 'who' },
				el('span', { class: 'name' }, s.name),
				el('span', { class: 'chip' }, SCOPE[s.scope] + (s.profile ? ' ' + s.profile : '')),
				el('span', { class: 'chip' }, s.transport),
				el('span', { class: 'chip ' + s.state, title: s.stateWhy }, s.state === 'pending' ? 'awaiting approval' : s.state)),
			el('div', { class: 'actions' },
				el('button', { 'data-k': s.id + ':check', 'aria-label': (s.busy ? 'Checking ' : 'Check ') + s.name, onclick: () => post('check', s.id), disabled: s.busy || (runsRepoCode && !trusted), title: runsRepoCode && !trusted ? "Trust the folder to check the repository's servers" : 'Start it once (or contact its URL) and list its tools' }, s.busy ? 'Checking…' : 'Check'),
				canEdit ? el('button', { 'data-k': s.id + ':edit', 'aria-label': 'Edit ' + s.name, onclick: () => post('edit', s.id) }, 'Edit…') : null,
				canEdit ? el('button', { 'data-k': s.id + ':toggle', 'aria-label': (s.state === 'off' ? 'Turn on ' : 'Turn off ') + s.name, onclick: () => post('toggle', s.id) }, s.state === 'off' ? 'Turn on…' : 'Turn off…') : null,
				canEdit ? el('button', { 'data-k': s.id + ':remove', 'aria-label': 'Remove ' + s.name, onclick: () => post('remove', s.id) }, 'Remove…') : null,
				el('button', { 'data-k': s.id + ':open', 'aria-label': 'Open the file of ' + s.name, onclick: () => post('open', s.id), title: s.file }, 'Open'))),
		el('div', { class: 'mono kv' }, target),
		el('div', { class: 'kv muted' },
			el('span', {}, s.stateWhy),
			vars(s.env, 'env'), vars(s.headers, 'headers'),
			s.envVars.length ? el('span', {}, 'passes ' + s.envVars.join(', ')) : null,
			s.bearerEnv ? el('span', {}, 'bearer ← $' + s.bearerEnv) : null,
			s.usage ? el('span', { title: s.usage.week + ' this week, ' + s.usage.month + ' in 30 days' }, s.usage.label + (s.usage.last ? ', last ' + ago(s.usage.last) : '')) : null,
			el('span', { title: s.file }, s.file.split(/[\\\\/]/).slice(-2).join('/'))),
		s.readOnly ? el('div', { class: 'issue info' }, s.readOnly) : null,
		...s.issues.map(i => el('div', { class: 'issue ' + i.severity }, i.message)),
		c ? el('div', { class: 'status ' + (c.ok ? 'on' : 'off') },
			(c.ok ? '✓ ' : '✗ ') + c.status,
			el('span', { class: 'muted' }, ' · ' + (c.how === 'handshake' ? 'Insilode handshake' : c.how) + ', ' + ago(c.at) + (c.ms ? ', ' + (c.ms / 1000).toFixed(1) + ' s' : ''))) : null,
		c && c.tools && c.tools.length ? el('div', { class: 'tools mono' }, c.tools.slice(0, 40).join(', ') + (c.tools.length > 40 ? ' …' : '')) : null);
}
window.addEventListener('message', e => {
	const d = e.data;
	if (d.type !== 'data') return;
	// The rows are drawn again on every update, so the button that had focus is a new element: put focus back on its twin (by server and action).
	const had = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : undefined;
	const probs = document.getElementById('problems');
	probs.replaceChildren(...d.problems.map(p => el('div', { class: 'card issue error' }, p.file + ': ' + p.message)));
	const list = document.getElementById('list');
	const groups = [['Claude', 'Claude Code', d.cli.claude ? 'claude CLI found: adds and removes go through it' : 'claude CLI not found: changes edit the files'], ['Codex', 'Codex', d.cli.codex ? 'codex CLI found: user-scope adds and removes go through it' : 'codex CLI not startable without a shell here: changes edit config.toml']];
	list.replaceChildren(...groups.map(([h, title, note]) => {
		const rows = d.servers.filter(s => s.harness === h);
		return el('div', {}, el('h2', {}, title + ' (' + rows.length + ')'), el('p', { class: 'sub' }, note),
			rows.length ? rows.map(s => row(s, d.cli, d.trusted)) : el('p', { class: 'muted' }, 'None configured.'));
	}));
	if (had) { const again = [...document.querySelectorAll('[data-k]')].find(b => b.dataset.k === had); if (again && !again.disabled) again.focus(); }
	// A check that finished since the last update is said once (never the whole list on the first draw).
	for (const s of d.servers) {
		const at = s.check ? s.check.at : 0;
		if (seen.has(s.id) && at && at !== seen.get(s.id)) announce(s.name + ': ' + (s.check.ok ? 'passed' : 'failed') + '. ' + s.check.status);
		seen.set(s.id, at);
	}
	if (d.focus) {
		const n = document.getElementById('s-' + d.focus);
		if (n) { n.classList.add('focus'); n.scrollIntoView({ block: 'center' }); }
	}
});
post('ready');
`;
