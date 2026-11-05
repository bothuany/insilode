// What "Show Flow at Cursor" says when it cannot draw a flow where the cursor is or fell back to another engine
// (src/cursorMessage.ts), and which engine the canvas names for a flow.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let m
before(async () => {
	m = await load('src/cursorMessage.ts')
})
after(cleanup)

const notice = (languageId, reason, falling) => m.cursorNotice({ languageId, reason, falling })

test('outside a function: the cursor is told to move into one, and a fall-back says which engine draws', () => {
	assert.equal(notice('csharp', 'outside-function', false), 'The cursor is not inside a function: move it into one to see its flow.')
	assert.equal(notice('typescript', 'outside-function', false), 'The cursor is not inside a function: move it into one to see its flow.')
	const fell = notice('python', 'outside-function', true)
	assert.ok(fell.startsWith('The cursor is not inside a function: move it into one to see its flow.'), 'the same sentence first')
	assert.match(fell, /language server/)
})

test('index not ready: building says so, and names the language server when it draws instead', () => {
	assert.equal(notice('java', 'index-not-ready', true), 'The index is still building: showing the language server\'s flow instead.')
	assert.match(notice('java', 'index-not-ready', false), /still building: try again/)
})

test('no solution: C# says what is missing; a language that starts at its language server has nothing to say', () => {
	assert.match(notice('csharp', 'no-solution', true), /No C# solution is open: showing the language server's flow instead/)
	assert.match(notice('csharp', 'no-solution', false), /No C# solution is open: open a folder/)
	// Any other language without an index is asked of its language server first: not news.
	assert.equal(notice('swift', 'no-solution', true), undefined)
	assert.equal(notice('lua', 'no-solution', true), undefined)
	// An indexed language that got here fell back from the index.
	assert.match(notice('go', 'no-solution', true), /index has no flow for this file/)
})

test('every reason has words for every language that can reach it, and never an empty string', () => {
	for (const reason of ['outside-function', 'index-not-ready', 'no-solution']) {
		for (const falling of [true, false]) {
			for (const languageId of ['csharp', 'java', 'python', 'typescript', 'swift']) {
				const text = notice(languageId, reason, falling)
				assert.ok(text === undefined || text.length > 10, `${languageId} ${reason} ${falling}`)
			}
		}
	}
	assert.ok(notice('csharp', 'outside-function', false))
	assert.ok(notice('java', 'index-not-ready', true))
})

test('the canvas names the engine from the target kind, with a hint only for a fall-back to the language server', () => {
	assert.deepEqual(m.engineOf('poly'), { name: 'Index' })
	assert.deepEqual(m.engineOf('roslyn'), { name: 'Roslyn' })
	assert.equal(m.engineOf('changes'), undefined)
	assert.deepEqual(m.engineOf('lsp', 'swift'), { name: 'Language server' })
	assert.deepEqual(m.engineOf('lsp'), { name: 'Language server' })
	const fallback = m.engineOf('lsp', 'typescript')
	assert.equal(fallback.name, 'Language server')
	assert.match(fallback.hint, /index did not trace this flow/)
	assert.equal(fallback.note, 'the index did not trace this')
	// For C# the engine that did not trace it is Roslyn.
	const cs = m.engineOf('lsp', 'csharp')
	assert.match(cs.hint, /Roslyn did not trace this flow/)
	assert.equal(cs.note, 'Roslyn did not trace this')
})
