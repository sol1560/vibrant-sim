import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionClient } from '../src/lib/client.ts'
import { parseFlow, runFlow } from '../src/lib/flow.ts'
import { estimateCost, toJUnit, type RunResult } from '../src/lib/result.ts'

/** Stands in for a live session; records what the flow asked it to do. */
function fakeSession(execResults: Record<string, { stdout: string; code: number }> = {}) {
	const calls: string[] = []
	const client = {
		info: async () => ({ os: 'linux', display: ':1', width: 1024, height: 768 }),
		exec: async (command: string) => {
			calls.push(`exec:${command}`)
			return { stdout: '', stderr: '', code: 0, ...execResults[command] }
		},
		click: async (x: number, y: number) => void calls.push(`click:${x},${y}`),
		move: async (x: number, y: number) => void calls.push(`move:${x},${y}`),
		type: async (text: string) => void calls.push(`type:${text}`),
		key: async (combo: string) => void calls.push(`key:${combo}`),
		screenshot: async () => {
			calls.push('screenshot')
			return Buffer.from('fake-png')
		},
	}
	return { client: client as unknown as SessionClient, calls }
}

const evidenceDir = () => mkdtempSync(join(tmpdir(), 'vsim-test-'))
const options = (dir: string) => ({ evidenceDir: dir, target: 'gha:linux', runId: 'test' })

test('runs every step and records evidence', async () => {
	const dir = evidenceDir()
	const { client, calls } = fakeSession()
	const flow = parseFlow(JSON.stringify({
		name: 'demo',
		steps: [
			{ exec: 'echo hi' },
			{ click: [10, 20] },
			{ type: 'abc' },
			{ key: 'Return' },
			{ screenshot: 'result' },
		],
	}))

	const result = await runFlow(flow, client, options(dir))

	assert.equal(result.status, 'passed')
	assert.equal(result.steps.length, 5)
	assert.deepEqual(calls, ['exec:echo hi', 'click:10,20', 'type:abc', 'key:Return', 'screenshot'])
	assert.deepEqual(result.evidence.screenshots, ['screenshots/004-result.png'])
	assert.equal(readFileSync(join(dir, 'screenshots/004-result.png'), 'utf8'), 'fake-png')
})

test('a missed expectation fails the run and is recorded as a check', async () => {
	const { client } = fakeSession({ 'check it': { stdout: 'nope', code: 0 } })
	const flow = parseFlow(JSON.stringify({
		name: 'demo',
		steps: [{ name: 'it says yes', exec: 'check it', expect: { contains: 'yes' } }],
	}))

	const result = await runFlow(flow, client, options(evidenceDir()))

	assert.equal(result.status, 'failed')
	assert.equal(result.steps[0]!.status, 'failed')
	assert.match(result.steps[0]!.failure!, /does not contain/)
	assert.deepEqual(result.checks.map((c) => c.status), ['failed'])
})

test('a wrong exit code fails even when the output looks right', async () => {
	const { client } = fakeSession({ 'run it': { stdout: 'ok', code: 3 } })
	const flow = parseFlow(JSON.stringify({
		name: 'demo',
		steps: [{ exec: 'run it', expect: { code: 0, contains: 'ok' } }],
	}))

	const result = await runFlow(flow, client, options(evidenceDir()))

	assert.equal(result.status, 'failed')
	assert.match(result.steps[0]!.failure!, /exit code 3, wanted 0/)
})

test('a broken machine skips the rest instead of driving a dead desktop', async () => {
	const { client, calls } = fakeSession()
	;(client as any).click = async () => { throw new Error('gateway gone') }
	const flow = parseFlow(JSON.stringify({
		name: 'demo',
		steps: [{ exec: 'first' }, { click: [1, 2] }, { type: 'never' }, { exec: 'also never' }],
	}))

	const result = await runFlow(flow, client, options(evidenceDir()))

	assert.equal(result.status, 'failed')
	assert.deepEqual(result.steps.map((s) => s.status), ['passed', 'error', 'skipped', 'skipped'])
	assert.deepEqual(calls, ['exec:first'])
})

test('a flow needs a name and steps', () => {
	assert.throws(() => parseFlow('{"steps":[]}'), /needs a name/)
	assert.throws(() => parseFlow('{"name":"x"}'), /steps array/)
})

test('JUnit output reports the failures', () => {
	const result: RunResult = {
		schema: 'vibrant-sim/result@1',
		runId: 'r1',
		target: 'gha:linux',
		os: { family: 'linux', image: 'ubuntu-latest', display: ':1' },
		status: 'failed',
		startedAt: new Date().toISOString(),
		durationMs: 2000,
		steps: [
			{ name: 'good', status: 'passed', durationMs: 1000, action: 'exec' },
			{ name: 'bad & <ugly>', status: 'failed', durationMs: 1000, action: 'exec', failure: 'no "yes"' },
		],
		checks: [],
		evidence: { screenshots: [], logs: [] },
	}

	const xml = toJUnit(result)
	assert.match(xml, /tests="2" failures="1"/)
	assert.match(xml, /bad &amp; &lt;ugly&gt;/)
	assert.match(xml, /no &quot;yes&quot;/)
})

test('cost rounds up to whole runner minutes and prices macOS higher', () => {
	assert.deepEqual(estimateCost('linux', 61_000), { runnerMinutes: 2, billableUsd: 0.016 })
	assert.equal(estimateCost('macos', 61_000).billableUsd, 0.16)
	assert.equal(estimateCost('linux', 1_000).runnerMinutes, 1)
})
