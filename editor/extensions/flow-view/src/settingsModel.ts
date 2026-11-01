/*---------------------------------------------------------------------------------------------
 *  Insilode Settings: what the settings page shows and what it may change. No `vscode` here (pure, run under plain Node
 *  by the tests): settings.ts reads the schemas from the extensions' package.json and the values from the editor.
 *
 *  The page is driven by the schemas the extensions contribute (`contributes.configuration`), so a new Insilode setting
 *  shows up on its own, under "More" until it is given a place in META below (a test fails until it is). The page only
 *  ever names a setting by its key; this module decides whether the key is one it shows and whether a value fits.
 *--------------------------------------------------------------------------------------------*/

/** One property of a `contributes.configuration` schema, as far as the page uses it. */
export interface SchemaProperty {
	type?: string | string[];
	default?: unknown;
	description?: string;
	markdownDescription?: string;
	deprecationMessage?: string;
	enum?: unknown[];
	enumDescriptions?: string[];
	minimum?: number;
	maximum?: number;
	pattern?: string;
	examples?: unknown[];
	items?: { type?: string };
	properties?: Record<string, SchemaProperty>;
}

/** How the page draws a setting. */
export type Kind = 'switch' | 'segments' | 'select' | 'number' | 'text' | 'list' | 'flags' | 'json';

export interface Category {
	id: string;
	label: string;
	blurb: string;
}

export interface FlagOption {
	key: string;
	label: string;
	description: string;
}

/** What never changes while the page is open (the theme list aside): the page builds its controls from it. */
export interface SettingSpec {
	key: string;
	category: string;
	group: string;
	title: string;
	description: string;
	kind: Kind;
	/** The editor's own setting, not Insilode's. */
	editor: boolean;
	/** Another setting that has to be on for this one to matter. */
	needs?: string;
	fallback: unknown;
	options?: { value: string; label: string; description: string }[];
	flags?: FlagOption[];
	min?: number;
	max?: number;
	step?: number;
	pattern?: string;
	examples?: string[];
}

export const CATEGORIES: Category[] = [
	{ id: 'agents', label: 'Agents', blurb: 'How Claude Code, Codex and your own agents start, run and look.' },
	{ id: 'notifications', label: 'Notifications', blurb: 'What interrupts you, and how much.' },
	{ id: 'pr', label: 'Pull requests', blurb: 'News from an agent’s pull request, sent back to the agent.' },
	{ id: 'desktop', label: 'Desktop', blurb: 'The app icon badge and the status overlay that stays above other apps.' },
	{ id: 'canvas', label: 'Canvas & flows', blurb: 'What the flow canvas and the type diagrams draw.' },
	{ id: 'integrations', label: 'Integrations', blurb: 'The tools Insilode gives agents and the hooks it listens to.' },
	{ id: 'editor', label: 'Editor', blurb: 'The editor settings people change most. Everything else is in all settings.' },
	{ id: 'more', label: 'More', blurb: 'Settings that have no place of their own yet.' },
];

