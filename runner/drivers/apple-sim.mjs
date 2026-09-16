// Apple simulator driver: iOS, watchOS, tvOS and visionOS.
//
// simctl gives clean device-pixel screenshots and real video recording, but it
// has no way to synthesise a touch. The simulator window is on the macOS
// desktop, though, and CGEvent input works there, so a tap is a device
// coordinate mapped into that window and clicked. That reuses the helper the
// macOS driver already compiles.
//
// Runtimes are discovered, never pinned: GitHub keeps only the last three Xcode
// releases' runtimes and prunes them monthly, and an SDK being installed does
// not mean its runtime is.

import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepare as prepareInput, rawInput } from './macos.mjs'

const run = promisify(execFile)

const FAMILY_PATTERNS = {
	ios: /iOS/i,
	watchos: /watchOS/i,
	tvos: /tvOS/i,
	visionos: /xrOS|visionOS/i,
}

const family = (process.env.VSIM_SIM_FAMILY || 'ios').toLowerCase()
let device = null

async function simctl(args, options = {}) {
	return run('xcrun', ['simctl', ...args], { maxBuffer: 64 * 1024 * 1024, ...options })
}

/** Picks the newest available device of the requested family. */
async function pickDevice() {
	const pattern = FAMILY_PATTERNS[family]
	if (!pattern) throw new Error(`unknown simulator family: ${family}`)

	const { stdout } = await simctl(['list', 'devices', 'available', '--json'], { encoding: 'utf8' })
	const catalogue = JSON.parse(stdout).devices

	const candidates = Object.entries(catalogue)
		.filter(([runtime]) => pattern.test(runtime))
		.flatMap(([runtime, devices]) =>
			devices.filter((d) => d.isAvailable).map((d) => ({ ...d, runtime })))

	if (!candidates.length) {
		const installed = Object.keys(catalogue).join(', ') || 'none'
		throw new Error(`no ${family} simulator on this runner. Installed runtimes: ${installed}`)
	}

	// Newest runtime wins; within a runtime, the later entry is the newer model.
	candidates.sort((a, b) => a.runtime.localeCompare(b.runtime, undefined, { numeric: true }))
	return candidates[candidates.length - 1]
}

export async function prepare() {
	if (device) return
	device = await pickDevice()
	await simctl(['boot', device.udid]).catch(() => {}) // already booted is fine
	await simctl(['bootstatus', device.udid, '-b'])
	await prepareInput()
	// The window only exists once Simulator.app is running, and taps need it.
	await run('open', ['-a', 'Simulator'])
	await waitForWindow()
}

async function waitForWindow(timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs
	let last = 'not checked'
	while (Date.now() < deadline) {
		try {
			return await windowRect()
		} catch (err) {
			last = String(err?.message ?? err)
		}
		await new Promise((r) => setTimeout(r, 2000))
	}
	throw new Error(`the Simulator window never appeared (${last})`)
}

/**
 * The simulator's screen area in macOS screen coordinates.
 *
 * Prefers the window's own content element, because the offset of a title bar
 * or toolbar is not something worth guessing at.
 */
async function windowRect() {
	// Variable names matter here: `ip` is a reserved word in AppleScript, and
	// assigning to it fails with "Can't set IP to ...".
	const script = `
    tell application "System Events" to tell process "Simulator"
      set theWindow to window 1
      set windowPos to position of theWindow
      set windowSize to size of theWindow
      try
        set innerView to group 1 of theWindow
        set innerPos to position of innerView
        set innerSize to size of innerView
        return "inner|" & (item 1 of innerPos) & "," & (item 2 of innerPos) & "," & (item 1 of innerSize) & "," & (item 2 of innerSize)
      end try
      return "window|" & (item 1 of windowPos) & "," & (item 2 of windowPos) & "," & (item 1 of windowSize) & "," & (item 2 of windowSize)
    end tell`
	const { stdout } = await run('osascript', ['-e', script], { timeout: 20_000 })
	const [kind, numbers] = stdout.trim().split('|')
	if (!numbers) throw new Error('no Simulator window')
	const [x, y, width, height] = numbers.split(',').map(Number)
	// Fall back to trimming a standard title bar when the inner element is not
	// exposed; everything below it is the device screen.
	const titleBar = kind === 'inner' ? 0 : 28
	return { x, y: y + titleBar, width, height: height - titleBar }
}

