// The reading pane's guesses from the code it shows: which value a call passes into which parameter, where a reading starts,
// and the service border a call crosses. Pure, run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindings, crossing, firstCall, serviceOf } from '../src/read/reading.ts'

const node = (label, code, extra = {}) => ({ key: label, symbolId: null, label, sub: '', kind: 'method', file: null, startLine: 10, endLine: 20, code, children: [], ...extra })

test('bindings pairs the values a Java call passes with the parameters they land in', () => {
  const callee = node('BillingClient.createInvoice', 'public String createInvoice(Order order) {\n  return x;\n}')
  assert.deepEqual(bindings('billing.createInvoice(saved);', callee), [{ param: 'order', arg: 'saved' }])
})

test('bindings reads Python signatures, leaves self out and keeps nested calls whole', () => {
  const callee = node('InvoiceService.issue', 'def issue(self, body: dict, retries=3):\n    pass')
  assert.deepEqual(bindings('return svc.issue(load(a, b), 2)', callee), [
    { param: 'body', arg: 'load(a, b)' },
    { param: 'retries', arg: '2' },
  ])
})

test('bindings drops annotations and generic types with commas in them', () => {
  const callee = node('Repo.save', 'public void save(@Valid Map<String, Order> byId, final int n) {}')
  assert.deepEqual(bindings('repo.save(index, 1);', callee), [
    { param: 'byId', arg: 'index' },
    { param: 'n', arg: '1' },
  ])
})

test('bindings gives nothing when it cannot pair the call with the signature', () => {
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
