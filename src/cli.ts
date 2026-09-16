#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateRecipient, open } from '../runner/envelope.mjs'
import { SessionClient } from './lib/client.ts'
import { parseFlow, runFlow } from './lib/flow.ts'
import { GitHub, resolveRepo, resolveToken } from './lib/github.ts'
import { toJUnit, toMarkdownSummary } from './lib/result.ts'
import {
	forgetSession,
	listSessions,
	resolveSession,
	saveSession,
	type SessionHandle,
	type SessionRecord,
} from './lib/store.ts'

const WORKFLOW = 'vsim-session.yml'

type Flags = Record<string, string | boolean>

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
	const positional: string[] = []
	const flags: Flags = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!
		// A leading dash followed by a digit is a coordinate, not a flag.
		if (!arg.startsWith('-') || /^-\d/.test(arg)) {
			positional.push(arg)
			continue
		}
		const [name, inline] = arg.replace(/^--?/, '').split('=', 2)
		if (inline !== undefined) flags[name!] = inline
		else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[name!] = argv[++i]!
		else flags[name!] = true
	}
	return { positional, flags }
}

const str = (flags: Flags, name: string, fallback: string): string =>
	typeof flags[name] === 'string' ? (flags[name] as string) : fallback

function client(record: SessionRecord): SessionClient {
	if (!record.handle) throw new Error(`session ${record.id} has no handle yet`)
	return new SessionClient(record.handle)
}

// --- commands ----------------------------------------------------------------

async function sessionStart(flags: Flags): Promise<void> {
	const record = await startSession(flags)
	const { id, os } = record
	const handle = record.handle!

	if (flags.json) {
		console.log(JSON.stringify({ id, ...handle }, null, 2))
		return
	}
	console.log('')
	console.log(`session   ${id}  (${os}, expires ${handle.expiresAt})`)
	console.log(`watch     ${handle.viewerUrl}`)
	console.log(`agent api ${handle.apiUrl}`)
	console.log(`run       ${handle.runUrl ?? record.runUrl}`)
	console.log('')
	console.log(`drive it: vsim shot ${id} -o screen.png   |   vsim click ${id} 640 400`)
	console.log(`stop it:  vsim session end ${id}`)
}

async function sessionEnd(positional: string[]): Promise<void> {
	const record = resolveSession(positional[0])
	try {
		await client(record).stop()
		console.log(`asked session ${record.id} to shut down`)
	} catch (err) {
		console.error(`gateway did not answer (${(err as Error).message}); cancelling the run instead`)
		const [owner, repo] = record.repo.split('/')
		await new GitHub({ owner: owner!, repo: repo! }, resolveToken()).cancelRun(record.runId)
	}
	forgetSession(record.id)
}

function sessionList(): void {
	const sessions = listSessions()
	if (!sessions.length) {
		console.log('no sessions')
		return
	}
	for (const s of sessions) {
		const expiry = s.handle?.expiresAt ? ` expires ${s.handle.expiresAt}` : ' (no handle yet)'
		console.log(`${s.id}\t${s.os}\t${s.repo}\trun ${s.runId}${expiry}`)
	}
}

async function shot(positional: string[], flags: Flags): Promise<void> {
	const record = resolveSession(positional[0])
	const png = await client(record).screenshot()
	const out = str(flags, 'o', str(flags, 'out', `${record.id}.png`))
	mkdirSync(dirname(out) || '.', { recursive: true })
	writeFileSync(out, png)
	console.log(`${out} (${png.length} bytes)`)
}

