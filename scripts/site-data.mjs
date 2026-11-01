// Builds the site's demo data from the real code: runs the polyglot worker (the built flow-view out/polyWorker.js, no
// `vscode`) headlessly on the fictional demo project in site/demo, and writes what the editor's parts would have shown:
//   - the endpoints, each one's flow, callers and impact, for the project before and after an agent's change;
//   - one "an agent changed this" change set, drawn by flow-view's own changeSet code, and the dock's "this turn touched" summary;
//   - the two pages that sit around the canvas in the real app: the Agents dock page (flow-agent's dockPage.ts) and the desktop
//     status overlay (the page inside editor/patches/flow-desktop.patch), each with a small shim so it runs in an iframe.
//   node scripts/site-data.mjs      writes site/public/data/demo.json and site/public/pages/
//   DEMO_CHANGED=<dir>               lays <dir> over base instead of site/demo/changed (the launch film's change)
// Needs `npm ci && node esbuild.mjs` in editor/extensions/flow-view first (the worker and the tree-sitter grammars live in its out/).
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXTENSIONS, ROOT, launchSync } from './lib.mjs'

const FLOW_VIEW = join(EXTENSIONS, 'flow-view')
const FLOW_AGENT = join(EXTENSIONS, 'flow-agent')
const DEMO = join(ROOT, 'site', 'demo')
const CHANGED = process.env.DEMO_CHANGED || join(DEMO, 'changed')
const PUBLIC = join(ROOT, 'site', 'public')
const OUT = join(PUBLIC, 'data', 'demo.json')
/** The same data as a TypeScript literal that must satisfy the site's types: `npm run typecheck` in site/ then fails when the data and protocol/flow.ts disagree. */
const CHECK = join(ROOT, 'site', 'src', 'generated', 'demo-check.ts')
const flowViewDeps = createRequire(join(FLOW_VIEW, 'package.json'))

if (!existsSync(join(FLOW_VIEW, 'out', 'polyWorker.js'))) {
	console.error('The index worker is not built. Run `npm ci && node esbuild.mjs` in editor/extensions/flow-view first.')
	process.exit(1)
}

/** git with fixed identity and dates, so two runs write the same commits. */
const git = (cwd, ...args) => {
	const env = { ...process.env, GIT_AUTHOR_NAME: 'Claude Code', GIT_AUTHOR_EMAIL: 'agent@example.invalid', GIT_COMMITTER_NAME: 'Claude Code', GIT_COMMITTER_EMAIL: 'agent@example.invalid', GIT_AUTHOR_DATE: '2026-01-15T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-15T10:00:00Z' }
	const r = launchSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
	if (r.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
	}
	return r.stdout
}

/** Every file under `dir` (not .git), as paths relative to it with forward slashes. */
function walk(dir, base = dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		if (e.name === '.git') {
			return []
		}
		const p = join(dir, e.name)
		return e.isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')]
	})
}

/** A checkout on Windows may have CRLF endings; the data must not depend on it (card line numbers do not change, text would). */
function lf(dir) {
	for (const f of walk(dir)) {
		const p = join(dir, f)
		const text = readFileSync(p, 'utf8')
		if (text.includes('\r\n')) {
			writeFileSync(p, text.replace(/\r\n/g, '\n'))
		}
	}
}

/** The demo project as two commits in two folders: the services as they are (`before`), then what an agent changed (`after`: site/demo/changed over base). */
function assemble() {
	// The real name of the folder: a Windows runner's temp folder has an 8.3 short name the index would not report back.
	const before = realpathSync.native(mkdtempSync(join(tmpdir(), 'insilode-site-')))
	cpSync(join(DEMO, 'base'), before, { recursive: true })
	lf(before)
	git(before, 'init', '-q', '-b', 'main')
	git(before, 'add', '-A')
	git(before, 'commit', '-q', '-m', 'Orders, billing and shipping services')
	const after = realpathSync.native(mkdtempSync(join(tmpdir(), 'insilode-site-')))
	cpSync(before, after, { recursive: true })
	cpSync(CHANGED, after, { recursive: true })
	lf(after)
	git(after, 'add', '-A')
	git(after, 'commit', '-q', '-m', 'Add discount codes to orders')
	return { before, after }
}

