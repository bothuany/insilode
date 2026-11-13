// The review navigation outside the tour, and how a card draws its removed lines. Pure files, run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cycle, findAfterReload, findCards, groupByFile, keepViewed, navKeyAction, nextUnviewed, splitName, stepKey, toggled } from '../src/review/nav.ts'
import { CHAR_W, GUTTER_W, LINE_H, toLines, toRows, layout } from '../src/layout.ts'
import { rangesOf, removedAt, tourFromChanges } from '../src/tour/review.ts'

const card = (key, label, file, plus = 1, minus = 0) => ({ key, label, file, diff: { plus, minus } })

test('groupByFile keeps the order given, files in the order they first appear', () => {
  const groups = groupByFile([card('a', 'A ▸ One', 'src\\A.cs'), card('b', 'B ▸ Two', 'src/B.cs'), card('c', 'A ▸ Three', 'src\\A.cs', 2, 3)])
  assert.deepEqual(groups.map(g => [g.name, g.rows.map(r => r.member)]), [['A.cs', ['One', 'Three']], ['B.cs', ['Two']]])
  assert.deepEqual(groups[0].rows[1], { key: 'c', owner: 'A', member: 'Three', plus: 2, minus: 3 })
})

test('splitName takes the method off the last dot', () => {
  assert.deepEqual(splitName('Ns.Svc ▸ Run'), { owner: 'Ns.Svc', member: 'Run' })
  assert.deepEqual(splitName('main'), { owner: '', member: 'main' })
})

test('stepKey wraps both ways and starts at the ends when nothing is current', () => {
  const keys = ['a', 'b', 'c']
  assert.equal(stepKey(keys, 'a', 1), 'b')
  assert.equal(stepKey(keys, 'c', 1), 'a')
  assert.equal(stepKey(keys, 'a', -1), 'c')
  assert.equal(stepKey(keys, null, 1), 'a')
  assert.equal(stepKey(keys, null, -1), 'c')
  assert.equal(stepKey(keys, 'gone', 1), 'a')
  assert.equal(stepKey([], 'a', 1), undefined)
})

test('nextUnviewed skips viewed changes and stops when none is left', () => {
  const keys = ['a', 'b', 'c']
  assert.equal(nextUnviewed(keys, 'a', new Set(['a'])), 'b')
  assert.equal(nextUnviewed(keys, 'a', new Set(['a', 'b'])), 'c')
  assert.equal(nextUnviewed(keys, 'c', new Set(['c', 'b'])), 'a')
  assert.equal(nextUnviewed(keys, 'a', new Set(keys)), undefined)
  assert.equal(nextUnviewed(['a'], 'a', new Set(['a'])), undefined)
})

test('toggled ticks and unticks without touching the old set', () => {
  const v = new Set(['a'])
  assert.deepEqual([...toggled(v, 'b')], ['a', 'b'])
  assert.deepEqual([...toggled(v, 'a')], [])
  assert.deepEqual([...v], ['a'])
})

test('findCards matches method or class names, name starts first, each card once', () => {
  const cards = [
    { key: '1', label: 'OrderService ▸ Place' },
    { key: '2', label: 'Cart ▸ PlaceholderFor' },
    { key: '3', label: 'Place ▸ Run' },
    { key: '1', label: 'OrderService ▸ Place' },
    { key: '4', label: 'Other ▸ Done' },
  ]
  assert.deepEqual(findCards(cards, 'place').map(c => c.key), ['1', '2', '3'])
  assert.deepEqual(findCards(cards, 'order serv').map(c => c.key), ['1'])
  assert.deepEqual(findCards(cards, 'zzz'), [])
  assert.deepEqual(findCards(cards, '  '), [])
})

test('cycle wraps and is safe on no matches', () => {
  assert.equal(cycle(3, 2, 1), 0)
  assert.equal(cycle(3, 0, -1), 2)
  assert.equal(cycle(0, 0, 1), 0)
})

// ---- the card's rows ----------------------------------------------------------------------------------------------------

const node = (code, diff, extra = {}) => ({ key: 'k', label: 'C ▸ M', kind: 'method', file: 'a.cs', startLine: 10, endLine: 10 + code.split('\n').length - 1, code, children: [], diff, ...extra })

test('toRows draws removed lines with the same dedent and tabs as the lines around them', () => {
  const n = node('\t\tvoid M()\n\t\t{\n\t\t\tNew();\n\t\t}', { added: [12], removed: [{ after: 11, lines: ['\t\t\tOld();', '\t\t\t\tdeeper();'] }], plus: 1, minus: 2 })
  const rows = toRows(n, toLines(n), false)
  assert.deepEqual(rows.map(r => ('del' in r ? `-${r.del}` : r.text)), ['void M()', '{', '-    Old();', '-        deeper();', '    New();', '}'])
})

test('a removed line with less indent than the card keeps its text', () => {
  const n = node('\t\tA();\n\t\tB();', { added: [], removed: [{ after: 10, lines: ['x();'] }], plus: 0, minus: 1 })
  const rows = toRows(n, toLines(n), false)
  assert.equal(rows.find(r => 'del' in r).del, 'x();')
})

test('card width accounts for a removed line longer than any current one', () => {
  const long = 'a'.repeat(60)
  const withDel = node('\tshort();', { added: [], removed: [{ after: 10, lines: [`\t${long}`] }], plus: 0, minus: 1 })
  const without = node('\tshort();', { added: [], removed: [], plus: 0, minus: 0 })
  const width = n => Number(layout(n, new Set(), new Set(), null).nodes.find(x => x.type === 'card').style.width)
  assert.equal(width(withDel), Math.round(60 * CHAR_W + GUTTER_W + 18))
  assert.equal(width(without), 320)
})

