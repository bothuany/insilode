// A small sample model so the diagram renders in a plain browser, without VS Code (`npm run dev`-style checks). Not shipped data.
import type { HarnessFlowItem, HarnessFlowModel, HarnessFlowRequest, PathHit, ReplayStep } from '../../../protocol/harness'

const A: HarnessFlowItem['agents'] = ['Claude', 'Codex']
const items: HarnessFlowItem[] = [
  { id: 'hook:ss', kind: 'hooks', stage: 'sessionStart', label: 'load-env', detail: 'SessionStart', matcher: 'startup', scope: 'project', agents: ['Claude'], file: '.claude/settings.json', line: 12 },
  { id: 'ins:claude', kind: 'instructions', stage: 'load', label: 'CLAUDE.md', detail: 'Project instructions', scope: 'project', agents: ['Claude'], tokens: 2100, file: 'CLAUDE.md' },
  { id: 'ins:agents', kind: 'instructions', stage: 'load', label: 'AGENTS.md', detail: 'Project instructions', scope: 'project', agents: ['Codex'], tokens: 900, file: 'AGENTS.md' },
  { id: 'mem:user', kind: 'memory', stage: 'load', label: 'MEMORY.md', detail: 'Auto memory', scope: 'user', agents: ['Claude'], tokens: 640, issues: ['Longer than 200 lines: the rest is not loaded.'] },
  { id: 'mcp:git', kind: 'mcp', stage: 'load', label: 'git', detail: 'stdio: uvx mcp-server-git', scope: 'project', agents: A, tokens: 1400 },
  { id: 'skill:review', kind: 'skills', stage: 'load', label: 'review', detail: 'Review a diff', scope: 'user', agents: ['Claude'], tokens: 80 },
  { id: 'hook:ups', kind: 'hooks', stage: 'promptSubmit', label: 'add-date', detail: 'UserPromptSubmit', matcher: '*', scope: 'user', agents: ['Claude'] },
  { id: 'rule:ts', kind: 'rules', stage: 'model', label: 'typescript.md', detail: 'Path-scoped rule', paths: ['**/*.ts', '**/*.tsx'], scope: 'project', agents: ['Claude'], tokens: 300, file: '.claude/rules/typescript.md' },
  { id: 'hook:pre-bash', kind: 'hooks', stage: 'preTool', label: 'block-force-push', detail: 'PreToolUse', matcher: 'Bash', scope: 'project', agents: ['Claude'], file: '.claude/settings.json', line: 20 },
  { id: 'hook:pre-edit', kind: 'hooks', stage: 'preTool', label: 'protect-lockfile', detail: 'PreToolUse', matcher: 'Edit|Write', scope: 'project', agents: ['Claude'] },
  { id: 'perm:allow-test', kind: 'permissions', stage: 'permission', label: 'Bash(npm test:*)', detail: 'allow rule', matcher: 'Bash(npm test:*)', effect: 'allow', scope: 'project', agents: ['Claude'] },
  { id: 'perm:ask-bash', kind: 'permissions', stage: 'permission', label: 'Bash(git push:*)', detail: 'ask rule', matcher: 'Bash(git push:*)', effect: 'ask', scope: 'user', agents: ['Claude'] },
  { id: 'perm:deny-env', kind: 'permissions', stage: 'permission', label: 'Read(./.env)', detail: 'deny rule', matcher: 'Read(./.env)', effect: 'deny', scope: 'project', agents: ['Claude'] },
  { id: 'hook:pr', kind: 'hooks', stage: 'permissionRequest', label: 'notify-ask', detail: 'PermissionRequest', matcher: '*', scope: 'local', agents: ['Claude'] },
  { id: 'agent:explore', kind: 'agents', stage: 'run', label: 'explorer', detail: 'Subagent, read-only', scope: 'project', agents: ['Claude'] },
  { id: 'hook:post', kind: 'hooks', stage: 'postTool', label: 'format-on-edit', detail: 'PostToolUse', matcher: 'Edit|Write', scope: 'project', agents: ['Claude'], issues: ['Command not found: prettier'] },
  { id: 'hook:stop', kind: 'hooks', stage: 'stop', label: 'run-tests', detail: 'Stop', matcher: '*', scope: 'project', agents: ['Claude'] },
]

const predicted = (itemId: string, why: string, verdict?: PathHit['verdict']): PathHit => ({ itemId, how: 'predicted', why, verdict })
const observed = (itemId: string, why: string, verdict?: PathHit['verdict']): PathHit => ({ itemId, how: 'observed', why, verdict })

function hitsFor(tool: string, command = '', file = ''): PathHit[] {
  if (tool === 'Bash') {
    const push = /git push/.test(command)
    return [
      predicted('hook:pre-bash', 'PreToolUse matcher Bash'),
      push ? predicted('perm:ask-bash', 'matches Bash(git push:*)', 'ask') : predicted('perm:allow-test', 'matches Bash(npm test:*)', 'allow'),
      ...(push ? [predicted('hook:pr', 'PermissionRequest matcher *')] : []),
    ]
  }
  if (tool === 'Edit' || tool === 'Write') {
    return [predicted('rule:ts', `${file || 'the file'} matches **/*.ts`), predicted('hook:pre-edit', 'PreToolUse matcher Edit|Write'), predicted('hook:post', 'PostToolUse matcher Edit|Write')]
  }
  if (tool === 'Read' && /\.env/.test(file)) return [predicted('perm:deny-env', 'matches Read(./.env)', 'deny')]
  return []
}

const steps: ReplayStep[] = [
  { at: 1, label: 'Prompt', event: { tool: 'Prompt' }, hits: [observed('ins:claude', 'loaded at start'), observed('hook:ups', 'UserPromptSubmit ran')] },
  { at: 2, label: 'Bash: npm test', event: { tool: 'Bash', command: 'npm test' }, hits: [observed('hook:pre-bash', 'recorded PreToolUse run', 'allow'), observed('perm:allow-test', 'matches Bash(npm test:*)', 'allow')] },
  { at: 3, label: 'Edit src/app.ts', event: { tool: 'Edit', file: 'src/app.ts' }, hits: [observed('rule:ts', 'read in the transcript'), predicted('hook:pre-edit', 'PreToolUse matcher Edit|Write'), predicted('hook:post', 'PostToolUse matcher Edit|Write')] },
]

/** What the host would answer: the fixture's stand-in for `flowHarness.flowModel`. */
export function sampleModel(req: HarnessFlowRequest): HarnessFlowModel {
  const agent = req.agent
  const shown = agent ? items.filter(i => i.agents.includes(agent)) : items
  const model: HarnessFlowModel = { root: 'sample/workspace', items: shown }
  if (req.mode === 'preview') {
    model.mode = 'default'
    model.hits = req.event ? hitsFor(req.event.tool, req.event.command, req.event.file) : []
  }
  if (req.mode === 'replay') {
    model.sessions = [
      { id: 's1', agent: 'Claude', title: 'Fix the failing test', at: Date.now() - 3_600_000 },
      { id: 's2', agent: 'Codex', title: 'Add a settings page', at: Date.now() - 86_400_000 },
    ]
    model.mode = 'default'
    model.steps = req.session ? steps : undefined
  }
  return model
}
