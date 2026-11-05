// The icons a rect can carry (`icon: "database"`): a bundled set of simple outline glyphs on a 16 × 16 grid, drawn here
// for Insilode (no cloud vendor marks, nothing that needs a licence). Each is path data in absolute commands only, so
// placing one is arithmetic: `iconPath` scales and moves the numbers. An unknown name is drawn as a text chip instead and
// the lint says so (docs/plans/canvas-board.md).

const GLYPHS: Record<string, string> = {
	database: 'M2 4 A6 2 0 0 1 14 4 A6 2 0 0 1 2 4 Z M2 4 V12 A6 2 0 0 0 14 12 V4 M2 8 A6 2 0 0 0 14 8',
	server: 'M2 3 H14 V7 H2 Z M2 9 H14 V13 H2 Z M4.5 5 H5.5 M4.5 11 H5.5',
	cloud: 'M4.5 12 A3 3 0 0 1 4.8 6 A4 4 0 0 1 12.3 6.8 A2.6 2.6 0 0 1 11.5 12 Z',
	user: 'M8 8 A2.6 2.6 0 1 0 8 2.8 A2.6 2.6 0 0 0 8 8 Z M3 14 C3 10.5 5 9.5 8 9.5 C11 9.5 13 10.5 13 14',
	users: 'M6 7.5 A2.3 2.3 0 1 0 6 3 A2.3 2.3 0 0 0 6 7.5 Z M1.5 13.5 C1.5 10.5 3.5 9.5 6 9.5 C8.5 9.5 10.5 10.5 10.5 13.5 M11 3.3 A2.2 2.2 0 0 1 11 7.5 M12 9.6 C13.8 10 14.5 11.3 14.5 13.5',
	file: 'M4 1.5 H9.5 L13 5 V14.5 H4 Z M9.5 1.5 V5 H13',
	folder: 'M1.5 4 H6 L7.5 5.5 H14.5 V13 H1.5 Z',
	code: 'M5.5 4.5 L2 8 L5.5 11.5 M10.5 4.5 L14 8 L10.5 11.5 M9 3 L7 13',
	terminal: 'M2 3 H14 V13 H2 Z M4.5 6 L7 8 L4.5 10 M8.5 10.5 H11.5',
	globe: 'M8 14.5 A6.5 6.5 0 1 0 8 1.5 A6.5 6.5 0 0 0 8 14.5 Z M1.5 8 H14.5 M8 1.5 C5.5 4 5.5 12 8 14.5 M8 1.5 C10.5 4 10.5 12 8 14.5',
	lock: 'M3.5 7 H12.5 V14 H3.5 Z M5.5 7 V5 A2.5 2.5 0 0 1 10.5 5 V7',
	key: 'M5 11 A3 3 0 1 0 5 5 A3 3 0 0 0 5 11 Z M8 8 H14 M12 8 V10.5 M14 8 V10',
	queue: 'M1.5 5 H5 V11 H1.5 Z M6.5 5 H10 V11 H6.5 Z M11.5 5 H15 V11 H11.5 Z',
	mail: 'M2 3.5 H14 V12.5 H2 Z M2 4 L8 9 L14 4',
	bell: 'M3.5 11.5 C4.5 10.5 4.5 9 4.5 7 A3.5 3.5 0 0 1 11.5 7 C11.5 9 11.5 10.5 12.5 11.5 Z M6.5 13.5 A1.6 1.6 0 0 0 9.5 13.5',
	clock: 'M8 14.5 A6.5 6.5 0 1 0 8 1.5 A6.5 6.5 0 0 0 8 14.5 Z M8 4.5 V8 L10.5 9.5',
	gear: 'M8 10.2 A2.2 2.2 0 1 0 8 5.8 A2.2 2.2 0 0 0 8 10.2 Z M8 1.5 V3.5 M8 12.5 V14.5 M1.5 8 H3.5 M12.5 8 H14.5 M3.4 3.4 L4.8 4.8 M11.2 11.2 L12.6 12.6 M12.6 3.4 L11.2 4.8 M4.8 11.2 L3.4 12.6',
	search: 'M7 11.5 A4.5 4.5 0 1 0 7 2.5 A4.5 4.5 0 0 0 7 11.5 Z M10.3 10.3 L14 14',
	chart: 'M2 2 V14 H14 M5 11 V8 M8 11 V5 M11 11 V7',
	cpu: 'M4.5 4.5 H11.5 V11.5 H4.5 Z M6.5 6.5 H9.5 V9.5 H6.5 Z M6.5 2 V4.5 M9.5 2 V4.5 M6.5 11.5 V14 M9.5 11.5 V14 M2 6.5 H4.5 M2 9.5 H4.5 M11.5 6.5 H14 M11.5 9.5 H14',
	box: 'M8 1.8 L14 4.8 V11.2 L8 14.2 L2 11.2 V4.8 Z M2 4.8 L8 7.8 L14 4.8 M8 7.8 V14.2',
	layers: 'M8 2 L14.5 5.2 L8 8.4 L1.5 5.2 Z M1.5 8 L8 11.2 L14.5 8 M1.5 10.8 L8 14 L14.5 10.8',
	link: 'M6.5 9.5 L9.5 6.5 M7 4.5 L8 3.5 A2.8 2.8 0 0 1 12.5 8 L11.5 9 M9 11.5 L8 12.5 A2.8 2.8 0 0 1 3.5 8 L4.5 7',
	bolt: 'M9 1.5 L3.5 9 H8 L7 14.5 L12.5 7 H8 Z',
	shield: 'M8 1.8 L13.5 3.8 V8 C13.5 11.5 11 13.5 8 14.5 C5 13.5 2.5 11.5 2.5 8 V3.8 Z',
	check: 'M3 8.5 L6.5 12 L13 4.5',
	x: 'M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5',
	warning: 'M8 2 L14.5 13.5 H1.5 Z M8 6.5 V9.5 M8 11.3 V11.6',
	info: 'M8 14.5 A6.5 6.5 0 1 0 8 1.5 A6.5 6.5 0 0 0 8 14.5 Z M8 7 V11.5 M8 4.8 V5.1',
	play: 'M4.5 2.5 L12.5 8 L4.5 13.5 Z',
	brain: 'M8 3 V13 M8 4 C6 2 3 3.5 3.5 6 C2 7 2.5 9.5 4 10 C4 12 6.5 13.5 8 12 M8 4 C10 2 13 3.5 12.5 6 C14 7 13.5 9.5 12 10 C12 12 9.5 13.5 8 12',
	text: 'M3 3.5 H13 M8 3.5 V13 M6 13 H10',
	grid: 'M2.5 2.5 H13.5 V13.5 H2.5 Z M2.5 8 H13.5 M8 2.5 V13.5',
	image: 'M2 3 H14 V13 H2 Z M2 11 L6 7.5 L9 10.5 L11 8.5 L14 11.5 M10.5 6 A1 1 0 1 0 10.5 5 A1 1 0 0 0 10.5 6 Z',
	api: 'M5.5 3 C3 3 4 6 2 8 C4 10 3 13 5.5 13 M10.5 3 C13 3 12 6 14 8 C12 10 13 13 10.5 13',
	git: 'M4 3 A1.5 1.5 0 1 0 4 6 A1.5 1.5 0 0 0 4 3 Z M4 6 V10 M4 13 A1.5 1.5 0 1 0 4 10 A1.5 1.5 0 0 0 4 13 Z M12 6 A1.5 1.5 0 1 0 12 3 A1.5 1.5 0 0 0 12 6 Z M12 6 C12 9 4 8 4 10',
	cache: 'M2 8 A6 6 0 0 1 13 5 M13.5 2.5 V5.5 H10.5 M14 8 A6 6 0 0 1 3 11 M2.5 13.5 V10.5 H5.5',
	disk: 'M2 2.5 H11.5 L14 5 V13.5 H2 Z M5 2.5 V6 H10 V2.5 M5 13.5 V9 H11 V13.5',
	tag: 'M2 2.5 H8.5 L14 8 L8 14 L2 8.5 Z M5 5 A0.8 0.8 0 1 0 5 5.01',
	flag: 'M3.5 14 V2 M3.5 3 H12 L10 6 L12 9 H3.5',
	star: 'M8 1.8 L9.9 6 L14.5 6.5 L11 9.6 L12 14.2 L8 11.8 L4 14.2 L5 9.6 L1.5 6.5 L6.1 6 Z',
	device: 'M4.5 1.5 H11.5 V14.5 H4.5 Z M7 12.5 H9',
};

