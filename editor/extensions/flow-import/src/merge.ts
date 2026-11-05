/*---------------------------------------------------------------------------------------------
 *  Merging another editor's settings, keyboard shortcuts and snippets into Insilode's, text in and text out. The rule
 *  everywhere is "merge, don't clobber": what the user already set in Insilode stays, the import only adds what is
 *  missing, and the files keep their comments and layout (edits go through jsonc-parser's `modify`).
 *
 *  No `vscode` and no file system: tested on its own (test/merge.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

/**
 * Keys that belong to Insilode or to the user's Insilode setup and are never taken from another editor: Insilode's own
 * settings, and the ones about Microsoft services (telemetry, Settings Sync and Cloud Changes, which need a Microsoft or
 * GitHub account Insilode does not use, experiments, the natural-language settings search, the update service).
 */
const PROTECTED = [/^flow\./, /^flowHarness\./, /^flow-agent\./, /^insilode\./, /^axle\./];
const DENIED = [
	/^telemetry\./,
	/^settingsSync\./,
	/^sync\./,
	/^workbench\.cloudChanges\./,
	/^workbench\.experimental\.cloudChanges\./,
	/^workbench\.enableExperiments$/,
	/^workbench\.settings\.enableNaturalLanguageSearch$/,
	/^update\./,
	/^extensions\.gallery\./,
	/^microsoft-authentication\./,
	/^remote\.tunnels\.access\./,
];

/** The colour and icon theme settings: imported only when the theme is chosen, and a theme only when it is installed. */
export const THEME_KEYS = [
	'workbench.colorTheme',
	'workbench.preferredDarkColorTheme',
	'workbench.preferredLightColorTheme',
	'workbench.preferredHighContrastColorTheme',
	'workbench.preferredHighContrastLightColorTheme',
	'workbench.iconTheme',
	'workbench.productIconTheme',
	'workbench.colorCustomizations',
	'editor.tokenColorCustomizations',
	'editor.semanticTokenColorCustomizations',
];
const THEME_SET = new Set(THEME_KEYS);

export type ThemeKind = 'color' | 'icon' | 'product';
/** Which kind of theme a setting names; the customization keys name none. */
export function themeKind(key: string): ThemeKind | undefined {
	return key === 'workbench.iconTheme' ? 'icon' : key === 'workbench.productIconTheme' ? 'product' : /colorTheme$/i.test(key) ? 'color' : undefined;
}

const LANGUAGE_BLOCK = /^\[.+\]$/;

/** A setting the import does not write on its own: it is listed, and written only when the user picks it. */
export interface HeldBack {
	/** The setting's name; inside a language block `[python].python.formatting.path`. */
	key: string;
	path: string[];
	value: unknown;
	reason: string;
}

/**
 * The hold-back rules, in one table. A setting that makes the editor run a program (a shell, a formatter, a git binary)
 * or that loosens a security boundary would turn a copied settings file into code that runs at the next start, so it is
 * held back and the user decides. First matching rule wins; `reason` is what the review list shows.
 *
 * A key ending in `.path` is held as an executable path, except the names in NOT_EXECUTABLE_PATH: `search.path` is a
 * folder to search, not a program. Values are looked at only for a string that names a script or program
 * (`.exe .sh .cmd .bat .ps1`), and not for keys a user would set to such a file name for another reason.
 */
const NOT_EXECUTABLE_PATH = new Set(['search.path']);
const VALUE_ALLOWLIST = new Set(['workbench.colorTheme', 'workbench.iconTheme', 'workbench.productIconTheme', 'editor.fontFamily', 'files.defaultLanguage']);
const SCRIPT_FILE = /\.(exe|sh|cmd|bat|ps1)$/i;
const looksLikePath = (v: unknown) => typeof v === 'string' && (/[\\/]/.test(v) || SCRIPT_FILE.test(v));

export const HELD_BACK_RULES: readonly { reason: string; test: (key: string, value: unknown) => boolean }[] = [
	{ reason: 'security setting', test: key => /^security\./.test(key) },
	{ reason: 'terminal shell path', test: key => /^terminal\.integrated\.(shell|shellArgs|automationShell|automationProfile)\.(windows|osx|linux)$/.test(key) },
	{ reason: 'terminal profiles run programs', test: key => /^terminal\.integrated\.profiles\./.test(key) },
	{ reason: 'default terminal profile with a path', test: (key, value) => /^terminal\.integrated\.defaultProfile\./.test(key) && looksLikePath(value) },
	{ reason: 'path to a program', test: key => key === 'git.path' || (/\.(path|executablePath)$/.test(key) && !NOT_EXECUTABLE_PATH.has(key)) },
	{ reason: 'command that is run', test: key => /\.(command|commandPath)$/.test(key) },
	{ reason: 'names a script or program', test: (key, value) => typeof value === 'string' && SCRIPT_FILE.test(value) && !VALUE_ALLOWLIST.has(key) },
];

