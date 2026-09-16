// Brings up one session on the runner and hands the caller a sealed handle.
//
// Order matters: the desktop must answer before the gateway is exposed, and the
// tunnel must be up before anything is sealed, so the caller never receives a
// handle that does not work yet.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seal } from './envelope.mjs'

const OS = process.env.VSIM_OS || process.platform
const RECIPIENT = process.env.VSIM_RECIPIENT_KEY || ''
// An unattended verify run is the agent, so it needs no tunnel and no sealing:
// the handle never leaves the machine.
const USE_TUNNEL = process.env.VSIM_TUNNEL !== 'off'
const TTL_MINUTES = Math.min(Number(process.env.VSIM_TTL_MINUTES || 30), 330)
const IDLE_MINUTES = Number(process.env.VSIM_IDLE_MINUTES || 10)
const OUT_DIR = process.env.VSIM_OUT_DIR || '.vsim'
const GATEWAY_PORT = 7890
// Simulators have no framebuffer server to put a browser in front of, so they
// run with no upstream and the gateway's own viewer is the picture.
const DEVICE_TARGETS = new Set(['android', 'ios', 'watchos', 'tvos', 'visionos'])
const IS_DEVICE = DEVICE_TARGETS.has(OS)
const DESKTOP_PORT = IS_DEVICE ? 0 : OS === 'linux' ? 3000 : 6080
const VNC_PASSWORD = 'vs' + randomBytes(3).toString('hex') // VNC legacy caps this at 8 chars

if (USE_TUNNEL && !RECIPIENT) throw new Error('VSIM_RECIPIENT_KEY is required when a tunnel is exposed')
mkdirSync(OUT_DIR, { recursive: true })

const children = []
const log = (...args) => console.log('[vsim]', ...args)

// The workflow watches for this file instead of polling a pid: `kill -0` is not
// reliable under Git Bash on Windows, and a job that cannot tell the session
// ended holds the runner until the TTL runs out.
let finished = false
function finish(reason) {
	if (finished) return
	finished = true
	try {
		writeFileSync(join(OUT_DIR, 'ended.json'), JSON.stringify({ reason, endedAt: new Date().toISOString() }, null, 2))
	} catch { /* the job timeout is the backstop */ }
	for (const child of children) child.kill('SIGTERM')
}

process.on('exit', () => finish('process exited'))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { finish(signal); process.exit(0) })
process.on('uncaughtException', (err) => {
	console.error('[vsim] fatal:', err?.message ?? err)
	finish(`fatal: ${err?.message ?? err}`)
	process.exit(1)
})

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

/** Runs a full command line through the shell, so quoting survives. */
function shellCommand(commandLine, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(commandLine, { shell: true, stdio: 'inherit', ...options })
		child.on('error', reject)
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`command failed (${code}): ${commandLine.split(' ')[0]}`)))) 
	})
}

async function startWindowsDesktop() {
	log('installing TightVNC')
	// VNC authentication is off on purpose: the server only listens on loopback
	// and the gateway already demands a pairing key. Turning it on here would
	// also put the password in the job log via chocolatey's output.
	await shellCommand(
		'choco install tightvnc -y --no-progress --installargs ' +
		'"ADDLOCAL=Server SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=0 ' +
		'SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=0" > choco.log 2>&1',
	)
	await sleep(5000)

	// TightVNC refuses connections from 127.0.0.1 out of the box, which is
	// exactly where websockify connects from. Without this the viewer shows
	// "loopback connections are not enabled" and never draws the desktop.
	await shellCommand(
		'powershell -NoProfile -Command "' +
		"Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\TightVNC\\Server' -Name AllowLoopback -Value 1 -Type DWord; " +
		"Restart-Service tvnserver -Force" +
		'"',
	)
	await sleep(4000)

	if (!existsSync('C:/novnc')) {
		await shellCommand('git clone --depth 1 -q https://github.com/novnc/noVNC.git C:/novnc')
	}
	await shellCommand('python -m pip install --quiet websockify')
	background('cmd', ['/c', `python -m websockify --web C:/novnc ${DESKTOP_PORT} localhost:5900`])
	await waitForHttp(`http://127.0.0.1:${DESKTOP_PORT}/vnc.html`, { label: 'noVNC', timeoutMs: 120_000 })

	// Unlike the Linux and macOS images, Windows ships without ffmpeg, so a
	// recording would stay a pile of PNGs. Fetch it in the background rather
	// than making every session wait a minute for something most do not use.
	spawn('cmd', ['/c', 'choco install ffmpeg-shared -y --no-progress > ffmpeg-install.log 2>&1'],
		{ stdio: 'ignore', detached: false })
}

