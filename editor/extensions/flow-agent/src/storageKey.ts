/*---------------------------------------------------------------------------------------------
 *  Insilode: the name of a window's storage folder under `agents/`. One function for the window that writes there (agents.ts) and
 *  the windows that read it (peersCore.ts), so the two can never disagree about which folder belongs to which project.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export const folderKey = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 12);
