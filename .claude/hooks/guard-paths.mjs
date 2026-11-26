// PreToolUse (Edit|Write|MultiEdit): refuse edits to generated or vendored paths. Exit 2 sends the reason back to Claude.
let input = ''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
	const path = String(JSON.parse(input || '{}').tool_input?.file_path ?? '').replaceAll('\\', '/')
	const rules = [
		[/\/editor\/vscode\//i, 'editor/vscode is the generated VS Code checkout; Insilode changes to VS Code go in editor/patches/flow-core.patch (see docs/building.md).'],
		[/\/(out|dist|dist-webview|node_modules|bin|obj)\//i, 'this is build output; edit the source and rebuild.'],
		[/package-lock\.json$/i, 'lockfiles change through npm install / npm ci, not by hand.'],
		[/\/test\/(expected|types-expected|table-expected)\//i, 'expected output is regenerated with `UPDATE=1 npm test` in flow-view, then reviewed as a diff.'],
	]
	const hit = rules.find(([re]) => re.test(path))
	if (hit) {
		process.stderr.write(`Blocked edit to ${path}: ${hit[1]}\n`)
		process.exit(2)
	}
})
