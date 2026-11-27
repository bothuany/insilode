//! insilode-agentsd: owns the agent ptys so they outlive any window. Windows are clients over a local socket
//! speaking JSON lines (see README "Protocol"). `insilode-agentsd ctl list` is a one-shot client for scripts.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "../../shared/transport.rs"]
mod transport;

const RING: usize = 1 << 20;
// shortcut: fixed size, no resize op; add {"op":"resize"} -> master.resize() when the window fits to its pane.
const SIZE: PtySize = PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 };
const AGENT: &str = "i=0; while true; do echo agent tick $i; i=$((i+1)); sleep 1; done";

struct Session {
	id: u32,
	kind: String,
	cwd: String,
	pid: Option<u32>,
	buf: VecDeque<u8>,
	writer: Box<dyn Write + Send>,
	child: Box<dyn Child + Send + Sync>,
	// Held so the master side stays open; dropping it would hang up the child.
	_master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
struct State {
	sessions: Vec<Session>,
	clients: Vec<UnixStream>,
	ide: Value,
	next: u32,
}

type Shared = Arc<Mutex<State>>;

fn line(v: &Value) -> Vec<u8> {
	let mut s = serde_json::to_vec(v).unwrap();
	s.push(b'\n');
	s
}

/// shortcut: writes under the state lock with a 2 s timeout, so a stuck window can stall output for 2 s before it is dropped;
/// a per-client queue and writer thread is the production shape.
fn broadcast(st: &mut State, v: &Value) {
	let bytes = line(v);
	st.clients.retain_mut(|c| c.write_all(&bytes).is_ok());
}

fn live_cwd(s: &Session) -> String {
	// The shell may have cd'd since it started; /proc knows (Linux only, Windows would ask the daemon-side shell integration).
	s.pid.and_then(|p| std::fs::read_link(format!("/proc/{p}/cwd")).ok()).map(|p| p.display().to_string()).unwrap_or_else(|| s.cwd.clone())
}

fn sessions(st: &mut State, tails: bool) -> Value {
	let list: Vec<Value> = st
		.sessions
		.iter_mut()
		.map(|s| {
			let alive = matches!(s.child.try_wait(), Ok(None));
			let mut v = json!({ "id": s.id, "kind": s.kind, "pid": s.pid, "cwd": live_cwd(s), "alive": alive });
			if tails {
				let (a, b) = s.buf.as_slices();
				let all = [a, b].concat();
				let tail = &all[all.len().saturating_sub(2048)..];
				v["tail"] = json!(String::from_utf8_lossy(tail));
			}
			v
		})
		.collect();
	json!({ "ev": "sessions", "sessions": list })
}

fn spawn(shared: &Shared, kind: &str, cwd: &str) -> anyhow::Result<()> {
	let pair = native_pty_system().openpty(SIZE)?;
	let mut cmd = if kind == "agent" {
		// The spike's stand-in for `claude` (needs a login); a real agent is CommandBuilder::new("claude") + args from launch.ts.
		let mut c = CommandBuilder::new("bash");
		c.args(["-c", AGENT]);
		c
	} else {
		let mut c = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "bash".into()));
		c.arg("-i");
		c
	};
	cmd.cwd(cwd);
	cmd.env("TERM", "xterm-256color");
	let child = pair.slave.spawn_command(cmd)?;
	drop(pair.slave);
	let mut reader = pair.master.try_clone_reader()?;
	let writer = pair.master.take_writer()?;
	let pid = child.process_id();
	let id = {
		let mut st = shared.lock().unwrap();
		st.next += 1;
		let id = st.next;
		st.sessions.push(Session { id, kind: kind.into(), cwd: cwd.into(), pid, buf: VecDeque::new(), writer, child, _master: pair.master });
		let v = sessions(&mut st, false);
		broadcast(&mut st, &v);
		id
	};
	eprintln!("agentsd: spawned {kind} id={id} pid={pid:?}");
	// Drain the pty always, attached window or not: a full pty buffer would block the agent's writes.
	let shared = shared.clone();
	std::thread::spawn(move || {
		let mut chunk = [0u8; 8192];
		loop {
			let n = match reader.read(&mut chunk) {
				Ok(0) | Err(_) => break,
				Ok(n) => n,
			};
			let mut st = shared.lock().unwrap();
			if let Some(s) = st.sessions.iter_mut().find(|s| s.id == id) {
				s.buf.extend(&chunk[..n]);
				let over = s.buf.len().saturating_sub(RING);
				s.buf.drain(..over);
			}
			let data = base64::engine::general_purpose::STANDARD.encode(&chunk[..n]);
			broadcast(&mut st, &json!({ "ev": "out", "id": id, "data": data }));
		}
		let mut st = shared.lock().unwrap();
		let v = sessions(&mut st, false);
		broadcast(&mut st, &v);
	});
	Ok(())
}

