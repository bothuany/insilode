// The `insilode` MCP server end to end, without Claude and without VS Code: JSON-RPC over in-memory streams,
// a fake Insilode window (the real bridge HTTP server with a scripted handler) found through a bridge dir in a temp folder.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { cleanup, load, temp } from './bundle.mjs'

let stdio, http, registry, tools
before(async () => {
	stdio = await load('src/mcp/stdio.ts')
	http = await load('src/mcp/http.ts')
	registry = await load('src/mcp/registry.ts')
	tools = await load('src/mcp/tools.ts')
})
// Whatever a test opened is closed here even when an assertion threw first, so a failure never leaves the run hanging.
const closers = []
after(async () => {
	for (const close of closers.splice(0)) {
		await close().catch(() => { })
	}
	cleanup()
})

/** Starts the server on fresh streams; `send` writes one request and resolves with the answer to it. */
function session(env, opts = {}) {
	const stdin = new PassThrough()
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const done = stdio.runStdio({ env, argv: [], cwd: opts.cwd ?? '/never-matches', stdin, stdout, stderr, alive: () => true, timeoutMs: 5000 })
	const lines = []
	const waiting = new Map()
	let buffer = ''
	stdout.on('data', d => {
		buffer += d
		let i
		while ((i = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, i)
			buffer = buffer.slice(i + 1)
			lines.push(line)
			const msg = JSON.parse(line) // stdout must carry JSON-RPC only
			waiting.get(msg.id)?.(msg)
		}
	})
	let id = 0
	closers.push(async () => { stdin.end(); await done })
	return {
		lines,
		send: (method, params) => new Promise(resolve => {
			const n = ++id
			waiting.set(n, resolve)
			stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
		}),
		raw: text => stdin.write(text + '\n'),
		close: async () => { stdin.end(); await done },
	}
}

async function fakeWindow(folders, handler) {
	const dir = temp('insilode-bridge-')
	const server = await http.startBridgeServer(handler)
	closers.push(() => server.close())
	await registry.writeBridgeFile({ pid: process.pid, port: server.port, token: server.token, workspaceFolders: folders, createdAt: Date.now() }, dir)
	return { dir, server }
}

test('mcp-protocol: initialize echoes the client protocol version and offers tools only', async () => {
	const s = session({ INSILODE_BRIDGE_DIR: temp('insilode-empty-') })
	const res = await s.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.296' } })
	assert.equal(res.result.protocolVersion, '2025-11-25')
	assert.deepEqual(res.result.capabilities, { tools: {}, prompts: {} })
	assert.equal(res.result.serverInfo.name, 'insilode')
	assert.match(res.result.instructions, /show_flow/)
	s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
	assert.deepEqual((await s.send('ping')).result, {})
	await s.close()
	assert.equal(s.lines.length, 2, 'a notification gets no answer')
})

test('mcp-protocol: tools/list has the eighteen tools, each annotated read-only with a schema', async () => {
	const s = session({ INSILODE_BRIDGE_DIR: temp('insilode-empty-') })
	const { result } = await s.send('tools/list')
	assert.deepEqual(result.tools.map(t => t.name), ['open', 'open_diff', 'get_diagnostics', 'find_symbol', 'go_to_definition', 'find_references', 'find_entry_points', 'show_flow', 'flow_text', 'impact', 'get_context', 'draw_board', 'board_from_code', 'update_board', 'tour', 'check_skeleton', 'tour_control', 'search_sessions'])
	for (const t of result.tools) {
		assert.equal(t.inputSchema.type, 'object', t.name)
		assert.equal(t.annotations.readOnlyHint, true, t.name)
		assert.ok(t.description.length > 60, `${t.name} needs a description a model can use`)
	}
	await s.close()
})

test('mcp-protocol: a tool call goes to the window that holds the folder and comes back unchanged', async () => {
	const calls = []
	const { dir, server } = await fakeWindow(['/work/app'], async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: `opened ${args.file}` }] } })
	const s = session({ INSILODE_BRIDGE_DIR: dir }, { cwd: '/work/app/src' })
	const { result } = await s.send('tools/call', { name: 'open', arguments: { file: 'src/a.cs', line: 12 } })
	assert.equal(result.content[0].text, 'opened src/a.cs')
	assert.notEqual(result.isError, true)
	assert.deepEqual(calls, [{ tool: 'open', args: { file: 'src/a.cs', line: 12 } }])
	await s.close()
	await server.close()
})