async function run(flags: Flags): Promise<void> {
	const flowPath = str(flags, 'flow', '')
	if (!flowPath) throw new Error('vsim run needs --flow <file.json>')
	const flow = parseFlow(readFileSync(flowPath, 'utf8'))
	const evidenceDir = str(flags, 'evidence', '.vsim-out')

	// Three ways in: a handle file written by a session on this same machine
	// (the unattended path), an existing remote session, or a fresh one.
	const localHandle = typeof flags.local === 'string' ? (flags.local as string) : null
	const reuse = typeof flags.session === 'string'
	const record = localHandle
		? localRecord(localHandle)
		: reuse
			? resolveSession(flags.session as string)
			: await startSession(flags)
	const session = client(record)

	try {
		const result = await runFlow(flow, session, {
			evidenceDir,
			target: `gha:${record.os}`,
			runId: record.id,
		})
		mkdirSync(evidenceDir, { recursive: true })
		writeFileSync(join(evidenceDir, 'vsim.result.json'), JSON.stringify(result, null, 2))
		writeFileSync(join(evidenceDir, 'junit.xml'), toJUnit(result))
		const summary = toMarkdownSummary(result)
		writeFileSync(join(evidenceDir, 'summary.md'), summary)
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)

		console.log(summary)
		console.log(`\nevidence in ${evidenceDir}/`)
		if (result.status !== 'passed') process.exitCode = 1
	} finally {
		// Only tear down a session this command created.
		if (!reuse && !localHandle) {
			await session.stop().catch(() => {})
			forgetSession(record.id)
		}
	}
}

/** Wraps a handle written by a session running on this machine. */
function localRecord(path: string): SessionRecord {
	const handle = JSON.parse(readFileSync(path, 'utf8')) as SessionHandle
	return {
		id: `local-${handle.os}`,
		os: handle.os,
		repo: process.env.GITHUB_REPOSITORY ?? 'local',
		runId: Number(handle.runId ?? 0),
		runUrl: handle.runUrl ?? '',
		privateKey: '',
		startedAt: new Date().toISOString(),
		handle,
	}
}

async function approve(positional: string[], flags: Flags): Promise<void> {
	const runId = Number(positional[0])
	if (!runId) throw new Error('vsim approve needs a run id')
	const repo = resolveRepo(typeof flags.repo === 'string' ? flags.repo : undefined)
	const github = new GitHub(repo, resolveToken())

	const pending = await github.pendingDeployments(runId)
	if (!pending.length) throw new Error(`run ${runId} is not waiting on anyone`)

	const blocked = pending.filter((p) => !p.current_user_can_approve)
	if (blocked.length === pending.length) {
		throw new Error(
			`this token cannot approve ${blocked.map((p) => p.environment.name).join(', ')}. ` +
			'GITHUB_TOKEN is never enough; use a PAT belonging to a required reviewer.',
		)
	}

	const state = flags.reject ? 'rejected' : 'approved'
	const ids = pending.filter((p) => p.current_user_can_approve).map((p) => p.environment.id)
	await github.reviewDeployment(runId, ids, state, str(flags, 'note', `${state} by vsim`))
	console.log(`${state}: ${pending.map((p) => p.environment.name).join(', ')} on run ${runId}`)
}

/** Shared by `session start` and `run`. */
async function startSession(flags: Flags): Promise<SessionRecord> {
	const os = str(flags, 'os', 'linux')
	if (!['linux', 'macos', 'windows'].includes(os)) throw new Error(`unknown --os: ${os}`)

	const repo = resolveRepo(typeof flags.repo === 'string' ? flags.repo : undefined)
	const github = new GitHub(repo, resolveToken())
	const id = `${os}-${randomBytes(4).toString('hex')}`
	const { publicKey, privateKey } = generateRecipient()

	console.error(`starting a ${os} session on ${repo.owner}/${repo.repo} (id ${id})`)
	await github.dispatch(WORKFLOW, str(flags, 'ref', 'main'), {
		session_id: id,
		os,
		recipient_key: publicKey,
		ttl_minutes: str(flags, 'ttl', '30'),
		idle_minutes: str(flags, 'idle', '10'),
	})

	const workflowRun = await github.findRunByName(id)
	console.error(`run ${workflowRun.id}: ${workflowRun.html_url}`)

	const record: SessionRecord = {
		id,
		os,
		repo: `${repo.owner}/${repo.repo}`,
		runId: workflowRun.id,
		runUrl: workflowRun.html_url,
		privateKey,
		startedAt: new Date().toISOString(),
	}
	saveSession(record)

	console.error('waiting for the machine to come up and seal its handle...')
	const artifactId = await github.waitForArtifact(workflowRun.id, `vsim-handle-${id}`)
	const files = await github.downloadArtifact(artifactId)
	const sealed = files.get('handle.sealed')
	if (!sealed) throw new Error(`handle artifact did not contain handle.sealed (got ${[...files.keys()].join(', ')})`)

	record.handle = open<SessionHandle>(privateKey, sealed.toString('utf8'))
	saveSession(record)
	await new SessionClient(record.handle).waitUntilReady()
	return record
}

