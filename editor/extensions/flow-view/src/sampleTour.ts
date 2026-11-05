/*---------------------------------------------------------------------------------------------
 *  Insilode: "Take the tour", the button on Home's first-run strip. It plays a sample tour that walks the user's own Home,
 *  Flow at Cursor and Boards, through the same path an agent's tour takes (`panel.playTour`). A tour file cannot carry a
 *  command (tour/validate.ts), so the steps are built here: the Home step runs `flow.home` from the allowlist, the others
 *  are explained, and the Boards step waits for the reader to try Show Board.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { Tour, TourStep } from '../../../../protocol/flow';
import { entryName } from './backends';
import type { TourHost } from './tourFile';

/** "Ctrl+Alt+F" the way the keybinding is written for this OS (⌥⌘F on a Mac). */
export const flowAtCursorChord = (platform: NodeJS.Platform = process.platform) => platform === 'darwin' ? '⌥⌘F' : 'Ctrl+Alt+F';

/** An intro or outro step has no `at`: the caption is centred and the cursor stays put. */
const step = (title: string, caption: string, wait?: TourStep['wait']): TourStep => ({ title, caption, state: 'ok', ...(wait ? { wait } : {}) });

/**
 * The sample tour: an intro, three stops in the reader's own window and an outro. Nothing in it points at a file, so it plays
 * on whatever flow is open. Pure: the caller passes the platform for the shortcut.
 */
export function buildSampleTour(platform: NodeJS.Platform = process.platform): Tour {
	return {
		id: `sample-${randomBytes(6).toString('hex')}`,
		title: 'Take the Insilode tour',
		origin: 'Insilode tour',
		source: 'agent',
		start: 0,
		steps: [
			step('Welcome to Insilode', 'Insilode draws how your code calls itself, and lets an agent point at the part it means. This tour has three short stops in your own window. Leave it whenever you like.'),
			step('Home', 'Home is where a window starts: the files and flows you were in, your endpoints, the health of your agent setup and the prompt box for your agent. Open it now.', { kind: 'command', command: 'flow.home', prompt: 'Open Home' }),
			step('Flow at Cursor', `Put the cursor in any function and press ${flowAtCursorChord(platform)}: the calls it makes, and the calls that reach it, are drawn here as cards. Try it after the tour; it replaces the flow on this canvas.`),
			step('Boards', 'A board is a diagram that stays: a sequence of this flow, the tables, the modules. Run Show Board from the Command Palette (or draw one with Board from Code), look at it, then come back and continue.', { kind: 'continue', prompt: 'Try Show Board, then continue' }),
			step('You are set', 'That is the tour. Ask your agent anything from Home; the strip there explains which agent gets your prompt, and it goes away when you hide it.'),
		],
	};
}

/** The flow to open the canvas on when none is: the first endpoint the index knows, asking the backends only when it knows none. */
async function startFlow(host: TourHost) {
	const known = host.endpointList.cached()[0];
	if (known) {
		return known;
	}
	try {
		return (await host.endpointList.fresh())[0];
	} catch {
		return undefined;
	}
}

/** Plays the sample tour on the canvas, opening one first when there is none. Says what is missing instead of showing a blank canvas. */
export async function playSampleTour(host: TourHost): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		void vscode.window.showInformationMessage('Insilode: open a folder first. The tour walks you through a flow of your own code.');
		return;
	}
	if (!host.panel.shown) {
		const entry = await startFlow(host);
		if (!entry) {
			const indexing = !host.endpointList.status().ready;
			void vscode.window.showInformationMessage(indexing
				? 'Insilode: the code is still being indexed. Take the tour again in a moment.'
				: `Insilode: no flow to start the tour on yet. Open a source file and press ${flowAtCursorChord()} to draw one, then take the tour.`);
			return;
		}
		await host.showEntry(entry.id, entryName(entry), entry.source);
	}
	await host.panel.playTour(buildSampleTour());
}
