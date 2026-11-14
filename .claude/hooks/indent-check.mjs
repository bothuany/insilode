// PostToolUse (Edit|Write|MultiEdit): the repo has no formatter, and CLAUDE.md asks every file to keep its own
// indentation: extension TypeScript uses tabs, the canvas in ui/ mostly 2 spaces (a few shared files such as
// board-canvas/spec.ts use tabs). Only the text Claude just wrote is checked, so older lines never block an edit.
// Tests and scripts are left out: they embed code in other languages (fixtures, PowerShell) with its own indentation.
// Exit 2 sends the offending lines back to Claude to fix.
import { existsSync, readFileSync } from 'fs'

let input = ''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
	const tool = JSON.parse(input || '{}').tool_input ?? {}
	const path = String(tool.file_path ?? '').replaceAll('\\', '/')

	let fallback
	if (/\/editor\/extensions\/flow-[^/]+\/(src|mcp)\/.+\.tsx?$/i.test(path)) {
		fallback = 'tabs'
	} else if (/\/ui\/src\/.+\.(tsx?|css)$/i.test(path)) {
		fallback = 'spaces'
	} else {
		return
	}

	const written = [tool.content, tool.new_string, ...(tool.edits ?? []).map(e => e?.new_string)].filter(s => typeof s === 'string').join('\n').split(/\r?\n/)
	// The file's own style wins over the folder default; a new file or one with no indented lines takes the default.
	const writtenSet = new Set(written)
	const others = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(line => !writtenSet.has(line)) : []
	const tabs = others.filter(line => /^\t/.test(line)).length
	const spaces = others.filter(line => /^ {2,}\S/.test(line)).length
	const style = tabs === spaces ? fallback : tabs > spaces ? 'tabs' : 'spaces'

	// Tabs files: a line that starts with two or more spaces (a lone space is a JSDoc ` * ` continuation).
	// Spaces files: a line that starts with a tab.
	const wrong = style === 'tabs' ? /^ {2,}\S/ : /^\t/
	const bad = written.filter(line => wrong.test(line))
	if (bad.length === 0) {
		return
	}
	const sample = bad.slice(0, 5).map(line => `  ${JSON.stringify(line.slice(0, 100))}`).join('\n')
	const rule = style === 'tabs' ? 'is indented with tabs' : 'is indented with spaces'
	process.stderr.write(`${path} ${rule}, but ${bad.length} line(s) you wrote are not:\n${sample}\nRe-indent them to match the file.\n`)
	process.exit(2)
})
