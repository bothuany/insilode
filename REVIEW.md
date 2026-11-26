# Reviewing Insilode

Read CLAUDE.md first; this file holds what the diff and CI don't show.

## What failure looks like here
- **It misdraws.** The index or canvas shows a wrong card, edge or caller (a client call listed as a route, a missed caller across services). Most fix commits land in `flow-view/src` and its golden output.
- **It breaks on Windows.** Path separators, 8.3 temp names, drive letters, git run inside a hostile folder: a recurring fix theme ("make the tests hold on Windows").
- **It crosses a trust boundary.** A webview message, the `insilode` MCP server and its loopback bridge, agent hooks and permissions: a command id or path that isn't checked.
- **It steals the screen.** A script, hook or test that opens a window or takes focus.
- **It lies.** A doc, tool description, empty state or count that says something the code doesn't do ("honest board_from_code").
- **It strands an update.** The update service, installer or release assembly leaves an install unable to update or migrate (Axle -> Insilode).

## Risk tiers
- **High** (deep review, a person reads it): `src/mcp`, `mcp/insilode-mcp.ts`, any webview page or `onDidReceiveMessage` handler, flow-agent session/hook code, flow-harness permissions, `editor/patches/`, `editor/installer/`, the update service and `scripts/release-files.mjs`, `.github/workflows/`, `protocol/flow.ts`, `.semgrep/rules`, `.dependency-cruiser.cjs`.
- **Medium** (default): extension and canvas features, `src/poly`, `src/board`, the analyzer, `site/`.
- **Low** (automated checks are enough): docs-only, `site/public/media`, test fixtures with no source change.

## Skip
- `editor/vscode/` (generated checkout), binary assets (icons, media).
- Golden output (`flow-view/test/expected`, `types-expected`, `table-expected`): don't review it line by line; check it with the `golden-diff-reviewer` agent against the source change.

## Don't report
What CI and `npm run arch` already enforce: dependency rules, wire types declared once, registered cross-extension commands, CSP and the command allowlist (semgrep), type checks, script syntax. At most three style nits, and only against the file's own convention (tabs/semicolons per CLAUDE.md).

## How to report
- Every finding has a file and line you read, never a guess from a name, and a concrete failing input or state.
- A bug the change didn't introduce is marked pre-existing and left alone.
- Start the summary with the count; when there is nothing to fix, say so plainly.
- For the high tier, also run the matching agent: `webview-security-reviewer` or `architecture-reviewer`.