async function startAndroidEmulator() {
	const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
	if (!sdk) throw new Error('ANDROID_HOME is not set; Android needs an x64 Linux runner')

	// Without this rule /dev/kvm is root-only, the emulator silently falls back
	// to software rendering, and everything runs two to three times slower.
	// GitHub's own documentation does not mention it.
	log('granting access to /dev/kvm')
	await shellCommand(
		'echo \'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\' ' +
		'| sudo tee /etc/udev/rules.d/99-kvm4all.rules > /dev/null && ' +
		'sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm',
	)
	if (!existsSync('/dev/kvm')) throw new Error('this runner has no /dev/kvm; Android needs x64 Linux')

	const image = process.env.VSIM_ANDROID_IMAGE || 'system-images;android-35;google_apis;x86_64'
	const sdkmanager = join(sdk, 'cmdline-tools/latest/bin/sdkmanager')
	const avdmanager = join(sdk, 'cmdline-tools/latest/bin/avdmanager')

	// avdmanager writes to $ANDROID_SDK_ROOT/.android/avd when that is set, but
	// the emulator never looks there, so pin the location both agree on.
	const avdHome = join(process.env.HOME || homedir(), '.android/avd')
	mkdirSync(avdHome, { recursive: true })
	const androidEnv = {
		...process.env,
		ANDROID_SDK_ROOT: sdk,
		ANDROID_AVD_HOME: avdHome,
		PATH: `${join(sdk, 'emulator')}:${join(sdk, 'platform-tools')}:${process.env.PATH}`,
	}

	log(`installing ${image}`)
	await shellCommand(`yes | "${sdkmanager}" --licenses > /dev/null 2>&1 || true`, { env: androidEnv })
	await shellCommand(`"${sdkmanager}" "platform-tools" "emulator" "${image}" > sdk-install.log 2>&1`, { env: androidEnv })
	await shellCommand(`echo no | "${avdmanager}" create avd -n vsim -k "${image}" -d pixel_6 --force > /dev/null 2>&1`, { env: androidEnv })

	log('booting the emulator')
	background(join(sdk, 'emulator/emulator'),
		['-avd', 'vsim', '-no-window', '-no-audio', '-no-boot-anim',
			'-gpu', 'swiftshader_indirect', '-no-snapshot',
			'-camera-back', 'none', '-camera-front', 'none',
			// Android 15+ prefers Vulkan, and swiftshader's Vulkan path leaves
			// screencap reading an empty framebuffer.
			'-feature', '-Vulkan'],
		{ env: androidEnv })

	const adb = join(sdk, 'platform-tools/adb')
	await sh(adb, ['wait-for-device'], { env: androidEnv })
	await shellCommand(
		`"${adb}" shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'`,
	)
	log('the emulator has finished booting')
	// The gateway runs as a separate process and does not inherit this PATH.
	return { VSIM_ADB: adb }
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

	const deadline = Date.now() + 180_000
	let url = null
	while (Date.now() < deadline) {
		const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
		url ??= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null
		// A URL in the log only means it was allocated. Edge routing is not live
		// until a connection is registered, and on macOS that lags noticeably.
		if (url && /Registered tunnel connection/.test(text)) return url
		await sleep(1500)
	}
	throw new Error(url
		? 'cloudflared allocated a URL but never registered a connection'
		: 'cloudflared never printed a tunnel URL')
}

