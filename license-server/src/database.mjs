import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS activation_codes (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      customer TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      features_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      device_limit INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activations (
      id TEXT PRIMARY KEY,
      code_id TEXT NOT NULL REFERENCES activation_codes(id),
      device_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      first_activated_at TEXT NOT NULL,
      last_activated_at TEXT NOT NULL,
      UNIQUE(code_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS issued_licenses (
      id TEXT PRIMARY KEY,
      code_id TEXT NOT NULL REFERENCES activation_codes(id),
      activation_id TEXT NOT NULL REFERENCES activations(id),
      device_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      target_id TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activation_hash ON activation_codes(key_hash);
    CREATE INDEX IF NOT EXISTS idx_activation_code_device ON activations(code_id, device_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  `);
  return db;
}