async function doctor(): Promise<void> {
	const checks: [string, () => string][] = [
		['node', () => {
			const major = Number(process.versions.node.split('.')[0])
			if (major < 20) throw new Error(`node ${process.versions.node} is too old; need >= 20`)
			return process.versions.node
		}],
		['github token', () => `${resolveToken().slice(0, 4)}… present`],
		['repository', () => {
			const { owner, repo } = resolveRepo()
			return `${owner}/${repo}`
		}],
		['gh cli', () => execFileSync('gh', ['--version'], { encoding: 'utf8' }).split('\n')[0]!],
	]
	let failed = false
	for (const [name, check] of checks) {
		try {
			console.log(`ok    ${name}: ${check()}`)
		} catch (err) {
			failed = true
			console.log(`FAIL  ${name}: ${(err as Error).message}`)
		}
	}
	if (failed) process.exitCode = 1
}

const USAGE = `vsim — on-demand cloud machines with a screen

  vsim session start [--os linux|macos|windows] [--ttl 30] [--idle 10] [--repo o/r] [--json]
  vsim session list
  vsim session end [id]

  vsim shot   [id] [-o file.png]
  vsim click  [id] <x> <y> [--button left|right|middle]
  vsim move   [id] <x> <y>
  vsim type   [id] <text>
  vsim key    [id] <combo>
  vsim exec   [id] <command>
  vsim tree   [id]
  vsim record [id] start|stop [--name run]

  vsim run --flow checks.json [--os linux] [--session id] [--evidence dir]
  vsim approve <run-id> [--reject] [--note "..."]

  vsim doctor
`

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2)
	const { positional, flags } = parseArgs(rest)

	switch (command) {
		case 'session': {
			const sub = positional.shift()
			if (sub === 'start') return sessionStart(flags)
			if (sub === 'end') return sessionEnd(positional)
			if (sub === 'list') return sessionList()
			throw new Error(`unknown: vsim session ${sub ?? ''}`)
		}
		case 'shot':
			return shot(positional, flags)
		case 'click':
		case 'move': {
			// `vsim click 640 400` and `vsim click <id> 640 400` both work.
			const coords = positional.filter((p) => /^-?\d+$/.test(p))
			const id = positional.find((p) => !/^-?\d+$/.test(p))
			const c = client(resolveSession(id))
			const [x, y] = coords.map(Number)
			if (x === undefined || y === undefined) throw new Error(`${command} needs x and y`)
			await (command === 'click' ? c.click(x, y, str(flags, 'button', 'left')) : c.move(x, y))
			return console.log(`${command} ${x},${y}`)
		}
		case 'type':
		case 'key':
		case 'exec': {
			const record = resolveSession(positional.length > 1 ? positional[0] : undefined)
			const payload = (positional.length > 1 ? positional.slice(1) : positional).join(' ')
			const c = client(record)
			if (command === 'type') { await c.type(payload); return console.log('typed') }
			if (command === 'key') { await c.key(payload); return console.log(`pressed ${payload}`) }
			return console.log(JSON.stringify(await c.exec(payload), null, 2))
		}
		case 'tree':
			return console.log(JSON.stringify(await client(resolveSession(positional[0])).tree(), null, 2))
		case 'record': {
			const action = positional.pop()
			const c = client(resolveSession(positional[0]))
			const result = action === 'start' ? await c.startRecording(str(flags, 'name', 'session')) : await c.stopRecording()
			return console.log(JSON.stringify(result, null, 2))
		}
		case 'run':
			return run(flags)
		case 'approve':
			return approve(positional, flags)
		case 'doctor':
			return doctor()
		default:
			console.log(USAGE)
			if (command) process.exitCode = 1
	}
}

main().catch((err: Error) => {
	console.error(`vsim: ${err.message}`)
	process.exit(1)
})
