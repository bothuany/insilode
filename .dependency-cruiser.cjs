// Architecture rules for the TypeScript side (the three extensions and the canvas), checked by `npm run arch`.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: 'no-circular',
			severity: 'error',
			comment: 'A module cycle makes load order matter and the pieces impossible to test alone.',
			from: { pathNot: 'node_modules' },
			to: { circular: true },
		},
		{
			name: 'no-cross-extension-imports',
			severity: 'error',
			comment: 'Each extension is bundled and activated on its own. They talk through registered commands, never through each other\'s source.',
			from: { path: '^editor/extensions/([^/]+)/' },
			to: { path: '^editor/extensions/([^/]+)/', pathNot: '^editor/extensions/$1/' },
		},
		{
			name: 'no-canvas-to-extension',
			severity: 'error',
			comment: 'The canvas runs in a webview: it cannot load extension-host code (Node, vscode).',
			from: { path: '^ui/' },
			to: { path: '^editor/' },
		},
		{
			name: 'no-extension-to-canvas',
			severity: 'error',
			comment: 'The extension inlines the built canvas bundle; it never imports the canvas source.',
			from: { path: '^editor/' },
			to: { path: '^ui/' },
		},
		{
			name: 'site-imports-only-canvas-and-protocol',
			severity: 'error',
			comment: 'The website (site/) is the canvas (ui/) on a fake host plus the pages around it. It reads the wire types from protocol/, and from the extensions only these vscode-free modules, so the dock and the desktop overlay are driven by the real ranking and mapping code; everything else of the real editor is data that scripts/site-data.mjs generates. React is allowed by name: this check runs where only the root dependencies are installed, and there the package does not resolve.',
			from: { path: '^site/' },
			to: { pathNot: ['^(site|ui|protocol)/', 'node_modules/', '^react(-dom)?(/|$)', '^editor/extensions/flow-agent/src/(attention|desktopModel|avatars|dockPage)\\.ts$'], dependencyTypesNot: ['npm', 'npm-dev', 'npm-peer', 'npm-optional', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'] },
		},
		{
			name: 'site-stays-off-vscode',
			severity: 'error',
			comment: 'The site runs in a plain browser: no module it reaches, through the extension files it may use or otherwise, may import `vscode`.',
			from: { path: '^site/src/' },
			to: { reachable: true, path: '^vscode$' },
		},
		{
			name: 'no-site-importers',
			severity: 'error',
			comment: 'The site is a leaf: the editor and the canvas never import it, or the real product would depend on its demo.',
			from: { path: '^(editor|ui|protocol)/' },
			to: { path: '^site/' },
		},
		{
			name: 'protocol-imports-nothing',
			severity: 'error',
			comment: 'protocol/ holds the shapes the host sends the canvas. Both sides import it, so it must not pull in either side (or anything else).',
			from: { path: '^protocol/' },
			to: { pathNot: '^protocol/' },
		},
		{
			name: 'protocol-is-type-only',
			severity: 'error',
			comment: 'protocol/ is erased from both bundles: the extension and the canvas reach it with `import type` / `export type` only.',
			from: { path: '^(editor|ui|site)/' },
			to: { path: '^protocol/', dependencyTypesNot: ['type-only'] },
		},
		{
			name: 'canvas-no-node-builtins',
			severity: 'error',
			comment: 'The canvas runs in a browser sandbox.',
			from: { path: '^(ui|site)/src/' },
			to: { dependencyTypes: ['core'] },
		},
		{
			name: 'headless-entries-stay-off-vscode',
			severity: 'error',
			comment: 'The polyglot worker (a worker thread) and the insilode MCP server (a plain Node process) have no `vscode` module: importing it, even transitively, crashes them at load.',
			from: { path: '^editor/extensions/flow-view/(src/poly/worker\\.ts|mcp/insilode-mcp\\.ts)$' },
			to: { reachable: true, path: '^vscode$' },
		},
		{
			name: 'pure-layers-stay-off-vscode',
			severity: 'error',
			comment: 'The parsing and graph modules are tested under plain Node (test/*.test.mjs). Only the host-facing files may import `vscode`.',
			from: {
				path: '^editor/extensions/flow-view/src/(poly|board|types|mcp|tour|skeleton)/',
				pathNot: [
					'/poly/(client|lspHost)\\.ts$',
					'/board/viewer\\.ts$',
					'/types/typeService\\.ts$',
					'/mcp/(bridge|handlers|planHost|register)\\.ts$',
				],
			},
			to: { path: '^vscode$' },
		},
		{
			name: 'harness-logic-stays-off-vscode',
			severity: 'error',
			comment: 'The harness map\'s matching, counting, parsing and lint modules are tested under plain Node (flow-harness/test/*.test.mjs), so none of them may reach `vscode`, even through another file. scan.ts imports effective.ts, never the other way round.',
			from: { path: '^editor/extensions/flow-harness/src/(permmatch|effective|transcript|activity|friction|xraymodel|lint|gaps|cost|memory|hookverdict)\\.ts$' },
			to: { path: '^vscode$', reachable: true },
		},
		{
			name: 'no-orphans',
			severity: 'warn',
			comment: 'A module nothing imports is dead code or a missing entry point.',
			from: {
				orphan: true,
				pathNot: ['\\.d\\.ts$', '(^|/)(esbuild|vite\\.[^/]+\\.config)\\.(mjs|ts)$', '/src/extension\\.ts$', '/poly/worker\\.ts$', '/mcp/insilode-mcp\\.ts$', '^ui/src/(webview|board/board|harness/harness)\\.tsx$', '^site/src/(canvas|home|try)\\.ts$'],
			},
			to: {},
		},
		{
			name: 'not-to-dev-dep',
			severity: 'error',
			comment: 'Bundled code must not import a package that is only a devDependency.',
			from: { path: '^(editor/extensions/[^/]+|ui|site)/src/' },
			to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'], pathNot: ['node_modules/@types/'] },
		},
	],
	options: {
		doNotFollow: { path: 'node_modules' },
		exclude: { path: ['node_modules', '/out/', '/dist', '/test/', '^editor/vscode/', '^\\.claude/', '^brag-output'] },
		// `vscode` is provided by the host at runtime; keep it as a named, unresolved module so the rules above can see it.
		tsPreCompilationDeps: true,
		combinedDependencies: false,
		enhancedResolveOptions: {
			exportsFields: ['exports'],
			conditionNames: ['import', 'require', 'node', 'default', 'types'],
			extensions: ['.ts', '.tsx', '.mjs', '.js', '.cjs', '.d.ts'],
		},
		reporterOptions: {
			dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
		},
	},
};
