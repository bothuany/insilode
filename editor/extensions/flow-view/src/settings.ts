/*---------------------------------------------------------------------------------------------
 *  Insilode Settings: the page that replaces a trip through VS Code's settings editor for the settings people change.
 *  It lists what the Insilode extensions contribute (their package.json `contributes.configuration`) and a few editor
 *  settings, and writes with `WorkspaceConfiguration.update`, so a change here is a change in settings.json and the other
 *  way round: the page follows `onDidChangeConfiguration`.
 *
 *  The page is a webview with a Content-Security-Policy (settingsPage.ts) that renders with textContent only. Its messages
 *  name a setting by key; a key that is not in the list built here is ignored, a value is checked against the setting's
 *  schema (settingsModel.ts), and `open` picks one of a fixed set of commands: it never carries a command id.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { CATEGORIES, buildSpecs, checkValue, deepEqual, type SchemaProperty, type SettingSpec } from './settingsModel';
import { settingsHtml } from './settingsPage';

/** What `open` may run: a fixed table, so the page names a place, never a command. */
const OPEN = new Map([
	['all', 'workbench.action.openSettings'],
	['json', 'workbench.action.openSettingsJson'],
]);
const SETTING_UI = 'workbench.action.openSettings';

interface Manifest {
	contributes?: {
		configuration?: { properties?: Record<string, SchemaProperty> } | { properties?: Record<string, SchemaProperty> }[];
		themes?: { label?: string }[];
	};
}

/** Every setting the Insilode extensions (publisher `flow`) declare. */
function contributed(): Record<string, SchemaProperty> {
	const out: Record<string, SchemaProperty> = {};
	for (const ext of vscode.extensions.all) {
		if (!ext.id.startsWith('flow.')) {
			continue;
		}
		const conf = (ext.packageJSON as Manifest).contributes?.configuration;
		for (const section of Array.isArray(conf) ? conf : conf ? [conf] : []) {
			Object.assign(out, section.properties);
		}
	}
	return out;
}

/** The colour themes every installed extension offers, by label. */
function themeLabels(): string[] {
	const labels = new Set<string>();
	for (const ext of vscode.extensions.all) {
		for (const t of (ext.packageJSON as Manifest).contributes?.themes ?? []) {
			if (typeof t.label === 'string' && t.label) {
				labels.add(t.label);
			}
		}
	}
	return [...labels].sort((a, b) => a.localeCompare(b));
}

export class FlowSettings implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private specs = new Map<string, SettingSpec>();
	private timer: NodeJS.Timeout | undefined;
	private focus: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (this.panel && [...this.specs.keys()].some(k => e.affectsConfiguration(k))) {
				clearTimeout(this.timer);
				this.timer = setTimeout(() => void this.post(), 60);
			}
		}));
	}

	dispose() {
		clearTimeout(this.timer);
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/** Opens the page, on a category (its id) or scrolled to one setting (its key). */
	async show(target?: unknown) {
		this.focus = typeof target === 'string' ? target : undefined;
		if (this.panel) {
			this.panel.reveal();
			await this.post();
			return;
		}
		const panel = this.panel = vscode.window.createWebviewPanel('flow.settings', 'Settings', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
		panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'flow.svg');
		panel.onDidDispose(() => this.panel = undefined);
		panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => vscode.window.showErrorMessage(`Insilode settings: ${(e as Error).message ?? e}`)));
		panel.webview.html = settingsHtml(randomBytes(16).toString('base64'));
	}

	/** The settings as the page lists them, with the theme list the editor has right now. */
	private load() {
		const specs = buildSpecs(contributed());
		const theme = specs.find(s => s.key === 'workbench.colorTheme');
		if (theme) {
			const now = vscode.workspace.getConfiguration().get<string>(theme.key);
			const labels = themeLabels();
			if (now && !labels.includes(now)) {
				labels.push(now);
			}
			theme.kind = 'select';
			theme.options = labels.map(l => ({ value: l, label: l, description: '' }));
		}
		this.specs = new Map(specs.map(s => [s.key, s]));
		return specs;
	}

	private async post() {
		if (!this.panel) {
			return;
		}
		const config = vscode.workspace.getConfiguration();
		const settings = this.load().map(s => {
			const i = config.inspect<unknown>(s.key);
			const workspace = i?.workspaceValue !== undefined;
			const stored = i?.workspaceValue ?? i?.globalValue;
			const fallback = i?.defaultValue ?? s.fallback;
			return { ...s, value: stored ?? fallback, modified: stored !== undefined, scope: workspace ? 'workspace' : 'user' };
		});
		await this.panel.webview.postMessage({ type: 'data', categories: CATEGORIES, settings, focus: this.focus });
		this.focus = undefined;
	}

	private async onMessage(m: { type?: unknown; key?: unknown; value?: unknown; target?: unknown }) {
		switch (m.type) {
			case 'ready': return this.post();
			case 'set': return this.set(m.key, m.value);
			case 'reset': return this.reset(m.key);
			case 'open': return this.open(m.target, m.key);
			default: return undefined;
		}
	}

	/** The setting the page named, only when it is one the page was given. */
	private spec(key: unknown): SettingSpec | undefined {
		return typeof key === 'string' ? this.specs.get(key) : undefined;
	}

	/** Where a write goes: where the setting is overridden for this workspace, else the user's settings. */
	private target(key: string) {
		return vscode.workspace.getConfiguration().inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	}

	private async set(key: unknown, value: unknown) {
		const spec = this.spec(key);
		if (!spec) {
			return;
		}
		const config = vscode.workspace.getConfiguration();
		const checked = checkValue(spec, value, config.get(spec.key));
		if (!checked.ok) {
			return;
		}
		// A value equal to the default is not written: settings.json keeps only what you changed.
		const fallback = config.inspect<unknown>(spec.key)?.defaultValue ?? spec.fallback;
		await config.update(spec.key, deepEqual(checked.value, fallback) ? undefined : checked.value, this.target(spec.key));
	}

	private async reset(key: unknown) {
		const spec = this.spec(key);
		// A json row (your own agent commands) is edited in settings.json only: one click here would delete the list.
		if (!spec || spec.kind === 'json') {
			return;
		}
		const config = vscode.workspace.getConfiguration();
		const i = config.inspect(spec.key);
		if (i?.workspaceValue !== undefined) {
			await config.update(spec.key, undefined, vscode.ConfigurationTarget.Workspace);
		}
		if (i?.globalValue !== undefined) {
			await config.update(spec.key, undefined, vscode.ConfigurationTarget.Global);
		}
	}

	private async open(target: unknown, key: unknown) {
		if (target === 'setting') {
			const spec = this.spec(key);
			return spec && vscode.commands.executeCommand(SETTING_UI, spec.key);
		}
		return typeof target === 'string' && OPEN.has(target) ? vscode.commands.executeCommand(OPEN.get(target)!) : undefined;
	}
}

