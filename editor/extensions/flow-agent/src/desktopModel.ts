/*---------------------------------------------------------------------------------------------
 *  Insilode: what the desktop surfaces outside the window show (desktop.ts sends it to core). The app
 *  badge is the number of agents that need you, the same number as the Agents dock badge. The
 *  status overlay gets one small item per live agent. Nothing here touches vscode, so it is tested
 *  on its own.
 *
 *  The overlay sits on top of every app, also on a shared screen: by default it says what kind of
 *  thing an agent does ("Running", "Editing"), never the command, the file or the question itself.
 *--------------------------------------------------------------------------------------------*/

import { attentionKind, rank, type AttentionKind, type Rankable } from './attention';

export type OverlayPosition = 'top-center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type OverlayDisplay = 'insilode' | 'primary' | 'secondary';
export type OverlayStyle = 'pill' | 'dots' | 'list';
export type OverlaySize = 'small' | 'medium' | 'large';
export type OverlayTheme = 'black' | 'editor' | 'dark' | 'light';
/** How agents are drawn in the dock and the overlay (src/avatars.ts): `flow.agents.avatar`. */
export type AvatarKind = 'gyro' | 'pixel';

export function readAvatar(v: unknown): AvatarKind {
	return v === 'pixel' ? 'pixel' : 'gyro';
}

/** Which agents and which facts the overlay shows. */
export interface OverlayShow {
	working: boolean;
	needsYou: boolean;
	/** Finished turns you have not looked at yet. */
	done: boolean;
	/** Idle, starting, and finished turns you have read. */
	idle: boolean;
	counts: boolean;
	activity: boolean;
	context: boolean;
	cost: boolean;
	/** How long it has been in its state. */
	elapsed: boolean;
}

export interface DesktopSettings {
	badge: boolean;
	overlay: boolean;
	position: OverlayPosition;
	display: OverlayDisplay;
	style: OverlayStyle;
	size: OverlaySize;
	opacity: number;
	theme: OverlayTheme;
	show: OverlayShow;
	autoHide: { noAgents: boolean; insilodeFocused: boolean };
	/**
	 * What the user never set, which core settles by the screen (a Mac with a camera housing: the island on, and not hidden
	 * while Insilode is focused). Both are false when `set` is not given to readSettings.
	 */
	unset: { enabled: boolean; focused: boolean };
	/** Commands, file names and questions in the activity line, for screens nobody else sees. */
	details: boolean;
}

export const DEFAULT_SHOW: OverlayShow = { working: true, needsYou: true, done: true, idle: false, counts: true, activity: true, context: true, cost: false, elapsed: true };

/**
 * Reads `flow.agents.desktop.*` through `get` (relative keys, e.g. `overlay.position`), with anything malformed falling back to
 * its default. `set` gives what the user wrote down for a key (no default), when it is given: a key it returns nothing for is
 * `unset`.
 */
