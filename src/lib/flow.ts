import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionClient } from './client.ts'
import { estimateCost, type Check, type RunResult, type Step } from './result.ts'

export type FlowStep = {
	name?: string
	exec?: string
	click?: [number, number]
	move?: [number, number]
	type?: string
	key?: string
	/** Clicks by label instead of coordinates; needs a platform with a tree. */
	tapText?: string
	/** Asserts a label is on screen; needs a platform with a tree. */
	assertText?: string
	/** With tapText: what must appear afterwards, retrying the tap until it does. */
	until?: string
	/** How long tapText and assertText keep looking. Default is about 18s. */
	timeoutMs?: number
	/** Windows only: bring a window to the front before interacting with it. */
	focus?: string
	screenshot?: string
	wait?: number
	/** Turns a step into an assertion; a miss fails the run. */
	expect?: { code?: number; contains?: string; notContains?: string }
}

export type Flow = { name: string; steps: FlowStep[] }

export function parseFlow(raw: string): Flow {
	const flow = JSON.parse(raw) as Flow
	if (!flow.name || !Array.isArray(flow.steps)) throw new Error('a flow needs a name and a steps array')
	return flow
}

function describe(step: FlowStep): string {
	if (step.exec) return `exec ${step.exec}`
	if (step.click) return `click ${step.click.join(',')}`
	if (step.tapText) return `tap ${JSON.stringify(step.tapText)}`
	if (step.assertText) return `assert ${JSON.stringify(step.assertText)}`
	if (step.move) return `move ${step.move.join(',')}`
	if (step.type !== undefined) return `type ${step.type.length} chars`
	if (step.key) return `key ${step.key}`
	if (step.focus) return `focus ${step.focus}`
	if (step.screenshot) return `screenshot ${step.screenshot}`
	if (step.wait) return `wait ${step.wait}ms`
	return 'noop'
}

/** Runs a flow against a live session and turns it into an evidence package. */
export async function runFlow(
	flow: Flow,
	session: SessionClient,
	options: { evidenceDir: string; target: string; runId: string },
): Promise<RunResult> {
	mkdirSync(join(options.evidenceDir, 'screenshots'), { recursive: true })
	const info = await session.info()
	const startedAt = new Date()
	const steps: Step[] = []
	const checks: Check[] = []
	const screenshots: string[] = []
	let aborted = false

	for (const [index, step] of flow.steps.entries()) {
		const name = step.name ?? describe(step)
		const began = Date.now()
		const record: Step = { name, status: 'passed', durationMs: 0, action: describe(step) }

		if (aborted) {
			record.status = 'skipped'
			steps.push(record)
			continue
		}

		try {
			if (step.exec) {
				const out = await session.exec(step.exec)
				record.detail = [out.stdout, out.stderr].filter(Boolean).join('\n').slice(0, 4000)
				if (step.expect) {
					const problems: string[] = []
					if (step.expect.code !== undefined && out.code !== step.expect.code) {
						problems.push(`exit code ${out.code}, wanted ${step.expect.code}`)
					}
					if (step.expect.contains && !record.detail.includes(step.expect.contains)) {
						problems.push(`output does not contain ${JSON.stringify(step.expect.contains)}`)
					}
					if (step.expect.notContains && record.detail.includes(step.expect.notContains)) {
						problems.push(`output contains ${JSON.stringify(step.expect.notContains)}`)
					}
					checks.push({
						id: name,
						kind: 'assert',
						status: problems.length ? 'failed' : 'passed',
						note: problems.join('; ') || undefined,
					})
					if (problems.length) {
						record.status = 'failed'
						record.failure = problems.join('; ')
					}
				}
			}
			if (step.tapText) {
				const hit = await session.tapText(step.tapText, false, step.timeoutMs, step.until)
				record.detail = `tapped ${JSON.stringify(hit.tapped)} at ${hit.x},${hit.y}${hit.rounds && hit.rounds > 1 ? ` (${hit.rounds} attempts)` : ''}`
			}
			if (step.assertText) {
				const hit = await session.assertText(step.assertText, false, step.timeoutMs)
				record.detail = `found ${JSON.stringify(hit.label)}`
				checks.push({ id: name, kind: 'assert', status: 'passed' })
			}
			if (step.click) await session.click(step.click[0], step.click[1])
			if (step.move) await session.move(step.move[0], step.move[1])
			if (step.type !== undefined) await session.type(step.type)
			if (step.key) await session.key(step.key)
			if (step.focus) await session.focus(step.focus)
			if (step.wait) await new Promise((r) => setTimeout(r, step.wait))
			if (step.screenshot) {
				const file = join('screenshots', `${String(index).padStart(3, '0')}-${step.screenshot}.png`)
				writeFileSync(join(options.evidenceDir, file), await session.screenshot())
				screenshots.push(file)
				record.evidence = [file]
			}
		} catch (err) {
			record.status = 'error'
			record.failure = String((err as Error).message)
		}

		record.durationMs = Date.now() - began
		steps.push(record)
		// A broken machine makes every later step meaningless, so stop driving it.
		if (record.status === 'error') aborted = true
	}

	const durationMs = Date.now() - startedAt.getTime()
	const failed = steps.some((s) => s.status === 'failed' || s.status === 'error')

	return {
		schema: 'vibrant-sim/result@1',
		runId: options.runId,
		target: options.target,
		os: { family: info.os, image: options.target, display: info.display, width: info.width, height: info.height },
		status: failed ? 'failed' : 'passed',
		startedAt: startedAt.toISOString(),
		durationMs,
		steps,
		checks,
		evidence: { screenshots, logs: [] },
		cost: estimateCost(info.os, durationMs),
	}
}
