// The neutral evidence contract.
//
// Every tool in this space invents its own report format, so a result from one
// cannot be read by another. This schema describes what was done, what was
// seen, what was asserted, who signed off, and what it cost — independent of
// which machine or driver produced it. JUnit XML is emitted alongside it so
// existing reporters and GitHub annotations keep working.

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'error'

export type Step = {
	name: string
	status: StepStatus
	durationMs: number
	action: string
	detail?: string
	evidence?: string[]
	failure?: string
}

export type Check = {
	id: string
	kind: 'assert' | 'visual' | 'agent'
	status: StepStatus
	note?: string
}

export type Verdict = {
	by: 'agent' | 'human'
	decision: 'pass' | 'fail'
	note: string
	at: string
}

export type RunResult = {
	schema: 'vibrant-sim/result@1'
	runId: string
	target: string
	os: { family: string; image: string; display: string; width?: number; height?: number }
	status: StepStatus
	startedAt: string
	durationMs: number
	steps: Step[]
	checks: Check[]
	evidence: { screenshots: string[]; video?: string; logs: string[] }
	verdict?: Verdict
	cost?: { runnerMinutes: number; billableUsd: number }
}

/** Per-minute list price for standard GitHub-hosted runners on a private repo. */
const MINUTE_PRICE: Record<string, number> = { linux: 0.008, windows: 0.016, macos: 0.08 }

export function estimateCost(osFamily: string, durationMs: number): { runnerMinutes: number; billableUsd: number } {
	// GitHub bills whole minutes, rounded up, per job.
	const runnerMinutes = Math.max(1, Math.ceil(durationMs / 60_000))
	const rate = MINUTE_PRICE[osFamily] ?? MINUTE_PRICE.linux!
	return { runnerMinutes, billableUsd: Number((runnerMinutes * rate).toFixed(4)) }
}

const escapeXml = (value: string): string =>
	value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))

export function toJUnit(result: RunResult): string {
	const failures = result.steps.filter((s) => s.status === 'failed' || s.status === 'error').length
	const skipped = result.steps.filter((s) => s.status === 'skipped').length
	const cases = result.steps
		.map((step) => {
			const attrs = `name="${escapeXml(step.name)}" classname="${escapeXml(result.target)}" time="${(step.durationMs / 1000).toFixed(3)}"`
			if (step.status === 'skipped') return `    <testcase ${attrs}><skipped/></testcase>`
			if (step.status === 'passed') return `    <testcase ${attrs}/>`
			return `    <testcase ${attrs}><failure message="${escapeXml(step.failure ?? 'failed')}">${escapeXml(step.detail ?? '')}</failure></testcase>`
		})
		.join('\n')

	return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="vibrant-sim" tests="${result.steps.length}" failures="${failures}" skipped="${skipped}" time="${(result.durationMs / 1000).toFixed(3)}">
${cases}
  </testsuite>
</testsuites>
`
}

export function toMarkdownSummary(result: RunResult): string {
	const icon = (s: StepStatus) => ({ passed: '✅', failed: '❌', error: '💥', skipped: '⏭️' }[s])
	const lines = [
		`### ${icon(result.status)} vibrant-sim — ${result.target}`,
		'',
		`| | |`,
		`|---|---|`,
		`| result | **${result.status}** |`,
		`| machine | ${result.os.image} (${result.os.display}) |`,
		`| duration | ${(result.durationMs / 1000).toFixed(1)}s |`,
	]
	if (result.cost) lines.push(`| cost | ${result.cost.runnerMinutes} min ≈ $${result.cost.billableUsd} |`)
	if (result.verdict) lines.push(`| verdict | ${result.verdict.decision} by ${result.verdict.by} — ${result.verdict.note} |`)
	lines.push('', '| step | result | evidence |', '|---|---|---|')
	for (const step of result.steps) {
		const evidence = step.evidence?.length ? step.evidence.map((e) => `\`${e}\``).join(' ') : '—'
		lines.push(`| ${step.name} | ${icon(step.status)} ${step.status} | ${evidence} |`)
	}
	const failed = result.steps.filter((s) => s.failure)
	if (failed.length) {
		lines.push('', '<details><summary>failures</summary>', '')
		for (const step of failed) lines.push(`- **${step.name}**: ${step.failure}`)
		lines.push('', '</details>')
	}
	return lines.join('\n')
}
