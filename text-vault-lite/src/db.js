import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";

export function openDatabase(filename) {
  mkdirSync(dirname(filename), {recursive: true});
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;
  `);
  return db;
}

export function listEntries(db) {
  return db.prepare(`
    SELECT id, text, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
    FROM entries
    WHERE deleted_at IS NULL
    ORDER BY created_at, id
  `).all();
}

export function upsertEntry(db, entry) {
  db.prepare(`
    INSERT INTO entries(id, text, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      text = excluded.text,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `).run(entry.id, entry.text, entry.createdAt, entry.updatedAt, entry.deletedAt ?? null);
}

export function softDeleteEntry(db, id, deletedAt) {
  db.prepare(`
    UPDATE entries SET text = '', deleted_at = ?, updated_at = ? WHERE id = ?
  `).run(deletedAt, deletedAt, id);
}
