#!/usr/bin/env bash
# The spike's end-to-end probe, inside the container under Xvfb: build, start the daemon, open the window, start an agent
# and a shell, close the window through its confirm dialog, check the agent keeps ticking, reopen, Open in IDE.
# Source is mounted read-only at /src, output goes to /out (screenshots, results.json, logs).
set -u
OUT=/out
mkdir -p "$OUT"
exec > >(tee "$OUT/probe.log") 2>&1
step() { echo "=== $*"; }
results=()
record() { results+=("$(jq -cn --arg s "$1" --arg r "$2" --arg e "$3" '{step:$s,result:$r,evidence:$e}')"); echo "[$2] $1: $3"; }

step build
rm -rf /build/src && mkdir -p /build/src
tar -C /src --exclude=target --exclude=node_modules --exclude=dist -cf - . | tar -C /build/src -xf -
cd /build/src/ui && npm install --no-audit --no-fund >"$OUT/build.log" 2>&1 && npm run build >>"$OUT/build.log" 2>&1 || { echo "ui build failed"; tail -30 "$OUT/build.log"; exit 1; }
mkdir -p /build/src/app/icons && convert -size 64x64 xc:'#3a6ea5' PNG32:/build/src/app/icons/icon.png
cd /build/src && cargo build --release >>"$OUT/build.log" 2>&1 || { echo "cargo build failed"; tail -60 "$OUT/build.log"; exit 1; }
cp Cargo.lock "$OUT/Cargo.lock"
BIN=${CARGO_TARGET_DIR:-/build/src/target}/release
XTERM_VERSION=$(jq -r .version /build/src/ui/node_modules/@xterm/xterm/package.json)
versions=$(cd /build/src && cargo tree -p insilode-agents --depth 1 -e normal 2>/dev/null | grep -E 'tauri v' | head -1; cargo tree -p insilode-agentsd --depth 1 2>/dev/null | grep portable-pty)
echo "versions: $versions xterm $XTERM_VERSION"

