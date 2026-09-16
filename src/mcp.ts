#!/usr/bin/env node
// MCP over stdio, for agents that speak MCP instead of shelling out.
//
// Tools map one-to-one onto the CLI. A screenshot comes back as an image block
// so the agent can actually look at the screen, and the UI tree comes back as
// text because it is far cheaper to reason about than pixels.

import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { SessionClient } from './lib/client.ts'
import { forgetSession, listSessions, resolveSession, type SessionRecord } from './lib/store.ts'

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: any }

const TOOLS = [
	{
		name: 'session_start',
		description:
			'Bring up a machine with a graphical desktop on GitHub Actions and return a link the human can watch. Takes about a minute.',
		inputSchema: {
			type: 'object',
			properties: {
				os: { type: 'string', enum: ['linux', 'macos', 'windows'], default: 'linux' },
				ttl_minutes: { type: 'number', default: 30 },
			},
		},
	},
	{
		name: 'session_list',
		description: 'List the sessions that are currently running.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'screenshot',
		description: 'Capture the screen of a session and return it as an image.',
		inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
	},
	{
		name: 'ui_tree',
		description:
			'Read the UI tree of a session: element names and coordinates. Prefer this over a screenshot when deciding where to click.',
		inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
	},
	{
		name: 'click',
		description: 'Click at a screen coordinate.',
		inputSchema: {
			type: 'object',
			properties: {
				session: { type: 'string' },
				x: { type: 'number' },
				y: { type: 'number' },
				button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
			},
			required: ['x', 'y'],
		},
	},
	{
		name: 'type_text',
		description: 'Type text into whatever has focus.',
		inputSchema: {
			type: 'object',
			properties: { session: { type: 'string' }, text: { type: 'string' } },
			required: ['text'],
		},
	},
	{
		name: 'press_key',
		description: 'Press a key or a combination, for example "Return" or "ctrl+s".',
		inputSchema: {
			type: 'object',
			properties: { session: { type: 'string' }, combo: { type: 'string' } },
			required: ['combo'],
		},
	},
	{
		name: 'exec',
		description: 'Run a shell command on the session machine.',
		inputSchema: {
			type: 'object',
			properties: { session: { type: 'string' }, command: { type: 'string' } },
			required: ['command'],
		},
	},
	{
		name: 'record',
		description: 'Start or stop a screen recording. The video is collected as a run artifact.',
		inputSchema: {
			type: 'object',
			properties: {
				session: { type: 'string' },
				action: { type: 'string', enum: ['start', 'stop'] },
				name: { type: 'string', default: 'session' },
			},
			required: ['action'],
		},
	},
	{
		name: 'session_end',
		description: 'Shut the machine down. Do this as soon as you are finished; it costs runner minutes.',
		inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
	},
]

function clientFor(id?: string): { client: SessionClient; record: SessionRecord } {
	const record = resolveSession(id)
	if (!record.handle) throw new Error(`session ${record.id} is not ready yet`)
	return { client: new SessionClient(record.handle), record }
}

const text = (value: string) => ({ content: [{ type: 'text', text: value }] })

async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
	switch (name) {
		case 'session_start': {
			// Reuses the CLI so there is exactly one implementation of the handshake.
			const { execFileSync } = await import('node:child_process')
			const out = execFileSync(
				process.execPath,
				[fileURLToPath(new URL('./cli.ts', import.meta.url)), 'session', 'start',
					'--os', String(args.os ?? 'linux'), '--ttl', String(args.ttl_minutes ?? 30), '--json'],
				{ encoding: 'utf8', timeout: 900_000 },
			)
			const handle = JSON.parse(out)
			return text(
				`Session ${handle.id} is up on ${handle.os}.\n\n` +
				`Give this link to the person you are working with so they can watch:\n${handle.viewerUrl}\n\n` +
				`It contains the pairing key, so keep it out of logs and commits. Expires ${handle.expiresAt}.`,
			)
		}
		case 'session_list': {
			const sessions = listSessions()
			if (!sessions.length) return text('No sessions running.')
			return text(sessions.map((s) => `${s.id}  ${s.os}  run ${s.runId}`).join('\n'))
		}
		case 'screenshot': {
			const { client } = clientFor(args.session)
			const png = await client.screenshot()
			return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }
		}
		case 'ui_tree': {
			const { client } = clientFor(args.session)
			return text(JSON.stringify(await client.tree(), null, 2))
		}
		case 'click': {
			const { client } = clientFor(args.session)
			await client.click(args.x, args.y, args.button ?? 'left')
			return text(`clicked ${args.x},${args.y}`)
		}
		case 'type_text': {
			const { client } = clientFor(args.session)
			await client.type(args.text)
			return text('typed')
		}
		case 'press_key': {
			const { client } = clientFor(args.session)
			await client.key(args.combo)
			return text(`pressed ${args.combo}`)
		}
		case 'exec': {
			const { client } = clientFor(args.session)
			const out = await client.exec(args.command)
			return text(`exit ${out.code}\n${out.stdout}${out.stderr}`)
		}
		case 'record': {
			const { client } = clientFor(args.session)
			const result = args.action === 'start'
				? await client.startRecording(args.name ?? 'session')
				: await client.stopRecording()
			return text(JSON.stringify(result))
		}
		case 'session_end': {
			const { client, record } = clientFor(args.session)
			await client.stop().catch(() => {})
			forgetSession(record.id)
			return text(`session ${record.id} shut down`)
		}
		default:
			throw new Error(`unknown tool: ${name}`)
	}
}

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', async (line) => {
	if (!line.trim()) return
	let request: Request
	try {
		request = JSON.parse(line)
	} catch {
		return
	}

	try {
		let result: unknown
		if (request.method === 'initialize') {
			result = {
				protocolVersion: '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'vibrant-sim', version: '0.1.0' },
			}
		} else if (request.method === 'tools/list') {
			result = { tools: TOOLS }
		} else if (request.method === 'tools/call') {
			result = await callTool(request.params.name, request.params.arguments ?? {})
		} else if (request.method.startsWith('notifications/')) {
			return
		} else {
			throw new Error(`unsupported method: ${request.method}`)
		}
		if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result })
	} catch (err) {
		if (request.id !== undefined) {
			send({
				jsonrpc: '2.0',
				id: request.id,
				result: { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true },
			})
		}
	}
})
