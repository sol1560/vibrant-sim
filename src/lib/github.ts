import { execFileSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

export type Run = {
	id: number
	name: string
	status: string
	conclusion: string | null
	html_url: string
	created_at: string
}

export type Repo = { owner: string; repo: string }

export function resolveToken(): string {
	const fromEnv = process.env.VSIM_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
	if (fromEnv) return fromEnv
	try {
		return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
	} catch {
		throw new Error('no GitHub token: set GH_TOKEN or run `gh auth login`')
	}
}

export function resolveRepo(explicit?: string): Repo {
	const value = explicit || process.env.VSIM_REPO || detectRepoFromGit()
	const match = value?.match(/([^/:]+)\/([^/]+?)(?:\.git)?$/)
	if (!match) throw new Error(`cannot work out the repository from "${value}"; pass --repo owner/name`)
	return { owner: match[1]!, repo: match[2]! }
}

function detectRepoFromGit(): string | undefined {
	for (const remote of ['origin', 'gh', 'upstream']) {
		try {
			const url = execFileSync('git', ['remote', 'get-url', remote], { encoding: 'utf8' }).trim()
			if (url.includes('github.com')) return url
		} catch { /* try the next remote */ }
	}
	return undefined
}

export class GitHub {
	readonly repo: Repo
	#token: string

	constructor(repo: Repo, token: string) {
		this.repo = repo
		this.#token = token
	}

	async #call(path: string, init: RequestInit = {}): Promise<Response> {
		const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
			...init,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${this.#token}`,
				'x-github-api-version': '2022-11-28',
				...(init.body ? { 'content-type': 'application/json' } : {}),
				...init.headers,
			},
		})
		if (!res.ok && res.status !== 302) {
			throw new Error(`GitHub ${init.method ?? 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 400)}`)
		}
		return res
	}

	async #json<T>(path: string, init?: RequestInit): Promise<T> {
		return (await this.#call(path, init)).json() as Promise<T>
	}

	#base(): string {
		return `/repos/${this.repo.owner}/${this.repo.repo}`
	}

	async dispatch(workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void> {
		await this.#call(`${this.#base()}/actions/workflows/${workflowFile}/dispatches`, {
			method: 'POST',
			body: JSON.stringify({ ref, inputs }),
		})
	}

	/**
	 * workflow_dispatch does not return a run id, so the workflow stamps the
	 * caller's session id into `run-name` and we match on it.
	 */
	async findRunByName(needle: string, { timeoutMs = 120_000 } = {}): Promise<Run> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const { workflow_runs } = await this.#json<{ workflow_runs: Run[] }>(
				`${this.#base()}/actions/runs?event=workflow_dispatch&per_page=30`,
			)
			const hit = workflow_runs.find((run) => run.name?.includes(needle))
			if (hit) return hit
			await new Promise((r) => setTimeout(r, 3000))
		}
		throw new Error(`no workflow run named "${needle}" appeared within ${timeoutMs}ms`)
	}

	async getRun(id: number): Promise<Run> {
		return this.#json<Run>(`${this.#base()}/actions/runs/${id}`)
	}

	async cancelRun(id: number): Promise<void> {
		await this.#call(`${this.#base()}/actions/runs/${id}/cancel`, { method: 'POST' })
	}

	async listRuns(workflowFile: string): Promise<Run[]> {
		const { workflow_runs } = await this.#json<{ workflow_runs: Run[] }>(
			`${this.#base()}/actions/workflows/${workflowFile}/runs?per_page=30`,
		)
		return workflow_runs
	}

	/** Artifacts show up while the run is still going, which is what makes the handshake work. */
	async waitForArtifact(runId: number, name: string, { timeoutMs = 600_000 } = {}): Promise<number> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const { artifacts } = await this.#json<{ artifacts: { id: number; name: string; expired: boolean }[] }>(
				`${this.#base()}/actions/runs/${runId}/artifacts?per_page=100`,
			)
			const hit = artifacts.find((a) => a.name === name && !a.expired)
			if (hit) return hit.id
			const run = await this.getRun(runId)
			if (run.status === 'completed') {
				throw new Error(`run ${runId} finished (${run.conclusion}) without publishing "${name}" — see ${run.html_url}`)
			}
			await new Promise((r) => setTimeout(r, 4000))
		}
		throw new Error(`artifact "${name}" never appeared on run ${runId}`)
	}

	async downloadArtifact(artifactId: number): Promise<Map<string, Buffer>> {
		const res = await this.#call(`${this.#base()}/actions/artifacts/${artifactId}/zip`)
		return readZip(Buffer.from(await res.arrayBuffer()))
	}

	async pendingDeployments(runId: number): Promise<{ environment: { name: string }; current_user_can_approve: boolean }[]> {
		return this.#json(`${this.#base()}/actions/runs/${runId}/pending_deployments`)
	}

	async reviewDeployment(runId: number, environmentIds: number[], state: 'approved' | 'rejected', comment: string): Promise<void> {
		await this.#call(`${this.#base()}/actions/runs/${runId}/pending_deployments`, {
			method: 'POST',
			body: JSON.stringify({ environment_ids: environmentIds, state, comment }),
		})
	}
}

/**
 * Minimal zip reader for artifact downloads.
 *
 * An artifact is a zip of a handful of small files; pulling in a zip library
 * for that would be the only runtime dependency in the whole CLI.
 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
	const files = new Map<string, Buffer>()
	const eocd = findEndOfCentralDirectory(buffer)
	let offset = buffer.readUInt32LE(eocd + 16)
	const count = buffer.readUInt16LE(eocd + 10)

	for (let i = 0; i < count; i++) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt zip central directory')
		const method = buffer.readUInt16LE(offset + 10)
		const compressedSize = buffer.readUInt32LE(offset + 20)
		const nameLength = buffer.readUInt16LE(offset + 28)
		const extraLength = buffer.readUInt16LE(offset + 30)
		const commentLength = buffer.readUInt16LE(offset + 32)
		const localOffset = buffer.readUInt32LE(offset + 42)
		const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

		const localNameLength = buffer.readUInt16LE(localOffset + 26)
		const localExtraLength = buffer.readUInt16LE(localOffset + 28)
		const dataStart = localOffset + 30 + localNameLength + localExtraLength
		const raw = buffer.subarray(dataStart, dataStart + compressedSize)
		if (!name.endsWith('/')) files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw))

		offset += 46 + nameLength + extraLength + commentLength
	}
	return files
}

function findEndOfCentralDirectory(buffer: Buffer): number {
	for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50) return i
	}
	throw new Error('not a zip file')
}
