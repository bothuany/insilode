/*---------------------------------------------------------------------------------------------
 *  Insilode: pull request news becomes work for the agent on that branch. CI failures, requested
 *  changes and conflicts found by polling (prState.ts) are queued per session and typed into the
 *  agent once its turn ends (Agents.onDidTurnEnd, Agents.deliver), within flow.agents.pr.*.
 *  The rules live in prEventsCore.ts (no vscode, tested on their own).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, AgentSession } from './agents';
import { PrWatcher, type PrState } from './prState';
import { allowed, autoSendQuestion, AUTO_SEND_ANSWER_KEY, composeLine, DailyCap, EventQueue, parseAutoSendAnswer, PrTracker, sendDecision, type PrEvent } from './prEventsCore';

interface Watch {
	tracker: PrTracker;
	queue: EventQueue;
	/** The PR the queued news is about, for its number and the daily cap. */
	pr?: PrState;
}

export class PrEvents implements vscode.Disposable {
	private readonly watches = new Map<string, Watch>();
	private readonly cap = new DailyCap();
	private readonly prs = new PrWatcher(() => { });
	private readonly subs: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private asking = false;

	/** `state`: the window-independent memory (globalState) the first-send question's answer (Always, Never) is kept in. */
	constructor(readonly agents: Agents, protected readonly state?: vscode.Memento) {
		this.subs.push(
			agents.onDidTurnEnd(s => void this.turnEnded(s)),
			agents.onDidChange(() => this.forget()),
		);
		this.schedule();
	}

	private cfg() {
		const c = vscode.workspace.getConfiguration('flow.agents.pr');
		return {
			autoSend: c.get<boolean>('autoSend', true),
			events: c.get<Record<string, boolean>>('events', {}),
			max: c.get<number>('maxAutoSends', 5),
			pollMs: Math.max(30, c.get<number>('pollSeconds', 120)) * 1000,
		};
	}

	private schedule() {
		if (this.disposed) {
			return;
		}
		this.timer = setTimeout(() => void this.poll().finally(() => this.schedule()), this.cfg().pollMs);
	}

	private watched(): AgentSession[] {
		return [...this.agents.sessions.values()].filter(s => (s.cli === 'claude' || s.cli === 'codex') && s.cwd && s.state !== 'ended');
	}

	/** Sessions that are gone take their queue with them. */
	private forget() {
		for (const id of [...this.watches.keys()]) {
			if (!this.agents.sessions.has(id)) {
				this.watches.delete(id);
			}
		}
	}

	private async poll() {
		const { pollMs } = this.cfg();
		const byCwd = new Map<string, AgentSession[]>();
		for (const s of this.watched()) {
			if (s.pr?.state === 'open' || s.pr?.state === 'draft') {
				byCwd.set(s.cwd!, [...byCwd.get(s.cwd!) ?? [], s]);
			}
		}
		for (const [cwd, sessions] of byCwd) {
			const pr = await this.prs.refresh(cwd, pollMs - 1000).catch(() => undefined);
			for (const s of sessions) {
				this.observe(s, pr);
				this.flush(s.id, false);
			}
		}
	}

	private async turnEnded(s: AgentSession) {
		if ((s.cli !== 'claude' && s.cli !== 'codex') || !s.cwd) {
			return;
		}
		const pr = await this.prs.refresh(s.cwd, 30_000).catch(() => undefined);
		this.observe(s, pr);
		this.flush(s.id, false);
	}

	private observe(s: AgentSession, pr: PrState | undefined) {
		if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) {
			return;
		}
		const w = this.watches.get(s.id) ?? { tracker: new PrTracker(), queue: new EventQueue() };
		this.watches.set(s.id, w);
		if (w.pr && w.pr.number !== pr.number) {
			w.queue.clear(); // the branch has another PR now: the old news is stale
		}
		w.pr = pr;
		w.queue.add(allowed(w.tracker.observe(pr), this.cfg().events));
	}

	/** The news waiting for a session. */
	pending(sessionId: string): readonly PrEvent[] {
		return this.watches.get(sessionId)?.queue.peek() ?? [];
	}

	/** Sends what is queued now, whatever the autoSend and daily cap settings say (a button, say). False if nothing went. */
	sendNow(sessionId: string): boolean {
		return this.flush(sessionId, true);
	}

	private flush(id: string, force: boolean): boolean {
		const w = this.watches.get(id);
		if (!w || !w.pr || !w.queue.size) {
			return false;
		}
		const { autoSend, max } = this.cfg();
		const decision = sendDecision({ setting: autoSend, answer: parseAutoSendAnswer(this.state?.get(AUTO_SEND_ANSWER_KEY)), force });
		if (decision === 'hold' || (!force && !this.cap.allows(w.pr.url, max))) {
			return false; // kept for later
		}
		if (decision === 'ask') {
			void this.ask(id, w.pr.number);
			return false; // the news waits in the queue while the question is open
		}
		if (!this.agents.deliver(id, composeLine(w.pr.number, w.queue.peek()))) {
			return false; // busy or being looked at: the next turn end tries again
		}
		w.queue.clear();
		if (!force) {
			this.cap.record(w.pr.url);
		}
		return true;
	}

	/**
	 * The first automatic send in a window with no remembered answer asks once, without a modal: sending costs the user's
	 * tokens. Always and Never are kept in globalState and win over the setting from then on; Not now (or closing the
	 * notice) sends nothing and asks again on the next event. One question is open at a time, whatever the number of agents.
	 */
	private async ask(id: string, prNumber: number) {
		if (this.asking || this.disposed) {
			return;
		}
		this.asking = true;
		try {
			const agent = this.agents.sessions.get(id)?.name ?? 'the agent';
			const pick = await vscode.window.showInformationMessage(autoSendQuestion(agent, prNumber), 'Always', 'Not now', 'Never');
			if (pick === 'Always' || pick === 'Never') {
				await this.state?.update(AUTO_SEND_ANSWER_KEY, pick === 'Always' ? 'always' : 'never');
			}
			if (pick === 'Always') {
				this.flush(id, false);
			}
		} finally {
			this.asking = false;
		}
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.subs.forEach(d => d.dispose());
	}
}
