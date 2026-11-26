# Probing Insilode

The full recipe is the `probe` skill (.claude/skills/probe/SKILL.md); this is the short version and the limits.

## What runs
- The editor (VS Code fork + `editor/extensions/*`, canvas from `ui/`): probe it in web mode, headless.
- Desktop-only behaviour (installer, update, status island, window focus): Docker or Windows Sandbox only.
- The website `site/`: `cd site && npm run dev` (port 5173), fake host over demo data.
- The C# analyzer `analyzer/`: no UI, checked by `dotnet test analyzer/tests`.

## Start it
1. `npm run build:extensions && npm run build:canvas`. If `editor/vscode` is missing, stop: `npm run setup` takes 10-20 minutes, ask first.
2. Folder: `node .claude/skills/probe/scripts/demo-workspace.mjs <scratchpad>/demo-shop` (Express + axios/fetch + FastAPI), or the user's named folder, unedited.
3. `npm run web -- <folder> > <scratchpad>/web.log 2>&1` in the background, then `node .claude/skills/probe/scripts/wait-url.mjs <scratchpad>/web.log`. Port 8765; `FLOW_PORT=8766` if taken.
4. Open the printed URL in the built-in browser pane. Up = the workbench loads.

## Sign in
- The URL's `?tkn=` is fresh each start; use it exactly, never write it down.
- A fresh folder opens in Restricted Mode: status bar "Restricted Mode" -> Trust, or the extensions don't run.
- Agents dock / turn impact / Codex hooks need a real Claude Code or Codex login and spend the user's quota: ask first, never type credentials.

## Probe by change
- Index / canvas: "Show Flow at Cursor" shows the expected cards in order and edge kinds (solid call, dashed `impl`, animated `HTTP?` / `topic?`, DB cards).
- Endpoints: "Open Endpoint Flow…" lists each route once and no client calls.
- Callers / impact: the Callers chip and "Affects N entry points" name the expected callers across services.
- Webview / message handler: console `onlyErrors` shows no CSP violation or activation error (vsda 404s are harmless).
- Desktop-only: `npm run docker:e2e -- --probe <script in scratchpad> --out <scratchpad dir>`; Windows-only: `npm run sandbox:e2e`.

## Never
- `npm start`, any Electron window on this machine, or global keyboard/mouse input.
- Set `INSILODE_E2E_ISOLATED=1` on this machine.
- Open an untrusted folder in web mode (webviews share the editor's origin).
- Publish: releases, GitHub Pages, social posts. Report instead.

## When it can't run
Log `not run live` with the reason: `editor/vscode` missing (setup not run), Docker not running or its first 20-40 minute build not done, Windows Sandbox feature off, no agent login, or the change lives on an unmerged branch.
