// PreToolUse (Bash|PowerShell): the rules in CLAUDE.md about windows and long runs, enforced for shell commands too,
// since guard-paths.mjs only sees Edit and Write. Exit 2 refuses and sends the reason back to Claude; an "ask" decision
// leaves a long but legitimate run to the user.
let input = ''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
	const command = String(JSON.parse(input || '{}').tool_input?.command ?? '')
	// Only at a command's start (line start or after ; & |), so a commit message or a grep that mentions them passes.
	const refuse = [
		[/(^|[;&|])\s*(npm\s+(run\s+)?start\b|node\s+\S*scripts[\\/]start\.mjs(?![^\n;&|]*--web))/im, 'this opens an Electron window on the developer\'s desktop. Use `npm run web` in the built-in browser pane (the probe skill), or `npm run docker:e2e` for desktop-only behaviour.'],
		[/((^|[;&|])\s*(export\s+|set\s+)?|\$env:)INSILODE_E2E_ISOLATED['"]?\s*=\s*['"]?1/im, 'INSILODE_E2E_ISOLATED=1 is set only inside Docker or Windows Sandbox by their own scripts; on this machine it lets the desktop e2e open windows. Use `npm run docker:e2e` or `npm run sandbox:e2e`.'],
	]
	const hit = refuse.find(([re]) => re.test(command))
	if (hit) {
		process.stderr.write(`Blocked command: ${hit[1]}\n`)
		process.exit(2)
	}
	if (/\bnpm\s+run\s+setup\b/i.test(command)) {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '`npm run setup` rebuilds the VS Code checkout and takes 10-20 minutes.' } }))
	}
})
