// SubagentStart / SubagentStop (implementer): the main session's Stop hooks never fire for a subagent, so a worker in its own worktree
// could report "done" without the architecture rules or the type check having run. This gate runs them in the worker's
// worktree and sends failures back (exit 2) once; on the stop right after that it lets the worker finish and shows the
// failure instead, so the orchestrator sees it and nothing loops.
//
// `node implementer-gate.mjs --remove <worktree>` removes a worker's worktree safely (see unlinkDependencies).
import { execFileSync } from 'child_process'
import { existsSync, lstatSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { ROOT, isWin, launchSync } from '../../scripts/lib.mjs'

// Windows paths compare without case (the drive letter's case differs between sources).
const fold = path => isWin ? path.toLowerCase() : path

function dependencyFolders(root) {
	const folders = ['node_modules', join('ui', 'node_modules'), join('editor', 'vscode')]
	for (const ext of readdirSync(join(root, 'editor', 'extensions'))) {
		folders.push(join('editor', 'extensions', ext, 'node_modules'))
	}
	return folders
}

// A worktree is a fresh checkout without the ignored install folders. Linking the main checkout's folders takes
// seconds where `npm run setup` takes minutes, and a junction needs no admin rights on Windows.
function linkDependencies(root, worktree) {
	for (const folder of dependencyFolders(root)) {
		const target = join(root, folder)
		const link = join(worktree, folder)
		if (existsSync(target) && !existsSync(link) && existsSync(dirname(link))) {
			symlinkSync(target, link, isWin ? 'junction' : 'dir')
		}
	}
}

// The links must be gone before anything deletes the worktree: `git worktree remove --force` on Git for Windows
// follows a junction and deletes the main checkout's folder behind it. Only the link itself is removed here.
function unlinkDependencies(root, worktree) {
	for (const folder of dependencyFolders(root)) {
		const link = join(worktree, folder)
		let stat
		try {
			stat = lstatSync(link)
		} catch {
			continue
		}
		if (stat.isSymbolicLink()) {
			isWin ? rmdirSync(link) : unlinkSync(link)
		}
	}
}

// Any link left anywhere in the worktree, without following links, so a removal never reaches outside it.
function findLink(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.name === '.git') {
			continue
		}
		if (lstatSync(path).isSymbolicLink()) {
			return path
		}
		if (entry.isDirectory()) {
			const found = findLink(path)
			if (found) {
				return found
			}
		}
	}
	return ''
}

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function output(run) {
	return `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`
}

if (process.argv[2] === '--remove') {
	const root = ROOT
	const worktree = resolve(process.argv[3] ?? '')
	if (!fold(worktree).startsWith(fold(join(root, '.claude', 'worktrees') + sep))) {
		console.error(`Not a worker worktree under .claude/worktrees: ${worktree}`)
		process.exit(1)
	}
	unlinkDependencies(root, worktree)
	const link = findLink(worktree)
	if (link) {
		console.error(`Not removed: ${link} is a link; remove it (the link only) first.`)
		process.exit(1)
	}
	git(root, ['worktree', 'remove', '--force', worktree])
	console.log(`Removed ${worktree}`)
	process.exit(0)
}

let input = ''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
	const event = JSON.parse(input || '{}')
	const retry = Boolean(event.stop_hook_active)
	const root = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd())
	const worktrees = join(root, '.claude', 'worktrees')

	// The docs do not say whether a subagent's `cwd` is its worktree, so fall back to the folder Claude Code names
	// after the agent id (`agent-<id>`).
	const cwd = resolve(event.cwd || '')
	const byId = join(worktrees, `agent-${event.agent_id}`)
	const inside = fold(cwd).startsWith(fold(worktrees + sep)) ? join(worktrees, cwd.slice(worktrees.length + 1).split(sep)[0]) : ''
	const worktree = inside || (existsSync(byId) ? byId : '')

	// At start, only link the install folders, so the worker can run tests before it reports.
	if (event.hook_event_name === 'SubagentStart') {
		if (worktree) {
			linkDependencies(root, worktree)
		}
		return
	}
	if (!worktree) {
		console.log(JSON.stringify({ systemMessage: 'Implementer gate skipped: the subagent ran without its own worktree.' }))
		return
	}

	const problems = []
	// The orchestrator merges the worker's branch, so work left uncommitted would be lost with the worktree.
	// Git for Windows ignores the junctions under `node_modules/`; elsewhere a symlink is not a directory to
	// .gitignore, so the linked folders are left out here by name.
	const left = git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
		.filter(entry => !/(^|\/)node_modules$|^editor\/vscode$/.test(entry.slice(3)))
	if (left.length > 0) {
		problems.push('Uncommitted changes are left in the worktree: commit them on its branch.')
	}

	// Changed files relative to where the worker started, which is the main checkout's HEAD (worktree.baseRef "head").
	const base = git(worktree, ['merge-base', 'HEAD', git(root, ['rev-parse', 'HEAD']).trim()]).trim()
	const changed = git(worktree, ['diff', '--name-only', '-z', base]).split('\0').filter(Boolean)
	const typescript = changed.filter(path => /\.tsx?$/.test(path) && /^(editor\/extensions|ui\/src|protocol|site\/src)\//.test(path))

	if (typescript.length > 0) {
		linkDependencies(root, worktree)

		const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
		const arch = existsSync(npmCli)
			? launchSync('node', [npmCli, 'run', '--silent', 'arch'], { cwd: worktree, encoding: 'utf8', windowsHide: true })
			: launchSync('npm', ['run', '--silent', 'arch'], { cwd: worktree, encoding: 'utf8', windowsHide: true })
		if (arch.status !== 0) {
			problems.push(`npm run arch failed:\n${output(arch).slice(-3000)}`)
		}

		const packages = new Set()
		for (const path of typescript) {
			const ext = /^editor\/extensions\/(flow-[^/]+)\//.exec(path)
			if (ext) {
				packages.add(`editor/extensions/${ext[1]}`)
			} else if (path.startsWith('ui/src/')) {
				packages.add('ui')
			}
		}
		for (const pkg of packages) {
			const tsc = pkg === 'ui'
				? join(worktree, 'ui', 'node_modules', 'typescript', 'bin', 'tsc')
				: join(worktree, 'editor', 'vscode', 'node_modules', 'typescript', 'bin', 'tsc6')
			if (!existsSync(tsc) || !existsSync(join(worktree, pkg, 'tsconfig.json'))) {
				continue
			}
			const run = launchSync('node', [tsc, '--noEmit', '-p', '.'], { cwd: join(worktree, pkg), encoding: 'utf8', windowsHide: true })
			if (run.status !== 0) {
				problems.push(`Type check failed in ${pkg}:\n${output(run).slice(-3000)}`)
			}
		}
	}

	// The worker is done once this hook lets it stop, so its links go now and its worktree is safe to delete.
	if (problems.length === 0) {
		unlinkDependencies(root, worktree)
		return
	}
	const message = problems.join('\n\n')
	if (retry) {
		unlinkDependencies(root, worktree)
		console.log(JSON.stringify({ systemMessage: `Implementer ${event.agent_id} finished with problems left:\n${message}` }))
		return
	}
	process.stderr.write(`Before you report, fix these in your worktree:\n${message}\n`)
	process.exit(2)
})
