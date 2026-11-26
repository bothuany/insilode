# agents-native (spike b of `agents-standalone`)

A throwaway proof, not production code: a native Agents app whose terminals live in a daemon, so they survive the window
and the IDE. Linux only; built and run only in Docker. Plan: `docs/plans/agents-standalone.md` (branch `cycle/agents-standalone`).

## Architecture

```
 insilode-agents (Tauri 2 window)  --JSON lines over a Unix socket-->  insilode-agentsd (daemon)
   webview: session list + xterm.js                                     portable-pty ptys, 1 MB ring buffer each
   Rust: socket client, close handling,                                 polls ~/.insilode/bridge/<pid>.json (IDE link)
         Open in IDE (spawns $INSILODE_CLI)
```

- `daemon/` — `insilode-agentsd`. Owns every pty (`portable-pty`), drains each one on its own thread whether a window is attached
  or not (a full pty buffer would block the agent), keeps the last 1 MB per session, and broadcasts output to attached windows.
  Polls the IDE bridge registry every second. `insilode-agentsd ctl list` is a one-shot client (sessions, pids, live cwd,
  the last 2 KB of output) that the probe uses for evidence.
- `app/` — `insilode-agents`. A Tauri 2 client: it owns no ptys. If no daemon answers, it starts the one next to its own binary
  in its own process group. The page (`ui/`, plain JS, xterm.js copied from node_modules by `ui/build.mjs`, no CDN, no bundler)
  calls `attach` once its listener is up; the daemon then replays every ring buffer, which is how a reopened window shows the
  scrollback.
- `shared/transport.rs` — the socket path (`$INSILODE_AGENTS_SOCK`, else `$XDG_RUNTIME_DIR/insilode-agentsd.sock`, else
  `~/.insilode/agentsd.sock`), mode 0600.
- Close: `CloseRequested` is prevented; the page counts running sessions and shows "N agents running, close?" (an in-page modal).
  Yes calls `really_close`, which destroys the window only (closing the last window ends the window process; the daemon is a
  separate process and keeps running). `INSILODE_AGENTS_AUTOCONFIRM=1` (probe only) still shows the dialog, logs
  `confirm shown: N`, and clicks Yes 2.5 s later.

### Protocol (one JSON object per line)

| Window -> daemon | Daemon -> window |
|---|---|
| `{"op":"hello"}` subscribe; replies sessions, replay of every buffer, IDE state | `{"ev":"sessions","sessions":[{id,kind,pid,cwd,alive}]}` |
| `{"op":"spawn","kind":"shell"\|"agent","cwd"}` | `{"ev":"out","id","data":<base64>,"replay"?}` |
| `{"op":"input","id","data"}` | `{"ev":"ide","ide":{connected,windows:[{pid,folders}]}}` |
| `{"op":"list"}` sessions with `tail` (for `ctl`) | |

## Versions used

Resolved by the probe build (`Cargo.lock`): tauri 2.12.7, tauri-build 2.7.6, wry 0.57.4, portable-pty 0.9.0,
`@xterm/xterm` 5.5.0, Rust stable from `rust:1-bookworm`, webkit2gtk-4.1 from Debian bookworm. The probe sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` up front (the usual fix for blank webviews under Xvfb); whether it is needed was not tested. APIs checked against the current Tauri 2 docs (prevent_close / destroy,
`withGlobalTauri`, capabilities) and the portable-pty docs (openpty, spawn_command, try_clone_reader, take_writer).

## Running the probe

From PowerShell at the repo root (Git Bash would mangle the `-v` paths):

```powershell
docker build -t insilode-agents-native:dev agents-native/docker
docker run --rm -e CARGO_TARGET_DIR=/target `
  -v ${PWD}/agents-native:/src:ro -v agents-native-cargo:/usr/local/cargo/registry -v agents-native-target:/target `
  -v <host output folder>:/out insilode-agents-native:dev bash /src/docker/probe.sh