/** key -> [category, group, title, needs?]. The order here is the order on the page. */
type Meta = [category: string, group: string, title: string, needs?: string];
const OVERLAY = 'flow.agents.desktop.overlay.enabled';
const AUTO_SEND = 'flow.agents.pr.autoSend';
const META: Record<string, Meta> = {
	'flow.agents.showChat': ['agents', 'Start & run', 'Offer agents in the chat panel'],
	'flow.agents.askTarget': ['agents', 'Start & run', 'Where questions go'],
	'flow.agents.worktree': ['agents', 'Start & run', 'Start agents in a git worktree'],
	'flow.agents.worktreeBase': ['agents', 'Start & run', 'Where a new worktree starts from'],
	'flow.agents.installAgentExtensions': ['agents', 'Start & run', 'Install the Claude Code and Codex extensions'],
	'flow.agents.custom': ['agents', 'Start & run', 'Your own agent commands'],
	'insilode.skeletonFirst.enabled': ['agents', 'Behaviour', 'Skeleton first'],
	'flow.agents.planBoard': ['agents', 'Behaviour', 'Draw plans as boards'],
	'flow.agents.turnImpact': ['agents', 'Behaviour', 'Show what a turn may affect'],
	'flow.agents.gaze': ['agents', 'Behaviour', 'Show where agents look'],
	'flow.agents.avatar': ['agents', 'Appearance', 'Agent avatars'],

	'flow.agents.notify.approval': ['notifications', 'Tell me when an agent', 'Waits for approval'],
	'flow.agents.notify.question': ['notifications', 'Tell me when an agent', 'Asks a question'],
	'flow.agents.notify.error': ['notifications', 'Tell me when an agent', 'Hits an error'],
	'flow.agents.notify.done': ['notifications', 'Tell me when an agent', 'Finishes a turn'],
	'flow.agents.notify.quiet': ['notifications', 'Noise', 'Quiet mode'],
	'flow.agents.notify.digestMinutes': ['notifications', 'Noise', 'Digest window'],
	'flowHarness.limitAlerts': ['notifications', 'Usage', 'Usage limit alerts'],

	'flow.agents.pr.autoSend': ['pr', 'Send news to the agent', 'Send pull request news automatically'],
	'flow.agents.pr.events': ['pr', 'Send news to the agent', 'Which events', AUTO_SEND],
	'flow.agents.pr.maxAutoSends': ['pr', 'Send news to the agent', 'Daily limit per pull request', AUTO_SEND],
	'flow.agents.pr.pollSeconds': ['pr', 'Checking', 'Check interval'],

	'flow.agents.desktop.badge': ['desktop', 'App icon', 'Badge with the agents that need you'],
	[OVERLAY]: ['desktop', 'Status overlay', 'Show the status overlay'],
	'flow.agents.desktop.overlay.position': ['desktop', 'Overlay look', 'Position', OVERLAY],
	'flow.agents.desktop.overlay.display': ['desktop', 'Overlay look', 'Screen', OVERLAY],
	'flow.agents.desktop.overlay.style': ['desktop', 'Overlay look', 'Style', OVERLAY],
	'flow.agents.desktop.overlay.size': ['desktop', 'Overlay look', 'Size', OVERLAY],
	'flow.agents.desktop.overlay.opacity': ['desktop', 'Overlay look', 'Opacity', OVERLAY],
	'flow.agents.desktop.overlay.theme': ['desktop', 'Overlay look', 'Colours', OVERLAY],
	'flow.agents.desktop.overlay.show': ['desktop', 'Overlay content', 'What it shows', OVERLAY],
	'flow.agents.desktop.overlay.autoHide': ['desktop', 'Overlay content', 'When it hides', OVERLAY],
	'flow.agents.desktop.overlay.details': ['desktop', 'Overlay content', 'Show commands and file names', OVERLAY],

	'flow.codeLens': ['canvas', 'Flows', 'Insilode link above every method'],
	'flow.showTests': ['canvas', 'Flows', 'Show test code in flows'],
	'flow.lspResolution': ['canvas', 'Flows', 'Resolve calls with the language server'],
	'flow.types.dtoSuffixes': ['canvas', 'Type diagrams', 'DTO name suffixes'],
	'flow.types.includeEntities': ['canvas', 'Type diagrams', 'Draw entities'],
	'flow.types.includeEnums': ['canvas', 'Type diagrams', 'Draw enums'],
	'flow.types.maxNodes': ['canvas', 'Type diagrams', 'Most types per diagram'],
	'flow.types.defaultCollapseLevel': ['canvas', 'Type diagrams', 'Architecture diagram: open levels'],

	'flow.agents.mcp': ['integrations', 'Tools for agents', 'The insilode tools'],
	'flow.agents.shim': ['integrations', 'Tools for agents', 'Also for a claude typed by hand'],
	'flow.ide.enabled': ['integrations', 'Tools for agents', 'Let Claude Code in a terminal connect'],
	'flow.agents.codexHooks': ['integrations', 'Hooks', 'Codex status and edits'],

	'workbench.colorTheme': ['editor', 'Appearance', 'Colour theme'],
	'window.zoomLevel': ['editor', 'Appearance', 'Window zoom'],
	'editor.fontSize': ['editor', 'Appearance', 'Font size'],
	'editor.fontFamily': ['editor', 'Appearance', 'Font family'],
	'editor.fontLigatures': ['editor', 'Appearance', 'Font ligatures'],
	'editor.lineNumbers': ['editor', 'Appearance', 'Line numbers'],
	'editor.minimap.enabled': ['editor', 'Appearance', 'Minimap'],
	'editor.tabSize': ['editor', 'Editing', 'Tab size'],
	'editor.wordWrap': ['editor', 'Editing', 'Word wrap'],
	'editor.formatOnSave': ['editor', 'Editing', 'Format on save'],
	'files.autoSave': ['editor', 'Editing', 'Auto save'],
	'files.trimTrailingWhitespace': ['editor', 'Editing', 'Trim trailing whitespace'],
	'terminal.integrated.fontSize': ['editor', 'Terminal', 'Terminal font size'],
};

