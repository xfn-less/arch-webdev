import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true })
  const db = new DatabaseSync(filename)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      envelope TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS object_versions (
      id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
      envelope TEXT NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY (id, revision)
    ) STRICT;
    INSERT OR IGNORE INTO metadata(key, value) VALUES ('generation', '0');
  `)
  return db
}

const metadata = (db, key) => db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value
const generation = db => Number(metadata(db, 'generation') ?? 0)

export function vaultHeader(db) {
  const value = metadata(db, 'vault_header')
  return value === undefined ? null : JSON.parse(String(value))
}

export function authHash(db) {
  const value = metadata(db, 'auth_hash')
  return value === undefined ? null : String(value)
}

export function createVault(db, header, credentialHash) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('vault_header', JSON.stringify(header))
    db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('auth_hash', credentialHash)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function rotateVault(db, header, credentialHash) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(JSON.stringify(header), 'vault_header')
    db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(credentialHash, 'auth_hash')
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

function manifest(db) {
  const objects = Object.fromEntries(db.prepare('SELECT id, kind, revision FROM objects ORDER BY id').all().map(row => [row.id, {kind: row.kind, revision: Number(row.revision)}]))
  return { schemaVersion: 1, generation: generation(db), objects }
}

export function snapshot(db) {
  const objects = Object.fromEntries(db.prepare('SELECT id, kind, revision, envelope FROM objects ORDER BY id').all().map(row => [row.id, { id: row.id, kind: row.kind, revision: Number(row.revision), envelope: JSON.parse(row.envelope) }]))
  return { manifest: manifest(db), objects }
}

export function changes(db, after) {
  const rows = db.prepare(`
    SELECT v.id, v.kind, v.revision, v.envelope
    FROM object_versions v
    JOIN (SELECT id, MAX(generation) generation FROM object_versions WHERE generation > ? GROUP BY id) n
      ON n.id = v.id AND n.generation = v.generation
    ORDER BY v.id`).all(after)
  const objects = Object.fromEntries(rows.map(row => [row.id, { id: row.id, kind: row.kind, revision: Number(row.revision), envelope: JSON.parse(row.envelope) }]))
  return { generation: generation(db), objects }
}

export function commit(db, request) {
  if (!Number.isSafeInteger(request.baseGeneration) || !Array.isArray(request.objects)) throw new Error('invalid commit')
  if (request.baseGeneration !== generation(db)) return null
  const current = new Map(db.prepare('SELECT id, kind, revision FROM objects').all().map(row => [row.id, row]))
  const seen = new Set()
  for (const object of request.objects) {
    const validID = object.kind === 'entry' ? /^[0-9a-z]{9}$/.test(object.id) : /^[A-Za-z0-9_-]{16,80}$/.test(object.id)
    if (!validID || !['entry', 'workspace', 'query', 'view'].includes(object.kind) || seen.has(object.id) || !Number.isSafeInteger(object.revision) || object.revision < 1 || !object.envelope || typeof object.envelope !== 'object') throw new Error('invalid object')
    seen.add(object.id)
    const old = current.get(object.id)
    if ((old && object.revision !== Number(old.revision) + 1) || (!old && object.revision !== 1)) return null
  }
  if (request.objects.length === 0) return manifest(db)
  const next = generation(db) + 1
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const object of request.objects) {
      const envelope = JSON.stringify(object.envelope)
      db.prepare('INSERT INTO object_versions(id, revision, kind, envelope, generation) VALUES (?, ?, ?, ?, ?)').run(object.id, object.revision, object.kind, envelope, next)
      db.prepare(`INSERT INTO objects(id, kind, revision, envelope, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, revision=excluded.revision, envelope=excluded.envelope, updated_at=excluded.updated_at`).run(object.id, object.kind, object.revision, envelope, Date.now())
    }
    db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(String(next), 'generation')
    db.exec('COMMIT')
    return manifest(db)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
