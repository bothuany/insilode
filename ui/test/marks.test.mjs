// The pen marks of a tour step on the canvas: what is accepted from the host, the caption's sentences and the clock that reveals
// the marks, and where a mark sits on a card. Pure files, run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { curveBetween, curvePoint, lineSpan, peekSpan, revealTimes, sanitizeMarks, sentenceStarts, splitSentences, visibleMarks, wavyLine, wordCount } from '../src/tour/marks.ts'
import { sanitizeStep } from '../src/tour/sanitize.ts'

// ---- sanitizeMarks -----------------------------------------------------------------------------------------------------

test('sanitizeMarks rebuilds each kind field by field and keeps only what a mark of its kind has', () => {
  const marks = sanitizeMarks([
    { kind: 'ring', lines: [71, 76], evil: '<script>', n: 5 },
    { kind: 'underline', lines: [72] },
    { kind: 'strike', lines: [80, 78], label: 'old', sentence: 2 },
    { kind: 'check', lines: [60, 60] },
    { kind: 'cross', lines: [61, 61] },
    { kind: 'badge', lines: [62, 62], n: 3 },
  ])
  assert.deepEqual(marks, [
    { kind: 'ring', lines: [71, 76] },
    { kind: 'underline', lines: [72, 72] },
    { kind: 'strike', lines: [78, 80], label: 'old', sentence: 2 },
    { kind: 'check', lines: [60, 60] },
    { kind: 'cross', lines: [61, 61] },
    { kind: 'badge', lines: [62, 62], n: 3 },
  ])
  const connect = sanitizeMarks([{ kind: 'connect', to: { file: 'C:\\w\\a.cs', startLine: 30, endLine: 52, label: 'Price.Total', extra: 1 }, label: 'price', lines: [1, 2] }])
  assert.deepEqual(connect, [{ kind: 'connect', to: { file: 'C:\\w\\a.cs', startLine: 30, endLine: 52, label: 'Price.Total' }, label: 'price' }])
})

test('sanitizeMarks drops what cannot be drawn and clamps the rest', () => {
  assert.equal(sanitizeMarks(undefined), undefined)
  assert.equal(sanitizeMarks('ring'), undefined)
  assert.equal(sanitizeMarks([]), undefined)
  assert.equal(sanitizeMarks([null, 'ring', 5, [], { kind: 'sparkle', lines: [1] }, { kind: 'ring' }, { kind: 'ring', lines: [] }, { kind: 'ring', lines: [1, 2, 3] }, { kind: 'ring', lines: [0, 3] }, { kind: 'ring', lines: [1.5] }, { kind: 'ring', lines: [20_000_000] }]), undefined)
  assert.equal(sanitizeMarks([{ kind: 'badge', lines: [1] }, { kind: 'badge', lines: [1], n: 0 }, { kind: 'badge', lines: [1], n: 100 }, { kind: 'badge', lines: [1], n: 1.5 }]), undefined, 'a badge needs a number from 1 to 99')
  assert.equal(sanitizeMarks([{ kind: 'connect' }, { kind: 'connect', to: { file: '', startLine: 1, endLine: 2 } }, { kind: 'connect', to: { file: 'a', startLine: 0, endLine: 2 } }, { kind: 'connect', to: 'a.cs' }]), undefined)
  const [mark] = sanitizeMarks([{ kind: 'ring', lines: [3, 4], label: 'x'.repeat(100), sentence: 9 }])
  assert.equal(mark.label.length, 40, 'the label is cut')
  assert.equal(mark.sentence, undefined, 'a sentence outside 1..6 is no sentence')
  assert.equal(sanitizeMarks([{ kind: 'ring', lines: [3], label: '   ' }])[0].label, undefined)
  const [far] = sanitizeMarks([{ kind: 'connect', to: { file: 'f'.repeat(2000), startLine: 1, endLine: 2, label: 'l'.repeat(500) } }])
  assert.deepEqual([far.to.file.length, far.to.label.length], [1000, 200])
})

test('sanitizeMarks keeps six marks at most, and the good ones after a bad one', () => {
  const many = [{ kind: 'sparkle' }, ...Array.from({ length: 9 }, (_, i) => ({ kind: 'ring', lines: [i + 1] }))]
  const marks = sanitizeMarks(many)
  assert.equal(marks.length, 6)
  assert.deepEqual(marks[0].lines, [1, 1])
})

test('sanitizeStep takes the marks through sanitizeMarks', () => {
  const step = sanitizeStep({ caption: 'c', state: 'ok', marks: [{ kind: 'ring', lines: [3, 4], x: 1 }, { kind: 'nope' }] })
  assert.deepEqual(step.marks, [{ kind: 'ring', lines: [3, 4] }])
  assert.equal(sanitizeStep({ caption: 'c', marks: [{ kind: 'nope' }] }).marks, undefined)
})

