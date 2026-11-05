/*---------------------------------------------------------------------------------------------
 *  Insilode: sending a question to the agent of the user's choice. flow.agents.ask is what Home, "Ask
 *  about this flow" and the other extensions call; the first time (or when the remembered target
 *  is gone) a picker asks where it goes, and later questions go there without asking. A short
 *  status bar note after each send says where it went and opens the picker to change it. The
 *  rules (order, fallbacks, the setting) are in askTarget.ts.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';
import { choices, customOf, isTarget, notReady, oneLine, parseSetting, planFirst, resolve, sameTarget, targetName, withFiles, type AskTarget, type Choice, type CustomCli } from './askTarget';
import { savedAgents } from './pick';

const REMEMBERED = 'flow.agents.askTarget';
/** How long the "Sent to … · change" note stays in the status bar. */
const NOTE_MS = 10_000;
/** A chat provider that answers selectChatModels slowly must not hold up the question. */
const CHAT_PROBE_MS = 1500;

type Item = vscode.QuickPickItem & { target?: AskTarget; act?: 'ask' | 'remember' };

export class AskRouter implements vscode.Disposable {
	private readonly note = vscode.window.createStatusBarItem('flow.agents.askNote', vscode.StatusBarAlignment.Left, 50);
	private noteTimer: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly agents: Agents) {
		this.note.name = 'Insilode: where questions go';
		this.note.command = 'flow.agents.chooseAskTarget';
	}

	dispose() {
		clearTimeout(this.noteTimer);
		this.note.dispose();
	}

	/**
	 * Sends `text` (and `files`, referred to the way the target reads them) to the chosen agent. `submit` sends it; without
	 * it the text waits in the prompt to be finished. Resolves true whenever the question was dealt with here, including
	 * when the user closed the picker, so the caller never opens a chat panel on top; false only for nothing to send.
	 * `plan` asks the agent to plan before it edits, said the way the chosen target understands it (planFirst).
	 */
	async ask(text: string, submit: boolean, origin?: string, files: string[] = [], plan = false, session?: string): Promise<boolean> {
		const line = oneLine(text);
		if (!line && !files.length) {
			return false;
		}
		const setting = parseSetting(vscode.workspace.getConfiguration('flow.agents').get('askTarget'));
		const customs = this.customs();
		const chat = await chatAvailable();
		const canStart = vscode.workspace.isTrusted;
		// A question about a tour goes to the agent that made it, when that session is still open: it knows the tour. If it is busy the
		// send below says so and puts the question on the clipboard, as for any session. A session that is gone falls back to the rules.
		const author = session ? this.agents.askSessions().find(x => x.id === session && x.alive && x.state !== 'ended') : undefined;
		const r = author ? { use: { kind: 'session', id: author.id, cli: author.cli, custom: customOf(author, customs)?.name } as AskTarget } : resolve({ setting, remembered: this.remembered(), sessions: this.agents.askSessions(), customs, chat, canStart });
		let target: AskTarget | undefined;
		if ('use' in r) {
			target = r.use;
		} else {
			target = await this.pick({ chat, canStart, customs, why: r.why, title: origin ? `Send to which agent? (${origin})` : 'Send to which agent?' });
			if (!target) {
				return true;
			}
		}
		const sent = await this.send(target, plan ? planFirst(line, target) : line, submit, files, customs);
		// Only "remember" learns from use; a fixed setting or "ask" keeps its own rule.
		if (setting === 'remember' && sent && !author) {
			await this.context.workspaceState.update(REMEMBERED, sent);
		}
		return true;
	}

	/** flow.agents.chooseAskTarget: the picker on its own, to change where questions go without sending one. */
	async choose(): Promise<void> {
		const setting = parseSetting(vscode.workspace.getConfiguration('flow.agents').get('askTarget'));
		if (setting !== 'ask' && setting !== 'remember') {
			const open = await vscode.window.showInformationMessage(`Questions always go to ${setting.replace(/^custom:/, '')}: the setting flow.agents.askTarget fixes it.`, 'Open Setting');
			if (open) {
				await vscode.commands.executeCommand('flow.settings', 'flow.agents.askTarget');
			}
			return;
		}
		const customs = this.customs();
		const picked = await this.pick({ chat: await chatAvailable(), canStart: vscode.workspace.isTrusted, customs, title: 'Where should questions for the agent go?', manage: setting });
		if (picked) {
			await this.context.workspaceState.update(REMEMBERED, picked);
			this.show(`$(comment-discussion) Questions go to ${targetName(picked, this.agents.askSessions())} · change`);
		}
	}

	private customs(): CustomCli[] {
		return savedAgents();
	}

	private remembered(): AskTarget | undefined {
		const v = this.context.workspaceState.get<unknown>(REMEMBERED);
		return isTarget(v) ? v : undefined;
	}

	private async pick(o: { chat: boolean; canStart: boolean; customs: CustomCli[]; title: string; why?: string; manage?: 'ask' | 'remember' }): Promise<AskTarget | undefined> {
		const sessions = this.agents.askSessions();
		const current = this.remembered();
		const list = choices({ sessions, customs: o.customs, chat: o.chat, canStart: o.canStart });
		const section = (c: Choice) => c.target.kind === 'session' ? 'Running' : c.target.kind === 'new' ? 'New session' : 'Other';
		const items: Item[] = [];
		let last = '';
		for (const c of list) {
			if (section(c) !== last) {
				last = section(c);
				items.push({ label: last, kind: vscode.QuickPickItemKind.Separator });
			}
			const mark = sameTarget(c.target, current) ? ' · current' : '';
			items.push({ label: `${icon(c.target)} ${c.label}`, description: (c.description ?? '') + mark || undefined, target: c.target });
		}
		if (o.manage) {
			items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
			items.push(o.manage === 'remember'
				? { label: '$(question) Ask every time', detail: 'Sets flow.agents.askTarget to "ask" for this workspace', act: 'ask' }
				: { label: '$(pin) Remember my choice', detail: 'Sets flow.agents.askTarget to "remember" for this workspace', act: 'remember' });
		}
		const placeHolder = o.why ? `${o.why}. Choose where to send it; later questions go there too.` : 'Later questions go to the same place; change it with "Insilode: Change Agent for Questions…".';
		const pick = await vscode.window.showQuickPick(items, { title: o.title, placeHolder, ignoreFocusOut: true });
		if (pick?.act) {
			await vscode.workspace.getConfiguration('flow.agents').update('askTarget', pick.act, vscode.ConfigurationTarget.Workspace);
			return undefined;
		}
		return pick?.target;
	}

	/** Delivers the question; resolves the target to remember (a new session is remembered as itself), or undefined when nothing was sent. */
	private async send(target: AskTarget, line: string, submit: boolean, files: string[], customs: CustomCli[]): Promise<AskTarget | undefined> {
		switch (target.kind) {
			case 'clipboard':
				await vscode.env.clipboard.writeText(withFiles(line, files));
				this.show('$(clippy) Question copied · change');
				return target;
			case 'chat':
				await vscode.commands.executeCommand('workbench.action.chat.open', { query: line, isPartialQuery: !submit, attachFiles: files.map(f => vscode.Uri.file(f)) });
				this.show('$(comment-discussion) Sent to the chat panel · change');
				return target;
			case 'session': {
				const name = targetName(target, this.agents.askSessions());
				if (this.agents.typeInto(target.id, withFiles(line, files, target.cli), submit, customs)) {
					this.show(`$(comment-discussion) Sent to ${name} · change`);
					return target;
				}
				// It started working or asking for permission between choosing and typing: never type into that.
				const now = this.agents.askSessions().find(x => x.id === target.id);
				await this.toClipboard(line, files, now ? notReady(now) : `${name} has closed`);
				this.agents.reveal(target.id);
				return target;
			}
			case 'new': {
				const custom = target.cli === 'custom' ? customs.find(c => c.name === target.custom) : undefined;
				if (target.cli === 'custom' && !custom) {
					await this.toClipboard(line, files, `${target.custom ?? 'That agent'} is no longer in flow.agents.custom`);
					return undefined;
				}
				const started = await this.agents.spawn(target.cli, undefined, custom);
				if (!started) {
					return undefined; // spawn said why
				}
				const session: AskTarget = { kind: 'session', id: started.id, cli: target.cli, custom: target.custom };
				// A custom CLI reports nothing, so there is no telling when its prompt is up; Claude and Codex say so through a hook.
				if (target.cli !== 'custom' && await this.agents.whenReady(started.id, customs) && this.agents.typeInto(started.id, withFiles(line, files, target.cli), submit, customs)) {
					this.show(`$(comment-discussion) Sent to ${started.name} · change`);
				} else {
					const now = this.agents.askSessions().find(x => x.id === started.id);
					await this.toClipboard(line, files, target.cli === 'custom' || !now ? `${started.name} is starting` : notReady(now));
				}
				return session;
			}
		}
	}

	private async toClipboard(line: string, files: string[], why: string) {
		await vscode.env.clipboard.writeText(withFiles(line, files));
		void vscode.window.showInformationMessage(`Insilode: ${why}. Your question is on the clipboard: paste it into its prompt.`, 'Change Agent…')
			.then(c => c && vscode.commands.executeCommand('flow.agents.chooseAskTarget'));
	}

	/** The note in the status bar: where the question went, and a click to change it. It takes no focus. */
	private show(text: string) {
		this.note.text = text;
		this.note.tooltip = 'Change where questions for the agent go';
		this.note.show();
		clearTimeout(this.noteTimer);
		this.noteTimer = setTimeout(() => this.note.hide(), NOTE_MS);
	}
}

function icon(t: AskTarget): string {
	switch (t.kind) {
		case 'session': return '$(terminal)';
		case 'new': return t.cli === 'claude' ? '$(sparkle)' : t.cli === 'codex' ? '$(hubot)' : '$(add)';
		case 'chat': return '$(comment-discussion)';
		case 'clipboard': return '$(clippy)';
	}
}

/**
 * Whether the chat panel has something behind it: Insilode's ACP chat sessions (flow.agents.showChat), or a language model
 * from another extension (Copilot, a local model). Insilode's own placeholder models (vendor `flow`, models.ts) answer
 * nothing on their own, so they do not count.
 */
async function chatAvailable(): Promise<boolean> {
	if (vscode.workspace.getConfiguration('flow.agents').get<boolean>('showChat', false)) {
		return true;
	}
	try {
		const models = await Promise.race([
			vscode.lm.selectChatModels(),
			new Promise<vscode.LanguageModelChat[]>(r => setTimeout(() => r([]), CHAT_PROBE_MS)),
		]);
		return models.some(m => m.vendor !== 'flow');
	} catch {
		return false;
	}
}
