/*---------------------------------------------------------------------------------------------
 *  Insilode: which repository or module a file belongs to, and the shape of the Endpoints view's
 *  data. Without vscode, so it is tested without the editor. In a git supermodule (a workspace whose
 *  children are submodules) the repository is the unit a developer thinks in.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import type { EntryPoint } from '../../../../protocol/flow';

export interface Repo {
	/** Absolute folder. */
	dir: string;
	name: string;
	/** Folder relative to the workspace folder, forward slashes; empty for a file outside every root or at the root. */
	rel: string;
}

/**
 * A file belongs to the nearest folder below its workspace root that has a `.git` entry (a file in a submodule, a folder in a
 * nested repository), else to its top-level folder under the root. The root itself is never a repository here: it is the whole.
 */
export function repoResolver(roots: readonly string[], exists: (p: string) => boolean = fs.existsSync): (file: string) => Repo {
	const memo = new Map<string, boolean>();
	const hasGit = (dir: string) => {
		let v = memo.get(dir);
		if (v === undefined) {
			v = exists(path.join(dir, '.git'));
			memo.set(dir, v);
		}
		return v;
	};
	const make = (root: string, dir: string): Repo => ({ dir, name: path.basename(dir), rel: path.relative(root, dir).split(path.sep).join('/') });
	return file => {
		for (const root of roots) {
			const rel = path.relative(root, path.dirname(file));
			if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
				continue;
			}
			const segs = rel ? rel.split(path.sep) : [];
			for (let i = segs.length; i > 0; i--) {
				const dir = path.join(root, ...segs.slice(0, i));
				if (hasGit(dir)) {
					return make(root, dir);
				}
			}
			return segs.length ? make(root, path.join(root, segs[0])) : make(root, root);
		}
		return { dir: path.dirname(file), name: path.basename(path.dirname(file)), rel: '' };
	};
}

const LANGS: [RegExp, string][] = [
	[/\.java$/i, 'Java'], [/\.cs$/i, 'C#'], [/\.(m|c)?[jt]sx?$/i, 'TS/JS'], [/\.py$/i, 'Python'], [/\.go$/i, 'Go'],
	[/\.php$/i, 'PHP'], [/\.rb$/i, 'Ruby'], [/\.rs$/i, 'Rust'],
];

/** The language of a source file, from its extension. */
export function languageOf(file: string): string {
	return LANGS.find(([re]) => re.test(file))?.[1] ?? 'Other';
}

export interface Row { id: string; source: string; action: string; verb: string; route: string; file: string; line: number; lang: string }
export interface Section { name: string; dir: string; rel: string; count: number; langs: string[]; groups: { name: string; items: Row[] }[] }

/**
 * Entries as sections (one per repository) of controller groups. `label` names the controller group, `shown` spells a file
 * for the row's tooltip. Two repositories with a controller of one name stay two groups.
 */
export function sections(entries: readonly (EntryPoint & { source: string })[], resolve: (file: string) => Repo, label: (e: EntryPoint) => string, shown: (file: string) => string = f => f): Section[] {
	const by = new Map<string, { repo: Repo; groups: Map<string, Row[]> }>();
	for (const e of entries) {
		const repo = resolve(e.file);
		const s = by.get(repo.dir) ?? { repo, groups: new Map<string, Row[]>() };
		by.set(repo.dir, s);
		const [verb, ...route] = e.http.split(/\s+/);
		const name = label(e);
		s.groups.set(name, [...(s.groups.get(name) ?? []), { id: e.id, source: e.source, action: e.action, verb: verb.toUpperCase(), route: route.join(' '), file: shown(e.file), line: e.line, lang: languageOf(e.file) }]);
	}
	return [...by.values()]
		.map(({ repo, groups }) => {
			const g = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => ({ name, items }));
			const all = g.flatMap(x => x.items);
			return { name: repo.name, dir: repo.dir, rel: repo.rel, count: all.length, langs: [...new Set(all.map(r => r.lang))].sort(), groups: g };
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

/** With this many endpoints over several repositories, the repositories start collapsed. */
export const COLLAPSE_ABOVE = 200;
export const startsCollapsed = (list: readonly Section[]) => list.length > 1 && list.reduce((n, s) => n + s.count, 0) > COLLAPSE_ABOVE;

/** Files by repository, for a picker: groups by name, the shortest path first within one. */
export function byRepo(files: readonly string[], roots: readonly string[], exists?: (p: string) => boolean): { repo: Repo; files: string[] }[] {
	const resolve = repoResolver(roots, exists);
	const by = new Map<string, { repo: Repo; files: string[] }>();
	for (const f of files) {
		const repo = resolve(f);
		const g = by.get(repo.dir) ?? { repo, files: [] };
		by.set(repo.dir, g);
		g.files.push(f);
	}
	return [...by.values()]
		.map(g => ({ ...g, files: g.files.sort((a, b) => a.length - b.length) }))
		.sort((a, b) => a.repo.name.localeCompare(b.repo.name) || a.repo.dir.localeCompare(b.repo.dir));
}