test('a card is as tall as its rows, removed ones included', () => {
  const n = node('\tA();\n\tB();', { added: [11], removed: [{ after: 10, lines: ['\tX();'] }], plus: 1, minus: 1 })
  const h = Number(layout(n, new Set(), new Set(), null).nodes.find(x => x.type === 'card').style.height)
  assert.equal(h, 44 + 3 * LINE_H + 12 + 32)
})

test('a review does not turn removed rows into highlight ranges: no unchanged line is lit and added lines keep their slots', () => {
  const n = node('\tA();\n\tB();\n\tC();', { added: [], removed: [{ after: 11, lines: ['\tX();'] }], plus: 0, minus: 1 })
  assert.deepEqual(tourFromChanges([n]).tour.steps[0].highlights, [])
  const many = node(Array.from({ length: 70 }, () => '\tA();').join('\n'), { added: [11, 12, 30, 50, 70], removed: [{ after: 10, lines: ['x'] }, { after: 40, lines: ['y'] }, { after: 60, lines: ['z'] }], plus: 5, minus: 3 })
  assert.deepEqual(tourFromChanges([many]).tour.steps[0].highlights, [[11, 12], [30, 30], [50, 50]])
  assert.deepEqual(rangesOf([30, 31, 50, 70, 11]), [[11, 11], [30, 31], [50, 50]])
  assert.equal(removedAt(12, 12), 12)
  assert.equal(removedAt(5, 12), 6)
})

const press = (key, mods = {}) => navKeyAction({ key, ctrlKey: false, altKey: false, metaKey: false, altGraph: false, ...mods })

test('navigation keys: brackets, letter aliases, find on / and f', () => {
  assert.deepEqual(['j', 'n', ']'].map(k => press(k)), ['next', 'next', 'next'])
  assert.deepEqual(['k', 'p', '['].map(k => press(k)), ['prev', 'prev', 'prev'])
  assert.deepEqual([press('v'), press('/'), press('f'), press('F')], ['viewed', 'find', 'find', 'find'])
  assert.equal(press('x'), undefined)
  assert.equal(press('ArrowRight'), undefined)
})

test('AltGr (Ctrl+Alt with the AltGraph state) types the brackets; a plain Ctrl or Alt shortcut does not', () => {
  assert.equal(press(']', { ctrlKey: true, altKey: true, altGraph: true }), 'next')
  assert.equal(press('[', { ctrlKey: true, altKey: true, altGraph: true }), 'prev')
  assert.equal(press(']', { ctrlKey: true, altKey: true }), undefined)
  assert.equal(press('j', { ctrlKey: true }), undefined)
  assert.equal(press('j', { altKey: true }), undefined)
  assert.equal(press('j', { metaKey: true }), undefined)
})

test('a viewed tick survives a reload only for the same card with the same diff', () => {
  const before = new Map([['a', '{"plus":1}'], ['b', '{"plus":2}'], ['c', '{"plus":3}']])
  const after = new Map([['a', '{"plus":1}'], ['b', '{"plus":5}'], ['d', '{"plus":3}']])
  assert.deepEqual([...keepViewed(new Set(['a', 'b', 'c', 'd', 'x']), before, after)], ['a'])
  assert.equal(keepViewed(new Set(['a']), new Map(), after).size, 0)
})

test('the find box survives a reload of the same cards, clamped, and closes for other cards', () => {
  const cards = [{ key: 'a', label: 'A ▸ Alpha' }, { key: 'b', label: 'B ▸ Alpha2' }, { key: 'c', label: 'C ▸ Other' }]
  const ids = new Set(['a', 'b', 'c'])
  assert.deepEqual(findAfterReload({ query: 'alp', index: 1 }, ids, [...cards]), { query: 'alp', index: 1 }, 'the same cards keep query and index')
  assert.deepEqual(findAfterReload({ query: 'alp', index: 5 }, ids, cards), { query: 'alp', index: 1 }, 'index clamped to the last match')
  assert.deepEqual(findAfterReload({ query: 'zzz', index: 3 }, ids, cards), { query: 'zzz', index: 0 }, 'no matches: index 0')
  assert.equal(findAfterReload({ query: 'alp', index: 0 }, ids, cards.slice(0, 2)), null, 'a card gone')
  assert.equal(findAfterReload({ query: 'alp', index: 0 }, ids, [...cards, { key: 'd', label: 'D ▸ New' }]), null, 'a card added')
  assert.equal(findAfterReload({ query: 'alp', index: 0 }, ids, [cards[0], cards[1], { key: 'x', label: 'X ▸ Y' }]), null, 'a card replaced')
  assert.equal(findAfterReload(null, ids, cards), null, 'no box stays none')
})

test('the change-set root wraps its summary and its card grows with the lines', () => {
  const root = (sub) => ({ key: 'changes', label: '2 changes', sub, kind: 'external', file: null, startLine: 0, endLine: 0, code: null, children: [] })
  const h = sub => Number(layout(root(sub), new Set(), new Set(), null).nodes.find(x => x.type === 'card').style.height)
  assert.equal(h('short'), 44)
  assert.equal(h('x'.repeat(100)), 44 + 2 * 14)
  assert.equal(h('x'.repeat(400)), 44 + 2 * 14)
})
