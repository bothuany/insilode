/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the plans' usage limits behind the status bar items, and how they read. Reports
 *  arrive from flow-agent through a registered command, so every field is checked here rather
 *  than trusted.
 *
 *  Pure (no vscode), so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

export interface LimitWindow {
	label: string;
	usedPercent: number;
	resetsAt?: number;
}

/** A harness's plan limits (5-hour, weekly), account-wide. */
export interface HarnessLimits {
	harness: string;
	windows: LimitWindow[];
}

const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const str = (v: unknown, max = 80): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** A limits report from another extension, or undefined when it holds no usable window. */
export function toLimits(arg: unknown): HarnessLimits | undefined {
	const a = arg as Record<string, unknown> | undefined;
	const harness = str(a?.harness);
	if (!harness || !Array.isArray(a?.windows)) {
		return undefined;
	}
	const windows = (a.windows as unknown[]).flatMap(w => {
		const o = w as Record<string, unknown> | undefined;
		const label = str(o?.label, 12);
		const usedPercent = num(o?.usedPercent);
		const resetsAt = num(o?.resetsAt);
		return label && usedPercent !== undefined ? [{ label, usedPercent: Math.min(100, usedPercent), ...(resetsAt ? { resetsAt } : {}) }] : [];
	}).slice(0, 4);
	return windows.length ? { harness, windows } : undefined;
}

export const fmtTokens = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);

/** The harness's short name in the status bar. */
const short = (harness: string) => harness.replace(/\s*Code$/, '');

/** `Claude 5h 32% · wk 61%`: the share used of each window. */
export function limitsText(l: HarnessLimits): string {
	return `${short(l.harness)} ${l.windows.map(w => `${w.label} ${Math.round(w.usedPercent)}%`).join(' · ')}`;
}

/** How long until a reset, in words short enough for a tooltip line. */
export function until(resetsAt: number, now: number): string {
	const mins = Math.max(0, Math.round((resetsAt - now) / 60_000));
	if (mins < 60) {
		return `${mins} min`;
	}
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		return `${hours} h ${mins % 60} min`;
	}
	return `${Math.floor(hours / 24)} days ${hours % 24} h`;
}

export const windowName = (w: LimitWindow) => w.label === '5h' ? '5-hour limit' : w.label === 'wk' ? 'Weekly limit' : `${w.label} limit`;

/** One line per window for the tooltip: what is used, what is left, and when it starts over. */
export function limitLines(l: HarnessLimits, now: number, time: (ms: number) => string): string[] {
	return l.windows.map(w => {
		const name = windowName(w);
		const used = Math.round(w.usedPercent);
		const reset = w.resetsAt ? `, resets ${time(w.resetsAt)} (in ${until(w.resetsAt, now)})` : '';
		return `${name}: ${used}% used, ${100 - used}% left${reset}`;
	});
}

/** How long a window without a reset time stays on show after its report: long enough to outlast a quiet spell between turns, short enough not to linger for hours. */
export const UNDATED_TTL_MS = 30 * 60_000;

/**
 * The windows still worth showing: one past its reset no longer says anything true, and one with no reset time
 * goes once its report is old, since nothing else would ever take it down.
 */
export function liveWindows(l: HarnessLimits, receivedAt: number, now: number): LimitWindow[] {
	return l.windows.filter(w => w.resetsAt ? w.resetsAt > now : now - receivedAt < UNDATED_TTL_MS);
}

export type Level = 'ok' | 'warn' | 'high';

/** The share used at which a limit is worth a look (`warn`) and at which it is close (`high`). */
export const WARN_AT = 75;
export const HIGH_AT = 90;

/** One window's level: the status bar colour and the notifications both read it, so the thresholds live here. */
export function windowLevel(usedPercent: number): Level {
	return usedPercent >= HIGH_AT ? 'high' : usedPercent >= WARN_AT ? 'warn' : 'ok';
}

/** The worst window decides the colour: past 90% the limit is close, past 75% worth a look. */
export function limitLevel(l: HarnessLimits): Level {
	return windowLevel(Math.max(...l.windows.map(w => w.usedPercent)));
}

export interface LimitAlert {
	level: 'warn' | 'high';
	message: string;
}

/**
 * The notifications a report calls for. `seen` maps `harness|window|resetsAt|level` to the reset time (0 when the window has
 * none) and is updated here: a window alerts once per level, a new window (a new reset time) alerts again, and keys whose reset
 * has passed are dropped. A jump straight past 90% says only the 90% thing, and counts the 75% one as told.
 */
export function dueAlerts(l: HarnessLimits, seen: Map<string, number>, now: number): LimitAlert[] {
	for (const [key, resetsAt] of seen) {
		if (resetsAt && resetsAt <= now) {
			seen.delete(key);
		}
	}
	const out: LimitAlert[] = [];
	for (const w of l.windows) {
		const level = windowLevel(w.usedPercent);
		if (level === 'ok' || (w.resetsAt && w.resetsAt <= now)) {
			continue;
		}
		const base = `${l.harness}|${w.label}|${w.resetsAt ?? 0}`;
		const warnKey = `${base}|warn`, highKey = `${base}|high`;
		const told = seen.has(level === 'high' ? highKey : warnKey);
		seen.set(warnKey, w.resetsAt ?? 0);
		if (level === 'high') {
			seen.set(highKey, w.resetsAt ?? 0);
		}
		if (!told) {
			const reset = w.resetsAt ? `, resets in ${until(w.resetsAt, now)}` : '';
			out.push({ level, message: `${short(l.harness)}: ${windowName(w)} at ${Math.round(w.usedPercent)}%${reset}` });
		}
	}
	return out;
}
