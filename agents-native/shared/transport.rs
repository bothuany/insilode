//! Where the daemon listens. Unix socket only; on Windows this becomes a named pipe name such as
//! `\\.\pipe\insilode-agentsd-<user>` (the `interprocess` crate's local_socket gives one API over both).

use std::path::PathBuf;

pub fn socket_path() -> PathBuf {
	if let Ok(p) = std::env::var("INSILODE_AGENTS_SOCK") {
		return p.into();
	}
	match std::env::var("XDG_RUNTIME_DIR") {
		Ok(d) if !d.is_empty() => PathBuf::from(d).join("insilode-agentsd.sock"),
		_ => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join(".insilode/agentsd.sock"),
	}
}
