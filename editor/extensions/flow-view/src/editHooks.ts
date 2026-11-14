/*---------------------------------------------------------------------------------------------
 *  Insilode: the hooks Claude Code is set to run after every agent edit, for the canvas's "n hooks" badge on an edited card.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

interface HookEntry { matcher?: string; hooks?: { type?: string; command?: string }[] }

/** What a hook command does, in a few words: the script it runs, or the start of the command. */
function hookName(command: string) {
	const script = /(?<name>[\w.-]+\.(?:sh|py|js|mjs|ts|ps1))/.exec(command);
	if (script?.groups) {
		return script.groups.name;
	}
	// A binary: its name and first argument ("/…/bin/blamely record claude" → "blamely record").
	const program = /^(?<bin>\/[^\s]+)(?:\s+(?<arg>[\w-]+))?/.exec(command.trim());
	if (program?.groups) {
		return [path.basename(program.groups.bin), program.groups.arg].filter(Boolean).join(' ');
	}
	return command.length > 48 ? `${command.slice(0, 48)}…` : command;
}

/** The names of the PostToolUse hooks of the user's and the project's Claude settings whose matcher covers an edit. */
export async function editHooks(root: string, home = os.homedir()): Promise<string[]> {
	const names: string[] = [];
	const edits = ['Edit', 'Write', 'MultiEdit'];
	for (const p of [path.join(home, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]) {
		let config: { hooks?: Record<string, HookEntry[]> };
		try {
			config = JSON.parse(await fs.readFile(p, 'utf8').catch(() => '') || '{}');
		} catch {
			continue;
		}
		for (const entry of config.hooks?.PostToolUse ?? []) {
			let matches = true;
			// `*` and an empty matcher mean "every tool"; anything else is a regular expression over tool names.
			if (entry.matcher && entry.matcher !== '*') {
				try {
					const re = new RegExp(`^(?:${entry.matcher})$`);
					matches = edits.some(t => re.test(t));
				} catch {
					matches = false;
				}
			}
			if (matches) {
				names.push(...(entry.hooks ?? []).filter(h => h.command).map(h => hookName(h.command!)));
			}
		}
	}
	return names;
}
