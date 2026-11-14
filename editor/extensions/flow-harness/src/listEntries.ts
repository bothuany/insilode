/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the entries of one folder, in name order, for the scan's walks (scanCore.ts, scanFsHost.ts, summary.ts). No `vscode`.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, type Dirent } from 'fs';

/** The entries of one folder in name order: all of them, or (`cap`) at most that many, read a few at a time. `cut` is told when entries were left unread. */
export async function listEntries(dir: string, cap = Infinity, cut?: () => void): Promise<Dirent[]> {
	if (cap === Infinity) {
		return (await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])).sort((a, b) => a.name < b.name ? -1 : 1);
	}
	const handle = await fs.opendir(dir).catch(() => undefined);
	const out: Dirent[] = [];
	try {
		for (let e = await handle?.read(); e; e = await handle?.read()) {
			if (out.length >= cap) {
				cut?.();
				break;
			}
			out.push(e);
		}
	} catch {
		// A folder that goes away while it is listed: what was read is the list.
	} finally {
		await handle?.close().catch(() => undefined);
	}
	return out.sort((a, b) => a.name < b.name ? -1 : 1);
}
