import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const sessions = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')

export function credentialHash(credential) { return hash(credential) }
export function credentialMatches(credential, expected) {
  if (typeof credential !== 'string' || typeof expected !== 'string') return false
  const actual = Buffer.from(hash(credential), 'hex')
  const wanted = Buffer.from(expected ?? '', 'hex')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
export function login() {
  const token = randomBytes(32).toString('base64url')
  const csrf = randomBytes(32).toString('base64url')
  sessions.set(hash(token), { csrf, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
  return { token, csrf }
}
export function session(token) {
  if (!token) return null
  const key = hash(token)
  const value = sessions.get(key)
  if (!value || value.expiresAt < Date.now()) { if (value) sessions.delete(key); return null }
  return value
}
export function logout(token) { if (token) sessions.delete(hash(token)) }
