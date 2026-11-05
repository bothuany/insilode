// board-canvas: frames place children without overlap, elbow arrows clear every text box on random layouts, and the
// parser keeps the spec drawable. Runs the real TypeScript through test/bundle.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load, temp } from './bundle.mjs'

let layout, paint, lint, parse
before(async () => {
	layout = await load('../../../board-canvas/layout.ts')
	paint = await load('../../../board-canvas/paint.ts')
	lint = await load('../../../board-canvas/lint.ts')
	parse = await load('../../../board-canvas/parse.ts')
})
after(cleanup)

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

// A small deterministic generator, so a failing layout can be reproduced by its seed.
function rng(seed) {
	let s = seed >>> 0
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

function randomSpec(seed) {
	const r = rng(seed)
	const n = 6 + Math.floor(r() * 14)
	const elements = []
	const frames = ['f1', 'f2'].slice(0, 1 + Math.floor(r() * 2))
	for (const [i, f] of frames.entries()) elements.push({ id: f, type: 'frame', label: `Frame ${i + 1}`, frameData: { layout: ['row', 'column', 'grid'][Math.floor(r() * 3)], columns: 2 + Math.floor(r() * 2) } })
	for (let i = 0; i < n; i++) {
		const type = r() < 0.3 ? 'text' : 'rect'
		const frame = r() < 0.6 ? frames[Math.floor(r() * frames.length)] : undefined
		elements.push(type === 'text'
			? { id: `t${i}`, type, label: 'Prices are copied onto the order so a later change cannot alter it.'.slice(0, 20 + Math.floor(r() * 50)), frame }
			: { id: `r${i}`, type, label: `Service ${i}`, detail: r() < 0.5 ? 'service · Orders.cs' : undefined, frame })
	}
	const boxes = elements.filter(e => e.type !== 'frame')
	const arrows = 3 + Math.floor(r() * 6)
	for (let i = 0; i < arrows; i++) {
		const a = boxes[Math.floor(r() * boxes.length)], b = boxes[Math.floor(r() * boxes.length)]
		if (a !== b) elements.push({ id: `a${i}`, type: 'arrow', label: r() < 0.5 ? 'calls' : undefined, arrow: { from: a.id, to: b.id } })
	}
	return { title: `seed ${seed}`, layout: ['row', 'column', 'grid'][Math.floor(r() * 3)], elements }
}

test('elements never overlap and stay inside their frame, over 40 random specs', () => {
	for (let seed = 1; seed <= 40; seed++) {
		const l = layout.layoutCanvas(randomSpec(seed))
		const placed = [...l.boxes.values()].filter(p => p.el.type !== 'frame')
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				assert.ok(!overlap(placed[i].box, placed[j].box), `seed ${seed}: ${placed[i].el.id} overlaps ${placed[j].el.id}`)
			}
			const parent = placed[i].el.frame ? l.boxes.get(placed[i].el.frame) : undefined
			if (parent) {
				const b = placed[i].box, f = parent.box
				assert.ok(b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h, `seed ${seed}: ${placed[i].el.id} sticks out of ${parent.el.id}`)
			}
		}
	}
})

test('elbow arrows never run through a text box, over 40 random specs', () => {
	let arrows = 0, detours = 0
	for (let seed = 1; seed <= 40; seed++) {
		const spec = randomSpec(seed)
		const painted = paint.paintCanvas(spec, paint.DARK)
		for (const [id, r] of painted.routes) {
			arrows++
			if (r.points.length > 4) detours++
			assert.deepEqual(r.crosses, [], `seed ${seed}: arrow ${id} crosses ${r.crosses.join(', ')}`)
		}
		const findings = lint.lintGeometry(spec, painted)
		assert.deepEqual(findings.filter(f => f.level === 'warning'), [], `seed ${seed}: ${findings.map(f => f.text).join(' | ')}`)
	}
	assert.ok(arrows > 100, `the test routed ${arrows} arrows`)
	console.log(`routed ${arrows} arrows, ${detours} with a detour`)
})

