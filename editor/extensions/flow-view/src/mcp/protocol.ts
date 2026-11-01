/*---------------------------------------------------------------------------------------------
 *  Insilode agent bridge: the MCP side of the `insilode` server. Newline-delimited JSON-RPC over a pair of
 *  streams (stdio in the real server, in-memory streams in tests). Nothing but JSON-RPC is ever
 *  written to the output; diagnostics go to `log`. `initialize` and `tools/list` always succeed:
 *  a problem with the Insilode window is a tool result with isError, which the model can read and act on.
 *--------------------------------------------------------------------------------------------*/

import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';
import { getPrompt, promptList } from './prompts';
import { TOOLS, TOOL_NAMES } from './tools';

export interface ToolResult {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
}

/** Runs a tool somewhere (the Insilode window) and answers; throwing is the same as an error result. */
export type Forward = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

export const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';

export const INSTRUCTIONS = [
	"Insilode is the user's code editor. These tools act on the Insilode window that has the current folder open.",
	'WHEN THE USER ASKS HOW SOMETHING WORKS, to be walked through it, or for an explanation of code ("walk me through how an order is placed", "how does X work", "explain this flow", "anlat", "nasıl çalışıyor", in any language), do not answer from memory or from files alone: find the entry with `find_entry_points`, get the call chain with `flow_text`, then SHOW it with `tour`. When you explain with a tour, also write a 3 to 5 line summary of the answer in chat, so a reader without the canvas still gets the answer. If these tools are listed but not loaded, load `find_entry_points`, `flow_text` and `tour` first (ToolSearch). 3-12 steps in the order the code runs, one idea per step, captions that say why and not what, in the language the user writes in (the `tour_guide` prompt has the advice). Questions the user asks during a tour come back to you; answer them through `tour_control`.',
	'To open a file or place in the editor use `open`. To open the flow of a feature for the user use `find_entry_points` then `show_flow`; `flow_text` is the same call chain as text, to understand code without reading many files.',
	'SKELETON FIRST: before your first edit for a request or an approved plan that adds or changes types, entities or interfaces (in any mode, plan mode or not), call `check_skeleton` once (load it with ToolSearch if it is listed but not loaded). It answers at once: off means implement as usual; on means the developer writes the skeleton themselves and it says what to do (draw the design with `draw_board`, every new or changed type with the members to write as `{"text": "name(param: Type): Return"}` objects, then stop). The developer then drives it by chat ("check", "hand over", "just do it", "done"): pass their reply to `check_skeleton` as its `step`. The `skeleton_first` prompt has the whole flow.',
	'IMPACT: `impact` for a method gives its callers and the entry points that reach it. For a table (`table`, or `entity` for its model class) it gives the endpoints that write it and the endpoints that read it, each with the method and database card it goes through; a guessed link (raw SQL, a naming default) is marked ~table?. It follows ORM calls and string SQL only and says what it did not check (dynamic SQL, views, other services, migrations). A migration file or an entity file alone (`file` without `method` or `line`) gives the same for the tables it changes: what the migration does to each table (adds, drops, renames), the endpoints that use it, and the code that may still use a column it drops.',
	'Use `impact` before changing shared code (or, with `table` or `entity`, a table or its entity), `get_context` to see what the user is looking at, and `draw_board` (kinds: flow, plan, class, er, sequence, architecture, state) to show the user a flow or plan you designed; tick plan steps with `update_board`. After drawing a board, EXPLAIN it with the `steps` of the board (3-10, a caption each, they play like a tour) instead of a paragraph in chat, and fix what the LINT in the answer names by drawing again with the same id (the `diagram_guide` prompt has the rules). For a sequence, ER, architecture or state diagram of EXISTING code use `board_from_code` instead of drawing it: Insilode reads every node and relation from the index, so none is invented; you only choose the scope and may add notes.',
].join('\n');

export const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

type Id = string | number | null;
interface Rpc { jsonrpc?: string; id?: Id; method?: unknown; params?: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class McpServer {
	constructor(private readonly forward: Forward, private readonly log: (message: string) => void = () => undefined) { }

