/*---------------------------------------------------------------------------------------------
 *  Insilode: the one drawing that stands for skeleton first, wherever an agent's switch is shown (the dock, the Agents page).
 *  A bone, not a skull: next to a permissions switch a skull reads as danger. Pure (no vscode), so both pages and the site may use it.
 *--------------------------------------------------------------------------------------------*/

/** A 16×16 outline in the current text colour; the caller sizes it with CSS (width and height on the svg). */
export const BONE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
	+ '<path d="M5.4 10.6l5.2-5.2"/><circle cx="3.6" cy="10.3" r="1.5"/><circle cx="5.7" cy="12.4" r="1.5"/><circle cx="10.3" cy="3.6" r="1.5"/><circle cx="12.4" cy="5.7" r="1.5"/></svg>';