test('mcp-protocol: INSILODE_WORKSPACE decides the window, not the working directory', async () => {
	const { dir, server } = await fakeWindow(['/work/app'], async () => ({ content: [{ type: 'text', text: 'ok' }] }))
	const s = session({ INSILODE_BRIDGE_DIR: dir, INSILODE_WORKSPACE: '/work/app' }, { cwd: '/somewhere/else' })
	assert.equal((await s.send('tools/call', { name: 'get_context', arguments: {} })).result.content[0].text, 'ok')
	await s.close()
	await server.close()
})

test('mcp-protocol: no window for the folder is a readable tool error, not a protocol error', async () => {
	const { dir, server } = await fakeWindow(['/work/other'], async () => ({ content: [{ type: 'text', text: 'wrong window' }] }))
	const s = session({ INSILODE_BRIDGE_DIR: dir }, { cwd: '/work/app' })
	const res = await s.send('tools/call', { name: 'open', arguments: { file: 'a.cs' } })
	assert.equal(res.error, undefined)
	assert.equal(res.result.isError, true)
	assert.match(res.result.content[0].text, /No Insilode window has this folder open/)
	await s.close()
	await server.close()
})

test('mcp-protocol: a window whose process is gone does not count', async () => {
	const dir = temp('insilode-bridge-')
	await registry.writeBridgeFile({ pid: 2 ** 22 - 3, port: 1, token: 'abcdefgh', workspaceFolders: ['/work/app'], createdAt: 1 }, dir)
	// the real liveness check (not the always-true one of `session`)
	const out = new PassThrough()
	const input = new PassThrough()
	const done = stdio.runStdio({ env: { INSILODE_BRIDGE_DIR: dir }, argv: [], cwd: '/work/app', stdin: input, stdout: out })
	closers.push(async () => { input.end(); await done })
	input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flow_text', arguments: { id: 'x' } } }) + '\n')
	const line = await new Promise(resolve => out.once('data', d => resolve(String(d))))
	assert.match(JSON.parse(line).result.content[0].text, /No Insilode window has this folder open/)
	input.end()
	await done
})

test('mcp-protocol: a window that does not answer is reported as unreachable, and the next window is tried', async () => {
	const dir = temp('insilode-bridge-')
	// newest, but nothing listens on its port
	await registry.writeBridgeFile({ pid: process.pid, port: 1, token: 'abcdefgh', workspaceFolders: ['/work/app'], createdAt: 50 }, dir)
	const alone = session({ INSILODE_BRIDGE_DIR: dir }, { cwd: '/work/app' })
	const res = await alone.send('tools/call', { name: 'open', arguments: { file: 'a' } })
	assert.equal(res.result.isError, true)
	assert.match(res.result.content[0].text, /not reachable/)
	await alone.close()
	// an older window of the same folder that does answer
	const server = await http.startBridgeServer(async () => ({ content: [{ type: 'text', text: 'second window' }] }))
	closers.push(() => server.close())
	await registry.writeBridgeFile({ pid: 424242, port: server.port, token: server.token, workspaceFolders: ['/work/app'], createdAt: 10 }, dir)
	const both = session({ INSILODE_BRIDGE_DIR: dir }, { cwd: '/work/app' })
	assert.equal((await both.send('tools/call', { name: 'open', arguments: { file: 'a' } })).result.content[0].text, 'second window')
	await both.close()
	await server.close()
})

test('mcp-protocol: a handler failure inside the window is an error result with its message', async () => {
	const { dir, server } = await fakeWindow(['/work/app'], async () => { throw new Error('index is still building') })
	const s = session({ INSILODE_BRIDGE_DIR: dir }, { cwd: '/work/app' })
	const res = await s.send('tools/call', { name: 'find_entry_points', arguments: { query: 'delete user' } })
	assert.equal(res.result.isError, true)
	assert.match(res.result.content[0].text, /index is still building/)
	await s.close()
	await server.close()
})

test('mcp-protocol: unknown tools, missing arguments, bad JSON and unknown methods', async () => {
	const s = session({ INSILODE_BRIDGE_DIR: temp('insilode-empty-') })
	assert.match((await s.send('tools/call', { name: 'delete_everything', arguments: {} })).result.content[0].text, /Unknown tool/)
	const missing = await s.send('tools/call', { name: 'open', arguments: {} })
	assert.equal(missing.result.isError, true)
	assert.match(missing.result.content[0].text, /missing required argument: file/)
	assert.equal((await s.send('no/such/method')).error.code, -32601)
	s.raw('this is not json')
	await new Promise(r => setTimeout(r, 50))
	assert.equal(JSON.parse(s.lines.at(-1)).error.code, -32700)
	await s.close()
})

