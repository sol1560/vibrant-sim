import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateRecipient, open, seal } from '../runner/envelope.mjs'

test('round-trips a session payload', () => {
	const { publicKey, privateKey } = generateRecipient()
	const payload = { tunnelUrl: 'https://abc-def.trycloudflare.com', pairingKey: 's3cret', runId: 42 }
	const opened = open<typeof payload>(privateKey, seal(publicKey, payload))
	assert.deepEqual(opened, payload)
})

test('a different private key cannot open it', () => {
	const alice = generateRecipient()
	const mallory = generateRecipient()
	const sealed = seal(alice.publicKey, { tunnelUrl: 'https://secret.example' })
	assert.throws(() => open(mallory.privateKey, sealed))
})

test('tampering with the ciphertext is rejected', () => {
	const { publicKey, privateKey } = generateRecipient()
	const sealed = seal(publicKey, { pairingKey: 'a'.repeat(32) })
	const parts = sealed.split('.')
	const body = Buffer.from(parts[3]!, 'base64url')
	body.writeUInt8(body.readUInt8(0) ^ 0xff, 0)
	parts[3] = body.toString('base64url')
	assert.throws(() => open(privateKey, parts.join('.')), /unable to authenticate|bad decrypt|Unsupported state/i)
})

test('each seal uses a fresh ephemeral key', () => {
	const { publicKey } = generateRecipient()
	const a = seal(publicKey, { x: 1 }).split('.')[1]
	const b = seal(publicKey, { x: 1 }).split('.')[1]
	assert.notEqual(a, b)
})

test('rejects envelopes that are not ours', () => {
	const { privateKey } = generateRecipient()
	assert.throws(() => open(privateKey, 'age1.aaa.bbb.ccc'), /not a vsim1 sealed envelope/)
})

test('public key is short enough for a workflow_dispatch input', () => {
	const { publicKey } = generateRecipient()
	assert.equal(publicKey.length, 43)
})
