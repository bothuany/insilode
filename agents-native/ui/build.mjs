// No bundler: the page is three files plus xterm's prebuilt UMD script and stylesheet, copied from node_modules (no CDN).
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
for (const f of ['index.html', 'main.js', 'style.css']) cpSync(f, `dist/${f}`)
cpSync('node_modules/@xterm/xterm/lib/xterm.js', 'dist/xterm.js')
cpSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css')
