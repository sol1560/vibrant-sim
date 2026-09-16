// Linux desktop driver.
//
// The desktop is a linuxserver/webtop container, so every command runs through
// `docker exec`. Probed on ubuntu-24.04: the container is serving in ~50s and
// `import -window root` returns a real 1024x768 XFCE frame.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CONTAINER = process.env.VSIM_CONTAINER || 'vsim-desktop'
const DISPLAY = process.env.VSIM_DISPLAY || ':1'

function inContainer(script) {
	return run('docker', ['exec', '-e', `DISPLAY=${DISPLAY}`, CONTAINER, 'bash', '-lc', script], {
		maxBuffer: 64 * 1024 * 1024,
		encoding: 'buffer',
	})
}

async function sh(script) {
	const { stdout } = await inContainer(script)
	return stdout.toString('utf8').trim()
}

export async function prepare() {
	// xdotool and ImageMagick are not in the base webtop image.
	await sh('command -v xdotool >/dev/null && command -v import >/dev/null || ' +
		'(apt-get update -qq && apt-get install -y -qq xdotool imagemagick x11-utils >/dev/null 2>&1)')
}

export async function info() {
	const geometry = await sh('xdotool getdisplaygeometry')
	const [width, height] = geometry.split(/\s+/).map(Number)
	return { os: 'linux', display: DISPLAY, width, height, container: CONTAINER }
}

export async function screenshot() {
	// Write to a file first: piping binary through `docker exec` is lossy on
	// some daemon versions, and the round-trip cost is negligible.
	const { stdout } = await inContainer('import -window root png:- 2>/dev/null')
	if (!stdout.length) throw new Error('screenshot produced no bytes')
	return stdout
}

export const move = (x, y) => sh(`xdotool mousemove ${Number(x)} ${Number(y)}`)

export async function click(x, y, button = 'left') {
	const code = { left: 1, middle: 2, right: 3 }[button]
	if (!code) throw new Error(`unknown button: ${button}`)
	// Avoid `--sync`: it can hang when the pointer is already at the target.
	await sh(`xdotool mousemove ${Number(x)} ${Number(y)} sleep 0.05 click ${code}`)
}

export async function typeText(text) {
	const b64 = Buffer.from(String(text), 'utf8').toString('base64')
	await sh(`xdotool type --clearmodifiers --delay 12 -- "$(echo ${b64} | base64 -d)"`)
}

export async function key(combo) {
	if (!/^[A-Za-z0-9_+ ]+$/.test(combo)) throw new Error(`unsafe key combo: ${combo}`)
	await sh(`xdotool key --clearmodifiers ${combo}`)
}

export async function exec(command) {
	const b64 = Buffer.from(String(command), 'utf8').toString('base64')
	try {
		const { stdout, stderr } = await inContainer(`echo ${b64} | base64 -d | bash`)
		return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), code: 0 }
	} catch (err) {
		return {
			stdout: String(err.stdout ?? ''),
			stderr: String(err.stderr ?? err.message),
			code: err.code ?? 1,
		}
	}
}

let recording = null

/** Real screen recording via x11grab inside the container. */
export async function startRecording(name) {
	if (recording) throw new Error('already recording')
	const remote = `/tmp/${name}.mp4`
	const { width, height } = await info()
	await sh('command -v ffmpeg >/dev/null || (apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null 2>&1)')
	// Detach inside the container so the exec call returns immediately.
	await sh(`nohup ffmpeg -y -f x11grab -video_size ${width}x${height} -framerate 12 -i ${DISPLAY} ` +
		`-c:v libx264 -preset ultrafast -pix_fmt yuv420p ${remote} > /tmp/${name}.ffmpeg.log 2>&1 & echo started`)
	recording = { name, remote }
	return { kind: 'x11grab', name }
}

export async function stopRecording(localPath) {
	if (!recording) throw new Error('not recording')
	const { name, remote } = recording
	recording = null
	await sh('pkill -INT -f "ffmpeg -y -f x11grab" || true')
	// libx264 needs a moment to flush the trailer, or the file is unplayable.
	await new Promise((r) => setTimeout(r, 2500))
	await run('docker', ['cp', `${CONTAINER}:${remote}`, localPath])
	return { path: localPath }
}

/** Window list stands in for an accessibility tree; X11 exposes no richer one. */
export async function tree() {
	const raw = await sh(
		'for id in $(xdotool search --onlyvisible --name "" 2>/dev/null); do ' +
		'name=$(xdotool getwindowname $id 2>/dev/null); ' +
		'geo=$(xdotool getwindowgeometry --shell $id 2>/dev/null | tr "\\n" " "); ' +
		'echo "$id|$name|$geo"; done',
	)
	const windows = raw.split('\n').filter(Boolean).map((line) => {
		const [id, name, geo = ''] = line.split('|')
		const num = (k) => {
			const m = geo.match(new RegExp(`${k}=(-?\\d+)`))
			return m ? Number(m[1]) : null
		}
		return { id, name, x: num('X'), y: num('Y'), width: num('WIDTH'), height: num('HEIGHT') }
	})
	return { kind: 'x11-windows', windows }
}