/** Why a setting is held back, or undefined when it is imported as usual. */
export function heldBackReason(key: string, value: unknown): string | undefined {
	return HELD_BACK_RULES.find(r => r.test(key, value))?.reason;
}

/** Whether the import holds a setting back instead of writing it (the rules are HELD_BACK_RULES). */
export function isHeldBack(key: string, value: unknown): boolean {
	return heldBackReason(key, value) !== undefined;
}

/**
 * The settings to write for a review: the held back ones whose keys were checked, and nothing else. A key the user has
 * in Insilode now is never overwritten, even when it was checked.
 */
export function heldToImport(held: readonly HeldBack[], selectedKeys: Iterable<string>, current?: string): { path: string[]; value: unknown }[] {
	const chosen = new Set(selectedKeys);
	const mine = parseObject(current);
	return held.filter(h => chosen.has(h.key) && !hasPath(mine, h.path)).map(h => ({ path: h.path, value: h.value }));
}

function hasPath(obj: Record<string, unknown>, path: string[]): boolean {
	let at: unknown = obj;
	for (const p of path) {
		if (!isObject(at) || !(p in at)) {
			return false;
		}
		at = at[p];
	}
	return true;
}

export interface SettingsPlan {
	/** Settings to add, in the order of the imported file. A language block (`[python]`) may be added part by part. */
	add: { path: string[]; value: unknown }[];
	/** Theme settings, kept apart: the host applies them only when the theme item is chosen and the theme exists. */
	theme: { key: string; value: unknown }[];
	/** Keys the user has already set in Insilode (their value stays). */
	kept: string[];
	/** Keys that are Insilode's own or about Microsoft services. */
	skipped: string[];
	/** Settings held back (see HELD_BACK_RULES): not in `add`, written only after the user picks them. */
	held: HeldBack[];
}

