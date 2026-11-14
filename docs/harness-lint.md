# Harness lint in CI

The harness map in the editor (`editor/extensions/flow-harness`) checks a project's agent setup: hooks that point at a missing script or can never fire, permission rules that are overbroad, shadowed or never consulted, `paths:` globs that match no file, frontmatter YAML rejects, duplicated or contradicting instructions, `.mcp.json` problems. `harness-lint` runs the same checks without the editor, so a pull request can fail on a broken rule or hook.

```bash
npm run harness:lint -- [--cwd <dir>] [--json] [--max-warnings <n>]
# or, after building the extension (`npm run build` in editor/extensions/flow-harness):
node editor/extensions/flow-harness/out/harness-lint.js [--cwd <dir>] [--json] [--max-warnings <n>]
```

It reads the repository (`.claude/settings.json`, `.claude/settings.local.json`, hooks and the scripts they run, `CLAUDE.md` / `AGENTS.md` at any depth, `.claude/rules`, `.cursor/rules`, skills, subagents, `.mcp.json`) and writes nothing; it uses no network. The user's own files (`~/.claude`, `~/.codex`) are not read: a CI machine has none, and a finding that depends on them would differ from one developer's machine to the next. For the same reason a path under `~` (an `@~/.claude/notes.md` import, a hook script `~/bin/guard.sh` or `$HOME/bin/guard.sh`) is not checked and never reported, and a file that is a link to somewhere outside `--cwd` is not read at all: it is reported as `outside-repo` (a warning) instead. Agent worktrees (`.claude/worktrees`, `.insilode/worktrees`, `.axle/worktrees`) are skipped at any depth, as the editor's search skips them.

One line per finding on stdout, `path:line:col severity rule message` (paths relative to `--cwd`, written with `/` on Windows too), or a JSON array of `{ file, line, column, severity, rule, message, fix? }` with `--json`. A summary goes to stderr.

| Exit | Meaning |
|---|---|
| 0 | No errors, and no more warnings than `--max-warnings` (when given) |
| 1 | An error, or too many warnings |
| 2 | Wrong usage, or a folder that cannot be read |

Hooks that name a missing script, invalid JSON, an unknown hook event and an invalid matcher are errors, and so is `rule-never-applies`, a permission rule that is never consulted. The editor shows that one as a warning; the CLI counts it as an error so a pull request fails on it. Everything else is a warning (`overbroad`, `shadowed` and `rule-conflict` permission rules, which only fire on an allow rule a stricter deny or ask rule already overrides, `outside-repo`, most instruction checks): add `--max-warnings 0` to fail on those as well. A finding about invalid JSON gives the line and column when the parser knows them and never quotes the file.

GitHub Actions:

```yaml
name: harness
on: pull_request
jobs:
  harness-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # Insilode's repository, which holds the lint; pin a tag or commit in real use. `actions/checkout` only writes inside the
      # workspace, so it is moved out right away: left there, the lint would walk into it and report Insilode's own files.
      - uses: actions/checkout@v4
        with: { repository: OWNER/insilode, path: .insilode-tools }
      - run: mv .insilode-tools "$RUNNER_TEMP/insilode"
      - run: npm ci && npm run build
        working-directory: ${{ runner.temp }}/insilode/editor/extensions/flow-harness
      - run: node "$RUNNER_TEMP/insilode/editor/extensions/flow-harness/out/harness-lint.js" --cwd "$GITHUB_WORKSPACE" --max-warnings 0
```

Replace `OWNER/insilode` with where the Insilode repository lives for you (a private one needs a `token:` on its checkout); in a checkout of Insilode itself `npm run harness:lint` does the same. The step fails the job on exit 1 (an error, or any warning because of `--max-warnings 0`) and on exit 2; drop `--max-warnings 0` to fail on errors only. Node 22 or later runs the CLI. The lint is not part of this repository's own CI workflow.
