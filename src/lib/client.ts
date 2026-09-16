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

	health() {
		return this.#json<{ ok: boolean; platform: string; idleSeconds: number }>('health')
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
	async waitUntilReady(timeoutMs = 180_000): Promise<void> {
		const deadline = Date.now() + timeoutMs
		let last = 'no attempt'
		while (Date.now() < deadline) {
			try {
				await this.health()
				return
			} catch (err) {
				last = String((err as Error).message)
			}
			await new Promise((r) => setTimeout(r, 3000))
		}
		throw new Error(`session gateway never answered (last: ${last})`)
	}
}
