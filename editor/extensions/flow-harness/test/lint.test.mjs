// The harness lint (src/lint.ts): mistakes in instructions, rules, skills, hooks and permission rules that agents never
// report. Every case is a small synthetic file.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let l
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-lint-'))
	const outfile = join(tmp, 'lint.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'lint.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	l = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const base = { files: [], hooks: [], rules: [], cwd: '/w', home: '/h', projectFiles: ['src/a.ts', 'src/ui/b.tsx', 'docs/x.md', 'package.json'] }
const run = input => l.lint({ ...base, ...input })
const file = (label, kind, text) => ({ file: `/w/${label}`, label, kind, text })
const codes = findings => findings.map(f => `${f.code}@${f.line}`)

test('a paths glob that matches no file is dead; a matching one is fine', () => {
	const f = run({ files: [file('.claude/rules/a.md', 'claude-rule', '---\npaths:\n  - "src/**/*.ts"\n  - "lib/**"\n---\nUse tabs.\n')] })
	assert.deepEqual(codes(f), ['dead-glob@1'])
	assert.match(f[0].message, /lib\/\*\* matches no file/)
	assert.match(f[0].fix, /relative to the project root/)
	assert.equal(run({ files: [file('.claude/rules/a.md', 'claude-rule', '---\npaths: "src/**/*.{ts,tsx}"\n---\nx\n')] }).length, 0, 'braces expand')
	assert.equal(run({ files: [file('.claude/rules/a.md', 'claude-rule', '---\npaths: "lib/**"\n---\nx\n')], projectFilesTruncated: true }).length, 0, 'a truncated file list gives no verdict at all (the scan says it was cut)')
	assert.equal(run({ files: [file('.cursor/rules/a.mdc', 'cursor-rule', '---\nglobs: docs/*.md\n---\nx\n')] }).length, 0, "Cursor's globs key")
})

test('frontmatter YAML would reject: an unquoted * alias, a tab, a line that is not key: value, no closing ---', () => {
	const alias = run({ files: [file('.claude/rules/a.md', 'claude-rule', '---\npaths: **/*.ts\n---\nx\n')] })
	assert.equal(alias[0].code, 'bad-frontmatter')
	assert.equal(alias[0].severity, 'error')
	assert.match(alias[0].message, /alias.*loads for every file/)
	assert.equal(alias[0].fix, 'Quote it: paths: "**/*.ts", or write the globs as a list of quoted items')
	assert.deepEqual(codes(run({ files: [file('.claude/rules/b.md', 'claude-rule', '---\n\tpaths: "src/**"\n---\n')] })).slice(0, 1), ['bad-frontmatter@1'])
	assert.deepEqual(codes(run({ files: [file('.claude/rules/c.md', 'claude-rule', '---\npaths: "src/**"\njust words\n---\n')] })), ['bad-frontmatter@2'])
	assert.deepEqual(codes(run({ files: [file('.claude/rules/d.md', 'claude-rule', '---\npaths: "src/**"\nUse tabs.\n')] })), ['bad-frontmatter@0'])
	assert.equal(run({ files: [file('.claude/rules/e.md', 'claude-rule', '---\n# a comment\npaths:\n  - "src/**"\ndescription: >\n  long text\n---\n')] }).length, 0, 'comments, lists and folded text are fine')
})

test("each tool's own key: globs in a Claude rule and paths in a Cursor rule are ignored", () => {
	assert.deepEqual(codes(run({ files: [file('.claude/rules/a.md', 'claude-rule', '---\nglobs: "src/**"\n---\n')] })), ['wrong-key@1'])
	assert.deepEqual(codes(run({ files: [file('.cursor/rules/a.mdc', 'cursor-rule', '---\npaths: "src/**"\n---\n')] })), ['wrong-key@1'])
})

test('skills and subagents: a missing description, a bad skill name, a vague description', () => {
	assert.deepEqual(codes(run({ files: [file('.claude/agents/r.md', 'agent', '---\nname: r\n---\nYou review.\n')] })), ['no-description@0'])
	assert.deepEqual(codes(run({ files: [file('.claude/agents/r.md', 'agent', 'You review.\n')] })), ['no-frontmatter@0'])
	assert.deepEqual(codes(run({ files: [file('.claude/skills/x/SKILL.md', 'skill', '---\nname: My Skill\ndescription: Deploys the app to staging when asked to ship.\n---\n')] })), ['bad-name@1'])
	assert.deepEqual(codes(run({ files: [file('.claude/skills/x/SKILL.md', 'skill', '---\nname: ship\ndescription: Deploys.\n---\n')] })), ['vague-description@2'])
	assert.deepEqual(codes(run({ files: [file('.claude/skills/x/SKILL.md', 'skill', '---\nname: ship\ndescription: >\n  Deploys the app to staging\n  when someone asks to ship it.\n---\n')] })), [], 'a folded description is read whole')
	assert.deepEqual(codes(run({ files: [file('.claude/agents/r.md', 'agent', '---\nname: r\ndescription: |\n  Reviews a change against the layer rules of this repo.\n---\n')] })), [])
})

test('a line said twice: in one file, across files of one tool, across tools', () => {
	const line = '- Run npm run arch before you commit any change.'
	const f = run({ files: [
		file('CLAUDE.md', 'claude-md', `# A\n${line}\n`),
		file('.claude/rules/x.md', 'claude-rule', `${line}\n`),
		file('AGENTS.md', 'agents-md', `${line}\n`),
	] })
	const dup = f.filter(x => x.code === 'duplicate')
	assert.equal(dup.length, 2)
	assert.ok(dup.some(x => x.file === '/w/.claude/rules/x.md' && x.severity === 'warning' && /Also in CLAUDE\.md:2/.test(x.message)))
	assert.ok(dup.some(x => x.file === '/w/AGENTS.md' && x.severity === 'info' && /@AGENTS\.md/.test(x.fix)), 'two tools each reading their own file is softer')
	assert.equal(run({ files: [file('CLAUDE.md', 'claude-md', `${line}\n\n${line}\n`)] })[0].message, 'Said twice in CLAUDE.md (also line 1)')
	assert.equal(run({ files: [file('CLAUDE.md', 'claude-md', '```\nnpm run arch before you commit any change\nnpm run arch before you commit any change\n```\n')] }).length, 0, 'code blocks are not prose')
})

test('a file that mirrors another is one finding, not one per line', () => {
	const text = ['Run npm run arch before you commit any change.', 'Keep comments in full sentences that explain why.', 'Never edit the generated editor checkout by hand.'].map(x => `- ${x}`).join('\n')
	const f = run({ files: [file('CLAUDE.md', 'claude-md', text), file('AGENTS.md', 'agents-md', text)] })
	assert.equal(f.length, 1)
	assert.match(f[0].message, /^3 lines here are also in CLAUDE\.md \(lines 1, 2, 3\)/)
})

test('a line contradicted by another: always X and never X', () => {
	const f = run({ files: [
		file('CLAUDE.md', 'claude-md', '- Use yarn workspaces for every package install.\n'),
		file('AGENTS.md', 'agents-md', "- Don't use yarn workspaces for every package install.\n"),
	] })
	assert.deepEqual(codes(f), ['contradiction@0'])
	assert.equal(f[0].file, '/w/AGENTS.md')
	assert.match(f[0].message, /Contradicts CLAUDE\.md:1/)
})

test('hooks: an unknown event, a case-sensitive tool name, a regex matching nothing, a matcher on an event without one', () => {
	const h = (event, matcher) => ({ event, matcher, command: 'node x.mjs', settingsFile: '/w/.claude/settings.json', line: 7 })
	const f = run({ hooks: [h('PreTooluse', 'Bash'), h('PreToolUse', 'bash|Edit'), h('PostToolUse', '^Notbook'), h('Stop', 'Bash'), h('PreToolUse', 'mcp__github__.*'), h('PreToolUse', 'Edit|Write'), h('PreToolUse', '(')] })
	assert.deepEqual(f.map(x => [x.code, x.severity, x.fix.slice(0, 22)]), [
		['unknown-event', 'error', 'Write it as PreToolUse'],
		['dead-matcher', 'error', 'Write it as Bash'],
		['dead-matcher', 'error', 'Fix the expression, or'],
		['dead-matcher', 'warning', 'Check the tool names; '],
		['ignored-matcher', 'info', 'Remove the matcher, or'],
	])
	assert.ok(f.every(x => x.file === '/w/.claude/settings.json' && x.line === 7))
})

test('permission rules: overbroad, wildcard before the subcommand, shadowed by a deny, duplicated, never consulted', () => {
	const r = (pattern, effect = 'allow', scope = 'project', line = 3) => ({ pattern, effect, scope, file: `/w/${scope}.json`, line })
	const f = run({ rules: [
		r('Bash'), r('Bash(git *)'), r('Bash(git * main)'), r('Bash(npm run build)'), r('Bash(npm run *)', 'allow', 'local'),
		r('Bash(npm *)', 'deny', 'user'), r('WebFetch(domain:*)'), r('Read(//**)'), r('Write(docs/**)'), r('Bash(npm run build)', 'allow', 'local'),
		r('Bash(npm test)'),
	] })
	const got = f.map(x => `${x.code}:${x.message.split(' ')[0]}`)
	assert.ok(got.includes('overbroad:Bash'))
	assert.ok(got.includes('overbroad:Bash(git'))
	assert.ok(got.includes('wildcard-before-subcommand:Bash(git'))
	assert.ok(got.includes('shadowed:Bash(npm'), 'npm run * can never work under a deny of npm *')
	assert.ok(got.includes('overbroad:WebFetch(domain:*)'))
	assert.ok(got.includes('overbroad:Read(//**)'))
	assert.ok(got.includes('rule-never-applies:Write(docs/**):'))
	assert.ok(got.includes('duplicate-rule:Bash(npm'))
	assert.equal(f.filter(x => x.code === 'shadowed').length, 4, 'npm run build (twice), npm run * and npm test all sit under the deny of npm *')
})

test('findings come errors first, each with a file, a line and a fix', () => {
	const f = run({ files: [file('.claude/rules/a.md', 'claude-rule', '---\npaths: **/*.ts\n---\n')], rules: [{ pattern: 'Bash', effect: 'allow', scope: 'user', file: '/h/s.json', line: 2 }] })
	assert.deepEqual(f.map(x => x.severity), ['error', 'warning'])
	assert.ok(f.every(x => x.file && Number.isInteger(x.line) && x.fix))
})
