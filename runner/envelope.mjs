// Sealed envelope: X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM.
//
// Why this exists: a GitHub Actions job log is world-readable on a public
// repository. Existing prototypes print the tunnel URL straight into it, which
// hands anyone who is watching a live desktop. The runner instead encrypts to a
// public key that the caller generated locally and only ever emits ciphertext.
//
// Plain ESM with no dependencies so the runner can execute it with the Node
// that is already on the image, without an install step.

import {
	createCipheriv,
	createDecipheriv,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
} from 'node:crypto'

const VERSION = 'vsim1'
const INFO = Buffer.from('vibrant-sim/session-envelope/v1')
// DER prefix for an X25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
// DER prefix for an X25519 PKCS#8 PrivateKeyInfo.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

const b64 = (buf) => Buffer.from(buf).toString('base64url')
const unb64 = (str) => Buffer.from(str, 'base64url')

/** @param {Buffer} raw */
export function publicKeyFromRaw(raw) {
	if (raw.length !== 32) throw new Error(`x25519 public key must be 32 bytes, got ${raw.length}`)
	return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/** @param {Buffer} raw */
export function privateKeyFromRaw(raw) {
	if (raw.length !== 32) throw new Error(`x25519 private key must be 32 bytes, got ${raw.length}`)
	return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

/** @param {import('node:crypto').KeyObject} key */
export function rawPublicKey(key) {
	return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
}

/** @param {import('node:crypto').KeyObject} key */
export function rawPrivateKey(key) {
	return key.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length)
}

/** Generates a recipient keypair, encoded so it survives a shell round-trip. */
export function generateRecipient() {
	const { publicKey, privateKey } = generateKeyPairSync('x25519')
	return { publicKey: b64(rawPublicKey(publicKey)), privateKey: b64(rawPrivateKey(privateKey)) }
}

function deriveKey(secret, ephemeralPub, recipientPub) {
	return Buffer.from(
		hkdfSync('sha256', secret, Buffer.concat([ephemeralPub, recipientPub]), INFO, 32),
	)
}

/**
 * Encrypts to the caller's public key. Runs on the runner.
 * @param {string} recipientPublicKey base64url raw X25519 public key
 * @param {unknown} payload JSON-serialisable
 */
export function seal(recipientPublicKey, payload) {
	const recipientRaw = unb64(recipientPublicKey)
	const recipient = publicKeyFromRaw(recipientRaw)
	const ephemeral = generateKeyPairSync('x25519')
	const ephemeralRaw = rawPublicKey(ephemeral.publicKey)
	const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
	const key = deriveKey(secret, ephemeralRaw, recipientRaw)

	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const body = Buffer.concat([
		cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
		cipher.final(),
		cipher.getAuthTag(),
	])
	return [VERSION, b64(ephemeralRaw), b64(iv), b64(body)].join('.')
}

/**
 * Decrypts with the caller's private key. Runs on the developer's machine.
 * @param {string} recipientPrivateKey base64url raw X25519 private key
 * @param {string} sealed
 */
export function open(recipientPrivateKey, sealed) {
	const parts = sealed.trim().split('.')
	if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('not a vsim1 sealed envelope')
	const [, ephB64, ivB64, bodyB64] = parts

	const privateRaw = unb64(recipientPrivateKey)
	const privateKey = privateKeyFromRaw(privateRaw)
	const recipientRaw = rawPublicKey(createPublicKey(privateKey))
	const ephemeralRaw = unb64(ephB64)
	const secret = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephemeralRaw) })
	const key = deriveKey(secret, ephemeralRaw, recipientRaw)

	const body = unb64(bodyB64)
	const tag = body.subarray(body.length - 16)
	const decipher = createDecipheriv('aes-256-gcm', key, unb64(ivB64))
	decipher.setAuthTag(tag)
	const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
	return JSON.parse(plain.toString('utf8'))
}
