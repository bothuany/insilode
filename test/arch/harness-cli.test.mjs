// The harness lint CLI (editor/extensions/flow-harness/cli/harness-lint.ts) runs in a plain Node process in CI, where there is no
// `vscode` module. The dependency-cruiser rule that keeps it off `vscode` only works while it names the entry, and the folder
// is part of `npm run arch`; this fails when either stops being true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const config = createRequire(import.meta.url)('../../.dependency-cruiser.cjs');
const ENTRY = 'editor/extensions/flow-harness/cli/harness-lint.ts';

test('a rule keeps the harness lint entry off vscode, transitively', () => {
	const rule = config.forbidden.find(r => r.name === 'headless-entries-stay-off-vscode');
	assert.ok(rule?.from.path && new RegExp(rule.from.path).test(ENTRY));
	assert.equal(rule.severity, 'error');
	assert.equal(rule.to.reachable, true);
	assert.match('vscode', new RegExp(rule.to.path));
});

test('the files it shares with the extension are in the pure harness modules rule', () => {
	const rule = config.forbidden.find(r => r.name === 'harness-logic-stays-off-vscode');
	for (const f of ['scanCore', 'scanFsHost']) {
		assert.match(`editor/extensions/flow-harness/src/${f}.ts`, new RegExp(rule.from.path), f);
	}
});

test('npm run arch cruises the cli folder, so the rule sees the entry', () => {
	const { scripts } = JSON.parse(readFileSync(repo + 'package.json', 'utf8'));
	assert.match(scripts.arch, /editor\/extensions\/flow-harness\/cli(\s|$)/);
	assert.ok(scripts['harness:lint']);
});
