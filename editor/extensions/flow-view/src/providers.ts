/*---------------------------------------------------------------------------------------------
 *  Insilode: where a flow comes from. One provider per kind of target; the canvas only sees FlowNode.
 *--------------------------------------------------------------------------------------------*/

import type { FlowNode, ImpactResult } from '../../../../protocol/flow';
import type { Analyzer } from './analyzer';

/** What every provider hands the canvas (declared in protocol/flow.ts). */
export type { FlowNode, ImpactResult };

/** Opaque to the webview; each provider defines its own fields. */
export type FlowTarget =
	| { kind: 'roslyn'; id: string }
	| { kind: 'lsp'; uri: string; line: number; character: number }
	| { kind: 'poly'; id: string }
	/** A whole change set on one canvas (changeSet.ts): the id only tells one showing from the next. */
	| { kind: 'changes'; id: string };

export interface FlowProvider {
	graph(target: FlowTarget): Promise<FlowNode>;
	callers(target: FlowTarget): Promise<FlowNode | null>;
	/** What breaks if this changes: entry points (or, without a framework adapter, root callers). */
	impact(target: FlowTarget): Promise<ImpactResult>;
}

/** C#/.NET: the Roslyn analyzer, which also resolves MediatR and DI hops. */
export class RoslynProvider implements FlowProvider {
	constructor(private readonly analyzer: Analyzer) { }

	private id(t: FlowTarget) {
		if (t.kind !== 'roslyn') {
			throw new Error('not a Roslyn target');
		}
		return encodeURIComponent(t.id);
	}

	graph(t: FlowTarget) {
		return this.analyzer.get<FlowNode>(`/api/graph?id=${this.id(t)}&depth=5`);
	}

	callers(t: FlowTarget) {
		return this.analyzer.get<FlowNode>(`/api/callers?id=${this.id(t)}&depth=3`);
	}

	async impact(t: FlowTarget) {
		const items = await this.analyzer.get<string[]>(`/api/impact?id=${this.id(t)}`);
		// The analyzer names the endpoints only: no file or line to open yet.
		return { label: 'endpoint', items: items.map(label => ({ label, file: null, line: 0 })) };
	}
}