// ---- sentences -----------------------------------------------------------------------------------------------------------

test('splitSentences cuts at . ! ? followed by a space or the end, and at line breaks', () => {
  assert.deepEqual(splitSentences('One. Two! Three? Four'), ['One.', 'Two!', 'Three?', 'Four'])
  assert.deepEqual(splitSentences('First line\nSecond line\n\n- item one\n- item two'), ['First line', 'Second line', '- item one', '- item two'])
  assert.deepEqual(splitSentences('Really?! Yes.'), ['Really?!', 'Yes.'])
  assert.deepEqual(splitSentences('He said "stop." Then left.'), ['He said "stop."', 'Then left.'])
})

test('splitSentences keeps numbers, abbreviations and ellipses intact', () => {
  assert.deepEqual(splitSentences('The price is 3.5 times v1.2 of it. Next.'), ['The price is 3.5 times v1.2 of it.', 'Next.'])
  assert.deepEqual(splitSentences('Use a cache, e.g. Redis, here. Then go.'), ['Use a cache, e.g. Redis, here.', 'Then go.'])
  assert.deepEqual(splitSentences('That is, i.e. the same. Done.'), ['That is, i.e. the same.', 'Done.'])
  assert.deepEqual(splitSentences('Cache vs. database is a choice. Pick one.'), ['Cache vs. database is a choice.', 'Pick one.'])
  assert.deepEqual(splitSentences('Locks, queues, etc. Then the rest.'), ['Locks, queues, etc.', 'Then the rest.'], 'an abbreviation before a capital ends the sentence')
  assert.deepEqual(splitSentences('Wait... then it runs. Yes'), ['Wait... then it runs.', 'Yes'])
  assert.deepEqual(splitSentences('It fails... Nothing is saved.'), ['It fails...', 'Nothing is saved.'])
})

test('splitSentences never cuts inside a backtick code span or a fence', () => {
  assert.deepEqual(splitSentences('Call `order.Place(). Now` first. Then `x.y?` last.'), ['Call `order.Place(). Now` first.', 'Then `x.y?` last.'])
  assert.deepEqual(splitSentences('Run it:\n```js\nfoo(). bar()\nbaz()\n```\nDone.'), ['Run it:', '```js\nfoo(). bar()\nbaz()\n```', 'Done.'])
})

test('splitSentences: one sentence stays one, and an empty caption is one empty sentence', () => {
  assert.deepEqual(splitSentences('Only one sentence here'), ['Only one sentence here'])
  assert.deepEqual(splitSentences('  Padded.  '), ['Padded.'])
  assert.deepEqual(splitSentences(''), [''])
  assert.deepEqual(splitSentences('   '), [''])
  assert.deepEqual(splitSentences('...'), ['...'])
})

test('wordCount counts what a reader reads: markdown marks and bare bullets are not words', () => {
  assert.equal(wordCount('The **price** is `copied` here.'), 5)
  assert.equal(wordCount('- a list item'), 3)
  assert.equal(wordCount('[a link](http://x.y/z) now'), 3)
  assert.equal(wordCount(''), 0)
})

test('sentenceStarts: the first at 0, the next after the words before it at 2.6 a second, with a floor of 250 ms', () => {
  // 13 words / 2.6 = 5 s.
  const thirteen = 'one two three four five six seven eight nine ten eleven twelve thirteen.'
  assert.deepEqual(sentenceStarts(`${thirteen} Next one here.`), [0, 5000])
  // 5 words take 1923 ms (rounded), one word 385.
  assert.deepEqual(sentenceStarts('one two three four five. Second. Third.'), [0, 1923, 2308])
  assert.deepEqual(sentenceStarts('Hi. Yo. Ok.'), [0, 385, 769], 'one word takes 385 ms')
  assert.deepEqual(sentenceStarts('... Next.'), [0, 250], 'a sentence of no words still takes the floor')
  assert.deepEqual(sentenceStarts(''), [0])
})

// ---- which marks are drawn when ------------------------------------------------------------------------------------------

const ring = (sentence) => ({ kind: 'ring', lines: [1, 1], ...(sentence ? { sentence } : {}) })
const stepOf = (marks, caption = 'one two three four five. Second one. Third one here now.') => ({ caption, marks })

test('visibleMarks shows a mark once its caption sentence has started; a mark with no sentence is on the first', () => {
  const step = stepOf([ring(), ring(2), ring(3)])
  // starts: 0, 1923, 1923 + 769 = 2692
  assert.deepEqual(sentenceStarts(step.caption), [0, 1923, 2692])
  assert.equal(visibleMarks(step, 0, false).length, 1)
  assert.equal(visibleMarks(step, 1922, false).length, 1)
  assert.equal(visibleMarks(step, 1923, false).length, 2)
  assert.equal(visibleMarks(step, 2692, false).length, 3)
  assert.deepEqual(visibleMarks(step, 0, false), [step.marks[0]])
})