export function parseObject(text: string | undefined): Record<string, unknown> {
	if (!text) {
		return {};
	}
	const errors: ParseError[] = [];
	const v = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
	return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** Whether a settings file sets anything at all (a file with only comments or `{}` does not). */
export function hasSettings(text: string | undefined): boolean {
	return Object.keys(parseObject(text)).length > 0;
}

const isSkipped = (key: string) => PROTECTED.some(r => r.test(key)) || DENIED.some(r => r.test(key));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What to take from `imported` into `current` (both settings.json texts). */
export function planSettings(current: string | undefined, imported: string | undefined): SettingsPlan {
	const mine = parseObject(current);
	const theirs = parseObject(imported);
	const plan: SettingsPlan = { add: [], theme: [], kept: [], skipped: [], held: [] };
	for (const [key, value] of Object.entries(theirs)) {
		if (isSkipped(key)) {
			plan.skipped.push(key);
		} else if (!LANGUAGE_BLOCK.test(key) && heldBackReason(key, value) !== undefined) {
			// A key the user has set keeps its value and is not offered again.
			if (key in mine) {
				plan.kept.push(key);
			} else {
				plan.held.push({ key, path: [key], value, reason: heldBackReason(key, value)! });
			}
		} else if (THEME_SET.has(key)) {
			if (key in mine) {
				plan.kept.push(key);
			} else {
				plan.theme.push({ key, value });
			}
		} else if (LANGUAGE_BLOCK.test(key) && isObject(value)) {
			// A language block is merged setting by setting: one the user set for that language in Insilode stays.
			const own = isObject(mine[key]) ? mine[key] as Record<string, unknown> : undefined;
			if (!own) {
				const entries = Object.entries(value).filter(([k]) => !isSkipped(k));
				for (const [k, v] of entries) {
					const reason = heldBackReason(k, v);
					if (reason !== undefined) {
						plan.held.push({ key: `${key}.${k}`, path: [key, k], value: v, reason });
					}
				}
				const kept = Object.fromEntries(entries.filter(([k, v]) => !isHeldBack(k, v)));
				if (Object.keys(kept).length) {
					plan.add.push({ path: [key], value: kept });
				}
				continue;
			}
			for (const [k, v] of Object.entries(value)) {
				if (isSkipped(k)) {
					plan.skipped.push(`${key}.${k}`);
				} else if (k in own) {
					plan.kept.push(`${key}.${k}`);
				} else if (isHeldBack(k, v)) {
					plan.held.push({ key: `${key}.${k}`, path: [key, k], value: v, reason: heldBackReason(k, v)! });
				} else {
					plan.add.push({ path: [key, k], value: v });
				}
			}
		} else if (key in mine) {
			plan.kept.push(key);
		} else {
			plan.add.push({ path: [key], value });
		}
	}
	return plan;
}

const FORMAT: FormattingOptions = { insertSpaces: false, tabSize: 4, eol: '\n' };

/** `current` with each value written at its path, comments and the rest of the file untouched. */
export function writeSettings(current: string | undefined, entries: { path: string[]; value: unknown }[]): string {
	let text = current && current.trim() ? current : '{\n}\n';
	for (const e of entries) {
		text = applyEdits(text, modify(text, e.path, e.value, { formattingOptions: FORMAT }));
	}
	return text;
}

export interface Keybinding {
	key: string;
	command: string;
	when?: string;
	args?: unknown;
}

export interface KeybindingsPlan {
	add: Keybinding[];
	/** Shortcuts the user already has in Insilode for the same key and context (theirs stays). */
	kept: Keybinding[];
	/** Exact duplicates of one Insilode already has. */
	duplicates: number;
}

function parseArray(text: string | undefined): Keybinding[] {
	if (!text) {
		return [];
	}
	const v = parse(text, [], { allowTrailingComma: true, disallowComments: false });
	return Array.isArray(v) ? v.filter((k): k is Keybinding => isObject(k) && typeof k.key === 'string' && typeof k.command === 'string') : [];
}

/** `ctrl+K  ctrl+S` and `ctrl+k ctrl+s` are the same chord. */
const normKey = (k: string) => k.toLowerCase().trim().split(/\s+/).join(' ');
const normWhen = (w: unknown) => typeof w === 'string' ? w.replace(/\s+/g, '') : '';
const slot = (k: Keybinding) => `${normKey(k.key)}\u0000${normWhen(k.when)}`;
const identity = (k: Keybinding) => `${slot(k)}\u0000${k.command}\u0000${JSON.stringify(k.args ?? null)}`;

/**
 * Shortcuts to append. A removal (`-command`) is a shortcut too. When Insilode already binds the same key in the same
 * context, the user's own binding stays; an import never rebinds a key the user chose.
 */
export function planKeybindings(current: string | undefined, imported: string | undefined): KeybindingsPlan {
	const mine = parseArray(current);
	const have = new Set(mine.map(identity));
	// A removal does not take a key: binding the key to something else in the same context is still the user's choice.
	const taken = new Set(mine.filter(k => !k.command.startsWith('-')).map(slot));
	const plan: KeybindingsPlan = { add: [], kept: [], duplicates: 0 };
	const adding = new Set<string>();
	for (const k of parseArray(imported)) {
		const id = identity(k);
		if (have.has(id) || adding.has(id)) {
			plan.duplicates++;
		} else if (!k.command.startsWith('-') && taken.has(slot(k))) {
			plan.kept.push(k);
		} else {
			adding.add(id);
			plan.add.push(k);
		}
	}
	return plan;
}

/** `current` with the shortcuts appended to its array, comments untouched. */
export function writeKeybindings(current: string | undefined, add: Keybinding[]): string {
	let text = current && Array.isArray(parse(current)) ? current : '// Place your key bindings in this file to override the defaults\n[\n]\n';
	for (const k of add) {
		text = applyEdits(text, modify(text, [-1], k, { formattingOptions: FORMAT, isArrayInsertion: true }));
	}
	return text;
}

export interface SnippetPlan {
	/** The text to write, or undefined when nothing changes. */
	text?: string;
	added: number;
	kept: number;
}

/** One snippets file: copied as it is when Insilode has none of that name, else its snippets with new names added. */
export function mergeSnippets(current: string | undefined, imported: string): SnippetPlan {
	const theirs = parseObject(imported);
	if (current === undefined || !current.trim()) {
		return { text: imported, added: Object.keys(theirs).length, kept: 0 };
	}
	const mine = parseObject(current);
	let text = current;
	let added = 0;
	let kept = 0;
	for (const [name, snippet] of Object.entries(theirs)) {
		if (name in mine) {
			kept++;
		} else {
			text = applyEdits(text, modify(text, [name], snippet, { formattingOptions: FORMAT }));
			added++;
		}
	}
	return { text: added ? text : undefined, added, kept };
}

/**
 * Colour theme names VS Code still writes but no longer has a theme for: it renamed its built-in themes and maps the
 * old names when it reads the setting (migrateThemeSettingsId in workbenchThemeService.ts). The import writes the new
 * name, which Insilode's built-in themes carry.
 */
const LEGACY_THEME_IDS: Record<string, string> = {
	'Default Dark Modern': 'Dark Modern',
	'Default Light Modern': 'Light Modern',
	'Default Dark+': 'Dark+',
	'Default Light+': 'Light+',
	'Experimental Dark': 'Dark 2026',
	'VS Code Dark': 'Dark 2026',
	'Experimental Light': 'Light 2026',
	'VS Code Light': 'Light 2026',
};

/** The themes of each kind the editor has, by the exact id a setting must name them with. */
export type ThemeIds = Record<ThemeKind, readonly string[]>;

/**
 * The id the editor knows a theme by, for a name a setting gives. VS Code matches a theme setting exactly
 * (`settingsId === value`, themeExtensionPoints.ts), so a name that differs only in case would leave Insilode on a
 * fallback theme: such a name is rewritten to the one installed theme it matches. Two installed themes that differ
 * only in case make the name ambiguous, and it is not applied.
 */
export function resolveTheme(installed: readonly string[], name: string): string | undefined {
	if (installed.includes(name)) {
		return name;
	}
	const lower = name.toLowerCase();
	const matches = [...new Set(installed.filter(id => id.toLowerCase() === lower))];
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The name a theme contribution is chosen by in settings, as VS Code derives it: a colour theme's `id`, or its label
 * when it has no id (colorThemeData.ts, `theme.id || label`); an icon or product icon theme's `id`. A label that is
 * still a `%placeholder%` names nothing a user could have written.
 */
export function themeSettingsId(kind: ThemeKind, theme: { id?: unknown; label?: unknown }): string | undefined {
	if (typeof theme.id === 'string' && theme.id) {
		return theme.id;
	}
	return kind === 'color' && typeof theme.label === 'string' && theme.label && !theme.label.startsWith('%') ? theme.label : undefined;
}

/**
 * The theme settings that can be applied: a theme the editor does not have (an extension that is not installed, is
 * disabled, or is not on Open VSX) would leave Insilode on a fallback theme, so it is left out and named in the report
 * instead. A theme that is applied is written with the exact id the editor knows it by.
 */
export function applicableTheme(theme: { key: string; value: unknown }[], installed: ThemeIds): { apply: { key: string; value: unknown }[]; missing: { key: string; value: unknown }[] } {
	const apply: { key: string; value: unknown }[] = [];
	const missing: { key: string; value: unknown }[] = [];
	for (const original of theme) {
		const kind = themeKind(original.key);
		const t = kind === 'color' && typeof original.value === 'string' ? { ...original, value: LEGACY_THEME_IDS[original.value] ?? original.value } : original;
		if (!kind || (kind === 'icon' && t.value === null)) {
			apply.push(t);
			continue;
		}
		const id = typeof t.value === 'string' ? resolveTheme(installed[kind], t.value) : undefined;
		if (id !== undefined) {
			apply.push({ ...t, value: id });
		} else {
			missing.push(t);
		}
	}
	return { apply, missing };
}

/**
 * Whether the install command failed because the gallery has no such extension. VS Code throws an
 * ExtensionManagementError whose name is its code (`NotFound`), and the name and code survive the command's round trip
 * to the extension host. The message is localized (a language pack translates it), so it is not looked at.
 */
export function isNotFound(error: unknown): boolean {
	const e = error as { name?: unknown; code?: unknown } | undefined;
	return e?.name === 'NotFound' || e?.code === 'NotFound';
}

/**
 * Whether a file system error from `vscode.workspace.fs` means the file is not there: a FileSystemError with the code
 * `FileNotFound` (or, from Node, ENOENT). Anything else (a file locked by OneDrive or a virus scanner, EBUSY; no
 * permission, EPERM) means the file may well exist, and the import must stop rather than treat it as empty.
 */
export function isFileNotFound(error: unknown): boolean {
	const e = error as { code?: unknown } | undefined;
	return e?.code === 'FileNotFound' || e?.code === 'ENOENT';
}

/** The error text when the editor has no extension gallery configured (extensionGalleryService.ts). */
export function isNoGallery(message: string): boolean {
	return /no extension gallery/i.test(message);
}
