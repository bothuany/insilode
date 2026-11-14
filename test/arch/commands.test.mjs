// The extensions call each other through command ids (flow.*, flowHarness.*, flow-agent.*), and most callers swallow
// the error (`.catch(() => undefined)`), so a renamed or removed command fails silently. Every id one of them invokes
// must be registered by one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const extensions = join(repo, 'editor', 'extensions');
const OURS = /^(flow|flowHarness|flow-agent)[.-]/;

function sources(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const p = join(dir, e.name);
		return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
	});
}

const files = readdirSync(extensions)
	.map(name => join(extensions, name, 'src'))
	.filter(dir => existsSync(dir))
	.flatMap(sources)
	.map(path => ({ path: relative(repo, path), text: readFileSync(path, 'utf8') }));
const all = files.map(f => f.text).join('\n');

// Commands that VS Code core registers, through a workbench contribution in an Insilode patch (editor/patches), rather than
// an extension. The extensions may invoke these too; the last test checks that a patch really registers each one.
// flow.desktop.*: the app badge and the desktop status overlay (flow-desktop.patch). They exist in the desktop app only,
// so flow-agent (src/desktop.ts) looks them up with getCommands() before calling them.
// _insilode.terminal.setDimensions: the size of a real terminal, which an extension cannot set; the Agents page's terminal panes
// call it (flow-core.patch, web and desktop alike; flow-agent src/termHost.ts).
// _insilode.agents.openWindow: a compact auxiliary window that shows one editor only, which the Agents page is created in (flow-core.patch,
// auxiliaryEditorPart.ts; flow-agent src/agentsPanel.ts asks on the desktop and falls back to a tab when the command is missing).
const CORE = ['flow.desktop.setBadge', 'flow.desktop.setOverlay', '_insilode.terminal.setDimensions', '_insilode.agents.openWindow'];
const patchDir = join(repo, 'editor', 'patches');
const patches = readdirSync(patchDir).filter(f => f.endsWith('.patch')).map(f => readFileSync(join(patchDir, f), 'utf8')).join('\n');

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `const Command = { showEntry: 'flow.showEntry', ... } as const` and `const FOCUS_TYPE = 'flow.types.focusType'`.
// The calling file's own definition wins; otherwise every file that defines the name is a candidate. A key is only
// looked up inside its own (flat) object. `defined` says whether the name is a constant at all: `m.command` is not.
function constant(name, key, here) {
	const find = text => {
		if (!key) {
			const v = new RegExp(String.raw`\bconst ${name}\s*=\s*['"]([^'"]+)['"]`).exec(text)?.[1];
			return { defined: v !== undefined, value: v };
		}
		const body = new RegExp(String.raw`\bconst ${name}\s*=\s*\{([^}]*)\}`).exec(text)?.[1];
		return { defined: body !== undefined, value: body && new RegExp(String.raw`(?:^|[\s,{])${key}\s*:\s*['"]([^'"]+)['"]`).exec(body)?.[1] };
	};
	const own = find(here);
	const found = own.defined ? [own] : files.map(f => find(f.text)).filter(r => r.defined);
	return { defined: found.length > 0, values: found.map(r => r.value).filter(Boolean) };
}

function ids(call) {
	const call_ = new RegExp(String.raw`\b${call}\(\s*(?:['"` + '`' + String.raw`]([^'"` + '`' + String.raw`]+)['"` + '`' + String.raw`]|(\w+)(?:\.(\w+))?)`, 'g');
	const out = [];
	for (const { path, text } of files) {
		for (const m of text.matchAll(call_)) {
			const where = `${path}:${text.slice(0, m.index).split('\n').length}`;
			if (m[1]) {
				out.push({ id: m[1], where });
				continue;
			}
			const { defined, values } = constant(m[2], m[3], text);
			if (defined && values.length === 0) {
				// Command.ghost where Command has no `ghost`: a renamed or removed key.
				out.push({ id: `${m[2]}.${m[3]} (not in ${m[2]})`, where, unresolved: true });
			}
			for (const id of values) {
				out.push({ id, where });
			}
		}
	}
	return out;
}

test('every command one extension invokes is registered by one of them', () => {
	const registered = ids('registerCommand').map(r => r.id);
	// `flow-agent.pickSkill.${kind}`
	const templates = registered.filter(id => id.includes('${'))
		.map(id => new RegExp('^' + id.split(/\$\{[^}]+\}/).map(escape).join('[\\w-]+') + '$'));
	const isRegistered = id => registered.includes(id) || CORE.includes(id) || templates.some(r => r.test(id));
	const missing = ids('executeCommand').filter(c => c.unresolved || (OURS.test(c.id) && !isRegistered(c.id)));
	assert.deepEqual(missing, []);
});

test('the scan finds the calls it is meant to guard', () => {
	const called = ids('executeCommand').map(c => c.id);
	const registered = ids('registerCommand').map(c => c.id);
	for (const id of ['flow.agentTurn', 'flow.agentDidEdit', 'flowHarness.recordPermission']) {
		assert.ok(called.includes(id), `${id} is invoked`);
	}
	assert.ok(registered.includes('flow.showEntry'), 'registrations through a constant (Command.showEntry) resolve');
});

test('every command core registers for the extensions is registered by a patch, and invoked', () => {
	const called = ids('executeCommand').map(c => c.id);
	for (const id of CORE) {
		assert.ok(patches.includes(`CommandsRegistry.registerCommand('${id}'`), `${id} is registered in editor/patches`);
		assert.ok(called.includes(id), `${id} is invoked by an extension (else drop it from CORE)`);
	}
});
