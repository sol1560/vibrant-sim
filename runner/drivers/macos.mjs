// macOS desktop driver.
//
// Probed on macos-26-arm64: `launchctl managername` reports Aqua, so the runner
// really is inside a GUI login session. `screencapture -x` returns a genuine
// desktop frame (menu bar, Dock) with no TCC prompt, and System Events answers
// osascript. Synthetic input goes through a tiny CGEvent helper compiled with
// the Swift toolchain that ships on the image; AppleScript `click at` is
// unreliable across releases.

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
let inputTool = null

const SWIFT_SOURCE = `import Foundation
import CoreGraphics

func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

func mouse(_ x: Double, _ y: Double, _ type: CGEventType, _ button: CGMouseButton, clicks: Int64 = 1) {
  let point = CGPoint(x: x, y: y)
  guard let ev = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
  ev.setIntegerValueField(.mouseEventClickState, value: clicks)
  post(ev)
}

func typeString(_ s: String) {
  for scalar in Array(s.utf16) {
    var unit = scalar
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
    down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
    up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
    post(down); post(up)
    usleep(8000)
  }
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
  "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
]

let flagNames: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "ctrl": .maskControl, "control": .maskControl,
  "alt": .maskAlternate, "option": .maskAlternate, "shift": .maskShift, "fn": .maskSecondaryFn,
]

func pressCombo(_ combo: String) {
  var flags: CGEventFlags = []
  var code: CGKeyCode? = nil
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    if let f = flagNames[part] { flags.insert(f) } else if let c = keyCodes[part] { code = c }
  }
  guard let key = code else { return }
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { return }
  down.flags = flags; up.flags = flags
  post(down); post(up)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { exit(2) }
switch cmd {
case "move":
  mouse(Double(args[1])!, Double(args[2])!, .mouseMoved, .left)
case "click":
  let x = Double(args[1])!, y = Double(args[2])!
  let button = args.count > 3 ? args[3] : "left"
  let b: CGMouseButton = button == "right" ? .right : (button == "middle" ? .center : .left)
  let downType: CGEventType = b == .right ? .rightMouseDown : (b == .center ? .otherMouseDown : .leftMouseDown)
  let upType: CGEventType = b == .right ? .rightMouseUp : (b == .center ? .otherMouseUp : .leftMouseUp)
  mouse(x, y, .mouseMoved, b)
  usleep(40000)
  mouse(x, y, downType, b)
  usleep(40000)
  mouse(x, y, upType, b)
case "type":
  typeString(args[1])
case "key":
  pressCombo(args[1])
default:
  exit(2)
}
`

export async function prepare() {
	if (inputTool) return
	const dir = await mkdtemp(join(tmpdir(), 'vsim-input-'))
	const source = join(dir, 'vsiminput.swift')
	const binary = join(dir, 'vsiminput')
	await writeFile(source, SWIFT_SOURCE, 'utf8')
	await run('swiftc', ['-O', '-o', binary, source], { timeout: 180_000 })
	inputTool = binary
}

async function input(args) {
	if (!inputTool) await prepare()
	await run(inputTool, args.map(String))
}

export async function info() {
	const { stdout } = await run('osascript', [
		'-e',
		'tell application "Finder" to get bounds of window of desktop',
	])
	const [, , width, height] = stdout.trim().split(', ').map(Number)
	return { os: 'macos', display: 'Aqua', width, height }
}

export async function screenshot() {
	const path = join(tmpdir(), `vsim-shot-${process.pid}-${Date.now()}.png`)
	try {
		await run('screencapture', ['-x', '-t', 'png', path], { timeout: 30_000 })
		return await readFile(path)
	} finally {
		await rm(path, { force: true })
	}
}

export const move = (x, y) => input(['move', x, y])
export const click = (x, y, button = 'left') => input(['click', x, y, button])
export const typeText = (text) => input(['type', String(text)])
export const key = (combo) => input(['key', String(combo)])

export async function exec(command) {
	try {
		const { stdout, stderr } = await run('/bin/bash', ['-lc', command], { maxBuffer: 32 * 1024 * 1024 })
		return { stdout, stderr, code: 0 }
	} catch (err) {
		return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message), code: err.code ?? 1 }
	}
}

let recording = null

/** `screencapture -v` records the real display; no extra tooling needed. */
export async function startRecording(name, localPath) {
	if (recording) throw new Error('already recording')
	const child = spawn('screencapture', ['-v', '-C', localPath], { stdio: 'ignore', detached: false })
	recording = { name, child, localPath }
	await new Promise((r) => setTimeout(r, 1200))
	return { kind: 'screencapture', name }
}

export async function stopRecording() {
	if (!recording) throw new Error('not recording')
	const { child, localPath } = recording
	recording = null
	// screencapture writes the movie atomically when it sees SIGINT.
	child.kill('SIGINT')
	await new Promise((resolve) => {
		child.on('exit', resolve)
		setTimeout(resolve, 15_000)
	})
	await new Promise((r) => setTimeout(r, 1500))
	return { path: localPath }
}

/** Real accessibility tree via System Events; far cheaper for an agent than pixels. */
export async function tree() {
	const script = `
    set out to ""
    tell application "System Events"
      repeat with p in (every application process whose visible is true)
        set pname to name of p
        set out to out & "app|" & pname & linefeed
        try
          repeat with w in (every window of p)
            set wname to name of w
            set wpos to position of w
            set wsize to size of w
            set out to out & "win|" & pname & "|" & wname & "|" & (item 1 of wpos) & "," & (item 2 of wpos) & "|" & (item 1 of wsize) & "," & (item 2 of wsize) & linefeed
          end repeat
        end try
      end repeat
    end tell
    return out`
	const { stdout } = await run('osascript', ['-e', script], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
	const apps = []
	const windows = []
	for (const line of stdout.split('\n')) {
		const parts = line.split('|')
		if (parts[0] === 'app') apps.push(parts[1])
		else if (parts[0] === 'win') {
			const [x, y] = (parts[3] ?? '').split(',').map(Number)
			const [width, height] = (parts[4] ?? '').split(',').map(Number)
			windows.push({ app: parts[1], name: parts[2], x, y, width, height })
		}
	}
	return { kind: 'macos-accessibility', apps, windows }
}
