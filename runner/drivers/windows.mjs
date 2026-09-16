// Windows desktop driver: thin wrapper over windows-helper.ps1.

import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'windows-helper.ps1')

async function ps(action, ...args) {
	const { stdout } = await run(
		'pwsh',
		['-NoProfile', '-NonInteractive', '-File', HELPER, '-Action', action,
			...args.flatMap((value, index) => [`-Arg${index + 1}`, String(value)])],
		{ timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
	)
	return stdout.trim()
}

export async function prepare() {
	await ps('info')
}

export async function info() {
	return JSON.parse(await ps('info'))
}

export async function screenshot() {
	const path = join(tmpdir(), `vsim-shot-${process.pid}-${Date.now()}.png`)
	try {
		await ps('screenshot', path)
		return await readFile(path)
	} finally {
		await rm(path, { force: true })
	}
}

export const move = (x, y) => ps('move', x, y)
export const click = (x, y, button = 'left') => ps('click', x, y, button)
export const typeText = (text) => ps('type', String(text))
export const key = (combo) => ps('key', String(combo))

export async function exec(command) {
	try {
		const { stdout, stderr } = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
			maxBuffer: 32 * 1024 * 1024,
			windowsHide: true,
		})
		return { stdout, stderr, code: 0 }
	} catch (err) {
		return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message), code: err.code ?? 1 }
	}
}

export async function tree() {
	return JSON.parse(await ps('tree'))
}