export async function info() {
	if (!device) await prepare()
	const png = await screenshot()
	const { width, height } = pngSize(png)
	return {
		os: family,
		display: `${device.name} — ${device.runtime.replace('com.apple.CoreSimulator.SimRuntime.', '')}`,
		width,
		height,
		udid: device.udid,
	}
}

/** PNG header read: avoids shelling out to sips for two numbers. */
function pngSize(buffer) {
	if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

export async function screenshot() {
	if (!device) await prepare()
	const path = join(tmpdir(), `vsim-sim-${process.pid}-${Date.now()}.png`)
	try {
		await simctl(['io', device.udid, 'screenshot', '--type=png', path])
		return await readFile(path)
	} finally {
		await rm(path, { force: true })
	}
}

/** Device pixels in, macOS screen coordinates out. */
async function toScreen(x, y) {
	const png = await screenshot()
	const { width, height } = pngSize(png)
	const rect = await windowRect()
	return {
		x: Math.round(rect.x + (Number(x) / width) * rect.width),
		y: Math.round(rect.y + (Number(y) / height) * rect.height),
	}
}

export async function click(x, y, button = 'left') {
	const point = await toScreen(x, y)
	await rawInput(['click', point.x, point.y, button])
}

export async function move(x, y) {
	const point = await toScreen(x, y)
	await rawInput(['move', point.x, point.y])
}

async function focusSimulator() {
	await run('open', ['-a', 'Simulator'])
	await new Promise((r) => setTimeout(r, 400))
}

export async function typeText(text) {
	// The simulator forwards the Mac keyboard to the device once its window has
	// focus, so no simctl equivalent is needed.
	await focusSimulator()
	await rawInput(['type', String(text)])
}

export async function key(combo) {
	await focusSimulator()
	await rawInput(['key', String(combo)])
}

export async function exec(command) {
	// Runs on the host, where simctl, xcrun and the build tools live. Use
	// `xcrun simctl spawn <udid> ...` inside it to reach the device.
	try {
		const { stdout, stderr } = await run('/bin/bash', ['-lc', command], { maxBuffer: 32 * 1024 * 1024 })
		return { stdout, stderr, code: 0 }
	} catch (err) {
		return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message), code: err.code ?? 1 }
	}
}

/**
 * Apple exposes a simulated app's accessibility tree only to XCUITest, so this
 * reports what is inspectable from outside rather than pretending otherwise.
 */
export async function tree() {
	if (!device) await prepare()
	const { stdout } = await simctl(['listapps', device.udid], { encoding: 'utf8' }).catch(() => ({ stdout: '' }))
	const apps = [...stdout.matchAll(/CFBundleIdentifier\s*=\s*"([^"]+)"/g)].map((m) => m[1])
	const rect = await windowRect()
	return {
		kind: 'apple-simulator',
		note: 'Apple exposes an app\'s accessibility tree only to XCUITest. Use a screenshot to decide where to tap.',
		device: { name: device.name, runtime: device.runtime, udid: device.udid },
		windows: [{ name: `${device.name} (Simulator)`, ...rect }],
		apps,
	}
}

let recording = null

export async function startRecording(name, localPath) {
	if (recording) throw new Error('already recording')
	if (!device) await prepare()
	const child = execFile('xcrun', ['simctl', 'io', device.udid, 'recordVideo', '--codec=h264', '--force', localPath])
	recording = { child, localPath }
	await new Promise((r) => setTimeout(r, 1500))
	return { kind: 'simctl-recordVideo', name }
}

export async function stopRecording(localPath) {
	if (!recording) throw new Error('not recording')
	const { child } = recording
	recording = null
	child.kill('SIGINT')
	await new Promise((resolve) => {
		child.on('exit', resolve)
		setTimeout(resolve, 15_000)
	})
	// simctl writes the container after the signal; reading too early gives a
	// file that will not play.
	await new Promise((r) => setTimeout(r, 2000))
	return { path: localPath }
}

/** Installs and launches an .app bundle, which is what most flows want. */
export async function installApp(appPath) {
	if (!device) await prepare()
	await simctl(['install', device.udid, appPath])
	return { installed: appPath }
}
