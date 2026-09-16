import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What the runner sealed and handed back. */
export type SessionHandle = {
	version: number
	os: string
	runId: string | null
	runUrl: string | null
	tunnelUrl: string
	pairingKey: string
	viewerUrl: string
	apiUrl: string
	expiresAt: string
}

export type SessionRecord = {
	id: string
	os: string
	repo: string
	runId: number
	runUrl: string
	privateKey: string
	startedAt: string
	handle?: SessionHandle
}

const root = process.env.VSIM_HOME || join(homedir(), '.vsim')
const sessionsDir = join(root, 'sessions')

export function saveSession(record: SessionRecord): void {
	mkdirSync(sessionsDir, { recursive: true })
	const path = join(sessionsDir, `${record.id}.json`)
	writeFileSync(path, JSON.stringify(record, null, 2))
	// The file holds the private key and the pairing key.
	chmodSync(path, 0o600)
}

export function loadSession(id: string): SessionRecord {
	const path = join(sessionsDir, `${id}.json`)
	if (!existsSync(path)) throw new Error(`no such session: ${id}`)
	return JSON.parse(readFileSync(path, 'utf8')) as SessionRecord
}

export function listSessions(): SessionRecord[] {
	if (!existsSync(sessionsDir)) return []
	return readdirSync(sessionsDir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as SessionRecord)
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function forgetSession(id: string): void {
	rmSync(join(sessionsDir, `${id}.json`), { force: true })
}

/** Falls back to the most recent session so short commands stay short. */
export function resolveSession(id?: string): SessionRecord {
	if (id) return loadSession(id)
	const [latest] = listSessions()
	if (!latest) throw new Error('no sessions; run `vsim session start` first')
	return latest
}