/** The extension's own modules that need no `vscode`, bundled the way flow-view's tests do, so the change set is built by the real code. */
async function loadHostModules(tmp) {
	const { build } = flowViewDeps('esbuild')
	const stub = join(tmp, 'vscode-stub.cjs')
	writeFileSync(stub, 'module.exports = {}')
	const load = async (entry, name, root = FLOW_VIEW, aliases = { vscode: stub }) => {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', alias: aliases, external: ['bufferutil', 'utf-8-validate'] })
		return import(pathToFileURL(outfile).href)
	}
	return {
		changeSet: await load('src/changeSet.ts', 'changeSet'),
		turnImpact: await load('src/mcp/turnImpact.ts', 'turnImpact'),
		tableIndex: await load('src/mcp/tableIndex.ts', 'tableIndex'),
		changed: await load('src/mcp/changedMethods.ts', 'changedMethods'),
		// No stub: these must stay free of `vscode`, or the site (and this bundle) could not use them.
		dockPage: await load('src/dockPage.ts', 'dockPage', FLOW_AGENT, {}),
		avatars: await load('src/avatars.ts', 'avatars', FLOW_AGENT, {}),
	}
}

class Index {
	#worker
	#seq = 0
	ready

	constructor(folder, cacheDir) {
		this.#worker = new Worker(join(FLOW_VIEW, 'out', 'polyWorker.js'), { workerData: { roots: [folder], wasmDir: join(FLOW_VIEW, 'out', 'wasm'), cacheFile: join(cacheDir, 'cache.json') } })
		this.ready = new Promise((ok, fail) => {
			const timer = setTimeout(() => fail(new Error('the index was not ready after 60 s')), 60_000)
			this.#worker.on('message', m => {
				if (m.type === 'ready') {
					clearTimeout(timer)
					ok()
				} else if (m.type === 'log' && /^index failed/.test(m.message)) {
					fail(new Error(m.message))
				}
			})
			this.#worker.on('error', fail)
		})
	}

	request(op, ...args) {
		const id = ++this.#seq
		return new Promise((ok, fail) => {
			const onMessage = m => {
				if (m.id === id) {
					this.#worker.off('message', onMessage)
					m.error ? fail(new Error(m.error)) : ok(m.result)
				}
			}
			this.#worker.on('message', onMessage)
			this.#worker.postMessage({ id, op, args })
		})
	}

	close() {
		return this.#worker.terminate()
	}
}

const norm = s => s.replace(/\r\n/g, '\n')
const hunksOf = (before, after) => flowViewDeps('diff').structuredPatch('a', 'b', norm(before), norm(after), '', '', { context: 0 }).hunks

/** The diff of one card, in the lines of the file as it is now (the same reading as AgentChanges.cardDiff in flow-view's agentDiff.ts). */
function cardDiff(hunks, start, end) {
	const d = { added: [], removed: [], plus: 0, minus: 0 }
	for (const h of hunks) {
		const from = h.newLines ? h.newStart : h.newStart + 1
		const to = h.newLines ? h.newStart + h.newLines - 1 : h.newStart
		if (to < start || from > end) {
			continue
		}
		let line = from
		let pending = []
		for (const l of h.lines) {
			if (l.startsWith('-')) {
				pending.push(l.slice(1))
				d.minus++
			} else if (l.startsWith('+')) {
				if (pending.length) {
					d.removed.push({ after: line - 1, lines: pending })
					pending = []
				}
				if (line >= start && line <= end) {
					d.added.push(line)
				}
				d.plus++
				line++
			}
		}
		if (pending.length) {
			d.removed.push({ after: line - 1, lines: pending })
		}
	}
	return d.plus || d.minus ? d : undefined
}

/** Every string in `value` with a temp folder replaced by `/demo`, so the data names no machine and a card has the same path everywhere (ids and keys hold paths too). */
function relocate(value, ...dirs) {
	const fix = str => {
		let moved = str
		for (const dir of dirs) {
			moved = moved.split(dir).join('/demo')
		}
		return moved === str ? str : moved.split('\\').join('/')
	}
	const go = v => {
		if (typeof v === 'string') {
			return fix(v)
		}
		if (Array.isArray(v)) {
			return v.map(go)
		}
		if (v && typeof v === 'object') {
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), go(x)]))
		}
		return v
	}
	return go(value)
}

