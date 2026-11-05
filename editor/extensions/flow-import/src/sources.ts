/*---------------------------------------------------------------------------------------------
 *  Where another editor keeps what a user would bring along: its User folder (settings.json, keybindings.json,
 *  snippets/) and the list of extensions it has installed. Read only: nothing here writes, and an extension is known
 *  by its id alone (its files are never read or copied; Insilode installs it again from its own gallery).
 *
 *  No `vscode`: the host passes the platform, home and environment, so tests run every OS's layout on any machine.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

export type Platform = 'win32' | 'darwin' | 'linux';

export interface Env {
	platform: Platform;
	home: string;
	/** %APPDATA% on Windows. */
	appData?: string;
	/** $XDG_CONFIG_HOME on Linux. */
	xdgConfigHome?: string;
}

export interface Product {
	id: 'code' | 'insiders' | 'vscodium' | 'cursor' | 'windsurf';
	name: string;
	/** The folder under the OS's application-data folder that holds `User`. */
	dataFolder: string;
	/** The folder under the home folder that holds `extensions`. */
	extensionsFolder: string;
}

/** In the order they are offered: VS Code first, since most people switch from it. */
export const PRODUCTS: readonly Product[] = [
	{ id: 'code', name: 'VS Code', dataFolder: 'Code', extensionsFolder: '.vscode' },
	{ id: 'insiders', name: 'VS Code Insiders', dataFolder: 'Code - Insiders', extensionsFolder: '.vscode-insiders' },
	{ id: 'vscodium', name: 'VSCodium', dataFolder: 'VSCodium', extensionsFolder: '.vscode-oss' },
	{ id: 'cursor', name: 'Cursor', dataFolder: 'Cursor', extensionsFolder: '.cursor' },
	{ id: 'windsurf', name: 'Windsurf', dataFolder: 'Windsurf', extensionsFolder: '.windsurf' },
];

export interface Source {
	product: Product;
	/** The editor's User folder (may not exist when only its extensions folder does). */
	userDir: string;
	/** The editor's extensions folder (may not exist). */
	extensionsDir: string;
}

/** The folder each OS keeps application data in, the parent of `Code/User`. */
export function appDataRoot(env: Env): string {
	switch (env.platform) {
		case 'win32': return env.appData || join(env.home, 'AppData', 'Roaming');
		case 'darwin': return join(env.home, 'Library', 'Application Support');
		default: return env.xdgConfigHome || join(env.home, '.config');
	}
}

/** The editors installed for this user: those with a User folder or an extensions folder. */
export function findSources(env: Env): Source[] {
	const root = appDataRoot(env);
	return PRODUCTS.map(product => ({
		product,
		userDir: join(root, product.dataFolder, 'User'),
		extensionsDir: join(env.home, product.extensionsFolder, 'extensions'),
	})).filter(s => isDir(s.userDir) || isDir(s.extensionsDir));
}

export interface SourcePickItem {
	label: string;
	description: string;
	detail: string;
	source: Source;
}

/**
 * The quick pick items for several editors: name, the User folder and when its settings.json last changed (the date, in
 * UTC, so the text does not depend on the machine's time zone). `modified` reads a file's modification time in
 * milliseconds, or undefined when there is no such file.
 */
export function sourcePickItems(sources: readonly Source[], modified: (path: string) => number | undefined = mtimeOf): SourcePickItem[] {
	return sources.map(source => {
		const at = modified(join(source.userDir, 'settings.json'));
		return {
			label: source.product.name,
			description: source.userDir,
			detail: at === undefined ? 'No settings.json (extensions only)' : `Settings last modified ${new Date(at).toISOString().slice(0, 10)}`,
			source,
		};
	});
}

/** What the first-start offer was answered with: the button pressed, or undefined for a notification that was closed. */
export type OfferAnswer = 'import' | 'notNow' | 'never' | undefined;

/**
 * Whether the offer is marked answered so it never comes back. Only an explicit answer counts: `Never`, and an import
 * that succeeded. `Not now`, a closed notification (the X), a source pick that was dismissed and an import that did not
 * run or stopped all leave it open, so the offer returns at the next start.
 */
export function offerAnswered(answer: OfferAnswer, importSucceeded: boolean): boolean {
	return answer === 'never' || (answer === 'import' && importSucceeded);
}

