import type { KeyObject } from 'node:crypto'

export function publicKeyFromRaw(raw: Buffer): KeyObject
export function privateKeyFromRaw(raw: Buffer): KeyObject
export function rawPublicKey(key: KeyObject): Buffer
export function rawPrivateKey(key: KeyObject): Buffer
export function generateRecipient(): { publicKey: string; privateKey: string }
export function seal(recipientPublicKey: string, payload: unknown): string
export function open<T = unknown>(recipientPrivateKey: string, sealed: string): T