const byKey = e => `${e.http} ${e.file}`
const sorted = entries => entries.sort((a, b) => (byKey(a) < byKey(b) ? -1 : byKey(a) > byKey(b) ? 1 : 0))

/** Entries and each one's flow, callers and impact, from one index. */
async function version(index) {
	await index.ready
	const entries = sorted((await index.request('entries')).map(e => ({ ...e, source: 'poly' })))
	const flows = {}
	for (const e of entries) {
		flows[e.id] = { graph: await index.request('graph', e.id, 5), callers: await index.request('callers', e.id), impact: await index.request('impact', e.id) }
	}
	return { entries, flows }
}

// ---- the two pages around the canvas ----------------------------------------------------------------------------------

/** What VS Code gives every webview before its own page: the font variables and a transparent body. */
const WEBVIEW_BASE = `:root{--vscode-font-family:"Segoe UI Variable Text","Segoe UI Variable",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:ui-monospace,Menlo,Consolas,monospace;--vscode-editor-font-size:12px}html{color-scheme:dark}`

/** The Agents dock page, with the theme variables and an `acquireVsCodeApi` that talks to the page around it. */
function dockPage(dockHtml, themeCss) {
	// The dock page listens to every window that can post to it: it hears only the page around it (a site that frames this one could not feed it).
	const guard = `<script>(function(){var add=window.addEventListener.bind(window);window.addEventListener=function(t,f,o){if(t==='message'){var g=f;f=function(e){if(e.source===parent&&e.origin===location.origin)g(e)}}add(t,f,o)}})()</script>`
	const shim = `${guard}<script>window.acquireVsCodeApi=function(){return{postMessage:function(m){parent.postMessage({source:'insilode-dock',message:m},location.origin)}}}</script>`
	const head = `<meta name="robots" content="noindex"><style>${themeCss}</style><style>${WEBVIEW_BASE}</style>${shim}`
	if (!dockHtml.includes('<head>')) {
		throw new Error('The dock page has no <head>: flow-agent/src/dockPage.ts changed shape, and the site has to follow.')
	}
	return dockHtml.replace('<head>', () => `<head>${head}`).replace("default-src 'none';", () => "default-src 'none'; base-uri 'none'; form-action 'none';")
}

/** The desktop status overlay page: it is a string inside the core patch, so it is cut out of the patch's added lines. */
function islandPage(avatars) {
	const patch = readFileSync(join(ROOT, 'editor', 'patches', 'flow-desktop.patch'), 'utf8').replace(/\r\n/g, '\n')
	const from = patch.indexOf('+++ b/src/vs/platform/insilodeDesktop/electron-main/insilodeOverlayMainService.ts')
	const to = patch.indexOf('\ndiff --git', from)
	if (from < 0 || to < 0) {
		throw new Error('The overlay service is not in flow-desktop.patch any more: the site cannot draw the notch from it.')
	}
	const source = patch.slice(from, to).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n')
	const open = 'const PAGE = /* html */ `'
	const close = '</script></body></html>`;'
	const a = source.indexOf(open)
	const b = source.indexOf(close, a)
	const marker = /const MARKER = ('[^'\n]*');/.exec(source)
	const palette = /^\s*black: (\{[^}]*\}),/m.exec(source)
	if (a < 0 || b < 0 || !marker || !palette) {
		throw new Error('The overlay page, its marker or its palette moved in flow-desktop.patch: update scripts/site-data.mjs to read it.')
	}
	const template = source.slice(a + open.length, b + close.length - 2)
	const MARKER = new Function(`return ${marker[1]}`)()
	const page = new Function('AVATAR_CSS', 'AVATAR_SCRIPT', 'MARKER', `return \`${template}\``)(avatars.AVATAR_CSS, avatars.AVATAR_SCRIPT, MARKER)
	// The page speaks to the main process through console.info lines with a marker: here they go to the page around it.
	const shim = `<script>(function(){var info=console.info.bind(console),M=${JSON.stringify(MARKER)};console.info=function(m){if(typeof m==='string'&&m.indexOf(M)===0){try{parent.postMessage({source:'insilode-island',message:JSON.parse(m.slice(M.length))},location.origin)}catch(e){}}else{info.apply(null,arguments)}}})()</script>`
	if (!page.includes('<head>')) {
		throw new Error('The overlay page has no <head>.')
	}
	// Dark like the page around it: with another colour scheme the browser paints an opaque backdrop behind an iframe.
	// No <base> and no form: the CSP says so (the real pages leave both open).
	const html = page.replace('<head>', () => `<head><meta name="robots" content="noindex"><meta name="color-scheme" content="dark">${shim}`).replace("default-src 'none';", () => "default-src 'none'; base-uri 'none'; form-action 'none';")
	return { html, colors: new Function(`return ${palette[1]}`)() }
}