function mtimeOf(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

export interface Snippet {
	/** The file name, e.g. `typescript.json` or `react.code-snippets`. */
	name: string;
	text: string;
}

export interface SourceContent {
	settings?: string;
	keybindings?: string;
	snippets: Snippet[];
	/** Extension ids (`publisher.name`, lower case), sorted. */
	extensions: string[];
	/** Files that are there but could not be read (locked, no permission), with the reason; they are not imported. */
	unreadable: { file: string; reason: string }[];
}

/** Reads a file as text; `readFileSync` but for tests, which make it fail as a locked file would. */
export type ReadFile = (path: string) => string;
const readUtf8: ReadFile = path => readFileSync(path, 'utf8');

/**
 * Everything that can be imported from one source, as text (settings and keybindings are JSON with comments). A file
 * that is missing is simply not there; one that exists but cannot be read (a snippet file a virus scanner holds, EBUSY,
 * or one without permission, EPERM) is skipped and listed in `unreadable`, so one bad file does not stop the import.
 */
export function readSource(source: Source, read: ReadFile = readUtf8): SourceContent {
	const unreadable: SourceContent['unreadable'] = [];
	const tryRead = (path: string): string | undefined => {
		try {
			return read(path);
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				unreadable.push({ file: path, reason: (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e) });
			}
			return undefined;
		}
	};
	const snippetsDir = join(source.userDir, 'snippets');
	const snippets: Snippet[] = [];
	if (isDir(snippetsDir)) {
		for (const name of readdirSync(snippetsDir).filter(n => /\.(json|code-snippets)$/i.test(n) && isFile(join(snippetsDir, n))).sort()) {
			const text = tryRead(join(snippetsDir, name));
			if (text !== undefined) {
				snippets.push({ name, text });
			}
		}
	}
	return {
		settings: tryRead(join(source.userDir, 'settings.json')),
		keybindings: tryRead(join(source.userDir, 'keybindings.json')),
		snippets,
		extensions: listExtensions(source.extensionsDir),
		unreadable,
	};
}

/**
 * The folders Insilode itself installs extensions into, where the editor looks for them (environmentService.ts
 * `extensionsPath`): `$VSCODE_EXTENSIONS`, a portable install's `extensions` folder, or `<home>/<dataFolderName>/extensions`
 * (`~/.insilode/extensions`). Read to find extensions that are installed but disabled, which the extension API does
 * not list.
 */
export function ownExtensionDirs(home: string, dataFolderName: string | undefined, env: { VSCODE_EXTENSIONS?: string; VSCODE_PORTABLE?: string }): string[] {
	const dirs = [env.VSCODE_EXTENSIONS, env.VSCODE_PORTABLE && join(env.VSCODE_PORTABLE, 'extensions'), dataFolderName && join(home, dataFolderName, 'extensions')];
	return [...new Set(dirs.filter((d): d is string => !!d))];
}

/** Ids that are Insilode's own (they ship with it) and are never installed from a gallery. */
const OWN = /^flow\./;
const FOLDER = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*?)-\d+\.\d+\.\d+/i;

interface ExtensionEntry {
	identifier?: { id?: unknown };
	relativeLocation?: unknown;
	location?: { path?: unknown; fsPath?: unknown } | string;
}

/**
 * The extensions installed in a VS Code style extensions folder. `extensions.json` is the editor's own list; folders
 * listed in `.obsolete` are uninstalled ones that are not deleted yet. Without the list (old installs), the folder names
 * (`publisher.name-1.2.3`) are the list. The same id at several versions counts once.
 */
export function listExtensions(dir: string): string[] {
	if (!isDir(dir)) {
		return [];
	}
	const obsolete = new Set(Object.keys(asObject(parse(readText(join(dir, '.obsolete')) ?? '{}'))).map(k => k.toLowerCase()));
	const ids = new Set<string>();
	const list = parse(readText(join(dir, 'extensions.json')) ?? 'null') as unknown;
	if (Array.isArray(list)) {
		for (const e of list as ExtensionEntry[]) {
			const id = typeof e?.identifier?.id === 'string' ? e.identifier.id.toLowerCase() : undefined;
			if (!id || obsolete.has(folderOf(e))) {
				continue;
			}
			ids.add(id);
		}
	} else {
		for (const name of readdirSync(dir)) {
			const m = FOLDER.exec(name);
			if (m && !obsolete.has(name.toLowerCase()) && isDir(join(dir, name))) {
				ids.add(m[1].toLowerCase());
			}
		}
	}
	return [...ids].filter(id => !OWN.test(id)).sort();
}

/** The folder an `extensions.json` entry lives in, as `.obsolete` names it. */
function folderOf(e: ExtensionEntry): string {
	if (typeof e.relativeLocation === 'string') {
		return e.relativeLocation.toLowerCase();
	}
	const loc = typeof e.location === 'string' ? e.location : (e.location?.path ?? e.location?.fsPath);
	return typeof loc === 'string' ? (loc.split(/[\\/]/).filter(Boolean).pop() ?? '').toLowerCase() : '';
}

function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

