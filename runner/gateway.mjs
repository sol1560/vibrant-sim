// The single front door of a session.
//
// One authenticated HTTP endpoint serves both audiences through one tunnel:
//   /                 the live desktop, reverse-proxied (WebSocket included)
//   /__vsim/api/*     the control API an agent drives
//   /__vsim/auth?k=   exchanges the pairing key for a cookie so a browser works
//
// The desktop upstream is deliberately left on the loopback interface. webtop
// ships with no authentication at all, and the built-in VNC servers on macOS
// and Windows are no better, so nothing reaches them without the pairing key.

import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'

const PAIRING_KEY = process.env.VSIM_PAIRING_KEY || ''
const PORT = Number(process.env.VSIM_GATEWAY_PORT || 7890)
const UPSTREAM_PORT = Number(process.env.VSIM_UPSTREAM_PORT || 3000)
const UPSTREAM_HOST = '127.0.0.1'
const PLATFORM = process.env.VSIM_PLATFORM || process.platform
const IDLE_PATH = process.env.VSIM_IDLE_FILE || ''
const STOP_FILE = process.env.VSIM_STOP_FILE || ''
const EVIDENCE_DIR = process.env.VSIM_EVIDENCE_DIR || 'evidence'

if (!PAIRING_KEY) {
	console.error('VSIM_PAIRING_KEY is required; refusing to serve an unauthenticated desktop')
	process.exit(1)
}

const DRIVERS = {
	linux: './drivers/linux.mjs',
	darwin: './drivers/macos.mjs',
	macos: './drivers/macos.mjs',
	win32: './drivers/windows.mjs',
	windows: './drivers/windows.mjs',
	android: './drivers/android.mjs',
	ios: './drivers/apple-sim.mjs',
	watchos: './drivers/apple-sim.mjs',
	tvos: './drivers/apple-sim.mjs',
	visionos: './drivers/apple-sim.mjs',
}

const driverPath = DRIVERS[PLATFORM]
if (!driverPath) {
	console.error(`no driver for platform "${PLATFORM}"; known: ${Object.keys(DRIVERS).join(', ')}`)
	process.exit(1)
}
const driver = await import(driverPath)

let lastActivity = Date.now()
const touch = () => { lastActivity = Date.now() }

// The driver is brought up after the server starts listening, so callers have
// to be told the difference between "not serving" and "not ready yet".
let ready = null
let preparing = true
let prepareError = null

// --- recording ---------------------------------------------------------------
// Linux and macOS record the real display. Windows has no comparable built-in,
// so it falls back to a timed frame sequence that ffmpeg turns into a movie.

let frameLoop = null
let driverRecordingPath = null

async function startRecording(name) {
	mkdirSync(EVIDENCE_DIR, { recursive: true })
	const target = resolve(EVIDENCE_DIR, `${name}.mp4`)
	if (driver.startRecording) {
		const started = await driver.startRecording(name, target)
		driverRecordingPath = target
		return { ...started, path: target }
	}

	const frameDir = join(EVIDENCE_DIR, `${name}-frames`)
	mkdirSync(frameDir, { recursive: true })
	let index = 0
	let busy = false
	frameLoop = {
		name,
		frameDir,
		target,
		timer: setInterval(async () => {
			if (busy) return
			busy = true
			try {
				writeFileSync(join(frameDir, `${String(index++).padStart(5, '0')}.png`), await driver.screenshot())
			} catch { /* a dropped frame must not kill the recording */ } finally { busy = false }
		}, 500),
	}
	return { kind: 'frame-sequence', name, path: target, frameDir }
}

function runFfmpeg(args) {
	return new Promise((resolve) => {
		const ff = spawn('ffmpeg', args, { stdio: 'ignore' })
		ff.on('error', () => resolve(false))
		ff.on('exit', (code) => resolve(code === 0))
	})
}

async function encodeFrames(frameDir, target, waitMs = 120_000) {
	const args = ['-y', '-framerate', '2', '-i', join(frameDir, '%05d.png'),
		'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', target]
	const deadline = Date.now() + waitMs
	let attempt = 0
	while (Date.now() < deadline) {
		if (await runFfmpeg(args) && existsSync(target)) return true
		attempt++
		if (attempt === 1) console.log('[vsim] ffmpeg is not ready yet; waiting for it to finish installing')
		await new Promise((r) => setTimeout(r, 10_000))
	}
	return false
}