test('a sample board renders to SVG and the layout follows the design numbers', () => {
	const spec = {
		title: 'Metin → Vektör', purpose: 'concept', layout: 'row',
		elements: [
			{ id: 'text', type: 'rect', label: 'Metin', detail: '"Fatura ödenmedi"' },
			{ id: 'model', type: 'frame', label: 'Model', frameData: { layout: 'row' } },
			{ id: 'tok', type: 'rect', frame: 'model', label: 'Tokenlar', detail: 'Fat · ura · öden · medi' },
			{ id: 'emb', type: 'rect', frame: 'model', label: 'Embedding', kind: 'service', inputs: [{ id: 'i', name: 'ids', type: 'int[4]' }], output: { id: 'o', name: 'E', type: 'float[4, 768]' } },
			{ id: 'pool', type: 'rect', frame: 'model', label: 'Pooling', detail: 'mean(4 token) → 1' },
			{ id: 'vec', type: 'rect', label: 'Vektör', detail: 'float[768]', origin: 'illustrative' },
			{ id: 'a1', type: 'arrow', label: 'tokenlar', arrow: { from: 'text', to: 'model' } },
			{ id: 'a2', type: 'arrow', arrow: { from: 'tok', to: 'emb', data: { shape: 'int[4]' } } },
			{ id: 'a3', type: 'arrow', arrow: { from: 'emb', to: 'pool', data: { shape: '4×768' } } },
			{ id: 'a4', type: 'arrow', label: 'pooling', arrow: { from: 'model', to: 'vec' } },
		],
	}
	const painted = paint.paintCanvas(spec, paint.DARK)
	const model = painted.layout.boxes.get('model')
	const tok = painted.layout.boxes.get('tok')
	assert.equal(tok.box.x, model.box.x + 14, 'pad 14')
	assert.equal(tok.box.y, model.box.y + 28 + 14, 'header 28 + pad 14')
	assert.equal(painted.layout.boxes.get('emb').box.x, tok.box.x + tok.box.w + 16, 'gap 16')
	assert.equal(painted.layout.boxes.get('emb').box.h, 64 + 2 * 18, 'two io rows')
	const svg = paint.toSvg(painted, paint.DARK)
	assert.match(svg, /<svg xmlns/)
	assert.match(svg, /Tokenlar/)
	assert.ok(!svg.includes('foreignObject'))
	// Written so a failing look can be opened; the folder goes with cleanup().
	writeFileSync(join(temp('insilode-canvas-'), 'sample.svg'), svg)
})

test('parseCanvas drops what cannot be drawn and says why', () => {
	const { spec, errors, notes } = parse.parseCanvas({
		title: 'T', purpose: 'code', layout: 'row',
		elements: [
			{ id: 'a', type: 'rect', label: 'A', style: { fill: '#123456', line: 'dashed', size: 'xl' } },
			{ id: 'a', type: 'rect', label: 'dup' },
			{ id: 'b', type: 'frame', frame: 'c', label: 'B' },
			{ id: 'c', type: 'frame', frame: 'b', label: 'C' },
			{ id: 'x', type: 'arrow', arrow: { from: 'a', to: 'nope' } },
			{ id: 'y', type: 'arrow', arrow: { from: 'a', to: { el: 'b', side: 'top' } } },
			{ id: 'z', type: 'widget', label: 'later' },
			{ type: 'rect' },
		],
	})
	assert.deepEqual(spec.elements.map(e => e.id), ['a', 'b', 'c', 'y'])
	assert.equal(spec.elements[0].style.fill, '#123456')
	assert.equal(spec.elements[0].style.size, undefined)
	assert.ok(errors.some(e => e.includes('duplicate id')))
	assert.ok(errors.some(e => e.includes('`nope` is not an element id')))
	assert.ok(errors.some(e => e.includes('unknown type')))
	assert.ok(errors.some(e => e.includes('missing id')))
	assert.ok(errors.some(e => e.includes('contains itself')))
	assert.ok(spec.elements.some(e => e.frame === undefined && (e.id === 'b' || e.id === 'c')), 'the cycle is broken')
	assert.equal(notes.length, 0)
	assert.throws(() => parse.parseCanvas({ title: 'T', elements: [] }), /non-empty "elements"/)
})
