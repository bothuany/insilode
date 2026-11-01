// The tool descriptions stay short, every rule taken out of them is still said somewhere an agent reads, and the tour is paired with a summary.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let tools, prompts, protocol
before(async () => {
	tools = await load('src/mcp/tools.ts')
	prompts = await load('src/mcp/prompts.ts')
	protocol = await load('src/mcp/protocol.ts')
})
after(cleanup)

const promptText = name => prompts.getPrompt(name, {}).messages[0].content.text
const tool = name => tools.TOOLS.find(t => t.name === name)

test('mcp-descriptions: no tool description is over 600 characters, and none uses a markdown table', () => {
	for (const t of tools.TOOLS) {
		assert.ok(t.description.length <= 600, `${t.name} has ${t.description.length} characters: move the rules into a prompt or the server instructions`)
		assert.doesNotMatch(t.description, /^\s*\|.*\|\s*$/m, `${t.name} must not use a markdown table`)
	}
})

test('mcp-descriptions: the rules taken out of the descriptions are still in a prompt or the server instructions', () => {
	const instructions = protocol.INSTRUCTIONS
	// impact: tables, guesses, what it does not check, migrations
	for (const part of [/endpoints that write it and the endpoints that read it/, /~table\?/, /dynamic SQL, views, other services, migrations/, /adds, drops, renames/]) assert.match(instructions, part)
	// draw_board: the rules and the example are in the diagram guide
	const diagram = promptText('diagram_guide')
	for (const part of [/One question per board/, /Ground it/, /Label edges with verbs/, /never more than 2 levels/, /`order`/, /LINT/, /same `id`/, /"id":"order-flow"/, /kind `plan`/, /update_board/]) assert.match(diagram, part)
	// board_from_code: the per-kind behaviour and the scope
	for (const part of [/board_from_code/, /guessed hop is dotted/, /cardinality/, /C4 container level/, /only where the code assigns a value/, /never nodes or edges/]) assert.match(diagram, part)
	// tour and tour_control: steps, captions, marks, wait, follow-ups, edit, answering a question
	const tour = promptText('tour_guide')
	for (const part of [/3-12 steps/, /WHY/, /`marks`/, /`wait`/, /`followUps`/, /action `edit`/, /action `note`/, /moved/, /offflow/, /missing/, /same `id`/]) assert.match(tour, part)
	// check_skeleton: the stages are in the skeleton_first prompt
	const skeleton = promptText('skeleton_first')
	for (const part of [/step "handover"/, /step "just"/, /step "accept"/, /step "finish"|"finish"/, /MISSING or DIFFERS/]) assert.match(skeleton, part)
	// and each description points at the prompt that holds what it left out
	assert.match(tool('draw_board').description, /diagram_guide/)
	assert.match(tool('board_from_code').description, /diagram_guide/)
	assert.match(tool('tour').description, /tour_guide/)
	assert.match(tool('tour_control').description, /tour_guide/)
	assert.match(tool('check_skeleton').description, /skeleton_first/)
})

test('mcp-descriptions: explaining with a tour also asks for a 3 to 5 line summary in chat', () => {
	const summary = /also write a 3 to 5 line summary of the answer in chat, so a reader without the canvas still gets (it|the answer)/i
	assert.match(protocol.INSTRUCTIONS, summary)
	assert.match(promptText('tour_guide'), summary)
	assert.match(tool('tour').description, summary)
	// the old wording that made the chat message a line is gone from every place
	const everything = [protocol.INSTRUCTIONS, tool('tour').description, tool('tour_control').description, ...prompts.promptList().map(p => promptText(p.name))].join('\n')
	assert.doesNotMatch(everything, /keep your own message to (a|one) line/)
	assert.doesNotMatch(everything, /INSTEAD of a (long )?text answer/)
	assert.doesNotMatch(everything, /message you write next stays/)
	assert.doesNotMatch(everything, /chat message stays one line/)
	assert.match(protocol.INSTRUCTIONS, /SHOW it with `tour`/)
})

test('mcp-descriptions: search_sessions says its text is verbatim and may hold secrets', () => {
	const d = tool('search_sessions').description
	assert.match(d, /Returns past conversation text verbatim from this machine's agent transcripts; it can contain secrets you typed\. Use it to find what was decided, not to copy text\./)
})

test('mcp-descriptions: every tool keeps readOnlyHint, and the comment says what read-only means here', async () => {
	for (const t of tools.TOOLS) assert.equal(t.annotations.readOnlyHint, true, t.name)
	const { readFileSync } = await import('node:fs')
	const { ROOT } = await import('./helpers.mjs')
	const src = readFileSync(`${ROOT}/src/mcp/tools.ts`, 'utf8')
	assert.match(src, /never writes a file/)
	assert.match(src, /change\s+(\*\s+)?what Insilode shows/)
})
