/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the shell of the harness's webview pages (the "Why?" view, the context X-ray).
 *  Every page gets a Content-Security-Policy from default-src 'none' and runs only the one
 *  script it was given, by nonce, so markup injected through data can neither load nor run code.
 *  Pages render data with textContent; nothing they receive is ever parsed as HTML.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';

/**
 * The status colours of the pages. A dark theme gets its own colour for each (the var() in STYLE; these are only its fallback);
 * a light theme gets the darker set, chosen for at least 4.5:1 on a white or light grey page, because the dark set (a pale
 * amber, a pale green) is under 2:1 there. test/page.test.mjs measures both sets.
 */
export const STATUS_COLORS = {
	dark: { allow: '#5fe0a1', ask: '#ffb454', deny: '#ff6b7d', accent: '#6f86ff' },
	light: { allow: '#146c3a', ask: '#8a5300', deny: '#b3261e', accent: '#0b5cad' },
} as const;

/** The context X-ray's segment colours (a bar and its legend, 3:1 against the page): the pale set for dark themes, a darker one for light. */
export const SEGMENT_COLORS = {
	dark: ['#6f86ff', '#b88cff', '#ffb454', '#5fe0a1', '#4fd6d0', '#f0a6ca', '#f2a170', '#9aa4bf'],
	light: ['#3b55d9', '#8a4fd6', '#a86400', '#1f8a56', '#0e8a85', '#c2417a', '#c0561f', '#6b7385'],
} as const;

/** Theme colours and the few shared classes both pages use. */
const STYLE = `
:root { --text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-widget-border, #30323c);
	--card: color-mix(in srgb, var(--vscode-editor-background) 85%, #2a2c36); --mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
	--allow: var(--vscode-testing-iconPassed, ${STATUS_COLORS.dark.allow}); --ask: var(--vscode-editorWarning-foreground, ${STATUS_COLORS.dark.ask});
	--deny: var(--vscode-errorForeground, ${STATUS_COLORS.dark.deny}); --accent: var(--vscode-textLink-foreground, ${STATUS_COLORS.dark.accent}); }
body.vscode-light, body.vscode-high-contrast-light { --allow: ${STATUS_COLORS.light.allow}; --ask: ${STATUS_COLORS.light.ask}; --deny: ${STATUS_COLORS.light.deny}; --accent: ${STATUS_COLORS.light.accent};
	--card: color-mix(in srgb, var(--vscode-editor-background) 95%, #000); }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 20px 32px; color: var(--text); background: var(--vscode-editor-background); font: 13px/1.5 var(--vscode-font-family, system-ui); }
h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 24px 0 8px; font-weight: 600; }
.sub { color: var(--muted); margin: 0 0 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
.row { display: flex; gap: 10px; align-items: baseline; }
.grow { flex: 1; min-width: 0; }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); font-size: 12px; }
.tag { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.tag.est { border-style: dashed; }
.tag.measured { color: var(--allow); border-color: color-mix(in srgb, var(--allow) 50%, transparent); }
.allow { color: var(--allow); } .ask { color: var(--ask); } .deny { color: var(--deny); }
button, select, input { font: inherit; color: var(--text); }
button { background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
button:hover { background: var(--vscode-list-hoverBackground); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
input, select { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 6px; padding: 4px 8px; }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 4px 8px 4px 0; vertical-align: top; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); }
th { color: var(--muted); font-weight: 500; }
s { color: var(--muted); }
.bar { display: flex; height: 14px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--line) 60%, transparent); margin: 8px 0; }
.bar i { display: block; height: 100%; }
/* A button that reads as a link, for the actions the pages used to draw as links with a click handler: reachable by Tab, with a visible focus ring. */
button.link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); text-decoration: none; }
button.link:hover { background: none; text-decoration: underline; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 1px; }
/* Text for a screen reader only (an aria-live status line, a label). */
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

/** A complete page: `body` is static markup written here, `script` the page's code; both are this extension's own text. */
export function page(title: string, body: string, script: string, extraStyle = ''): string {
	const nonce = randomBytes(16).toString('base64');
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	return /* html */ `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${title}</title><style>${STYLE}${extraStyle}</style></head><body>${body}
<div id="announce" class="sr-only" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
/** Builds an element; text goes in as textContent, never as markup. */
function el(tag, attrs, ...kids) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : String(v));
	}
	for (const k of kids.flat()) if (k !== undefined && k !== null && k !== false) n.append(k instanceof Node ? k : String(k));
	return n;
}
// Says a result to a screen reader without drawing it: the page's own #announce region (aria-live), cleared first so the same text is read again.
function announce(text) {
	const n = document.getElementById('announce');
	if (!n) return;
	n.textContent = '';
	setTimeout(() => { n.textContent = text; }, 30);
}
// Millions as M, as the Agents dock writes a context window (1M, not 1000k).
const fmt = n => n >= 1e6 ? +(n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n));
${script}
</script></body></html>`;
}