test('mcp-protocol: the window refuses requests with an Origin header, a wrong token or a foreign Host', async () => {
	const server = await http.startBridgeServer(async () => ({ content: [{ type: 'text', text: 'ok' }] }), { token: 'secret-token-1234' })
	closers.push(() => server.close())
	const nodeHttp = await import('node:http')
	const request = (headers, path = '/call', method = 'POST') => new Promise((resolve, reject) => {
		const req = nodeHttp.request({ host: '127.0.0.1', port: server.port, path, method, headers, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
		req.on('error', reject)
		req.end(method === 'POST' ? JSON.stringify({ tool: 'get_context', args: {} }) : undefined)
	})
	assert.equal(await request({ 'x-insilode-token': 'secret-token-1234' }), 200)
	assert.equal(await request({ 'x-insilode-token': 'secret-token-1234', origin: 'https://evil.example' }), 403, 'a web page cannot call it')
	assert.equal(await request({ 'x-insilode-token': 'secret-token-1234', host: 'evil.example' }), 403, 'DNS rebinding')
	assert.equal(await request({ 'x-insilode-token': 'wrong-token-123456' }), 401)
	assert.equal(await request({}), 401)
	assert.equal(await request({ 'x-insilode-token': 'secret-token-1234' }, '/ping', 'GET'), 200)
	assert.equal(await request({ 'x-insilode-token': 'secret-token-1234' }, '/other'), 404)
	await server.close()
})

test('mcp-protocol: the draw_board schema is valid JSON Schema-shaped; a board or a Mermaid source', () => {
	const draw = tools.TOOLS.find(t => t.name === 'draw_board')
	assert.equal(draw.inputSchema.required, undefined, 'board or source: the handler asks for one of them')
	assert.deepEqual(draw.inputSchema.properties.board.required, ['title'])
	assert.deepEqual(draw.inputSchema.properties.source.required, ['mermaid'])
	assert.equal(draw.inputSchema.additionalProperties, false)
	JSON.parse(JSON.stringify(tools.TOOLS)) // serializable as is
})

test('mcp-protocol: board_from_code is read-only, takes a kind and a scope, and cannot be given nodes or edges', async () => {
	const calls = []
	const { dir, server } = await fakeWindow(['/work/app'], async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: 'ok' }] } })
	const s = session({ INSILODE_BRIDGE_DIR: dir, INSILODE_WORKSPACE: '/work/app' })
	const { result } = await s.send('tools/list')
	const t = result.tools.find(x => x.name === 'board_from_code')
	assert.deepEqual(t.inputSchema.required, ['kind'])
	assert.deepEqual(t.inputSchema.properties.kind.enum, ['sequence', 'er', 'architecture', 'state'])
	assert.equal(t.inputSchema.additionalProperties, false)
	assert.equal(t.inputSchema.properties.scope.additionalProperties, false)
	assert.deepEqual(['nodes', 'edges', 'board', 'groups'].filter(k => k in t.inputSchema.properties), [], 'relations come from the code, never from the agent')
	assert.deepEqual(['id', 'file', 'method', 'line', 'symbol', 'tables', 'module', 'enum'].filter(k => !(k in t.inputSchema.properties.scope.properties)), [])
	assert.equal(t.annotations.readOnlyHint, true)
	assert.match(t.description, /draw_board for anything the code does not show/)
	assert.equal((await s.send('tools/call', { name: 'board_from_code', arguments: { kind: 'er', scope: { tables: ['orders'] } } })).result.content[0].text, 'ok')
	assert.deepEqual(calls, [{ tool: 'board_from_code', args: { kind: 'er', scope: { tables: ['orders'] } } }])
	await s.close()
	await server.close()
})

test('mcp-protocol: impact takes a table or an entity as well as a method, and says what it cannot see', async () => {
	const calls = []
	const { dir, server } = await fakeWindow(['/work/app'], async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: 'ok' }] } })
	const s = session({ INSILODE_BRIDGE_DIR: dir, INSILODE_WORKSPACE: '/work/app' })
	const { result } = await s.send('tools/list')
	const impact = result.tools.find(t => t.name === 'impact')
	assert.equal(impact.inputSchema.additionalProperties, false)
	assert.deepEqual(['table', 'entity', 'method', 'file', 'id'].filter(k => !(k in impact.inputSchema.properties)), [])
	assert.match(impact.description, /endpoints that write it and the endpoints that read it/)
	assert.match(impact.description, /dynamic SQL, views, other services, migrations/)
	assert.equal((await s.send('tools/call', { name: 'impact', arguments: { table: 'orders' } })).result.content[0].text, 'ok')
	assert.deepEqual(calls, [{ tool: 'impact', args: { table: 'orders' } }])
	await s.close()
	await server.close()
})

