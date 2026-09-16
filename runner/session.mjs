// Brings up one session on the runner and hands the caller a sealed handle.
//
// Order matters: the desktop must answer before the gateway is exposed, and the
// tunnel must be up before anything is sealed, so the caller never receives a
// handle that does not work yet.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { seal } from './envelope.mjs'

const OS = process.env.VSIM_OS || process.platform
const RECIPIENT = process.env.VSIM_RECIPIENT_KEY || ''
const TTL_MINUTES = Math.min(Number(process.env.VSIM_TTL_MINUTES || 30), 330)
const IDLE_MINUTES = Number(process.env.VSIM_IDLE_MINUTES || 10)
const OUT_DIR = process.env.VSIM_OUT_DIR || '.vsim'
const GATEWAY_PORT = 7890
const DESKTOP_PORT = OS === 'linux' ? 3000 : 6080
const VNC_PASSWORD = 'vs' + randomBytes(3).toString('hex') // VNC legacy caps this at 8 chars

if (!RECIPIENT) throw new Error('VSIM_RECIPIENT_KEY is required')
mkdirSync(OUT_DIR, { recursive: true })

const children = []
const log = (...args) => console.log('[vsim]', ...args)

function background(command, args, options = {}) {
	const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
	children.push(child)
	const tag = `[${command.split(/[\\/]/).pop()}]`
	child.stdout?.on('data', (d) => process.stdout.write(`${tag} ${d}`))
	child.stderr?.on('data', (d) => process.stdout.write(`${tag} ${d}`))
	return child
}

function sh(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...options })
		child.on('error', reject)
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
	})
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForHttp(url, { timeoutMs = 240_000, label = url, accept = (s) => s > 0 && s < 500 } = {}) {
	const deadline = Date.now() + timeoutMs
	let lastError = 'no attempt'
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
			if (accept(res.status)) return res.status
			lastError = `status ${res.status}`
		} catch (err) {
			lastError = String(err?.message ?? err)
		}
		await sleep(2000)
	}
	throw new Error(`${label} did not come up within ${timeoutMs}ms (last: ${lastError})`)
}

// --- desktop, per platform ---------------------------------------------------

async function startLinuxDesktop() {
	log('starting webtop container')
	await sh('docker', ['run', '-d', '--name', 'vsim-desktop', '--shm-size=1gb',
		'-p', `127.0.0.1:${DESKTOP_PORT}:3000`,
		'-e', 'PUID=1000', '-e', 'PGID=1000', '-e', 'TZ=UTC', '-e', 'TITLE=vibrant-sim',
		'lscr.io/linuxserver/webtop:ubuntu-xfce'])
	await waitForHttp(`http://127.0.0.1:${DESKTOP_PORT}/`, { label: 'webtop' })
	log('webtop is serving')
}

async function startNoVnc(vncTarget) {
	if (!existsSync('/tmp/novnc')) {
		await sh('git', ['clone', '--depth', '1', '--recurse-submodules', '-q',
			'https://github.com/novnc/noVNC.git', '/tmp/novnc'])
	}
	const websockify = '/tmp/novnc/utils/websockify/run'
	if (existsSync(websockify)) {
		background('python3', [websockify, '--web', '/tmp/novnc', String(DESKTOP_PORT), vncTarget])
	} else {
		// Bundled submodule missing: fall back to a pip install.
		await sh('python3', ['-m', 'pip', 'install', '--quiet', '--break-system-packages', 'websockify'])
			.catch(() => sh('python3', ['-m', 'pip', 'install', '--quiet', 'websockify']))
		background('python3', ['-m', 'websockify', '--web', '/tmp/novnc', String(DESKTOP_PORT), vncTarget])
	}
	await waitForHttp(`http://127.0.0.1:${DESKTOP_PORT}/vnc.html`, { label: 'noVNC', timeoutMs: 90_000 })
	log('noVNC is serving')
}

async function startMacDesktop() {
	log('enabling the built-in VNC server')
	await sh('sudo', ['/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart',
		'-activate', '-configure', '-access', '-on',
		'-clientopts', '-setvnclegacy', '-vnclegacy', 'yes',
		'-clientopts', '-setvncpw', '-vncpw', VNC_PASSWORD,
		'-restart', '-agent', '-privs', '-all'])
	await sleep(6000)
	await startNoVnc('localhost:5900')
}