```

`docker/probe.sh` builds the UI and both binaries, starts Xvfb + dbus + openbox (the window manager turns `wmctrl -c` into a
real WM_DELETE_WINDOW, the same request a title-bar close sends), and then: starts the daemon; opens the window (start time =
launch until the page calls `ready`); clicks New agent and New shell; types `echo hello` (screenshot 1); closes through the
dialog (2a: the dialog, 2: no window); checks the agent pid is alive and its tick count grows with no window; writes a fake
bridge file with a live pid; reopens (screenshot 3: scrollback continuing, IDE connected); clicks Open in IDE with
`INSILODE_CLI` pointing at a stub that records its args. Output: `/out/*.png`, `results.json`, `probe.log`, `daemon.log`,
`window1.log`, `window2.log`, `build.log`.

### Result of the last run (2026-11-27)

All 8 steps passed. Daemon RSS 2.4 MB with two sessions; window process tree (Tauri + WebKitWebProcess + WebKitNetworkProcess)
about 400 MB (a plain sum of RSS, so shared libraries count once per process; PSS would be lower); window launch to `ready` 270 ms cold, 389 ms on reopen (with replay). The agent ticked 9 -> 14 in 5 s with no
window, and the reopened window shows ticks 0..20 without a gap. Note: the dialog counts every running session, shells included.

## Stubbed

- **The agent** is `bash -c 'i=0; while true; do echo agent tick $i; ...'` (a real `claude` needs a login). Wiring: spawn
  `claude` with the arguments `claudeCommand` builds in `flow-agent/src/launch.ts`, as an argv array.
- **MCP config for `claude`** (`mcpConfig` in `flow-agent/src/agents.ts`): not written. Wiring: the daemon writes the same
  `{"mcpServers":{"insilode":{command, args:[insilode-mcp.js], env:{INSILODE_WORKSPACE, INSILODE_SESSION}}}}` file per session
  and passes `--mcp-config <file>`. The MCP server already finds the IDE through the bridge registry by folder, so it works
  whenever an IDE for that folder is open and degrades when none is. It needs the MCP script shipped with the Agents app (or
  found in the installed IDE) and a Node to run it (`ELECTRON_RUN_AS_NODE` with the IDE binary, as today).
- **Show in Flow**: the button only logs. Wiring: a bridge endpoint in flow-view's `src/mcp/http.ts` (or an existing tool
  such as the one that opens a flow) called with the bridge `port`/`token` of the window whose folder holds the session cwd,
  exactly as `insilode-mcp.ts` picks a window today; when no IDE runs, spawn `$INSILODE_CLI <cwd>` first and retry.
- **Open in IDE** is real but only passes the folder (`$INSILODE_CLI <cwd>`, argv array, no shell); when the IDE is already
  open for that folder it could focus it over the bridge instead.
- **Hooks / permissions / session state** (flow-agent's hook server, `termHost.ts` mirroring) are not ported.
- Fixed 100x30 pty and xterm size (no resize op), no session close/kill, no persistence across daemon restarts, writes to
  clients happen under the state lock with a 2 s timeout (a stuck window stalls output up to 2 s before it is dropped).

## What Windows would take

- **Ptys**: portable-pty already uses ConPTY on Windows 10 1809+; the daemon code is the same apart from the `/proc` cwd
  lookup (ConPTY cannot tell the shell's cwd: shell integration or OSC 7 instead) and the default shell (`pwsh`/`cmd`).
- **Transport**: a named pipe `\\.\pipe\insilode-agentsd-<user SID>` with an ACL for the user only, in place of the Unix
  socket; the `interprocess` crate's `local_socket` gives one API over both. `libc::kill(pid,0)` for bridge liveness becomes
  `OpenProcess` + `GetExitCodeProcess`.
- **Daemon lifetime**: start it detached (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, no console window), optionally at
  login (Run key or a scheduled task); a tray icon to quit it with "N agents running" like the window.
- **Window**: Tauri 2 uses WebView2 (present on Windows 11; the bootstrapper for 10). Building needs MSVC (link.exe).
- **Installer, signing, updates**: Tauri's bundler (NSIS or MSI) with both binaries, Authenticode signing of both exes and the
  installer (the same certificate as the IDE so SmartScreen reputation is shared), and `tauri-plugin-updater` or the IDE's
  own update service; an update must not kill running agents, so the daemon is replaced only when no sessions run (or hands
  its ptys over, which ConPTY does not support: realistically, wait).
