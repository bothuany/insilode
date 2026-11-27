// Renders each loop's HyperFrames project (build.mjs) and writes the files the home page plays: <loop>.webm (VP9), <loop>.mp4 (H.264)
// and <loop>-poster.webp (its first frame, which is also its last), silent and at most LIMIT bytes each.
//   node video/deliver.mjs [work dir] [media dir] [loops]
// The media dir defaults to site/public/media/loops.
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = fileURLToPath(new URL('..', import.meta.url))
const work = resolve(process.argv[2] ?? join(tmpdir(), 'insilode-loops'))
const media = resolve(process.argv[3] ?? join(site, 'public', 'media', 'loops'))
const LOOPS = process.argv.slice(4).length ? process.argv.slice(4) : ['reading', 'review', 'services', 'agents']
const LIMIT = 2.5e6
mkdirSync(media, { recursive: true })

const run = (cmd, args, cwd) => {
	const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}
// npx through the running Node: the Windows npx.cmd shim (nvm) looks for npm next to the working directory.
const NPX = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
const ff = (...args) => run('ffmpeg', ['-loglevel', 'error', '-y', ...args])
const size = f => statSync(f).size

/** Encodes with the best quality (lowest CRF) from `crf` up whose file fits LIMIT. */
function fitted(encode, file, crf, step) {
	for (; crf <= 51; crf += step) {
		encode(crf)
		if (size(file) <= LIMIT) return crf
	}
	throw new Error(`${file} does not fit in ${LIMIT} bytes`)
}

for (const loop of LOOPS) {
	const project = join(work, 'build', loop)
	run(process.execPath, [NPX, 'hyperframes', 'render', '-o', `renders/${loop}.mp4`, '--quality', 'delivery', '--video-frame-format', 'png', '--quiet'], project)
	const master = join(project, 'renders', `${loop}.mp4`)
	const mp4 = join(media, `${loop}.mp4`)
	const webm = join(media, `${loop}.webm`)
	// H.264 with the moov atom first, so the page can start playing before it has the whole file.
	const h264 = fitted(crf => ff('-i', master, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4), mp4, 23, 2)
	const vp9 = fitted(crf => ff('-i', master, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-an', webm), webm, 33, 3)
	ff('-i', master, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', join(media, `${loop}-poster.webp`))
	console.log(loop, `mp4 ${(size(mp4) / 1e6).toFixed(2)} MB (crf ${h264})`, `webm ${(size(webm) / 1e6).toFixed(2)} MB (crf ${vp9})`)
}
