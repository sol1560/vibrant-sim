// Android emulator driver.
//
// The emulator only runs at a usable speed on an x64 Linux runner with KVM, and
// KVM needs a udev rule the GitHub docs do not mention; session.mjs installs it.
//
// Unlike the desktop platforms, Android hands out a real accessibility tree
// through uiautomator, with element text, resource ids, bounds and whether each
// node is clickable. Read that before reaching for a screenshot.

import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ADB = process.env.VSIM_ADB || 'adb'
const SERIAL = process.env.VSIM_ANDROID_SERIAL || 'emulator-5554'

function adb(args, options = {}) {
	return run(ADB, ['-s', SERIAL, ...args], { maxBuffer: 64 * 1024 * 1024, ...options })
}

async function shell(command) {
	const { stdout } = await adb(['shell', command], { encoding: 'utf8' })
	return stdout.trim()
}

export async function prepare() {
	await adb(['wait-for-device'])
	// A device that answers adb is not necessarily finished booting.
	await shell('while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done')
	await shell('while ! pm list packages > /dev/null 2>&1; do sleep 1; done')

	// A hosted runner has no GPU, so everything renders in software. Animations
	// are what actually pushes the launcher into "isn't responding"; without
	// them the first screenshot is a real home screen rather than a black frame.
	for (const scale of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
		await shell(`settings put global ${scale} 0`).catch(() => {})
	}
	await shell('input keyevent 82').catch(() => {})
	await shell('wm dismiss-keyguard').catch(() => {})
	await settleLauncher()
}

/**
 * Waits for the home screen to actually draw, dismissing the not-responding
 * dialog if software rendering made the launcher miss its deadline.
 */
async function settleLauncher(timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const focus = await shell('dumpsys window displays | grep -m1 -i mCurrentFocus').catch(() => '')

		if (/Application Not Responding|ANR/i.test(focus)) {
			const waitButton = (await tree()).windows.find((n) => n.text === 'Wait' && n.clickable)
			if (waitButton) await click(...waitButton.centre)
			await new Promise((r) => setTimeout(r, 3000))
			continue
		}
		if (/Launcher|launcher/.test(focus)) return
		await new Promise((r) => setTimeout(r, 2000))
	}
	// Not fatal: a flow that launches its own app never needs the home screen.
	console.log('[vsim] the launcher never settled; carrying on anyway')
}

export async function info() {
	const size = await shell('wm size')
	const [, width, height] = size.match(/(\d+)x(\d+)/) ?? []
	const density = (await shell('wm density')).match(/(\d+)/)?.[1]
	return {
		os: 'android',
		display: `${await shell('getprop ro.build.version.release')} (api ${await shell('getprop ro.build.version.sdk')})`,
		width: Number(width),
		height: Number(height),
		density: Number(density),
		serial: SERIAL,
	}
}

export async function screenshot() {
	// exec-out keeps the PNG binary-clean; `shell screencap` mangles newlines.
	const { stdout } = await adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' })
	if (!stdout.length) throw new Error('screencap produced no bytes')
	if (!looksBlank(stdout)) return stdout

	// screencap reads the framebuffer directly, and under software rendering
	// that can come back a single flat colour while the screen is in fact
	// drawn — screenrecord, which goes through the display pipeline, shows the
	// real thing. Falling back costs a few seconds, so only do it when the
	// frame really is empty.
	console.log('[vsim] screencap returned a blank frame; grabbing one from screenrecord instead')
	return frameFromRecording()
}

/**
 * A flat frame compresses to almost nothing. A real screen at phone resolution
 * never does, so an implausibly small PNG means the framebuffer read failed.
 */
function looksBlank(png) {
	const { width, height } = pngSize(png)
	return width * height > 250_000 && png.length < 40_000
}

