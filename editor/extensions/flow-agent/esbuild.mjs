// Bundles the extension (and the ESM-only ACP SDK) into one CommonJS file the extension host can load.
// The agent adapters are NOT bundled: they run as their own node processes from node_modules.
// The Agents page's terminal (xterm.js and its fit addon, devDependencies) is built beside it as out/xterm.js, a script the page inlines
// under its nonce, with out/xterm.css: the page code itself (agentsPage.ts) imports neither, so the website can render the same page.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
await build({
	entryPoints: ['src/extension.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	outfile: 'out/extension.js',
	external: ['vscode'],
	sourcemap: true,
	logLevel: 'info',
})
const xterm = await build({
	stdin: {
		contents: "import { Terminal } from '@xterm/xterm'\nimport { FitAddon } from '@xterm/addon-fit'\nwindow.insilodeXterm = { Terminal, FitAddon }\n",
		resolveDir: process.cwd(),
		loader: 'js',
	},
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	minify: true,
	legalComments: 'none',
	write: false,
	logLevel: 'info',
})
const js = xterm.outputFiles[0].text
// The page puts this inside a <script> element: a closing tag or a comment opener in it would end the script early or change how it parses.
if (/<\/script|<script|<!--/i.test(js)) {
	throw new Error('The xterm bundle contains markup an inline script cannot hold.')
}
mkdirSync('out', { recursive: true })
writeFileSync('out/xterm.js', js)
copyFileSync(createRequire(import.meta.url).resolve('@xterm/xterm/css/xterm.css'), 'out/xterm.css')