fn handle(shared: Shared, stream: UnixStream) {
	let mut out = stream.try_clone().unwrap();
	let _ = out.set_write_timeout(Some(Duration::from_secs(2)));
	for l in BufReader::new(stream).lines() {
		let Ok(l) = l else { break };
		let Ok(req) = serde_json::from_str::<Value>(&l) else { continue };
		match req["op"].as_str().unwrap_or("") {
			"hello" => {
				// Replay every session's ring buffer, then subscribe: this is what makes a reopened window show the scrollback.
				let mut st = shared.lock().unwrap();
				let mut bytes = line(&sessions(&mut st, false));
				for s in &st.sessions {
					let (a, b) = s.buf.as_slices();
					let data = base64::engine::general_purpose::STANDARD.encode([a, b].concat());
					bytes.extend(line(&json!({ "ev": "out", "id": s.id, "data": data, "replay": true })));
				}
				bytes.extend(line(&json!({ "ev": "ide", "ide": st.ide })));
				if out.write_all(&bytes).is_ok() {
					st.clients.push(out.try_clone().unwrap());
				}
			}
			"list" => {
				let v = sessions(&mut shared.lock().unwrap(), true);
				let _ = out.write_all(&line(&v));
			}
			"spawn" => {
				let kind = if req["kind"] == "agent" { "agent" } else { "shell" };
				let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
				let cwd = req["cwd"].as_str().filter(|c| std::path::Path::new(c).is_dir()).unwrap_or(&home).to_string();
				if let Err(e) = spawn(&shared, kind, &cwd) {
					eprintln!("agentsd: spawn failed: {e}");
				}
			}
			"input" => {
				let mut st = shared.lock().unwrap();
				if let (Some(s), Some(d)) = (st.sessions.iter_mut().find(|s| Some(s.id as u64) == req["id"].as_u64()), req["data"].as_str()) {
					let _ = s.writer.write_all(d.as_bytes());
				}
			}
			_ => {}
		}
	}
}

/// The IDE link: ~/.insilode/bridge/<pid>.json written by every IDE window (flow-view src/mcp/registry.ts). Same shape check
/// as parseBridgeInfo, and a file whose pid is gone does not count (a killed IDE cannot delete its own file).
fn ide_status() -> Value {
	let dir = std::env::var("INSILODE_BRIDGE_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".insilode/bridge"));
	let mut windows = vec![];
	for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
		let name = e.file_name().to_string_lossy().to_string();
		let Some(stem) = name.strip_suffix(".json").filter(|s| s.chars().all(|c| c.is_ascii_digit())) else { continue };
		let Ok(v) = std::fs::read_to_string(e.path()).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) else { continue };
		let (Some(pid), true, true, Some(folders)) = (v["pid"].as_i64(), v["port"].is_i64(), v["token"].as_str().is_some_and(|t| !t.is_empty()), v["workspaceFolders"].as_array()) else { continue };
		if stem != pid.to_string() {
			continue;
		}
		// kill(pid, 0): EPERM still means running.
		let alive = unsafe { libc::kill(pid as i32, 0) == 0 } || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
		if alive {
			windows.push(json!({ "pid": pid, "folders": folders }));
		}
	}
	json!({ "connected": !windows.is_empty(), "windows": windows })
}

fn ctl(args: &[String]) -> anyhow::Result<()> {
	let mut s = UnixStream::connect(transport::socket_path())?;
	s.write_all(&line(&json!({ "op": args.first().map(String::as_str).unwrap_or("list") })))?;
	let mut l = String::new();
	BufReader::new(s).read_line(&mut l)?;
	print!("{l}");
	Ok(())
}

fn main() -> anyhow::Result<()> {
	let args: Vec<String> = std::env::args().skip(1).collect();
	if args.first().map(String::as_str) == Some("ctl") {
		return ctl(&args[1..]);
	}
	let path = transport::socket_path();
	if UnixStream::connect(&path).is_ok() {
		eprintln!("agentsd: already running at {}", path.display());
		return Ok(());
	}
	let _ = std::fs::remove_file(&path);
	if let Some(d) = path.parent() {
		std::fs::create_dir_all(d)?;
	}
	let listener = UnixListener::bind(&path)?;
	// Only this user may talk to the daemon: it can type into every agent.
	std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
	eprintln!("agentsd: listening on {} pid={}", path.display(), std::process::id());
	let shared: Shared = Arc::new(Mutex::new(State { ide: ide_status(), ..Default::default() }));
	{
		let shared = shared.clone();
		std::thread::spawn(move || loop {
			std::thread::sleep(Duration::from_secs(1));
			let now = ide_status();
			let mut st = shared.lock().unwrap();
			if st.ide != now {
				st.ide = now.clone();
				broadcast(&mut st, &json!({ "ev": "ide", "ide": now }));
			}
		});
	}
	for stream in listener.incoming().flatten() {
		let shared = shared.clone();
		std::thread::spawn(move || handle(shared, stream));
	}
	Ok(())
}
