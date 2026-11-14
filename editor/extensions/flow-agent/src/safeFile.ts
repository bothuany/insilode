/*---------------------------------------------------------------------------------------------
 *  Insilode: opening a file whose path came from a directory listing in a folder any program may write to (Claude's session registry
 *  and transcripts). A FIFO there would make a plain open() wait for a writer for ever, on a thread of libuv's small pool: a few of
 *  those and every file read in the extension host hangs. No vscode: tested on its own (test/safeFile.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs } from 'fs';

/**
 * O_NONBLOCK makes opening a FIFO or a device return at once instead of waiting. A link is followed, not refused: dotfiles setups link single
 * files, and what the link points to is checked on the handle below (a FIFO or a device behind a link is still not a regular file).
 * Windows has no such flag, and no FIFOs.
 */
const FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Opens `file` for reading and checks the handle itself (not the path, which may have changed since it was listed): it must be a
 * regular file of at most `maxSize` bytes. Throws, with the handle closed, when it is not; the caller skips the file.
 */
export async function openRegular(file: string, maxSize = Infinity): Promise<{ handle: fs.FileHandle; size: number }> {
	const handle = await fs.open(file, FLAGS);
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.size > maxSize) {
			throw new Error('not a regular file within the size limit');
		}
		return { handle, size: st.size };
	} catch (e) {
		await handle.close().catch(() => undefined);
		throw e;
	}
}