async function stopRecording() {
	if (driverRecordingPath) {
		const path = driverRecordingPath
		driverRecordingPath = null
		await driver.stopRecording(path)
		const size = existsSync(path) ? statSync(path).size : 0
		if (!size) throw new Error(`recording finished but ${path} is empty`)
		return { kind: 'native', path, bytes: size }
	}
	if (!frameLoop) throw new Error('not recording')
	const { frameDir, target } = frameLoop
	clearInterval(frameLoop.timer)
	frameLoop = null
	const frames = readdirSync(frameDir).length

	// Windows has no ffmpeg on the image, so the session fetches it in the
	// background. A short recording can finish before that does; wait rather
	// than handing back a directory of PNGs.
	const encoded = await encodeFrames(frameDir, target)

	if (!encoded) {
		return { kind: 'frame-sequence', path: null, frameDir, frames, note: 'ffmpeg unavailable; frames kept as-is' }
	}
	// Hundreds of PNGs would dominate the evidence artifact for no extra value.
	rmSync(frameDir, { recursive: true, force: true })
	return { kind: 'frame-sequence', path: target, frames, bytes: statSync(target).size }
}

/**
 * Clicks whatever the accessibility tree says carries this text.
 *
 * A flow written against pixel coordinates breaks the moment the device or the
 * resolution changes. Where a tree exists, naming the thing is both stabler and
 * easier to read.
 */
async function tapByText(text, exact) {
	if (!text) throw new Error('tap/text needs text')
	const needle = text.toLowerCase()
	const { windows = [] } = await driver.tree()

	const labelOf = (node) => String(node.text ?? node.label ?? node.name ?? '')
	const matches = (node) => {
		const label = labelOf(node).toLowerCase()
		if (!label) return false
		return exact ? label === needle : label.includes(needle)
	}

	// Prefer something the tree says is actually tappable.
	const candidates = windows.filter(matches)
	const target = candidates.find((n) => n.clickable) ?? candidates[0]
	if (!target) {
		const seen = windows.map(labelOf).filter(Boolean).slice(0, 25)
		throw new Error(`nothing matching ${JSON.stringify(text)} on screen. Visible: ${seen.join(' | ') || 'nothing labelled'}`)
	}

	const [x, y] = target.centre ?? [
		Math.round(target.x + (target.width ?? 0) / 2),
		Math.round(target.y + (target.height ?? 0) / 2),
	]
	await driver.click(x, y, 'left')
	return { tapped: labelOf(target), x, y }
}

function keyMatches(candidate) {
	if (typeof candidate !== 'string' || candidate.length !== PAIRING_KEY.length) return false
	return timingSafeEqual(Buffer.from(candidate), Buffer.from(PAIRING_KEY))
}

function presentedKey(req) {
	const auth = req.headers.authorization
	if (auth?.startsWith('Bearer ')) return auth.slice(7)
	const cookie = req.headers.cookie ?? ''
	const match = cookie.match(/(?:^|;\s*)vsim=([^;]+)/)
	if (match) return decodeURIComponent(match[1])
	return null
}

const json = (res, status, body) => {
	const payload = Buffer.from(JSON.stringify(body))
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length })
	res.end(payload)
}

async function handleApi(req, res, url) {
	const action = url.pathname.slice('/__vsim/api/'.length)
	const body = await new Promise((resolve) => {
		const chunks = []
		req.on('data', (c) => chunks.push(c))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
		})
	})

	try {
		if (action === 'health') {
			const body = {
				ok: !preparing && !prepareError,
				platform: PLATFORM,
				preparing,
				idleSeconds: Math.round((Date.now() - lastActivity) / 1000),
				...(prepareError ? { error: prepareError } : {}),
			}
			return json(res, body.ok ? 200 : 503, body)
		}

		// exec is plain shell on the host and does not need the driver, so leave
		// it working when the driver failed; otherwise a broken session cannot
		// be diagnosed from the outside.
		if (action === 'exec') return json(res, 200, await driver.exec(body.command ?? ''))

		// Everything else needs a working driver, so wait for it rather than
		// failing on a session that is simply still booting.
		await ready
		if (prepareError) return json(res, 503, { error: prepareError })

		switch (action) {
			case 'info':
				return json(res, 200, await driver.info())
			case 'screenshot': {
				const png = await driver.screenshot()
				if (body.encoding === 'base64') return json(res, 200, { format: 'png', base64: png.toString('base64') })
				res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
				return res.end(png)
			}
			case 'click':
				await driver.click(body.x, body.y, body.button ?? 'left')
				return json(res, 200, { ok: true })
			case 'move':
				await driver.move(body.x, body.y)
				return json(res, 200, { ok: true })
			case 'type':
				await driver.typeText(body.text ?? '')
				return json(res, 200, { ok: true })
			case 'key':
				await driver.key(body.combo ?? body.keys ?? '')
				return json(res, 200, { ok: true })
			case 'exec':
				return json(res, 200, await driver.exec(body.command ?? ''))
			case 'tree':
				return json(res, 200, await driver.tree())
			case 'tap/text':
				return json(res, 200, await tapByText(body.text ?? '', body.exact === true))
			case 'focus':
				if (!driver.focus) return json(res, 501, { error: `focus is not implemented on ${PLATFORM}` })
				return json(res, 200, await driver.focus(body.title ?? ''))
			case 'record/start':
				return json(res, 200, await startRecording(body.name ?? 'session'))
			case 'record/stop':
				return json(res, 200, await stopRecording())
			case 'stop':
				if (STOP_FILE) writeFileSync(STOP_FILE, new Date().toISOString())
				json(res, 200, { ok: true, stopping: true })
				return setTimeout(() => process.exit(0), 500)
			default:
				return json(res, 404, { error: `unknown action: ${action}` })
		}
	} catch (err) {
		return json(res, 500, { error: String(err?.message ?? err) })
	}
}

