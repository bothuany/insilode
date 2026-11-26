// The Claude Code guard hooks in .claude/hooks enforce CLAUDE.md's rules (no desktop windows, no isolation flag on the
// developer's machine, no edits to generated output); a regex that drifts would let a command through silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(new URL('../../.claude/hooks/', import.meta.url));

function run(hook, toolInput) {
	const r = spawnSync(process.execPath, [hooks + hook], { input: JSON.stringify({ tool_input: toolInput }), encoding: 'utf8' });
	return { code: r.status, out: r.stdout };
}

test('guard-commands refuses desktop windows and the isolation flag', () => {
	for (const command of ['npm start', 'npm run start', 'cd x && npm start', 'node scripts/start.mjs', 'INSILODE_E2E_ISOLATED=1 node run.mjs', 'export INSILODE_E2E_ISOLATED=1', "$env:INSILODE_E2E_ISOLATED = '1'"]) {
		assert.equal(run('guard-commands.mjs', { command }).code, 2, command);
	}
});

test('guard-commands lets web mode, e2e scripts and searches through', () => {
	for (const command of ['npm run web -- demo', 'node scripts/start.mjs --web', 'npm run docker:e2e', 'npm run startup-check', 'grep -rn INSILODE_E2E_ISOLATED test', 'echo "INSILODE_E2E_ISOLATED=1 check"', "git commit -m 'Refuse npm start in hooks'"]) {
		const r = run('guard-commands.mjs', { command });
		assert.equal(r.code, 0, command);
		assert.equal(r.out, '', command);
	}
});

test('guard-commands asks before npm run setup', () => {
	const r = run('guard-commands.mjs', { command: 'npm run setup' });
	assert.equal(r.code, 0);
	assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'ask');
});

test('guard-paths refuses every golden output folder', () => {
	for (const folder of ['expected', 'types-expected', 'table-expected']) {
		assert.equal(run('guard-paths.mjs', { file_path: `C:\\r\\editor\\extensions\\flow-view\\test\\${folder}\\a.json` }).code, 2, folder);
	}
	assert.equal(run('guard-paths.mjs', { file_path: 'C:\\r\\editor\\extensions\\flow-view\\src\\a.ts' }).code, 0);
});
