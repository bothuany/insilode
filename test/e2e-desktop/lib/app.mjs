// Starts Insilode with a throwaway profile and hands back its windows. Playwright's `_electron` API first (it also gives the
// main process, which the island checks use); a packaged build can have Electron's inspector fuse off, and then `_electron`
// cannot attach, so the app is started with a remote debugging port and Playwright connects to that instead (no main process).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { refusal } from './isolation.mjs'

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Polls `fn` until it returns something truthy or `ms` pass; the error says what was being waited for. */
export async function until(what, fn, { ms = 30000, every = 300 } = {}) {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		try {
			const v = await fn()
			if (v) {
				return v
			}
		} catch (e) {
			last = e
		}
		await sleep(every)
	}
	throw new Error(`Timed out after ${ms / 1000}s waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`)
}

/** A scenario that fails is run again from a fresh app, because a window that is slow to appear is the usual flake. */
export async function withRetries(tries, fn, onRetry = () => { }) {
	let error
	for (let i = 1; i <= tries; i++) {
		try {
			return await fn(i)
		} catch (e) {
			error = e
			if (i < tries) {
				onRetry(i, e)
			}
		}
	}
	throw error
}

/**
 * Linux has no OS keyring in a container (no GNOME Keyring or KWallet on the session bus), and the first read of secret
 * storage (flow-view keeps its IDE bridge token there) then opens a modal "An OS keyring couldn't be identified" that
 * blocks the window until someone answers it. The basic store keeps secrets in the throwaway profile and asks nothing.
 * Windows and macOS always have their keychain, so they keep the default.
 */
export function passwordStoreArgs(platform = process.platform) {
	return platform === 'linux' ? ['--password-store=basic'] : []
}

const isWorkbench = url => /workbench(\.desktop)?\.html|workbench\.esm/.test(url) || (url.startsWith('vscode-file:') && url.includes('workbench'))
export const isOverlay = url => url.startsWith('data:text/html')

/**
 * @param {object} o
 * @param {string} o.exe          Electron or Insilode executable
 * @param {string[]} [o.args]     arguments before ours (`.` plus flags for a source checkout)
 * @param {string} [o.cwd]
 * @param {string} o.out          where logs go
 * @param {string} [o.folder]     workspace to open
 * @param {object} [o.settings]   written to the profile's settings.json
 * @param {Record<string, string | object>} [o.files]  more files for the profile, by path under its user data folder (e.g. `User/globalStorage/storage.json`, the main process's window state); objects are written as JSON
 * @param {object} [o.env]
 * @param {boolean} [o.updates]    leave the update service on (default: off)
 * @param {boolean} [o.updates]    leave the update service on (default: off)
 * @param {string[]} [o.extensions]  folders loaded with --extensionDevelopmentPath
 */
export async function launchInsilode(o) {
	const why = refusal()
	if (why) {
		throw new Error(why)
	}
	// Loaded here so that the helpers of this folder (and their unit tests) work without the dependency installed.
	const { _electron, chromium } = await import('playwright-core')
	const profile = mkdtempSync(join(tmpdir(), 'insilode-e2e-'))
	const userData = join(profile, 'user-data')
	mkdirSync(join(userData, 'User'), { recursive: true })
	const settings = { 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none', 'window.confirmBeforeClose': 'never', ...o.settings }
	writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2))
	for (const [file, content] of Object.entries(o.files ?? {})) {
		mkdirSync(dirname(join(userData, file)), { recursive: true })
		writeFileSync(join(userData, file), typeof content === 'string' ? content : JSON.stringify(content))
	}
	const args = [
		...(o.args ?? []),
		'--user-data-dir', userData,
		'--extensions-dir', join(profile, 'extensions'),
		'--disable-workspace-trust', '--skip-release-notes',
		// --disable-dev-shm-usage: in a container (Docker's /dev/shm is small) Chromium otherwise fails a few percent of the module loads, and the workbench never starts.
		'--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', ...(o.updates ? [] : ['--disable-updates']),
		...passwordStoreArgs(),
		...(o.extensions ?? []).map(e => `--extensionDevelopmentPath=${e}`),
		...(o.folder ? [o.folder] : []),
	]
	const env = { ...process.env, ...o.env, ELECTRON_ENABLE_LOGGING: '1', VSCODE_SKIP_PRELAUNCH: '1' }
	delete env.ELECTRON_RUN_AS_NODE
	let mode = '_electron'
	let app
	let proc
	let browser
	try {
		app = await _electron.launch({ executablePath: o.exe, args, cwd: o.cwd, env, timeout: 60000 })
		// Electron's own log (crashes, GPU and sandbox problems, files it could not read) is what explains an empty window.
		const log = createWriteStream(join(o.out, 'app.log'), { flags: 'a' })
		app.process().stdout?.pipe(log)
		app.process().stderr?.pipe(log)
	} catch (e) {
		mode = 'cdp'
		console.log(`  _electron could not attach (${String(e.message).split('\n')[0]}); using a remote debugging port`)
		const port = 9333 + Math.floor(Math.random() * 500)
		const log = createWriteStream(join(o.out, 'app.log'), { flags: 'a' })
		proc = spawn(o.exe, [...args, `--remote-debugging-port=${port}`], { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
		proc.stdout.pipe(log)
		proc.stderr.pipe(log)
		await until('the debugging port', async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, { ms: 60000 })
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
	}
	const pages = () => mode === '_electron' ? app.windows() : browser.contexts().flatMap(c => c.pages())
	const self = {
		mode,
		profile,
		pages,
		/** The editor window: waits for the workbench to exist, not just for a window. */
		async workbench(ms = 90000) {
			const page = await until('the Insilode window', () => pages().find(p => isWorkbench(p.url())), { ms })
			await page.waitForSelector('.monaco-workbench', { timeout: ms })
			return page
		},
		overlayPage: () => pages().find(p => isOverlay(p.url())),
		/** Runs in Electron's main process; only with _electron. */
		async main(fn, arg) {
			if (mode !== '_electron') {
				throw new Error('needs the main process, which this run cannot reach (the app ignores Electron\'s inspector)')
			}
			return app.evaluate(fn, arg)
		},
		/** Changes the profile's settings while the app runs: VS Code watches the file. */
		setSettings(patch) {
			Object.assign(settings, patch)
			writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2))
		},
		pid: () => proc?.pid ?? app?.process().pid,
		/**
		 * Quits the app and deletes its profile. `beforeRemove` runs once the app is gone and before the profile is deleted: the
		 * moment to copy its logs or read what it wrote (they are complete then, and gone after).
		 */
		async close(beforeRemove) {
			try {
				if (mode === '_electron') {
					await Promise.race([app.close(), sleep(15000)])
					app.process().kill()
				} else {
					await browser.close().catch(() => undefined)
					proc.kill()
				}
			} catch {
				// already gone
			}
			await sleep(500)
			try {
				await beforeRemove?.(profile)
			} catch (e) {
				console.log(`  after closing the app: ${e.message}`)
			}
			try {
				rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
			} catch {
				// a log file Electron still holds: the runner is thrown away anyway
			}
		},
	}
	return self
}