export function readSettings(get: (key: string) => unknown, set?: (key: string) => unknown): DesktopSettings {
	const bool = (key: string, fallback: boolean) => {
		const v = get(key);
		return typeof v === 'boolean' ? v : fallback;
	};
	const oneOf = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
		const v = get(key);
		return values.includes(v as T) ? v as T : fallback;
	};
	const flags = <T extends object>(key: string, defaults: T): T => {
		const v = get(key);
		const out = { ...defaults };
		if (v && typeof v === 'object') {
			for (const k of Object.keys(defaults) as (keyof T)[]) {
				const value = (v as Record<string, unknown>)[k as string];
				if (typeof value === 'boolean') {
					out[k] = value as T[keyof T];
				}
			}
		}
		return out;
	};
	const opacity = get('overlay.opacity');
	return {
		badge: bool('badge', true),
		// `overlay.enabled`, not `overlay`: a setting cannot also be the parent of `overlay.position` and the rest.
		overlay: bool('overlay.enabled', false),
		position: oneOf('overlay.position', ['top-center', 'top-left', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'], 'top-center'),
		display: oneOf('overlay.display', ['insilode', 'primary', 'secondary'], 'insilode'),
		style: oneOf('overlay.style', ['pill', 'dots', 'list'], 'pill'),
		size: oneOf('overlay.size', ['small', 'medium', 'large'], 'medium'),
		// Below 0.3 the overlay is there but cannot be read, which is worse than turning it off.
		opacity: typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(1, Math.max(0.3, opacity)) : 0.95,
		theme: oneOf('overlay.theme', ['black', 'editor', 'dark', 'light'], 'black'),
		show: flags('overlay.show', DEFAULT_SHOW),
		autoHide: flags('overlay.autoHide', { noAgents: true, insilodeFocused: true }),
		details: bool('overlay.details', false),
		unset: set
			? { enabled: typeof set('overlay.enabled') !== 'boolean', focused: typeof (set('overlay.autoHide') as { insilodeFocused?: unknown } | undefined)?.insilodeFocused !== 'boolean' }
			: { enabled: false, focused: false },
	};
}

/**
 * The value the user wrote for a setting (`inspect()` of it), not the default. An object-valued setting is judged key by key
 * across the scopes: a workspace that writes one key must not hide a key only the user's settings write.
 */
export function writtenValue(i: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined): unknown {
	const scopes = [i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue];
	const objects = scopes.filter(v => v && typeof v === 'object');
	return objects.length ? Object.assign({}, ...objects) : scopes.reverse().find(v => v !== undefined);
}

/**
 * Whether this window sends agents for the island: when the user turned it on, or left it unset on a Mac (where core then decides
 * by the screen's camera housing: only it can tell, so it answers `flow.desktop.setOverlay` with the real verdict).
 */
export function overlayWanted(settings: Pick<DesktopSettings, 'overlay' | 'unset'>, platform: string): boolean {
	return settings.overlay || (settings.unset.enabled && platform === 'darwin');
}

/** The app badge: how many agents need you. The Agents dock badge is this number too (Agents.needsYou). */
export function needsYouCount(sessions: Iterable<Rankable>): number {
	let n = 0;
	for (const s of sessions) {
		if (attentionKind(s)) {
			n++;
		}
	}
	return n;
}

/** The fields of a session the overlay looks at. */
export interface OverlaySource extends Rankable {
	id: string;
	name: string;
	cli: string;
	activity?: string;
	usage?: { used: number; size?: number; percent?: number };
	cost?: { session: { usd?: number } };
}

export type OverlayState = 'working' | 'needs' | 'done' | 'idle';

/** One agent as the overlay draws it. Core treats every string as text, never as markup. */
export interface OverlayItem {
	id: string;
	name: string;
	cli: string;
	state: OverlayState;
	attention?: AttentionKind;
	activity?: string;
	/** Share of the context window in use, 0-100. */
	context?: number;
	usd?: number;
	/** When it entered its state (epoch ms). */
	since?: number;
}

export interface OverlayModel {
	items: OverlayItem[];
	counts?: { needs: number; working: number; done: number };
}

/** The tool verbs agents.ts starts its activity lines with (`describe`), and the fixed lines that say nothing private. */
const VERBS = ['Running', 'Editing', 'Writing', 'Reading', 'Searching the web', 'Searching', 'Finding', 'Fetching', 'Delegating', 'Thinking'];

/**
 * The activity line as the overlay may show it. With `details` off only the leading verb is kept ("Running", not
 * "Running npm test"), an approval says "Wants approval" (its text is the command), and anything else is dropped:
 * a question, an MCP tool line or an error text can quote anything.
 */
export function overlayActivity(activity: string | undefined, details: boolean): string | undefined {
	const text = activity?.split('\n')[0].trim();
	if (!text) {
		return undefined;
	}
	if (details) {
		return text.length > 80 ? `${text.slice(0, 79)}…` : text;
	}
	if (text.startsWith('Wants to:')) {
		return 'Wants approval';
	}
	return VERBS.find(v => text === v || text.startsWith(`${v} `));
}

function overlayState(s: Rankable, kind: AttentionKind | undefined): OverlayState {
	if (kind === 'done') {
		return 'done';
	}
	if (kind) {
		return 'needs';
	}
	return s.state === 'working' ? 'working' : 'idle';
}

function contextPercent(u: OverlaySource['usage']): number | undefined {
	const p = u?.percent ?? (u?.size ? (u.used / u.size) * 100 : undefined);
	return p === undefined || !Number.isFinite(p) ? undefined : Math.round(Math.min(100, Math.max(0, p)));
}

/** The overlay's agents, most urgent first like the dock; ended sessions never show. */
export function overlayModel(sessions: Iterable<OverlaySource>, o: DesktopSettings): OverlayModel {
	const items: OverlayItem[] = [];
	for (const s of rank([...sessions].filter(s => s.state !== 'ended'))) {
		const kind = attentionKind(s);
		const state = overlayState(s, kind);
		const wanted = state === 'needs' ? o.show.needsYou : state === 'done' ? o.show.done : state === 'working' ? o.show.working : o.show.idle;
		if (!wanted) {
			continue;
		}
		const activity = o.show.activity ? overlayActivity(s.activity, o.details) : undefined;
		const context = o.show.context ? contextPercent(s.usage) : undefined;
		const usd = o.show.cost ? s.cost?.session.usd : undefined;
		items.push({
			id: s.id, name: s.name.slice(0, 60), cli: s.cli, state,
			...(o.show.elapsed ? { since: s.since } : {}),
			...(kind ? { attention: kind } : {}),
			...(activity ? { activity } : {}),
			...(context !== undefined ? { context } : {}),
			...(typeof usd === 'number' && Number.isFinite(usd) ? { usd } : {}),
		});
	}
	const count = (state: OverlayState) => items.filter(i => i.state === state).length;
	return { items, ...(o.show.counts ? { counts: { needs: count('needs'), working: count('working'), done: count('done') } } : {}) };
}

/** What core needs besides the agents: where and how to draw them. */
export function overlayOptions(o: DesktopSettings, avatar: AvatarKind = 'gyro') {
	return { position: o.position, display: o.display, style: o.style, size: o.size, opacity: o.opacity, theme: o.theme, autoHide: o.autoHide, avatar, unset: o.unset };
}
