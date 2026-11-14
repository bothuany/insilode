/*---------------------------------------------------------------------------------------------
 *  Insilode boards as a Markdown document: the mermaid diagram plus a table of the nodes with links to
 *  their code and their status. This is what the stand-in viewer shows. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import { toMermaid } from './mermaid';
import type { BoardNode, BoardSpec, NodeStatus } from '../../../../../board-canvas/spec';

const STATUS: Record<NodeStatus, string> = { todo: 'todo', doing: '**doing**', done: 'done', skipped: 'skipped', blocked: '**blocked**' };
const DONE_MARK: Record<NodeStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]', skipped: '[-]', blocked: '[!]' };

/** A table cell: no pipes or line breaks that would end the row. */
const cell = (text: string | undefined) => (text ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').trim();

export interface MarkdownOptions {
	/** The link target for a node's code: a `file:` URL with a #L fragment, supplied by the host (it knows the platform and folders). */
	link?: (file: string, line?: number) => string | undefined;
	/** The path as shown to the reader. */
	display?: (file: string) => string;
}

function where(n: BoardNode, o: MarkdownOptions): string {
	if (!n.file) {
		return '';
	}
	const shown = `${(o.display ?? (f => f))(n.file)}${n.line ? `:${n.line}` : ''}`;
	const url = o.link?.(n.file, n.line);
	// The destination goes in <> so spaces and parentheses in a path cannot end the link.
	return url ? `[${cell(shown).replace(/[\[\]]/g, '')}](<${url}>)` : cell(shown);
}

/** The full document for a board. */
export function boardMarkdown(id: string, spec: BoardSpec, o: MarkdownOptions = {}): string {
	const out: string[] = [`# ${cell(spec.title)}`, ''];
	if (spec.description) {
		out.push(spec.description.replace(/\r?\n/g, ' ').replace(/</g, '&lt;'), '');
	}
	if (spec.kind === 'plan') {
		const done = spec.nodes.filter(n => n.status === 'done').length;
		out.push(`**Plan** · ${done} of ${spec.nodes.length} steps done`, '');
	}
	out.push('```mermaid', toMermaid(spec), '```', '');
	if (spec.kind === 'plan') {
		out.push('## Steps', '');
		spec.nodes.forEach((n, i) => {
			const loc = where(n, o);
			out.push(`${i + 1}. ${DONE_MARK[n.status ?? 'todo']} ${cell(n.label)}${loc ? ` — ${loc}` : ''}${n.detail ? `  \n   ${cell(n.detail)}` : ''}${n.note ? `  \n   _${cell(n.note)}_` : ''}`);
		});
		out.push('');
	} else {
		out.push('## Nodes', '', '| Node | Kind | Where | Status | Note |', '| --- | --- | --- | --- | --- |');
		for (const n of spec.nodes) {
			out.push(`| ${cell(n.label)} | ${n.kind ?? ''} | ${where(n, o)} | ${n.status ? STATUS[n.status] : ''} | ${cell(n.note ?? n.detail)} |`);
		}
		out.push('');
	}
	out.push(`<sub>Board \`${id.replace(/`/g, '')}\` · drawn in Insilode · ${spec.nodes.length} nodes, ${spec.edges.length} edges</sub>`, '');
	return out.join('\n');
}
