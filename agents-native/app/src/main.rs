//! The Agents window: a Tauri client of insilode-agentsd. It owns no ptys, so closing it leaves every agent running.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WindowEvent};

#[path = "../../shared/transport.rs"]
mod transport;

static STARTED: OnceLock<Instant> = OnceLock::new();

struct Conn(Mutex<UnixStream>);

/// Connects to the daemon, starting it first when nobody runs one: the window alone is enough to get going.
fn connect() -> Result<UnixStream, String> {
	let path = transport::socket_path();
	if let Ok(s) = UnixStream::connect(&path) {
		return Ok(s);
	}
	let exe = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("insilode-agentsd");
	// Its own process group, so the daemon does not get the window's signals and outlives it.
	std::os::unix::process::CommandExt::process_group(Command::new(&exe).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()), 0)
		.spawn()
		.map_err(|e| format!("cannot start {}: {e}", exe.display()))?;
	for _ in 0..30 {
		std::thread::sleep(Duration::from_millis(100));
		if let Ok(s) = UnixStream::connect(&path) {
			return Ok(s);
		}
	}
	Err(format!("daemon did not come up at {}", path.display()))
}

fn send_line(conn: &Conn, line: &str) -> Result<(), String> {
	let mut s = conn.0.lock().unwrap();
	s.write_all(line.as_bytes()).and_then(|_| s.write_all(b"\n")).map_err(|e| e.to_string())
}

/// Called by the page once its listener is up, so the replay of the scrollback is not emitted into the void.
#[tauri::command]
fn attach(app: tauri::AppHandle, conn: tauri::State<Conn>) -> Result<(), String> {
	let reader = conn.0.lock().unwrap().try_clone().map_err(|e| e.to_string())?;
	std::thread::spawn(move || {
		for line in BufReader::new(reader).lines().map_while(Result::ok) {
			let _ = app.emit("daemon", line);
		}
		let _ = app.emit("daemon", r#"{"ev":"gone"}"#.to_string());
	});
	send_line(&conn, r#"{"op":"hello"}"#)
}

#[tauri::command]
fn send(conn: tauri::State<Conn>, line: String) -> Result<(), String> {
	send_line(&conn, &line)
}

#[tauri::command]
fn config() -> serde_json::Value {
	serde_json::json!({
		"autoconfirm": std::env::var("INSILODE_AGENTS_AUTOCONFIRM").is_ok_and(|v| v == "1"),
		"cwd": std::env::var("INSILODE_AGENTS_CWD").ok(),
	})
}

/// Open in IDE: the Insilode CLI with the session's folder, as an argument array (no shell, so a folder name is never parsed).
#[tauri::command]
fn open_in_ide(cwd: String) -> Result<String, String> {
	let cli = std::env::var("INSILODE_CLI").unwrap_or_else(|_| "insilode".into());
	let mut child = Command::new(&cli).arg(&cwd).stdin(Stdio::null()).spawn().map_err(|e| format!("{cli}: {e}"))?;
	std::thread::spawn(move || child.wait());
	println!("open-in-ide: {cli} {cwd:?}");
	Ok(cli)
}

#[tauri::command]
fn ready() {
	println!("READY ms={}", STARTED.get().unwrap().elapsed().as_millis());
}

#[tauri::command]
fn log(msg: String) {
	println!("page: {msg}");
}

/// The user said yes to "N agents running, close?": close the window only (destroy, since close() would ask again).
#[tauri::command]
fn really_close(window: tauri::WebviewWindow, running: u32) {
	println!("close confirmed: running={running}");
	let _ = window.destroy();
}

fn main() {
	STARTED.get_or_init(Instant::now);
	let stream = match connect() {
		Ok(s) => s,
		Err(e) => {
			eprintln!("agents window: {e}");
			std::process::exit(1);
		}
	};
	tauri::Builder::default()
		.manage(Conn(Mutex::new(stream)))
		.invoke_handler(tauri::generate_handler![attach, send, config, open_in_ide, ready, log, really_close])
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { api, .. } = event {
				// The page knows how many sessions run and asks; it calls really_close on yes.
				api.prevent_close();
				println!("close requested");
				let _ = window.app_handle().emit("close-requested", ());
			}
		})
		.run(tauri::generate_context!())
		.expect("tauri run");
}