const pairingKey = randomBytes(32).toString('base64url')
const idleFile = join(OUT_DIR, 'idle-seconds')

let driverEnv = {}
if (OS === 'linux') await startLinuxDesktop()
else if (OS === 'macos' || OS === 'darwin') await startMacDesktop()
else if (OS === 'windows' || OS === 'win32') await startWindowsDesktop()
else if (OS === 'android') driverEnv = await startAndroidEmulator()
// The Apple simulator driver discovers, boots and opens its own device; there
// is nothing for the session to set up first.
else if (!DEVICE_TARGETS.has(OS)) throw new Error(`unsupported VSIM_OS: ${OS}`)

log('starting the gateway')
background(process.execPath, [fileURLToPath(new URL('./gateway.mjs', import.meta.url))], {
	env: {
		...process.env,
		VSIM_PAIRING_KEY: pairingKey,
		VSIM_GATEWAY_PORT: String(GATEWAY_PORT),
		VSIM_UPSTREAM_PORT: String(DESKTOP_PORT),
		VSIM_PLATFORM: OS,
		VSIM_SIM_FAMILY: OS,
		VSIM_IDLE_FILE: idleFile,
		VSIM_STOP_FILE: join(OUT_DIR, 'stop'),
		VSIM_EVIDENCE_DIR: join(OUT_DIR, 'evidence'),
		...driverEnv,
	},
})
// 401 means it is serving and demanding a key, which is all that matters here;
// the driver may still be booting behind it.
await waitForHttp(`http://127.0.0.1:${GATEWAY_PORT}/__vsim/api/health`, {
	label: 'gateway',
	timeoutMs: 120_000,
	accept: (s) => s === 401,
})
log('gateway is serving')

let baseUrl = `http://127.0.0.1:${GATEWAY_PORT}`
if (USE_TUNNEL) {
	baseUrl = await startTunnel(GATEWAY_PORT)
	// Deliberately not probing the tunnel from here. A macOS runner cannot
	// reliably resolve its own trycloudflare hostname, and the caller has to
	// verify reachability anyway before it reports the session as usable.
}

// webtop and TightVNC hand a browser a real remote-framebuffer session. macOS
// cannot: its built-in VNC server demands account credentials, and a hosted
// runner has no secure token to reset the account password with. Simulators
// have no framebuffer server at all. The built-in viewer polls the same
// screenshot endpoint the agent uses, so the picture is there either way.
const viewerPath = OS === 'linux'
	? '/'
	: OS === 'windows'
		? '/vnc.html?autoconnect=1&resize=scale'
		: '/__vsim/view'

const handle = {
	version: 1,
	os: OS,
	runId: process.env.GITHUB_RUN_ID ?? null,
	runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
		? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
		: null,
	tunnelUrl: baseUrl,
	pairingKey,
	viewerUrl: `${baseUrl}/__vsim/auth?k=${encodeURIComponent(pairingKey)}&to=${encodeURIComponent(viewerPath)}`,
	apiUrl: `${baseUrl}/__vsim/api`,
	expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
}

if (USE_TUNNEL) {
	writeFileSync(join(OUT_DIR, 'handle.sealed'), seal(RECIPIENT, handle))
	log(`sealed handle written; ttl ${TTL_MINUTES}m, idle limit ${IDLE_MINUTES}m`)
	log('the tunnel URL is intentionally absent from this log')
} else {
	// Loopback only, never uploaded as an artifact.
	writeFileSync(join(OUT_DIR, 'handle.json'), JSON.stringify(handle, null, 2))
	log(`local handle written; ttl ${TTL_MINUTES}m, idle limit ${IDLE_MINUTES}m`)
}

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
finish(reason)
