// The board panel's decisions that need no window: when an open tab comes forward, which settings the canvas may open, and which type a
// clicked file stands for. (boardPanel.ts and typeviews.ts call these; they need `vscode`, these do not.)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let req
before(async () => { req = await load('src/boardRequest.ts') })
after(cleanup)

test('reveal: an open tab comes forward only when the board was asked for, never for a redraw', () => {
	assert.equal(req.revealsExistingTab(true, undefined), false, 'update_board and redraw pass no reveal')
	assert.equal(req.revealsExistingTab(true, false), false)
	assert.equal(req.revealsExistingTab(true, true), true, 'Show Board and the type diagram commands')
	assert.equal(req.revealsExistingTab(false, true), false, 'a new tab is opened by the caller, first draw needs no reveal')
	assert.equal(req.revealsExistingTab(false, undefined), false)
})

test('empty state: the host opens only the settings on its own list, never an id taken from the message', () => {
	assert.equal(req.openableSetting('flow.types.dtoSuffixes'), 'flow.types.dtoSuffixes')
	for (const bad of ['workbench.action.openSettings', 'flow.types.maxNodes', 'flow.types.dtoSuffixes ', '', 7, undefined, null, { toString: () => 'flow.types.dtoSuffixes' }]) {
		assert.equal(req.openableSetting(bad), undefined, String(bad))
	}
})

test('Show Type in DTO Diagram from the explorer: the type a file is named for', () => {
	assert.equal(req.fileTypeName('/work/app/src/OrderDto.java'), 'OrderDto')
	assert.equal(req.fileTypeName('C:\\work\\app\\Models\\Order.cs'), 'Order')
	assert.equal(req.fileTypeName('/w/order.dto.ts'), undefined, 'a dotted name is no identifier')
	assert.equal(req.fileTypeName('/w/OrderService.test.ts'), 'OrderService')
	assert.equal(req.fileTypeName('/w/order-dto.ts'), undefined)
	assert.equal(req.fileTypeName('/w/README'), 'README')
	assert.equal(req.fileTypeName('/w/'), undefined)
})