test('mcp-protocol: the server tells the agent to show code with `tour`, and lists the tour_guide prompt', async () => {
	const s = session({ INSILODE_BRIDGE_DIR: temp('insilode-empty-') })
	const init = await s.send('initialize', {})
	assert.match(init.result.instructions, /SHOW it with `tour`/)
	const list = await s.send('prompts/list')
	assert.deepEqual(list.result.prompts.map(p => p.name), ['skeleton_first', 'tour_guide', 'diagram_guide', 'explain_change'])
	const explain = (await s.send('prompts/get', { name: 'explain_change' })).result.messages[0].content.text
	for (const part of [/`tour`/, /"changes": true/, /get_context/, /impact/, /`table` step/, /risks/, /tour_guide/]) assert.match(explain, part)
	const got = await s.send('prompts/get', { name: 'tour_guide' })
	const guide = got.result.messages[0].content.text
	assert.equal(got.result.messages[0].role, 'user')
	for (const advice of [/flow_text/, /WHY/, /same `id`/, /user's language|language the user/, /action `note`/, /action `resume`/, /moved/, /offflow/, /missing/]) assert.match(guide, advice)
	const unknown = await s.send('prompts/get', { name: 'nope' })
	assert.equal(unknown.error.code, -32602)
	assert.match(unknown.error.message, /tour_guide/)
	await s.close()
})

test('mcp-protocol: tour and tour_control reach the window as they are; a call without the required fields never does', async () => {
	const calls = []
	const { dir, server } = await fakeWindow(['/work/app'], async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: `${tool} ok` }] } })
	const s = session({ INSILODE_BRIDGE_DIR: dir }, { cwd: '/work/app' })
	const tour = { id: 'place-order', title: 'T', steps: [{ caption: 'c', file: 'src/a.cs', method: 'A.B', line: 3, lines: [[3, 4]] }], flow: { changes: true } }
	assert.equal((await s.send('tools/call', { name: 'tour', arguments: tour })).result.content[0].text, 'tour ok')
	assert.equal((await s.send('tools/call', { name: 'tour_control', arguments: { id: 'place-order', action: 'end' } })).result.content[0].text, 'tour_control ok')
	const bad = await s.send('tools/call', { name: 'tour', arguments: { title: 'no steps' } })
	assert.equal(bad.result.isError, true)
	assert.match(bad.result.content[0].text, /missing required argument: steps/)
	assert.deepEqual(calls.map(c => c.tool), ['tour', 'tour_control'])
	assert.deepEqual(calls[0].args, tour)
	await s.close()
	await server.close()
})

test('mcp-protocol: the tour tools are described for a model and their schemas are closed', async () => {
	const tool = name => tools.TOOLS.find(t => t.name === name)
	const t = tool('tour')
	assert.deepEqual(t.inputSchema.required, ['title', 'steps'])
	assert.equal(t.inputSchema.additionalProperties, false)
	assert.equal(t.inputSchema.properties.steps.maxItems, 30)
	assert.equal(t.inputSchema.properties.steps.items.properties.caption.maxLength, 600)
	assert.equal(t.inputSchema.properties.steps.items.additionalProperties, false)
	assert.equal(t.inputSchema.properties.flow.additionalProperties, false)
	assert.deepEqual(t.inputSchema.properties.steps.items.required, ['caption'])
	assert.match(t.description, /tour_guide/)
	assert.match(t.description, /missing/)
	const c = tool('tour_control')
	assert.deepEqual(c.inputSchema.properties.action.enum, ['go', 'note', 'resume', 'end'])
	assert.equal(c.inputSchema.properties.text.maxLength, 2000)
	assert.match(c.description, /note/)
	assert.equal(c.inputSchema.additionalProperties, false)
	for (const x of [t, c]) assert.equal(x.annotations.readOnlyHint, true)
})

test('mcp-protocol: the agent session the server was started for reaches the window with each call; an odd one is dropped', async () => {
	const seen = []
	const { dir, server } = await fakeWindow(['/work/app'], async (tool, args, caller) => { seen.push(caller); return { content: [{ type: 'text', text: 'ok' }] } })
	for (const [id, expected] of [['27251515-ce1e-4d1f-bfec-1c55ae092a4b', { session: '27251515-ce1e-4d1f-bfec-1c55ae092a4b' }], ['../../etc', {}], ['a b', {}], ['x'.repeat(65), {}], [undefined, {}]]) {
		const s = session(id === undefined ? { INSILODE_BRIDGE_DIR: dir } : { INSILODE_BRIDGE_DIR: dir, INSILODE_SESSION: id }, { cwd: '/work/app' })
		await s.send('tools/call', { name: 'tour_control', arguments: { id: 'x', action: 'end' } })
		await s.close()
		assert.deepEqual(seen.pop(), expected, String(id))
	}
	await server.close()
})