test('visibleMarks with showAll gives every mark whatever the time; a step without marks gives none', () => {
  const step = stepOf([ring(), ring(3)])
  assert.equal(visibleMarks(step, 0, true).length, 2)
  assert.deepEqual(visibleMarks({ caption: 'c' }, 5000, false), [])
  assert.deepEqual(visibleMarks({ caption: 'c' }, 5000, true), [])
})

test('a sentence beyond the count appears with the last sentence', () => {
  const step = stepOf([ring(6)], 'Only one sentence here')
  assert.equal(visibleMarks(step, 0, false).length, 1, 'one sentence: every mark is on it')
  const two = stepOf([ring(5)], 'One two three four five. Six.')
  assert.equal(visibleMarks(two, 1000, false).length, 0)
  assert.equal(visibleMarks(two, 1923, false).length, 1, 'the last sentence starts at 1923')
})

test('revealTimes lists each moment a mark appears once, in order, without the start', () => {
  const step = stepOf([ring(), ring(3), ring(2), ring(3), ring(9)])
  assert.deepEqual(revealTimes(step), [1923, 2692])
  assert.deepEqual(revealTimes({ caption: 'c' }), [])
})

// ---- where a mark sits ---------------------------------------------------------------------------------------------------

test('lineSpan: from the first drawn row of the range to the last, with gaps in a skeleton left out', () => {
  const rows = [{ no: 10 }, { no: 11 }, { gap: 5, from: 12 }, { no: 17 }, { no: 18 }, { del: 'x', after: 18, i: 0 }, { no: 19 }]
  assert.deepEqual(lineSpan(rows, [10, 11], 50, 18), { y1: 50, y2: 86 })
  assert.deepEqual(lineSpan(rows, [11, 17], 50, 18), { y1: 68, y2: 50 + 4 * 18 }, 'a range over a gap spans what is drawn')
  assert.deepEqual(lineSpan(rows, [19, 40], 0, 10), { y1: 60, y2: 70 })
  assert.equal(lineSpan(rows, [12, 16], 0, 10), undefined, 'a range that sits entirely in the gap is not drawn')
  assert.equal(lineSpan([], [1, 2], 0, 10), undefined)
})

test('peekSpan: rows count from the peek\'s first line and stop at the rows it shows', () => {
  assert.deepEqual(peekSpan(20, 10, [22, 23], 100, 18), { y1: 136, y2: 172 })
  assert.deepEqual(peekSpan(20, 10, [15, 21], 100, 18), { y1: 100, y2: 136 }, 'cut at the top')
  assert.deepEqual(peekSpan(20, 10, [28, 40], 0, 10), { y1: 80, y2: 100 }, 'cut at the bottom')
  assert.equal(peekSpan(20, 10, [30, 31], 0, 10), undefined)
  assert.equal(peekSpan(20, 10, [1, 19], 0, 10), undefined)
})

test('curveBetween leaves from the nearest edges: side to side when the cards sit apart, else top to bottom', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 }
  const right = curveBetween(a, { x: 300, y: 100, w: 100, h: 60 })
  assert.deepEqual([right.from, right.to], [{ x: 100, y: 25 }, { x: 300, y: 130 }])
  assert.ok(right.c1.x > right.from.x && right.c2.x < right.to.x, 'it leaves and arrives horizontally')
  const left = curveBetween({ x: 300, y: 0, w: 100, h: 50 }, a)
  assert.deepEqual([left.from, left.to], [{ x: 300, y: 25 }, { x: 100, y: 25 }])
  const below = curveBetween(a, { x: 20, y: 200, w: 100, h: 50 })
  assert.deepEqual([below.from, below.to], [{ x: 50, y: 50 }, { x: 70, y: 200 }])
  assert.ok(below.c1.y > below.from.y && below.c2.y < below.to.y)
  const above = curveBetween({ x: 20, y: 200, w: 100, h: 50 }, a)
  assert.deepEqual([above.from, above.to], [{ x: 70, y: 200 }, { x: 50, y: 50 }])
  const mid = curvePoint(right, 0.5)
  assert.ok(mid.x > 100 && mid.x < 300 && mid.y > 25 && mid.y < 130)
  assert.deepEqual(curvePoint(right, 0), right.from)
  assert.deepEqual(curvePoint(right, 1), right.to)
})

test('wavyLine is a path from x1 to x2 at the given height, drawn in pieces', () => {
  const d = wavyLine(10, 94, 40)
  assert.match(d, /^M10\.0 40\.0( q[-\d.]+ [-\d.]+ [-\d.]+ 0)+$/)
  assert.equal(d.split('q').length - 1, 6)
  assert.equal(wavyLine(0, 5, 0).split('q').length - 1, 1, 'a short line is one piece')
})