// ---- the harness map -------------------------------------------------------------------------------------------------------

/** A glob as the scan asks the workspace for files: `**`, `*` and `{a,b}`. */
const globToRegExp = glob => {
	let re = ''
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]
		if (glob.startsWith('**/', i)) {
			re += '(?:.*/)?'
			i += 2
		} else if (glob.startsWith('**', i)) {
			re += '.*'
			i += 1
		} else if (c === '*') re += '[^/]*'
		else if (c === '{') re += '(?:'
		else if (c === '}') re += ')'
		else if (c === ',') re += '|'
		else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`^${re}$`)
}

/**
 * The harness map of the demo project, from flow-harness's own scan (scan.ts): `vscode` is a stub that lists the project's files, and the
 * home folder is an empty one, so nothing of whoever builds this (their ~/.claude, their MCP servers) can end up on the site.
 */
async function scanHarness(root, tmp) {
	const { build } = flowViewDeps('esbuild')
	const stub = join(tmp, 'vscode-workspace.mjs')
	writeFileSync(stub, `
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
const root = ${JSON.stringify(root)}
const all = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'node_modules' || n === '.git' ? [] : all(p)) : [p] })
const toRe = ${globToRegExp.toString()}
// scan.ts asks once per workspace folder with a RelativePattern; the stub has one folder, so only the pattern counts.
export class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern } }
export const workspace = {
	workspaceFolders: [{ uri: { fsPath: root } }],
	async findFiles(include, exclude, max) {
		const inc = toRe(typeof include === 'string' ? include : include.pattern)
		const exc = exclude ? toRe(exclude) : undefined
		const out = []
		for (const p of all(root)) {
			const rel = relative(root, p).split(sep).join('/')
			if (inc.test(rel) && !(exc && exc.test(rel))) out.push({ fsPath: p, path: p })
			if (max && out.length >= max) break
		}
		return out
	},
}
export default { workspace, RelativePattern }
`)
	const outfile = join(tmp, 'harness-scan.mjs')
	// The ESM build of jsonc-parser: its UMD main cannot be bundled into an ES module.
	await build({ entryPoints: [join(EXTENSIONS, 'flow-harness', 'src', 'scan.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', alias: { vscode: stub }, mainFields: ['module', 'main'] })
	const home = mkdtempSync(join(tmpdir(), 'insilode-site-home-'))
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }
	// scan.ts reads the home folder when it loads: it must be the empty one by then.
	process.env.HOME = home
	process.env.USERPROFILE = home
	delete process.env.CLAUDE_CONFIG_DIR
	delete process.env.CODEX_HOME
	try {
		const { scan } = await import(pathToFileURL(outfile).href)
		const h = await scan()
		if (!h) throw new Error('The harness scan found no workspace.')
		const pick = i => ({ kind: i.kind, scope: i.scope, label: i.label, detail: i.detail, agents: i.agents, tokens: i.tokens, onDemand: i.onDemand, issues: i.issues.map(x => ({ severity: x.severity, message: x.message, fix: x.fix, line: x.line })), file: i.file, rule: i.rule && { effect: i.rule.effect }, hook: i.hook && { command: i.hook.command }, mcp: i.mcp && { id: i.mcp.id, state: i.mcp.state } })
		return { root: h.root, score: h.score, counts: h.counts, startupTokens: h.startupTokens, gaps: h.gaps.map(g => ({ key: g.key, label: g.label })), items: h.items.map(pick) }
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
		rmSync(home, { recursive: true, force: true })
	}
}

const dirs = assemble()
/**
 * The site's guided tours (site/demo/tours.json): each step names a card by its label and the lines to light by text they contain,
 * and gets its file and line numbers from the index here, so the tours cannot drift from the demo code. A step that no longer
 * finds its card or its lines stops the build.
 */
function guidedTours(version) {
	const spec = JSON.parse(readFileSync(join(DEMO, 'tours.json'), 'utf8'))
	return spec.tours.map(t => {
		const entry = version.entries.find(e => e.http === t.entry)
		if (!entry) {
			throw new Error(`tours.json: tour "${t.id}" starts at ${t.entry}, which is not an endpoint of the demo any more.`)
		}
		const cards = []
		const walk = n => {
			cards.push(n)
			n.children.forEach(c => walk(c.node))
		}
		walk(version.flows[entry.id].graph)
		const steps = t.steps.map(s => {
			const card = cards.find(n => n.label === s.card)
			if (!card) {
				throw new Error(`tours.json: tour "${t.id}" has no card "${s.card}" on the flow of ${t.entry}.`)
			}
			const step = { title: s.title, caption: s.caption, state: 'ok', at: { file: card.file, startLine: card.startLine, endLine: card.endLine, label: card.label } }
			if (s.table) {
				step.at.table = s.table
			}
			if (s.lines) {
				const code = (card.code ?? '').split('\n')
				step.highlights = s.lines.map(text => {
					const i = code.findIndex(line => line.includes(text))
					if (i < 0) {
						throw new Error(`tours.json: tour "${t.id}" lights "${text}" in ${s.card}, which no longer has that line.`)
					}
					return [card.startLine + i, card.startLine + i]
				})
			}
			return step
		})
		return { id: t.id, title: t.title, entry: entry.id, origin: 'Guided tour', source: 'file', steps, start: 0, agent: { label: 'Guide', color: '#6f86ff' } }
	})
}

const scratch = mkdtempSync(join(tmpdir(), 'insilode-site-work-'))
const indexBefore = new Index(dirs.before, scratch)
const indexAfter = new Index(dirs.after, scratch)
try {
	const { changeSet, turnImpact, tableIndex, changed, dockPage: dockModule, avatars } = await loadHostModules(scratch)
	const before = await version(indexBefore)
	const after = await version(indexAfter)
	const dir = dirs.after
	const index = indexAfter
	const entries = after.entries
	const flows = after.flows

	// The change set: what the second commit changed, drawn by the same code the editor uses for "show the changes in flow".
	const files = git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean).map(f => join(dir, f))
	// A file the change added has no earlier version: every line of it is new.
	const added = new Set(git(dir, 'diff', '--name-only', '--diff-filter=A', 'HEAD~1', 'HEAD').split('\n').filter(Boolean).map(f => join(dir, f)))
	const was = new Map(files.map(f => [f, added.has(f) ? '' : git(dir, 'show', `HEAD~1:${f.slice(dir.length + 1).split(sep).join('/')}`)]))
	const hunks = new Map(files.map(f => [f, hunksOf(was.get(f), readFileSync(f, 'utf8'))]))
	const sameFile = (a, b) => a.split(sep).join('/') === b.split(sep).join('/')
	const annotate = async root => {
		const visit = n => {
			const f = n.file && files.find(x => sameFile(x, n.file))
			const d = f && cardDiff(hunks.get(f), n.startLine, n.endLine)
			if (d) {
				n.diff = d
			}
			n.children.forEach(c => visit(c.node))
		}
		visit(root)
	}
	const tables = new tableIndex.TableIndex({
		entries: () => entries,
		poly: { isReady: true, entities: () => index.request('entities'), tables: ms => index.request('tables', ms) },
		analyzer: { isReady: false, entities: async () => undefined, tables: async () => undefined },
	})
	const providerFor = () => ({ graph: t => index.request('graph', t.id, 5), callers: async () => null, impact: async () => ({ label: 'endpoint', items: [] }) })
	const impactDeps = {
		analyzer: { isReady: false },
		poly: { isReady: true, refresh: async () => undefined, methods: f => index.request('methods', f) },
		endpoints: { cached: () => entries },
		providerFor,
		rangesOf: async f => (hunks.has(f) ? changed.rangesFromHunks(hunks.get(f)) : undefined),
		tables,
	}
	const provider = new changeSet.ChangeSetProvider({ impactOf: (fs, limits) => turnImpact.turnImpact(fs, impactDeps, limits), providerFor, annotate })
	// Each endpoint again with the agent's change on its cards: what the canvas draws once a prompt is picked in the timeline.
	for (const flow of Object.values(flows)) {
		const marked = structuredClone(flow.graph)
		await annotate(marked)
		if (JSON.stringify(marked) !== JSON.stringify(flow.graph)) {
			flow.changed = marked
		}
	}
	provider.use({ label: 'Claude Code: discount codes on orders', files })
	const root = await provider.graph()
	const impact = await provider.impact()
	const plus = f => hunks.get(f).reduce((n, h) => n + h.lines.filter(l => l.startsWith('+')).length, 0)
	const minus = f => hunks.get(f).reduce((n, h) => n + h.lines.filter(l => l.startsWith('-')).length, 0)
	const timeline = [{ id: 1, prompt: 'Add discount codes to orders: a code on the order cuts its total before it is saved and invoiced.', agent: 'Claude Code', at: Date.parse('2026-01-15T10:00:00Z'), files: files.map(file => ({ file, plus: plus(file), minus: minus(file) })) }]

	// What the dock says after the turn ("This turn touched 4 flows and table orders (4 endpoints)"): flow-view's answer to
	// `flow.agent.turnImpact`, shaped as its extension.ts hands it to the dock.
	const turn = await turnImpact.turnImpact(files, impactDeps)
	const { changed: changedMethods, tables: changedTables, ...turnRest } = turn
	const agentImpact = {
		...turnRest,
		methods: changedMethods.slice(0, 40).map(m => ({ file: m.file, name: m.name })),
		tables: changedTables.map(t => ({ table: t.table, entity: t.entity ?? t.mapped, entityChanged: !!t.entity, migration: t.migrations[0]?.name, endpoints: t.endpoints, guess: t.guess, partial: t.checked < t.of })),
		// The tables bring endpoints no changed method reaches: the dock lists those flows too.
		flows: [...turn.flows, ...turnImpact.tableEndpoints(turn)],
	}

	// The files the agent edits, by their path in the demo project (what its permission question names).
	const edits = files.map(file => ({ path: relative(dir, file).split(sep).join('/') }))

	const harness = await scanHarness(dirs.before, scratch)

	const theme = readFileSync(join(ROOT, 'site', 'src', 'theme', 'vscode-theme.css'), 'utf8')
	const island = islandPage(avatars)
	mkdirSync(join(PUBLIC, 'pages'), { recursive: true })
	writeFileSync(join(PUBLIC, 'pages', 'dock.html'), dockPage(dockModule.dockHtml(), theme))
	writeFileSync(join(PUBLIC, 'pages', 'island.html'), island.html)

	const data = relocate({ before, after: { entries, flows }, changes: { label: 'Claude Code: discount codes on orders', root, impact, timeline }, agentImpact, edits, harness, islandColors: island.colors }, dirs.before, dirs.after)
	data.tours = guidedTours(data.before)
	mkdirSync(join(OUT, '..'), { recursive: true })
	writeFileSync(OUT, `${JSON.stringify(data)}\n`)
	mkdirSync(join(CHECK, '..'), { recursive: true })
	writeFileSync(CHECK, `// Generated by scripts/site-data.mjs; checked by tsc, never imported. A field the data lacks or has the wrong type for fails here; an extra one (the index also reports the ORM name) does not.
import type { DemoData } from '../demo'

const checked = <T extends DemoData>(data: T) => data

export const demo = checked(${JSON.stringify(data)})
`)
	console.log(`site data: ${entries.length} endpoints, change set with ${files.length} files → ${OUT}`)
} finally {
	await indexBefore.close()
	await indexAfter.close()
	rmSync(dirs.before, { recursive: true, force: true })
	rmSync(dirs.after, { recursive: true, force: true })
	rmSync(scratch, { recursive: true, force: true })
}