function pngSize(png) {
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function frameFromRecording() {
	const remote = '/sdcard/vsim-frame.mp4'
	const local = join(tmpdir(), `vsim-frame-${process.pid}-${Date.now()}.mp4`)
	const still = `${local}.png`
	try {
		await shell(`rm -f ${remote}`)
		await adb(['shell', 'screenrecord', '--time-limit', '2', '--bit-rate', '4000000', remote])
		await adb(['pull', remote, local])
		await run('ffmpeg', ['-v', 'error', '-sseof', '-1', '-i', local, '-frames:v', '1', '-y', still])
		return await readFile(still)
	} finally {
		await rm(local, { force: true })
		await rm(still, { force: true })
	}
}

export const click = (x, y) => shell(`input tap ${Number(x)} ${Number(y)}`)

/** There is no pointer to move on a touch screen; a tap is the whole gesture. */
export const move = (x, y) => shell(`input tap ${Number(x)} ${Number(y)}`)

export async function typeText(text) {
	// `input text` reads spaces as argument separators and chokes on shell
	// metacharacters, so send it one safely escaped chunk at a time.
	for (const chunk of String(text).match(/.{1,120}/gs) ?? []) {
		const escaped = chunk
			.replace(/(["'`\\$&|;<>()~*?\[\]{}!#])/g, '\\$1')
			.replace(/ /g, '%s')
		await shell(`input text "${escaped}"`)
	}
}

const KEYCODES = {
	return: 'KEYCODE_ENTER', enter: 'KEYCODE_ENTER', tab: 'KEYCODE_TAB',
	space: 'KEYCODE_SPACE', delete: 'KEYCODE_DEL', backspace: 'KEYCODE_DEL',
	escape: 'KEYCODE_ESCAPE', back: 'KEYCODE_BACK', home: 'KEYCODE_HOME',
	menu: 'KEYCODE_MENU', power: 'KEYCODE_POWER', search: 'KEYCODE_SEARCH',
	up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
	left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
	volumeup: 'KEYCODE_VOLUME_UP', volumedown: 'KEYCODE_VOLUME_DOWN',
	appswitch: 'KEYCODE_APP_SWITCH', recents: 'KEYCODE_APP_SWITCH',
}

export async function key(combo) {
	const name = String(combo).toLowerCase().replace(/[\s_-]/g, '')
	const code = KEYCODES[name] ?? (/^KEYCODE_[A-Z0-9_]+$/.test(combo) ? combo : null)
	if (!code) throw new Error(`unknown key: ${combo}`)
	await shell(`input keyevent ${code}`)
}

export async function exec(command) {
	try {
		const { stdout, stderr } = await adb(['shell', command], { encoding: 'utf8' })
		return { stdout, stderr, code: 0 }
	} catch (err) {
		return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message), code: err.code ?? 1 }
	}
}

/** Real accessibility tree: text, ids, bounds, and what is actually tappable. */
export async function tree() {
	await shell('uiautomator dump /sdcard/vsim-ui.xml')
	const { stdout } = await adb(['exec-out', 'cat', '/sdcard/vsim-ui.xml'], { encoding: 'utf8' })

	const nodes = []
	for (const match of stdout.matchAll(/<node\b([^>]*)\/?>/g)) {
		const attrs = Object.fromEntries(
			[...match[1].matchAll(/(\w[\w-]*)="([^"]*)"/g)].map(([, k, v]) => [k, v]),
		)
		const bounds = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
		if (!bounds) continue
		const [, x1, y1, x2, y2] = bounds.map(Number)
		// A node with no label and no id is layout, not something to act on.
		if (!attrs.text && !attrs['content-desc'] && !attrs['resource-id']) continue
		nodes.push({
			text: attrs.text || undefined,
			label: attrs['content-desc'] || undefined,
			id: attrs['resource-id'] || undefined,
			class: attrs.class,
			clickable: attrs.clickable === 'true',
			enabled: attrs.enabled === 'true',
			x: x1,
			y: y1,
			width: x2 - x1,
			height: y2 - y1,
			centre: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
		})
	}
	return { kind: 'android-uiautomator', windows: nodes }
}

let recording = null

export async function startRecording(name, localPath) {
	if (recording) throw new Error('already recording')
	const remote = `/sdcard/${name}.mp4`
	await shell(`rm -f ${remote}`)
	// screenrecord caps at three minutes per file; long sessions get a series.
	const child = execFile(ADB, ['-s', SERIAL, 'shell', 'screenrecord', '--time-limit', '180', remote])
	recording = { remote, localPath, child }
	await new Promise((r) => setTimeout(r, 1500))
	return { kind: 'screenrecord', name }
}

export async function stopRecording(localPath) {
	if (!recording) throw new Error('not recording')
	const { remote, child } = recording
	recording = null
	child.kill('SIGINT')
	// screenrecord finalises the container after the signal; pulling too early
	// yields a file that will not play.
	await new Promise((r) => setTimeout(r, 3500))
	await adb(['pull', remote, localPath])
	return { path: localPath }
}

/** Installs and launches an APK, which is what most flows actually want. */
export async function installApp(apkPath) {
	await adb(['install', '-r', '-g', apkPath])
	return { installed: apkPath }
}