function proxyHttp(req, res) {
	const upstream = httpRequest(
		{ host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` } },
		(up) => {
			res.writeHead(up.statusCode ?? 502, up.headers)
			up.pipe(res)
		},
	)
	upstream.on('error', (err) => {
		if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
		res.end(`desktop upstream not reachable: ${err.message}`)
	})
	req.pipe(upstream)
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

	if (url.pathname === '/__vsim/auth') {
		if (!keyMatches(url.searchParams.get('k') ?? '')) {
			res.writeHead(401, { 'content-type': 'text/plain' })
			return res.end('bad pairing key')
		}
		touch()
		res.writeHead(302, {
			'set-cookie': `vsim=${encodeURIComponent(PAIRING_KEY)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
			location: url.searchParams.get('to') || '/',
		})
		return res.end()
	}

	if (!keyMatches(presentedKey(req) ?? '')) {
		res.writeHead(401, { 'content-type': 'text/plain' })
		return res.end('vibrant-sim: pairing key required')
	}
	touch()

	if (url.pathname.startsWith('/__vsim/api/')) return handleApi(req, res, url)
	// A simulator session has no framebuffer server to proxy; the built-in
	// viewer is the only picture, so send the root there.
	if (!UPSTREAM_PORT && url.pathname === '/') {
		res.writeHead(302, { location: '/__vsim/view' })
		return res.end()
	}
	if (url.pathname === '/__vsim/view') {
		const page = readFileSync(new URL('./viewer.html', import.meta.url))
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length })
		return res.end(page)
	}
	return proxyHttp(req, res)
})

// Raw socket relay for the VNC WebSocket; the desktop is useless without it.
server.on('upgrade', (req, socket, head) => {
	if (!keyMatches(presentedKey(req) ?? '')) {
		socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
		return
	}
	touch()
	const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
		const headers = Object.entries(req.headers)
			.flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))
			.join('\r\n')
		upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
		if (head?.length) upstream.write(head)
		socket.pipe(upstream)
		upstream.pipe(socket)
	})
	const drop = () => { socket.destroy(); upstream.destroy() }
	upstream.on('error', drop)
	socket.on('error', drop)
})

if (IDLE_PATH) {
	// The reaper in session.mjs reads this instead of asking the gateway, so a
	// wedged driver still gets the session torn down.
	setInterval(() => {
		try {
			writeFileSync(IDLE_PATH, String(Math.round((Date.now() - lastActivity) / 1000)))
		} catch { /* a missing file just means "no reading yet" */ }
	}, 5000).unref()
}

// Listen first, prepare second. Booting a simulator and compiling the input
// helper can take minutes, and a session that is not listening yet looks dead
// to everything waiting on it.
server.listen(PORT, '127.0.0.1', () => {
	console.log(`gateway listening on 127.0.0.1:${PORT} -> upstream ${UPSTREAM_PORT || 'none'} (${PLATFORM})`)
})

ready = driver.prepare().then(
	() => { preparing = false },
	(err) => {
		preparing = false
		prepareError = String(err?.message ?? err)
		console.error(`[vsim] the driver failed to start: ${prepareError}`)
	},
)
