/*---------------------------------------------------------------------------------------------
 *  Insilode: where the Agents page keeps its pane layouts. The layout on screen goes to the workspace's storage (each project reopens
 *  its own), the layouts the user named go to the global storage (every project can apply them). No `vscode`: the two stores are
 *  anything with get and update, so this is tested on its own. Whatever is read back or handed in is validated by paneLayout.ts first.
 *--------------------------------------------------------------------------------------------*/

import { layoutName, MAX_LAYOUTS, parse, type PaneLayout } from './paneLayout';

export interface Memento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface SavedLayout {
	name: string;
	layout: PaneLayout;
}

export const CURRENT_KEY = 'flow.agents.page.layout';
export const SAVED_KEY = 'flow.agents.page.layouts';

export class LayoutStore {
	constructor(private readonly workspace: Memento, private readonly global: Memento) {}

	/** The layout the page had on screen last, when it is still sound and has panes. */
	current(): PaneLayout | undefined {
		const layout = parse(this.workspace.get<unknown>(CURRENT_KEY));
		return layout?.root ? layout : undefined;
	}

	/** An empty workspace is stored as nothing, so a closed workspace stays closed. */
	setCurrent(layout: PaneLayout): void {
		void this.workspace.update(CURRENT_KEY, layout.root ? layout : undefined);
	}

	/** The saved layouts, oldest first; an entry that is not sound is left out, and no more than MAX_LAYOUTS are read. */
	saved(): SavedLayout[] {
		const raw = this.global.get<unknown>(SAVED_KEY);
		const out: SavedLayout[] = [];
		for (const e of Array.isArray(raw) ? raw : []) {
			const name = layoutName((e as { name?: unknown } | null)?.name);
			const layout = parse((e as { layout?: unknown } | null)?.layout);
			if (name !== undefined && layout?.root && !out.some(s => s.name === name) && out.length < MAX_LAYOUTS) {
				out.push({ name, layout });
			}
		}
		return out;
	}

	/** Saves under `name` (a layout of that name is replaced). Returns false when it is not saved: no panes, a bad name, or a 21st name. */
	save(name: string, layout: PaneLayout): boolean {
		const clean = layoutName(name);
		const all = this.saved();
		const at = all.findIndex(s => s.name === clean);
		if (clean === undefined || !layout.root || (at < 0 && all.length >= MAX_LAYOUTS)) {
			return false;
		}
		if (at < 0) {
			all.push({ name: clean, layout });
		} else {
			all[at] = { name: clean, layout };
		}
		void this.global.update(SAVED_KEY, all);
		return true;
	}

	remove(name: string): void {
		void this.global.update(SAVED_KEY, this.saved().filter(s => s.name !== name));
	}
}