/**
 * The editor settings the page offers next to Insilode's. VS Code's own schema is not readable from an extension, so the
 * few that are offered are described here; the editor says the real default and value at run time.
 */
export const EDITOR_SETTINGS: Record<string, SchemaProperty> = {
	'workbench.colorTheme': { type: 'string', description: 'The colour theme of the whole window.' },
	'window.zoomLevel': { type: 'number', default: 0, minimum: -3, maximum: 5, description: 'Zoom of the window: 0 is 100%, each step is about 20%.' },
	'editor.fontSize': { type: 'number', default: 14, minimum: 8, maximum: 40, description: 'Font size of the editor, in pixels.' },
	'editor.fontFamily': { type: 'string', default: 'Consolas, monospace', description: 'Font of the editor: a comma-separated list, the first one installed wins.' },
	'editor.fontLigatures': { type: 'boolean', default: false, description: 'Draw ligatures such as => and !== in fonts that have them.' },
	'editor.lineNumbers': { type: 'string', default: 'on', enum: ['on', 'off', 'relative'], enumDescriptions: ['Line numbers', 'No line numbers', 'Distance from the cursor line'], description: 'How line numbers are shown.' },
	'editor.minimap.enabled': { type: 'boolean', default: true, description: 'Show the small overview of the file at the right edge.' },
	'editor.tabSize': { type: 'number', default: 4, minimum: 1, maximum: 8, description: 'Spaces a tab is worth, unless the file says otherwise.' },
	'editor.wordWrap': { type: 'string', default: 'off', enum: ['off', 'on', 'wordWrapColumn', 'bounded'], enumDescriptions: ['Long lines scroll sideways', 'Wrap at the window edge', 'Wrap at the wrap column', 'Wrap at the window edge or the wrap column, whichever is smaller'], description: 'Whether long lines wrap.' },
	'editor.formatOnSave': { type: 'boolean', default: false, description: 'Format the file when you save it.' },
	'files.autoSave': { type: 'string', default: 'off', enum: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'], enumDescriptions: ['Save only when you do', 'Save after a short pause', 'Save when the editor loses focus', 'Save when the window loses focus'], description: 'When changed files are saved on their own.' },
	'files.trimTrailingWhitespace': { type: 'boolean', default: false, description: 'Remove spaces at the end of lines when you save.' },
	'terminal.integrated.fontSize': { type: 'number', default: 14, minimum: 6, maximum: 100, description: 'Font size of the terminal, in pixels.' },
};

const humanize = (key: string) => {
	const last = key.split('.').pop() ?? key;
	const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

const typesOf = (p: SchemaProperty) => (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []);
const isFlags = (p: SchemaProperty) => typesOf(p).includes('object') && !!p.properties && Object.values(p.properties).every(v => typesOf(v).includes('boolean'));

function kindOf(p: SchemaProperty): Kind {
	const types = typesOf(p);
	if (p.enum && p.enum.every(v => typeof v === 'string')) {
		return p.enum.length <= 3 && p.enum.every(v => String(v).length <= 12) ? 'segments' : 'select';
	}
	if (types.includes('boolean')) {
		return 'switch';
	}
	if (types.includes('number') || types.includes('integer')) {
		return 'number';
	}
	if (types.includes('string')) {
		return 'text';
	}
	if (types.includes('array') && (!p.items || p.items.type === 'string')) {
		return 'list';
	}
	return isFlags(p) ? 'flags' : 'json';
}

/** Short labels for the values of an enum: "top-center" stays, "wordWrapColumn" reads as words. */
const valueLabel = (v: string) => {
	const spaced = v.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** The description's first sentence-ish for an enum value: the schema writes "Name: explanation" or just the explanation. */
const describe = (p: SchemaProperty) => (p.markdownDescription ?? p.description ?? '').trim();

export function specOf(key: string, p: SchemaProperty): SettingSpec {
	const meta = META[key];
	const kind = kindOf(p);
	const spec: SettingSpec = {
		key,
		category: meta?.[0] ?? 'more',
		group: meta?.[1] ?? 'Other',
		title: meta?.[2] ?? humanize(key),
		description: describe(p),
		kind,
		editor: key in EDITOR_SETTINGS,
		needs: meta?.[3],
		fallback: p.default,
	};
	if (p.enum && (kind === 'segments' || kind === 'select')) {
		spec.options = p.enum.map((v, i) => ({ value: String(v), label: valueLabel(String(v)), description: p.enumDescriptions?.[i] ?? '' }));
	}
	if (kind === 'number') {
		spec.min = p.minimum;
		spec.max = p.maximum;
		const whole = typesOf(p).includes('integer') || [p.default, p.minimum, p.maximum].every(v => v === undefined || Number.isInteger(v));
		spec.step = whole ? 1 : 0.05;
	}
	if (kind === 'text') {
		spec.pattern = p.pattern;
		spec.examples = p.examples?.filter((e): e is string => typeof e === 'string');
	}
	if (kind === 'flags') {
		spec.flags = Object.entries(p.properties ?? {}).filter(([, v]) => !v.deprecationMessage).map(([k, v]) => ({ key: k, label: humanize(k), description: v.description ?? '' }));
	}
	return spec;
}

/**
 * The settings the page shows, in page order: the contributed ones (not the deprecated ones) and the editor's, the ones with a
 * place in META first in META's order. `contributed` is every property the Insilode extensions declare.
 */
export function buildSpecs(contributed: Record<string, SchemaProperty>): SettingSpec[] {
	const all: Record<string, SchemaProperty> = { ...EDITOR_SETTINGS };
	for (const [key, p] of Object.entries(contributed)) {
		if (!p.deprecationMessage) {
			all[key] = p;
		}
	}
	const order = Object.keys(META);
	const rank = (key: string) => { const i = order.indexOf(key); return i < 0 ? order.length : i; };
	return Object.keys(all).sort((a, b) => rank(a) - rank(b)).map(key => specOf(key, all[key]));
}

const deepEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const ka = Object.keys(a);
		return ka.length === Object.keys(b).length && ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
	}
	return false;
};
export { deepEqual };

export type Checked = { ok: true; value: unknown } | { ok: false; reason: string };
const no = (reason: string): Checked => ({ ok: false, reason });

/**
 * Whether `value`, as the page sent it, is a value the setting can have. The page is not trusted with anything: the type, the
 * range, the enum, the pattern and the keys of an object are all checked here. `current` is what the setting is now (a flags
 * object is merged into it, so a page that sends one switch cannot drop the others).
 */
export function checkValue(spec: SettingSpec, value: unknown, current: unknown): Checked {
	switch (spec.kind) {
		case 'switch':
			return typeof value === 'boolean' ? { ok: true, value } : no('not a boolean');
		case 'segments':
		case 'select':
			return typeof value === 'string' && spec.options?.some(o => o.value === value) ? { ok: true, value } : no('not one of the choices');
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return no('not a number');
			}
			if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
				return no('out of range');
			}
			return spec.step === 1 && !Number.isInteger(value) ? no('not a whole number') : { ok: true, value };
		}
		case 'text': {
			if (typeof value !== 'string' || value.length > 500) {
				return no('not text');
			}
			let fits = true;
			try {
				fits = !spec.pattern || new RegExp(spec.pattern).test(value);
			} catch {
				fits = true;
			}
			return fits ? { ok: true, value } : no('does not fit the pattern');
		}
		case 'list':
			return Array.isArray(value) && value.length <= 200 && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 100)
				? { ok: true, value: [...new Set(value as string[])] }
				: no('not a list of short texts');
		case 'flags': {
			const known = new Set(spec.flags?.map(f => f.key));
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				return no('not an object');
			}
			const entries = Object.entries(value);
			if (!entries.every(([k, v]) => known.has(k) && typeof v === 'boolean')) {
				return no('unknown switch');
			}
			const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
			return { ok: true, value: { ...base, ...Object.fromEntries(entries) } };
		}
		default:
			return no('edited in settings.json');
	}
}