export const ICON_NAMES: readonly string[] = Object.keys(GLYPHS);

export const hasIcon = (name: string) => Object.prototype.hasOwnProperty.call(GLYPHS, name);

// How many numbers each path command takes; the arc keeps its flags and rotation as they are.
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7, Z: 0 };
const round = (n: number) => Math.round(n * 100) / 100;

/** The glyph as path data fitted into a `size` square at (x, y); undefined for a name that is not in the set. */
export function iconPath(name: string, x: number, y: number, size: number): string | undefined {
	if (!hasIcon(name)) return undefined;
	const k = size / 16;
	return [...GLYPHS[name].matchAll(/([A-Z])([^A-Z]*)/g)].map(([, cmd, args]) => {
		const nums = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
		const out: (string | number)[] = [cmd];
		for (let i = 0; i < nums.length; i += Math.max(1, ARITY[cmd])) {
			const g = nums.slice(i, i + ARITY[cmd]);
			if (cmd === 'H') out.push(round(x + g[0] * k));
			else if (cmd === 'V') out.push(round(y + g[0] * k));
			else if (cmd === 'A') out.push(round(g[0] * k), round(g[1] * k), g[2], g[3], g[4], round(x + g[5] * k), round(y + g[6] * k));
			else for (let j = 0; j < g.length; j += 2) out.push(round(x + g[j] * k), round(y + g[j + 1] * k));
		}
		return out.join(' ');
	}).join(' ');
}
