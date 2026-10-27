/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: a notification when a plan's usage limit passes 75% and again past 90%, once
 *  per limit window (keyed by when the window resets), behind flowHarness.limitAlerts. The levels
 *  are budget.ts's, the same ones that colour the status bar item; the decision is budget.ts's
 *  dueAlerts, so it is tested without vscode.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { dueAlerts, toLimits } from './budget';

export class LimitAlerts {
	/** What was already told, in memory only: a reload may tell a window's level once more. */
	private readonly seen = new Map<string, number>();

	/** Called with every flowHarness.reportLimits argument, after the status bar took it. */
	report(arg: unknown): void {
		const limits = toLimits(arg);
		if (!limits) {
			return;
		}
		const enabled = vscode.workspace.getConfiguration('flowHarness').get<boolean>('limitAlerts', true);
		const due = dueAlerts(limits, this.seen, Date.now());
		if (!enabled) {
			return; // the keys are kept even so: turning the setting on must not replay what was already passed
		}
		// Notifications show without taking focus; nothing here awaits the user's answer.
		for (const a of due) {
			void (a.level === 'high' ? vscode.window.showWarningMessage(a.message) : vscode.window.showInformationMessage(a.message));
		}
	}
}
