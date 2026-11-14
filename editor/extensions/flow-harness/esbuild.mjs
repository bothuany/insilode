// Bundles the extension into one CommonJS file the extension host can load.
import { build } from 'esbuild'
await build({
	entryPoints: ['src/extension.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	outfile: 'out/extension.js',
	external: ['vscode'],
	sourcemap: true,
	// jsonc-parser's UMD entry requires its parts at run time, which a bundle cannot follow: take its ES module build.
	mainFields: ['module', 'main'],
	logLevel: 'info',
})
// The headless harness lint (cli/harness-lint.ts): a plain Node script for CI, no `vscode`.
await build({
	entryPoints: ['cli/harness-lint.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	outfile: 'out/harness-lint.js',
	mainFields: ['module', 'main'],
	logLevel: 'info',
})