async function startWindowsDesktop() {
	log('installing TightVNC')
	await sh('choco', ['install', 'tightvnc', '-y', '--no-progress', '--installargs',
		`ADDLOCAL=Server SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=${VNC_PASSWORD} SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=0`],
		{ shell: true })
	await sleep(5000)
	if (!existsSync('/tmp/novnc') && !existsSync('C:/novnc')) {
		await sh('git', ['clone', '--depth', '1', '-q', 'https://github.com/novnc/noVNC.git', 'C:/novnc'], { shell: true })
	}
	await sh('python', ['-m', 'pip', 'install', '--quiet', 'websockify'], { shell: true })
	background('python', ['-m', 'websockify', '--web', 'C:/novnc', String(DESKTOP_PORT), 'localhost:5900'], { shell: true })
	await waitForHttp(`http://127.0.0.1:${DESKTOP_PORT}/vnc.html`, { label: 'noVNC', timeoutMs: 120_000 })
}

// --- orchestration -----------------------------------------------------------

async function startTunnel(port) {
	log('starting a cloudflared quick tunnel')
	const logPath = join(OUT_DIR, 'cloudflared.log')
	writeFileSync(logPath, '')
	// stdio is discarded on purpose. cloudflared banners the tunnel URL on
	// stderr, and a job log on a public repository is world-readable, so the
	// URL must only ever reach the private logfile and the sealed handle.
	const child = spawn(process.env.VSIM_CLOUDFLARED || 'cloudflared',
		['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--logfile', logPath],
		{ stdio: 'ignore' })
	children.push(child)
	child.on('exit', (code) => log(`cloudflared exited with ${code}`))

	const deadline = Date.now() + 90_000
	while (Date.now() < deadline) {
		const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
		const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
		if (match) return match[0]
		await sleep(1500)
	}
	throw new Error('cloudflared never printed a tunnel URL')
}

const pairingKey = randomBytes(32).toString('base64url')
const idleFile = join(OUT_DIR, 'idle-seconds')

if (OS === 'linux') await startLinuxDesktop()
else if (OS === 'macos' || OS === 'darwin') await startMacDesktop()
else if (OS === 'windows' || OS === 'win32') await startWindowsDesktop()
else throw new Error(`unsupported VSIM_OS: ${OS}`)

log('starting the gateway')
background(process.execPath, [new URL('./gateway.mjs', import.meta.url).pathname], {
	env: {
		...process.env,
		VSIM_PAIRING_KEY: pairingKey,
		VSIM_GATEWAY_PORT: String(GATEWAY_PORT),
		VSIM_UPSTREAM_PORT: String(DESKTOP_PORT),
		VSIM_PLATFORM: OS,
		VSIM_IDLE_FILE: idleFile,
		VSIM_STOP_FILE: join(OUT_DIR, 'stop'),
		VSIM_EVIDENCE_DIR: join(OUT_DIR, 'evidence'),
	},
})
await waitForHttp(`http://127.0.0.1:${GATEWAY_PORT}/__vsim/api/health`, {
	label: 'gateway',
	timeoutMs: 240_000,
	accept: (s) => s === 401 || s === 200,
})
log('gateway is up')

const tunnelUrl = await startTunnel(GATEWAY_PORT)
await waitForHttp(`${tunnelUrl}/__vsim/api/health`, { label: 'tunnel', timeoutMs: 60_000, accept: (s) => s === 401 })

const viewerPath = OS === 'linux'
	? '/'
	: `/vnc.html?autoconnect=1&resize=scale&password=${encodeURIComponent(VNC_PASSWORD)}`

const handle = {
	version: 1,
	os: OS,
	runId: process.env.GITHUB_RUN_ID ?? null,
	runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
		? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
		: null,
	tunnelUrl,
	pairingKey,
	viewerUrl: `${tunnelUrl}/__vsim/auth?k=${encodeURIComponent(pairingKey)}&to=${encodeURIComponent(viewerPath)}`,
	apiUrl: `${tunnelUrl}/__vsim/api`,
	expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
}

writeFileSync(join(OUT_DIR, 'handle.sealed'), seal(RECIPIENT, handle))
log(`sealed handle written; ttl ${TTL_MINUTES}m, idle limit ${IDLE_MINUTES}m`)
log('the tunnel URL is intentionally absent from this log')

// --- keep alive --------------------------------------------------------------

const expiry = Date.now() + TTL_MINUTES * 60_000
const stopFile = join(OUT_DIR, 'stop')
let reason = 'ttl'

while (Date.now() < expiry) {
	if (existsSync(stopFile)) { reason = 'stopped by caller'; break }
	if (existsSync(idleFile)) {
		const idle = Number(readFileSync(idleFile, 'utf8')) || 0
		if (idle > IDLE_MINUTES * 60) { reason = `idle for ${idle}s`; break }
	}
	await sleep(5000)
}

log(`session ending: ${reason}`)
writeFileSync(join(OUT_DIR, 'ended.json'), JSON.stringify({ reason, endedAt: new Date().toISOString() }, null, 2))
for (const child of children) child.kill('SIGTERM')
