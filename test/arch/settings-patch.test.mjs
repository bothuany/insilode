// editor/patches/flow-settings.patch sends the gear, the Settings menu item and Ctrl+, to flow-view's flow.settings, and lets a
// webview panel ask for the modal layer with the view column flow-view uses. Nothing else compiles those two ends together, so
// this checks they still agree: the command is contributed and registered, and the page asks for -4, which the patch reads as the editor's MODAL_GROUP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFileSync(`${repo}${path}`, 'utf8').replace(/\r\n/g, '\n');
const patch = read('editor/patches/flow-settings.patch');
const view = read('editor/extensions/flow-view/package.json');
const extension = read('editor/extensions/flow-view/src/extension.ts');
const settings = read('editor/extensions/flow-view/src/settings.ts');

test('the patch runs a command flow-view contributes and registers', () => {
	assert.match(patch, /executeCommand\('flow\.settings'\)/);
	assert.ok(JSON.parse(view).contributes.commands.some(c => c.command === 'flow.settings'));
	assert.match(extension, /registerCommand\('flow\.settings'/);
});

test('the modal column is the same number on both sides', () => {
	assert.match(patch, /MODAL_GROUP/);
	assert.match(settings, /MODAL_COLUMN = -4 as vscode\.ViewColumn/);
});

test('"All VS Code settings" does not run the command the patch redirects', () => {
	assert.match(settings, /\['all', 'workbench\.action\.openSettings2'\]/);
});
