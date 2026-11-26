// The reading pane's guesses from the code it shows: which value a call passes into which parameter, where a reading starts,
// and the service border a call crosses. Pure, run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindings, commonFolder, crossing, firstCall, serviceOf } from '../src/read/reading.ts'

const node = (label, code, extra = {}) => ({ key: label, symbolId: null, label, sub: '', kind: 'method', file: null, startLine: 10, endLine: 20, code, children: [], ...extra })

test('flow-reading/RC01 bindings pairs the values a Java call passes with the parameters they land in', () => {
  const callee = node('BillingClient.createInvoice', 'public String createInvoice(Order order) {\n  return x;\n}')
  assert.deepEqual(bindings('billing.createInvoice(saved);', callee), [{ param: 'order', arg: 'saved' }])
})

test('flow-reading/RC01 bindings reads Python signatures, leaves self out and keeps nested calls whole', () => {
  const callee = node('InvoiceService.issue', 'def issue(self, body: dict, retries=3):\n    pass')
  assert.deepEqual(bindings('return svc.issue(load(a, b), 2)', callee), [
    { param: 'body', arg: 'load(a, b)' },
    { param: 'retries', arg: '2' },
  ])
})

test('flow-reading/RC01 bindings drops annotations and generic types with commas in them', () => {
  const callee = node('Repo.save', 'public void save(@Valid Map<String, Order> byId, final int n) {}')
  assert.deepEqual(bindings('repo.save(index, 1);', callee), [
    { param: 'byId', arg: 'index' },
    { param: 'n', arg: '1' },
  ])
})

test('flow-reading/RC01 bindings gives nothing when it cannot pair the call with the signature', () => {
  const callee = node('S.f', 'void f(int a, int b) {}')
  assert.deepEqual(bindings('s.f(1);', callee), [], 'counts differ')
  assert.deepEqual(bindings('s.g(1, 2);', callee), [], 'another method on the line')
  assert.deepEqual(bindings('s.f(1, 2);', node('S.f', null)), [], 'no code')
  assert.deepEqual(bindings('s.f(', callee), [], 'call not closed on the line')
})

test('firstCall starts a reading at the first call, or at the first line when there is none', () => {
  assert.equal(firstCall(node('A.b', 'x', { children: [{ callLine: 14 }, { callLine: 12 }] })), 12)
  assert.equal(firstCall(node('A.b', 'x')), 10)
})

test('crossing names an HTTP or message hop and the service and language it enters', () => {
  const from = node('BillingClient.createInvoice', 'x', { file: '/demo/orders-service/src/main/java/BillingClient.java' })
  const to = node('create_invoice', 'x', { file: '/demo/billing-service/app/main.py', sub: 'POST /api/invoices' })
  assert.equal(crossing('http', from, to), 'HTTP POST /api/invoices  →  billing-service · Python')
  assert.equal(crossing('message', from, { ...to, sub: 'MSG order.placed', file: '/demo/shipping-service/src/OrderEvents.java' }), 'Message order.placed  →  shipping-service')
  assert.equal(crossing('call', from, to), null)
  assert.equal(serviceOf('C:\\work\\orders-service\\src\\A.java'), 'orders-service')
})

test('flow-reading/RC01 bindings shows nothing for named or keyword arguments, **kwargs and destructured parameters', () => {
  const py = node('S.f', 'def f(self, a, b):\n    pass')
  assert.deepEqual(bindings('s.f(b=1, a=2)', py), [], 'named arguments do not pair by position')
  assert.deepEqual(bindings('s.f(x, y)', node('S.f', 'def f(a, **kwargs):\n    pass')), [], 'kwargs')
  assert.deepEqual(bindings('s.f(*rest)', node('S.f', 'def f(a, b):\n    pass')), [], 'spread argument')
  assert.deepEqual(bindings('f(opts)', node('f', 'function f({ a, b }: Opts) {}')), [], 'destructured parameter')
  assert.deepEqual(bindings('f(...xs)', node('f', 'function f(a: number) {}')), [], 'spread in TypeScript')
})

test('flow-reading/RC01 bindings never throws on names that are regex syntax', () => {
  assert.deepEqual(bindings('x.f[0](1)', node('X.f[0]', 'void f[0](int a) {}')), [])
  assert.deepEqual(bindings('a.b(1)', node('POST /api/(v1)*', 'x')), [])
  assert.deepEqual(bindings('x.get((1)', node('X.get(', 'int get((int a) {}')), [], 'an unbalanced bracket in a label')
})

test('serviceOf names the folder above src, app or lib, on Windows paths too (drive letter, backslashes, case)', () => {
  assert.equal(serviceOf('/demo/orders-service/src/main/java/A.java'), 'orders-service')
  assert.equal(serviceOf('C:\\work\\Orders-Service\\SRC\\A.java'), 'Orders-Service', 'the marker is found whatever its case')
  assert.equal(serviceOf('c:/work/billing/App/main.py'), 'billing')
  assert.equal(serviceOf(null), '')
})

test('serviceOf without a marker is the first folder below the flow\'s common folder, however the two spell the drive and the folders', () => {
  const files = ['C:\\Work\\orders\\controllers\\A.java', 'c:\\work\\Billing\\handlers\\main.py']
  const base = commonFolder(files)
  assert.deepEqual(base, ['C:', 'Work'])
  assert.equal(serviceOf('c:\\WORK\\Billing\\handlers\\main.py', base), 'Billing')
  assert.equal(serviceOf('C:\\Work\\orders\\controllers\\A.java', base), 'orders')
  assert.equal(serviceOf('/demo/billing/handlers/main.py', ['', 'demo']), 'billing', 'POSIX paths')
  // A file directly in the common folder belongs to no service of its own.
  assert.equal(serviceOf('C:\\Work\\Main.java', base), '')
})

test('serviceOf with the marker right under the common folder is the common folder\'s own name', () => {
  assert.equal(serviceOf('/demo/orders-service/src/A.java', ['', 'demo', 'orders-service']), 'orders-service')
  assert.equal(serviceOf('/demo/orders-service/src/A.java'), 'orders-service')
})

test('serviceOf: without a marker the first folder under the common one is all there is to go on', () => {
  const a = node('A.a', 'x', { file: 'C:\\w\\svc\\handlers\\a.py' })
  const b = node('B.b', 'x', { file: 'C:\\w\\svc\\services\\b.py', sub: 'POST /x' })
  const base = commonFolder([a.file, b.file])
  assert.deepEqual(base, ['C:', 'w', 'svc'])
  assert.equal(crossing('http', a, b, base), 'HTTP POST /x  →  services', 'without a marker the first folder under the common one is all there is to go on')
})

test('commonFolder is the folder every file lies under, case-insensitively; nothing when they share none', () => {
  assert.deepEqual(commonFolder(['/a/b/x.java', '/a/b/c/y.java']), ['', 'a', 'b'])
  assert.deepEqual(commonFolder(['/a/x.java']), ['', 'a'])
  assert.deepEqual(commonFolder(['C:\\a\\x.java', 'D:\\a\\y.java']), [])
  assert.deepEqual(commonFolder([null, '/a/x.java']), ['', 'a'], 'cards without a file are left out')
  assert.deepEqual(commonFolder([]), [])
})
