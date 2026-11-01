/*---------------------------------------------------------------------------------------------
 *  Insilode: Claude Code's and Codex's own editor extensions, installed from Open VSX the first time Insilode starts, so
 *  they are there as if they came with it. They are not shipped inside Insilode: both are the publishers' own, under
 *  licenses that do not allow passing them on, so each copy comes from their listing. Anthropic and OpenAI are trusted
 *  publishers in product.json (editor/patches/flow-core.patch), so no trust dialog asks. Each extension is installed at
 *  most once: one you uninstall stays uninstalled. flow.agents.installAgentExtensions turns it off.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { agentExtensionStep } from './agentExtensionsCore';

/** Claude Code (Anthropic) and Codex (OpenAI), as Open VSX names them. */
export const AGENT_EXTENSIONS = ['anthropic.claude-code', 'openai.chatgpt'];

/** The extensions already handled: installed by Insilode, found installed, or not on Open VSX. Never tried again. */
const HANDLED = 'flow.agents.agentExtensionsHandled';

export async function installAgentExtensions(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
	if (!vscode.workspace.getConfiguration('flow.agents').get<boolean>('installAgentExtensions', true)) {
		return;
	}
	const handled = new Set(context.globalState.get<string[]>(HANDLED, []));
	for (const id of AGENT_EXTENSIONS) {
		if (handled.has(id)) {
			continue;
		}
		if (vscode.extensions.getExtension(id)) {
			handled.add(id);
			continue;
		}
		try {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
			log.info(`Agents: installed ${id} from Open VSX`);
			handled.add(id);
		} catch (e) {
			const step = agentExtensionStep(e);
			log.warn(`Agents: ${id} was not installed (${(e as Error)?.message ?? e}); ${step === 'stop' ? 'this Insilode has no extension gallery' : step === 'skip' ? 'it is not on Open VSX' : 'trying again at the next start'}`);
			if (step === 'skip') {
				handled.add(id);
			} else if (step === 'stop') {
				break;
			}
		}
	}
	await context.globalState.update(HANDLED, [...handled]);
}
