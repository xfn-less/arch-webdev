import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { authHash, changes, commit, createVault, openDatabase, rotateVault, snapshot, vaultHeader } from './db.js'
import { credentialHash, credentialMatches, login, logout, session } from './auth.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const webRoot = join(root, 'web')
const db = openDatabase(process.env.TEXT_VAULT_DB ?? join(root, 'data', 'text-vault.sqlite'))
const app = new Hono()
const listeners = new Set()
const cookieOptions = { httpOnly: true, sameSite: 'Strict', secure: process.env.NODE_ENV === 'production', path: '/' }
const error = (c, status, code) => c.json({ error: code }, status)
const token = c => getCookie(c, 'text_vault_session')
const current = c => session(token(c))
const requireAuth = async (c, next) => current(c) ? next() : error(c, 401, 'unauthorized')
const requireCSRF = async (c, next) => current(c)?.csrf === c.req.header('X-CSRF-Token') ? next() : error(c, 403, 'csrf_failed')

app.use('*', async (c, next) => { c.header('Cache-Control', c.req.path.startsWith('/api/') ? 'no-store' : 'no-cache'); return next() })
app.get('/api/health', c => c.json({ ok: true }))
app.get('/api/vault', c => { const header = vaultHeader(db); return header ? c.json(header) : error(c, 404, 'vault_not_found') })
app.post('/api/setup', async c => {
  if (vaultHeader(db)) return error(c, 409, 'conflict')
  const input = await c.req.json().catch(() => null)
  if (!input || typeof input.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.credential) || !input.header || typeof input.header !== 'object') return error(c, 400, 'invalid_setup')
  try { createVault(db, input.header, credentialHash(input.credential)) } catch { return error(c, 400, 'invalid_setup') }
  const auth = login()
  setCookie(c, 'text_vault_session', auth.token, { ...cookieOptions, maxAge: 86400 })
  return c.json({ csrfToken: auth.csrf })
})
app.post('/api/login', async c => {
  const input = await c.req.json().catch(() => null)
  if (!input || !credentialMatches(input.credential, authHash(db))) return error(c, 401, 'unauthorized')
  const auth = login()
  setCookie(c, 'text_vault_session', auth.token, { ...cookieOptions, maxAge: 86400 })
  return c.json({ csrfToken: auth.csrf })
})
app.use('/api/*', async (c, next) => {
  if (['/api/health', '/api/vault', '/api/setup', '/api/login'].includes(c.req.path)) return next()
  return requireAuth(c, next)
})
app.get('/api/snapshot', c => c.json(snapshot(db)))
app.get('/api/changes', c => { const after = Number(c.req.query('after')); return Number.isSafeInteger(after) && after >= 0 ? c.json(changes(db, after)) : error(c, 400, 'invalid_generation') })
app.get('/api/events', c => {
  let close
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = value => {
        try { controller.enqueue(encoder.encode(`event: generation\ndata: ${value}\n\n`)) }
        catch { close?.() }
      }
      listeners.add(send)
      send(snapshot(db).manifest.generation)
      close = () => listeners.delete(send)
    },
    cancel() { close?.() }
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
})
app.post('/api/commit', requireCSRF, async c => {
  try {
    const result = commit(db, await c.req.json())
    if (!result) return error(c, 409, 'conflict')
    for (const listener of listeners) listener(result.generation)
    return c.json({ manifest: result })
  } catch { return error(c, 400, 'invalid_commit') }
})
app.post('/api/rekey', requireCSRF, async c => { const input = await c.req.json().catch(() => null); if (!input || typeof input.credential !== 'string' || !input.header) return error(c, 400, 'invalid_rekey'); rotateVault(db, input.header, credentialHash(input.credential)); logout(token(c)); const auth = login(); setCookie(c, 'text_vault_session', auth.token, { ...cookieOptions, maxAge: 86400 }); return c.json({ csrfToken: auth.csrf }) })
app.post('/api/logout', requireCSRF, c => { logout(token(c)); deleteCookie(c, 'text_vault_session', { path: '/' }); return c.body(null, 204) })
app.get('/', c => c.redirect('/index.html'))
app.use('*', serveStatic({ root: webRoot }))
app.notFound(c => c.text('Not found', 404))

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname: host })
console.log(`Text Vault listening on http://${host}:${port}`)