step display
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99
for _ in $(seq 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
eval "$(dbus-launch --sh-syntax)"
# A window manager is what turns `wmctrl -c` into WM_DELETE_WINDOW, i.e. the same close request a user's title bar sends.
openbox >/dev/null 2>&1 &
sleep 1

export XDG_RUNTIME_DIR=/tmp/rt INSILODE_BRIDGE_DIR=/tmp/bridge INSILODE_AGENTS_CWD=/work/project INSILODE_AGENTS_AUTOCONFIRM=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
mkdir -p -m 700 "$XDG_RUNTIME_DIR" && mkdir -p /tmp/bridge /work/project
shot() { import -window root "$OUT/$1"; echo "screenshot $OUT/$1"; }
tree_rss() { # kB over a process and all its descendants (WebKitWebProcess and WebKitNetworkProcess are children of the window)
	local total=0 p
	for p in $1 $(pgrep -P "$1"); do
		[ "$p" = "$1" ] && total=$((total + $(ps -o rss= -p "$p" 2>/dev/null || echo 0))) && continue
		total=$((total + $(tree_rss "$p")))
	done
	echo $total
}
ctl() { "$BIN/insilode-agentsd" ctl list; }
ticks() { ctl | jq -r '.sessions[] | select(.kind=="agent") | .tail' | grep -o 'agent tick [0-9]*' | tail -1 | awk '{print $3}'; }
open_window() { # $1 log file; prints start ms (launch until the page called `ready`)
	local t0 t1
	t0=$(date +%s%N)
	"$BIN/insilode-agents" >"$OUT/$1" 2>&1 &
	WPID=$!
	for _ in $(seq 300); do grep -q READY "$OUT/$1" && break; sleep 0.05; done
	t1=$(date +%s%N)
	WID=$(xdotool search --sync --name '^Insilode Agents$' | head -1)
	START_MS=$(( (t1 - t0) / 1000000 ))
}
click() { xdotool mousemove --window "$WID" "$1" "$2" click 1; sleep "${3:-1}"; }
# Button centres in the 240px sidebar (style.css): New shell 86, New agent 124, Open in IDE 162; first session row 245.

step daemon
setsid "$BIN/insilode-agentsd" >"$OUT/daemon.log" 2>&1 < /dev/null &
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/insilode-agentsd.sock" ] && break; sleep 0.1; done
DPID=$(pgrep -f "^$BIN/insilode-agentsd\$" | head -1)
record daemon-up "$([ -n "$DPID" ] && echo pass || echo fail)" "$(head -1 "$OUT/daemon.log")"

step window-1
open_window window1.log
START1=$START_MS
record window-open "$(grep -q READY "$OUT/window1.log" && [ -n "$WID" ] && echo pass || echo fail)" "$(grep READY "$OUT/window1.log") wall=${START1}ms wid=$WID"
click 120 124 2   # New agent
click 120 86 2    # New shell (selected, it is the newest)
click 700 300 0.5 # focus the terminal
xdotool type --delay 50 'echo hello'; xdotool key Return; sleep 1.5
shot 1-shell-and-agent.png
WIN_RSS=$(tree_rss "$WPID")
hello=$(ctl | jq -r '.sessions[] | select(.kind=="shell") | .tail' | grep -cP '(^|\r)hello\r?$' || true) # bash prefixes output with ESC[?2004l\r (bracketed paste off)
record shell-echo "$([ "$hello" -ge 1 ] && echo pass || echo fail)" "shell tail has 'hello' line x$hello; sessions: $(ctl | jq -c '[.sessions[]|{id,kind,pid,alive}]')"

step close
wmctrl -c 'Insilode Agents'
sleep 1
shot 2a-close-confirm.png
for _ in $(seq 100); do kill -0 "$WPID" 2>/dev/null || break; sleep 0.1; done
sleep 0.5
shot 2-window-closed.png
closed=$(kill -0 "$WPID" 2>/dev/null && echo no || echo yes)
record close-asks "$(grep -q 'confirm shown: 2' "$OUT/window1.log" && grep -q 'close confirmed' "$OUT/window1.log" && [ "$closed" = yes ] && echo pass || echo fail)" "$(grep -E 'close requested|confirm shown|close confirmed' "$OUT/window1.log" | tr '\n' ' ') window-exited=$closed"

step agent-survives
APID=$(ctl | jq -r '.sessions[] | select(.kind=="agent") | .pid')
t_a=$(ticks); sleep 5; t_b=$(ticks)
alive=$(kill -0 "$APID" 2>/dev/null && echo yes || echo no)
record agent-alive "$([ "$alive" = yes ] && [ "${t_b:-0}" -gt "${t_a:-0}" ] && echo pass || echo fail)" "agent pid $APID alive=$alive, tick $t_a -> $t_b over 5s with no window; daemon alive=$(kill -0 "$DPID" && echo yes)"
DAEMON_RSS=$(ps -o rss= -p "$DPID" | tr -d ' ')

step ide-bridge
sleep 1000 & FAKE_IDE=$!
echo "{\"pid\":$FAKE_IDE,\"port\":1,\"token\":\"probe\",\"workspaceFolders\":[\"/work/project\"],\"createdAt\":0}" > "/tmp/bridge/$FAKE_IDE.json"
printf '#!/bin/sh\nprintf "%%s\\n" "$@" > /tmp/cli-args.txt\n' > /tmp/fake-insilode && chmod +x /tmp/fake-insilode
export INSILODE_CLI=/tmp/fake-insilode
sleep 1.5

step window-2
open_window window2.log
START2=$START_MS
sleep 1
click 120 245 2   # the agent row
shot 3-reopened-scrollback.png
replayed=$(ctl | jq -r '.sessions[] | select(.kind=="agent") | .tail' | grep -c 'agent tick' || true)
record reopen "$(grep -q READY "$OUT/window2.log" && echo pass || echo fail)" "$(grep READY "$OUT/window2.log") wall=${START2}ms; agent ring buffer tail holds $replayed tick lines, now at tick $(ticks)"

step open-in-ide
click 120 162 1.5 # Open in IDE
args=$(cat /tmp/cli-args.txt 2>/dev/null | tr '\n' ' ')
record open-in-ide "$([ "$args" = '/work/project ' ] && echo pass || echo fail)" "stub got args: [${args}] ; $(grep 'open-in-ide' "$OUT/window2.log")"
record ide-status "$(grep -q 'ide: IDE not running' "$OUT/window1.log" && grep -q 'ide: IDE connected' "$OUT/window2.log" && echo pass || echo fail)" "window1: $(grep -m1 'ide:' "$OUT/window1.log"); window2 (bridge file $FAKE_IDE.json, live pid): $(grep -m1 'ide:' "$OUT/window2.log")"
WIN2_RSS=$(tree_rss "$WPID")

printf '%s\n' "${results[@]}" | jq -s \
	--argjson drss "$DAEMON_RSS" --argjson wrss "$WIN_RSS" --argjson w2rss "$WIN2_RSS" --argjson s1 "$START1" --argjson s2 "$START2" --arg v "$versions" --arg x "$XTERM_VERSION" \
	'{steps: ., rss_kb: {daemon: $drss, window_tree_first: $wrss, window_tree_second: $w2rss}, window_start_ms: {first_cold: $s1, second: $s2, definition: "launch of insilode-agents until the page invoked ready (listener up, attached, replay sent)"}, versions: {crates: $v, xterm: $x}}' \
	> "$OUT/results.json"
cat "$OUT/results.json"
cp /tmp/cli-args.txt "$OUT/cli-args.txt" 2>/dev/null
kill "$WPID" "$FAKE_IDE" 2>/dev/null
