#!/bin/sh
# Installs Insilode on macOS from the latest GitHub release, without the Gatekeeper prompt:
#
#   curl -fsSL https://insilode.dev/install.sh | sh
#
# Gatekeeper checks only files that carry the com.apple.quarantine attribute, which browsers, Mail and AirDrop add and curl
# does not. Insilode is signed ad hoc, not with an Apple Developer ID, so an app downloaded in a browser is blocked on its first
# launch ("Insilode" Not Opened); the same app fetched here opens straight away. The zip is checked against the release's
# SHA256SUMS.txt before anything is installed.
#
# Settings, all optional:
#   INSILODE_VERSION=0.5.2         a version instead of the latest release
#   INSILODE_INSTALL_DIR=<folder>  where Insilode.app goes (default /Applications if you can write to it, else ~/Applications)
#   INSILODE_DOWNLOAD_BASE=<url>   a mirror of the release files (default the GitHub release of that version)
#
# Everything runs inside main, called on the last line, so a download cut off halfway runs nothing.

set -eu

REPO=bothuany/insilode
APP=Insilode.app

say() { printf '%s\n' "$*"; }
fail() { printf 'insilode install: %s\n' "$*" >&2; exit 1; }

# The processor the app is built for. A shell under Rosetta reports x86_64 on Apple silicon; the arm64 build is the right one there.
arch() {
	case "$(uname -m)" in
		arm64 | aarch64) echo arm64 ;;
		x86_64)
			if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then echo arm64; else echo x64; fi
			;;
		*) fail "no Insilode build for the processor $(uname -m)" ;;
	esac
}

# The latest release's version, read from where github.com/<repo>/releases/latest redirects (.../tag/v1.2.3), so no JSON parser is needed.
latest_version() {
	url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || fail 'could not reach GitHub to find the latest release'
	tag=${url##*/}
	case "$tag" in
		v[0-9]*) echo "${tag#v}" ;;
		*) fail "could not read the latest release from $url" ;;
	esac
}

install_dir() {
	if [ -n "${INSILODE_INSTALL_DIR:-}" ]; then
		echo "$INSILODE_INSTALL_DIR"
	elif [ -w /Applications ]; then
		echo /Applications
	else
		echo "$HOME/Applications"
	fi
}

main() {
	[ "$(uname -s)" = Darwin ] || fail 'this script installs the macOS app. On Windows: irm https://insilode.dev/install.ps1 | iex. On Linux: the .deb, .rpm or tarball from https://github.com/'"$REPO"'/releases/latest'
	for tool in curl ditto shasum; do
		command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing"
	done

	cpu=$(arch)
	version=${INSILODE_VERSION:-$(latest_version)}
	version=${version#v}
	base=${INSILODE_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$version}
	zip="Insilode-$version-darwin-$cpu.zip"
	dest=$(install_dir)

	# Replacing the bundle under a running app leaves it half old, half new until it quits.
	if pgrep -f "$dest/$APP/Contents/MacOS/" >/dev/null 2>&1; then
		fail "Insilode is running from $dest: quit it, then run this again"
	fi

	tmp=$(mktemp -d "${TMPDIR:-/tmp}/insilode.XXXXXX")
	trap 'rm -rf "$tmp"' EXIT
	# A signal handler that returns lets the script carry on, so stop here (the EXIT trap still cleans up).
	trap 'exit 130' INT TERM

	say "Downloading Insilode $version for $cpu"
	curl -fL --progress-bar -o "$tmp/$zip" "$base/$zip" || fail "could not download $base/$zip"
	curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fail "could not download $base/SHA256SUMS.txt"

	expected=$(awk -v f="$zip" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1; exit }' "$tmp/SHA256SUMS.txt")
	[ -n "$expected" ] || fail "SHA256SUMS.txt has no line for $zip"
	actual=$(shasum -a 256 "$tmp/$zip" | awk '{ print $1 }')
	[ "$expected" = "$actual" ] || fail "$zip does not match SHA256SUMS.txt (expected $expected, got $actual): nothing was installed"

	# ditto keeps the bundle's symlinks, permissions and signature, which a plain unzip can break.
	mkdir -p "$tmp/app"
	ditto -x -k "$tmp/$zip" "$tmp/app" || fail "could not unpack $zip"
	[ -d "$tmp/app/$APP" ] || fail "$zip holds no $APP"

	# The new app goes next to the old one first, so a move that fails halfway (another volume, a full disk) still leaves the
	# old app in place; only a complete copy replaces it.
	mkdir -p "$dest"
	rm -rf "$dest/.$APP.new"
	mv "$tmp/app/$APP" "$dest/.$APP.new" || { rm -rf "$dest/.$APP.new"; fail "could not move the app into $dest"; }
	rm -rf "$dest/$APP"
	mv "$dest/.$APP.new" "$dest/$APP"
	# Nothing here added the attribute, but a copy of this script saved from a browser may run with it set on what it writes.
	xattr -dr com.apple.quarantine "$dest/$APP" 2>/dev/null || true

	say "Installed Insilode $version in $dest/$APP"
	say "Open it from Launchpad or with: open \"$dest/$APP\""
	say "For the insilode command, choose \"Shell Command: Install 'insilode' command in PATH\" from the Command Palette."
	say "To update, run this command again."
}

main "$@"
