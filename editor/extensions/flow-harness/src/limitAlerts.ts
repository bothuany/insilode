/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: a notification when a plan's usage limit passes 75% and again past 90%, once
 *  per limit window (keyed by when the window resets), behind flowHarness.limitAlerts. The levels
 *  are budget.ts's, the same ones that colour the status bar item.
 *
 *  Stub of the shared contract (docs/design/xirp-plan.md, part D): hears every report, notifies nothing yet.
 *--------------------------------------------------------------------------------------------*/

export class LimitAlerts {
	/** Called with every flowHarness.reportLimits argument, after the status bar took it. */
	report(_arg: unknown): void { }
}