	/** One message (or batch) in, the reply line out; undefined when nothing is to be sent (notifications). */
	async handle(line: string): Promise<string | undefined> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		}
		if (Array.isArray(parsed)) {
			const replies = (await Promise.all(parsed.map(m => this.one(m)))).filter((r): r is object => r !== undefined);
			return replies.length ? JSON.stringify(replies) : undefined;
		}
		const reply = await this.one(parsed);
		return reply && JSON.stringify(reply);
	}

	private async one(raw: unknown): Promise<object | undefined> {
		if (!isObject(raw)) {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
		}
		const msg = raw as Rpc;
		const hasId = msg.id !== undefined;
		if (typeof msg.method !== 'string') {
			// A response to something we never sent, or garbage: nothing to answer.
			return hasId && msg.id !== null && !('result' in raw) && !('error' in raw) ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } } : undefined;
		}
		const reply = (result: unknown) => hasId ? { jsonrpc: '2.0', id: msg.id, result } : undefined;
		const fail = (code: number, message: string) => hasId ? { jsonrpc: '2.0', id: msg.id, error: { code, message } } : undefined;
		const params = isObject(msg.params) ? msg.params : {};
		switch (msg.method) {
			case 'initialize':
				return reply({
					// Echo the client's version: Claude Code is newer than any version written down here.
					protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
					capabilities: { tools: {}, prompts: {} },
					serverInfo: { name: 'insilode', version: SERVER_VERSION },
					instructions: INSTRUCTIONS,
				});
			case 'ping':
				return reply({});
			case 'tools/list':
				return reply({ tools: TOOLS });
			case 'tools/call':
				return hasId ? reply(await this.call(params)) : undefined;
			case 'resources/list':
				return reply({ resources: [] });
			case 'prompts/list':
				return reply({ prompts: promptList() });
			case 'prompts/get': {
				const prompt = getPrompt(params.name, isObject(params.arguments) ? params.arguments : {});
				return prompt ? reply(prompt) : fail(-32602, `Unknown prompt: ${String(params.name)}. Prompts: ${promptList().map(p => p.name).join(', ')}.`);
			}
			default:
				// notifications/initialized, notifications/cancelled and the like need no answer.
				return msg.method.startsWith('notifications/') ? undefined : fail(-32601, `Method not found: ${msg.method}`);
		}
	}

	private async call(params: Record<string, unknown>): Promise<ToolResult> {
		const name = params.name;
		if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
			return errorResult(`Unknown tool: ${String(name)}. Tools: ${TOOLS.map(t => t.name).join(', ')}.`);
		}
		const args = isObject(params.arguments) ? params.arguments : {};
		const tool = TOOLS.find(t => t.name === name)!;
		const missing = ((tool.inputSchema.required as string[] | undefined) ?? []).filter(k => args[k] === undefined || args[k] === null);
		if (missing.length) {
			return errorResult(`${name}: missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
		}
		try {
			return await this.forward(name, args);
		} catch (e) {
			this.log(`${name} failed: ${(e as Error)?.message ?? e}`);
			return errorResult(`${name} failed: ${(e as Error)?.message ?? e}`);
		}
	}
}

/** Reads lines from `input` until it ends, answering each on `output`. Resolves when the input is closed and every call has answered. */
export function serve(input: Readable, output: Writable, forward: Forward, log?: (message: string) => void): Promise<void> {
	const server = new McpServer(forward, log);
	const inflight = new Set<Promise<void>>();
	const rl = createInterface({ input, crlfDelay: Infinity });
	rl.on('line', line => {
		if (!line.trim()) {
			return;
		}
		const p = server.handle(line).then(out => {
			if (out !== undefined) {
				output.write(out + '\n');
			}
		}).catch(e => log?.(`handler error: ${(e as Error)?.message ?? e}`)).finally(() => inflight.delete(p));
		inflight.add(p);
	});
	return new Promise(resolve => rl.on('close', () => void Promise.all(inflight).then(() => resolve())));
}
