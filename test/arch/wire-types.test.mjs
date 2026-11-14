// The shapes the flow-view host sends the canvas are declared once, in protocol/flow.ts, and both sides import them
// type-only (.dependency-cruiser.cjs: protocol-imports-nothing, protocol-is-type-only). A second declaration of one of
// them in an extension or the canvas would start drifting from the first, so none may exist outside protocol/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const protocol = readFileSync(join(repo, 'protocol', 'flow.ts'), 'utf8');

function sources(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const p = join(dir, e.name);
		return e.isDirectory() ? (e.name === 'node_modules' ? [] : sources(p)) : /\.tsx?$/.test(e.name) ? [p] : [];
	});
}

const extensions = join(repo, 'editor', 'extensions');
const roots = [
	...readdirSync(extensions).flatMap(name => [join(extensions, name, 'src'), join(extensions, name, 'mcp')]),
	join(repo, 'ui', 'src'),
	join(repo, 'site', 'src'),
].filter(dir => existsSync(dir));
const files = roots.flatMap(sources).map(path => ({ path: relative(repo, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));

const declared = [...protocol.matchAll(/^export (?:interface|type) (\w+)/gm)].map(m => m[1]);
// `Kind` and `EdgeKind` are common names (poly/assist.ts and board-canvas/spec.ts have their own, unrelated ones); these are the wire's alone.
const WIRE = ['FlowNode', 'FlowEdge', 'EntryPoint', 'DbSchema', 'DbColumn', 'Tour', 'TourStep', 'TourNote', 'GazeEvent', 'HostToCanvasTour', 'CanvasToHostTour'];
const declaration = name => new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|class)\\s+${name}\\b`, 'm');

test('protocol/flow.ts declares the wire types', () => {
	for (const name of WIRE) {
		assert.ok(declared.includes(name), `${name} is declared in protocol/flow.ts`);
	}
});

test('no extension or canvas file declares a wire type again', () => {
	const again = files.flatMap(f => WIRE.filter(n => declaration(n).test(f.text)).map(n => `${f.path}: ${n}`));
	assert.deepEqual(again, []);
});

test('the scan finds the declarations it is meant to guard', () => {
	assert.ok(files.some(f => f.path === 'ui/src/types.ts'), 'the canvas sources are scanned');
	assert.ok(files.some(f => f.path === 'editor/extensions/flow-view/src/providers.ts'), 'the host sources are scanned');
	assert.ok(declaration('FlowNode').test('export interface FlowNode {'));
	assert.ok(declaration('EntryPoint').test('interface EntryPoint {'));
	assert.ok(!declaration('FlowNode').test('export type { FlowNode };'));
});
