/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page (HTML, CSS and the script that draws it). No `vscode` here, so the page can be rendered
 *  outside the editor too (the website puts it in an iframe and sends it the same messages). Stub of the contract:
 *  the page itself is built in its own change. It receives AgentsPageMessage (agentsData.ts) and posts AgentsAction
 *  (agentsMessage.ts) through acquireVsCodeApi().postMessage.
 *--------------------------------------------------------------------------------------------*/

export function agentsHtml(): string {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`;
}
