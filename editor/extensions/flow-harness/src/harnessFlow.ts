/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the harness flow diagram's model. Places every harness piece at the step of an
 *  agent turn where it acts, and for the preview and replay modes, the path one event takes through
 *  them (protocol/harness.ts). flow-view's panel asks for it through flowHarness.flowModel.
 *
 *  Stub of the shared contract (docs/design/xirp-plan.md, part F): answers an empty diagram.
 *--------------------------------------------------------------------------------------------*/

import type { HarnessFlowModel, HarnessFlowRequest } from '../../../../protocol/harness';
import type { Live } from './live';
import type { Harness } from './scan';

/** The request flowHarness.flowModel was given, checked: anything unexpected becomes the static diagram. */
export function toRequest(arg: unknown): HarnessFlowRequest {
	const o = arg && typeof arg === 'object' ? arg as Record<string, unknown> : {};
	const mode = o.mode === 'preview' || o.mode === 'replay' ? o.mode : 'static';
	return { mode };
}

export async function flowModel(request: HarnessFlowRequest, harness: Harness | undefined, _live: Live): Promise<HarnessFlowModel> {
	void request;
	return { root: harness?.root ?? '', items: [] };
}
