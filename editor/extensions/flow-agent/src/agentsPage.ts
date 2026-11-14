/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page (HTML, CSS and the script that draws it). No `vscode` here, so the page can be rendered
 *  outside the editor too (the website puts it in an iframe and sends it the same messages). It receives
 *  AgentsPageMessage (agentsData.ts) and posts AgentsAction (agentsMessage.ts) through acquireVsCodeApi().postMessage
 *  (the website's shim defines one too). agentsPanel.ts gives it to the webview and answers.
 *
 *  It is a terminal workspace: the sessions are listed on the left, and dragged into panes that split and rearrange (the layout is
 *  paneLayout.ts, the workspace agentsWorkspace.ts, the rest agentsShell.ts). Board and List stay as overviews. The terminals are
 *  xterm.js, which agentsPanel.ts hands over built (esbuild.mjs makes it); without it the page still draws and its panes say so.
 *  Text from a row only ever reaches the page through textContent (the h() helper): the only markup set as HTML is built from
 *  constants (the avatar, the CLI marks, the pane icons).
 *--------------------------------------------------------------------------------------------*/

import { AVATAR_CSS, AVATAR_SCRIPT } from './avatars';
import { DOCK_COLORS, ICON, colorVars } from './dockPage';
import { paneLayoutModule } from './paneLayout';
import { BOOT_SCRIPT, SHELL_CSS, SHELL_SCRIPT } from './agentsShell';
import { WORKSPACE_CSS, WORKSPACE_SCRIPT } from './agentsWorkspace';

/** The built terminal: xterm.js with its fit addon as one script that sets `window.insilodeXterm`, and its style sheet. */
export interface TermAssets {
	js: string;
	css: string;
}

const CSS = String.raw`
:root {
	--bg: var(--vscode-editor-background, #1b1c23); --text: var(--vscode-foreground, #cfd2dc); --muted: var(--vscode-descriptionForeground, #8b90a0);
	--line: var(--vscode-widget-border, var(--vscode-panel-border, #30323c)); --hover: var(--vscode-list-hoverBackground, #2a2c36);
	--card: color-mix(in srgb, var(--bg) 82%, #808aa0); --col: color-mix(in srgb, var(--bg) 94%, #808aa0);
	--input: var(--vscode-input-background, #24262e); --focus: var(--vscode-focusBorder, #6f7cff);
	--btn: var(--vscode-button-secondaryBackground, #3a3d4a); --btn-text: var(--vscode-button-secondaryForeground, #e6e8ee);
	--mono: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace);
	--term-bg: var(--vscode-terminal-background, var(--vscode-editor-background, #1b1c23));
	${colorVars(DOCK_COLORS.dark)}
}
body.vscode-light, body.vscode-high-contrast-light {
	--card: color-mix(in srgb, var(--bg) 60%, #fff); --col: color-mix(in srgb, var(--bg) 94%, #5a6480);
	${colorVars(DOCK_COLORS.light)}
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; color: var(--text); background: var(--bg); font: 13px/1.4 var(--vscode-font-family, -apple-system, system-ui, sans-serif); overflow: hidden; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible, .card:focus-visible, .lrow:focus-visible { outline: 1.5px solid var(--focus); outline-offset: -1.5px; }
#app { display: flex; flex-direction: column; height: 100%; }
#app[hidden] { display: none; }
.ico { flex: none; width: 15px; height: 15px; display: block; }
.ico.claude { color: var(--claude); } .ico.codex { color: var(--codex); } .ico.custom { color: var(--custom); }
.mark { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11.5px; }
.mark.cust { color: var(--custom); }
.av.big { width: 40px; height: 40px; border-radius: 10px; }
${AVATAR_CSS}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
${SHELL_CSS}
${WORKSPACE_CSS}
`;

/** The page's script: the layout module, then the shell, the workspace and the start. Plain JavaScript in String.raw, so it can be tested as text. */
const SCRIPT = `
const L = (${paneLayoutModule.toString()})();
const MARK = { claude: ${JSON.stringify(ICON.claude)}, codex: ${JSON.stringify(ICON.codex)} };
${SHELL_SCRIPT}
${WORKSPACE_SCRIPT}
${BOOT_SCRIPT}
`;

/**
 * `nonce` is made per load by agentsPanel.ts (the website passes its own): every script runs by it. `term` is the built xterm.js; without it
 * (the website, a checkout that was not built) the page has no terminals. The policy is the same either way: nothing is loaded from outside.
 */
export function agentsHtml(nonce: string, term?: TermAssets): string {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	// The terminal goes in as an inline script: a closing tag in it would end the script early, so a bundle that has one is not used.
	const vendor = term && !/<\/script|<script|<!--/i.test(term.js) ? `<script nonce="${nonce}">/*insilode:xterm*/${term.js}</script>` : '';
	const termCss = vendor && !/<\/style/i.test(term!.css) ? term!.css : '';
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agents</title><style>${CSS}${termCss}</style></head><body><script nonce="${nonce}">${AVATAR_SCRIPT}</script>${vendor}<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
