// The terminal installers the site serves (site/public/install.sh for macOS, site/public/install.ps1 for Windows): each fetches
// the release's file and SHA256SUMS.txt, installs only a file that matches its line, and installs nothing otherwise. They run
// here against a local server that stands in for the GitHub release. install.sh runs with stand-ins for the macOS tools it
// calls (uname, ditto, shasum, pgrep, xattr), so it can be checked on Windows and Linux too.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const temp = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'insilode-install-'))
const run = promisify(execFile)
const VERSION = '9.8.7'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const bash = process.platform !== 'win32' ? (spawnSync('bash', ['--version']).status === 0 ? 'bash' : '') : existsSync(GIT_BASH) ? GIT_BASH : ''
// install.ps1 refuses to run anywhere but Windows (a Linux runner has pwsh too), so its tests run on Windows only.
const pwsh = process.platform === 'win32' && spawnSync('pwsh', ['-NoProfile', '-Command', '1']).status === 0 ? 'pwsh' : ''

const sha256 = text => createHash('sha256').update(text).digest('hex')

/** A local stand-in for a release: serves `files` by name, and a SHA256SUMS.txt over `sums` (by default the files' own hashes). */
async function release(files, sums = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]))) {
	const all = { ...files, 'SHA256SUMS.txt': Object.entries(sums).map(([name, hash]) => `${hash}  ${name}\n`).join('') }
	const server = createServer((req, res) => {
		const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''))
		if (name in all) {
			res.end(all[name])
		} else {
			res.statusCode = 404
			res.end()
		}
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

/** Stand-ins for the macOS tools install.sh calls. ditto "unpacks" the zip by copying it into the bundle, so a test can see which file was installed. */
function macTools() {
	const dir = temp()
	const tool = (name, body) => {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
		chmodSync(join(dir, name), 0o755)
	}
	tool('uname', 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac')
	tool('ditto', 'mkdir -p "$4/Insilode.app/Contents/MacOS" && cp "$3" "$4/Insilode.app/Contents/MacOS/payload"')
	tool('shasum', `node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex') + '  ' + process.argv[1] + '\\\\n')" "$3"`)
	tool('pgrep', 'exit 1')
	tool('xattr', 'exit 0')
	return dir
}

async function installSh(base, dest) {
	const env = { ...process.env, INSILODE_VERSION: VERSION, INSILODE_DOWNLOAD_BASE: base, INSILODE_INSTALL_DIR: dest.replaceAll('\\', '/') }
	// Git Bash puts its own folders in front of the PATH it was given, so the stand-ins go in front from inside the shell.
	const front = 'case "$1" in [A-Za-z]:*) d=$(cygpath -u "$1") ;; *) d=$1 ;; esac; PATH="$d:$PATH" exec sh "$2"'
	try {
		const { stdout } = await run(bash, ['-c', front, 'install', macTools(), join(ROOT, 'site', 'public', 'install.sh')], { env, encoding: 'utf8' })
		return { ok: true, out: stdout }
	} catch (err) {
		return { ok: false, out: `${err.stdout}${err.stderr}` }
	}
}

const zip = `Insilode-${VERSION}-darwin-arm64.zip`

test('install.sh installs the zip that matches SHA256SUMS.txt, and replaces an older install', { skip: bash ? false : 'needs bash' }, async () => {
	const server = await release({ [zip]: 'the new app' })
	try {
		const dest = temp()
		mkdirSync(join(dest, 'Insilode.app', 'old'), { recursive: true })
		const result = await installSh(server.base, dest)
		assert.ok(result.ok, result.out)
		assert.equal(readFileSync(join(dest, 'Insilode.app', 'Contents', 'MacOS', 'payload'), 'utf8'), 'the new app')
		assert.ok(!existsSync(join(dest, 'Insilode.app', 'old')), 'the old bundle is replaced, not merged into')
		assert.match(result.out, new RegExp(`Installed Insilode ${VERSION.replaceAll('.', '\\.')}`))
	} finally {
		server.close()
	}
})

test('install.sh installs nothing when the zip does not match SHA256SUMS.txt, or has no line there', { skip: bash ? false : 'needs bash' }, async () => {
	for (const sums of [{ [zip]: sha256('another file') }, { 'Insilode-other.zip': sha256('the app') }]) {
		const server = await release({ [zip]: 'the app' }, sums)
		try {
			const dest = temp()
			const result = await installSh(server.base, dest)
			assert.ok(!result.ok, result.out)
			assert.match(result.out, /does not match SHA256SUMS\.txt|has no line for/)
			assert.ok(!existsSync(join(dest, 'Insilode.app')))
		} finally {
			server.close()
		}
	}
})

const setup = `Insilode-Setup-${VERSION}-x64.exe`

/** install.ps1 the way the site tells people to run it (`irm | iex`: in the caller's session), downloading only. */
async function installPs1(base) {
	const env = { ...process.env, INSILODE_VERSION: VERSION, INSILODE_DOWNLOAD_BASE: base, INSILODE_DOWNLOAD_ONLY: '1' }
	const script = join(ROOT, 'site', 'public', 'install.ps1')
	try {
		const { stdout } = await run(pwsh, ['-NoProfile', '-Command', `Get-Content -Raw '${script}' | Invoke-Expression`], { env, encoding: 'utf8' })
		return { ok: true, out: stdout }
	} catch (err) {
		return { ok: false, out: `${err.stdout}${err.stderr}` }
	}
}

test('install.ps1 keeps a setup that matches SHA256SUMS.txt, without the Mark of the Web SmartScreen checks', { skip: pwsh ? false : 'needs pwsh on Windows' }, async () => {
	const server = await release({ [setup]: 'the setup' })
	try {
		const result = await installPs1(server.base)
		assert.ok(result.ok, result.out)
		const exe = /Checked (.+?) against SHA256SUMS\.txt/.exec(result.out)?.[1]
		assert.ok(exe && existsSync(exe), result.out)
		assert.equal(readFileSync(exe, 'utf8'), 'the setup')
		if (process.platform === 'win32') {
			// The Zone.Identifier stream is the Mark of the Web; without it SmartScreen does not stop the setup.
			assert.ok(!existsSync(`${exe}:Zone.Identifier`), 'the download carries no Mark of the Web')
		}
	} finally {
		server.close()
	}
})

test('install.ps1 stops before running anything when the setup does not match SHA256SUMS.txt', { skip: pwsh ? false : 'needs pwsh on Windows' }, async () => {
	const server = await release({ [setup]: 'the setup' }, { [setup]: sha256('another file') })
	try {
		const result = await installPs1(server.base)
		assert.ok(!result.ok, result.out)
		assert.match(result.out, /does not match SHA256SUMS\.txt.*nothing was installed/)
	} finally {
		server.close()
	}
})
