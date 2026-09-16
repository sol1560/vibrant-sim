import type { SessionHandle } from './store.ts'

/** Talks to the gateway running on the session machine, through the tunnel. */
export class SessionClient {
	readonly handle: SessionHandle

	constructor(handle: SessionHandle) {
		this.handle = handle
	}

	async #call(action: string, body?: unknown): Promise<Response> {
		const res = await fetch(`${this.handle.apiUrl}/${action}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.handle.pairingKey}`,
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(120_000),
		})
		if (!res.ok) throw new Error(`${action} -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
		return res
	}

	async #json<T>(action: string, body?: unknown): Promise<T> {
		return (await this.#call(action, body)).json() as Promise<T>
	}

	/** Answers even while the driver is still starting, so it reports that too. */
	async health(): Promise<{ ok: boolean; platform: string; preparing?: boolean; idleSeconds: number; error?: string }> {
		const res = await fetch(`${this.handle.apiUrl}/health`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.handle.pairingKey}` },
			signal: AbortSignal.timeout(30_000),
		})
		if (res.status !== 200 && res.status !== 503) {
			throw new Error(`health -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
		}
		return res.json() as Promise<{ ok: boolean; platform: string; preparing?: boolean; idleSeconds: number; error?: string }>
	}

	info() {
		return this.#json<{ os: string; display: string; width: number; height: number }>('info')
	}

	async screenshot(): Promise<Buffer> {
		const res = await this.#call('screenshot')
		return Buffer.from(await res.arrayBuffer())
	}

	click(x: number, y: number, button = 'left') {
		return this.#json<{ ok: true }>('click', { x, y, button })
	}

	move(x: number, y: number) {
		return this.#json<{ ok: true }>('move', { x, y })
	}

	type(text: string) {
		return this.#json<{ ok: true }>('type', { text })
	}

	key(combo: string) {
		return this.#json<{ ok: true }>('key', { combo })
	}

	exec(command: string) {
		return this.#json<{ stdout: string; stderr: string; code: number }>('exec', { command })
	}

	tree() {
		return this.#json<{ kind: string; windows: unknown[] }>('tree')
	}

	/** Clicks whatever the accessibility tree says carries this text. */
	tapText(text: string, exact = false, timeoutMs?: number, until?: string) {
		return this.#json<{ tapped: string; x: number; y: number; rounds?: number }>(
			'tap/text', { text, exact, timeoutMs, until })
	}

	/** Asserts a label is on screen, using the same tree a tap would use. */
	assertText(text: string, exact = false, timeoutMs?: number) {
		return this.#json<{ found: true; label: string }>('assert/text', { text, exact, timeoutMs })
	}

	/** Windows only: bring a window to the front by a substring of its title. */
	focus(title: string) {
		return this.#json<{ focused: string }>('focus', { title })
	}

	startRecording(name: string) {
		return this.#json<{ kind: string; path: string }>('record/start', { name })
	}

	stopRecording() {
		return this.#json<{ kind: string; path: string }>('record/stop')
	}

	stop() {
		return this.#json<{ ok: true }>('stop')
	}

	/** Polls until the gateway answers, so `session start` can return a usable handle. */
	async waitUntilReady(timeoutMs = 900_000): Promise<void> {
		const deadline = Date.now() + timeoutMs
		let last = 'no attempt'
		while (Date.now() < deadline) {
			try {
				const health = await this.health()
				if (health.ok) return
				// A simulator boot and a Swift compile take minutes; that is not
				// a failure, but a driver that gave up is.
				if (health.error) throw new Error(health.error)
				last = 'still starting up'
			} catch (err) {
				last = String((err as Error).message)
			}
			await new Promise((r) => setTimeout(r, 3000))
		}
		throw new Error(`session never became usable (last: ${last})`)
	}
}
