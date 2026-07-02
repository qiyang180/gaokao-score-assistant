import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function resolvePath(value, fallback) {
  return path.resolve(serverRoot, value || fallback);
}

export function loadConfig(overrides = {}) {
  const keyPath = resolvePath(
    overrides.keyPath || process.env.LICENSE_PRIVATE_KEY_PATH,
    '../.license-secrets/prod-2026-01-private.pem',
  );
  const passphrasePath = resolvePath(
    overrides.passphrasePath || process.env.LICENSE_KEY_PASSPHRASE_FILE,
    '../.license-secrets/prod-2026-01-passphrase.txt',
  );
  const passphrase = overrides.passphrase
    || process.env.LICENSE_KEY_PASSPHRASE
    || (fs.existsSync(passphrasePath) ? fs.readFileSync(passphrasePath, 'utf8').trim() : '');
  const privateKey = overrides.privateKey || fs.readFileSync(keyPath, 'utf8');
  const publicKey = crypto.createPublicKey({
    key: privateKey,
    format: 'pem',
    passphrase,
  }).export({ type: 'spki', format: 'pem' });

  return {
    port: Number(overrides.port || process.env.PORT || 8787),
    dbPath: resolvePath(overrides.dbPath || process.env.DB_PATH, 'data/licenses.sqlite'),
    keyId: overrides.keyId || process.env.LICENSE_KEY_ID || 'prod-2026-01',
    keyPepper: overrides.keyPepper || process.env.ACTIVATION_KEY_PEPPER || required('ACTIVATION_KEY_PEPPER'),
    privateKey,
    publicKey,
    passphrase,
    adminUsername: overrides.adminUsername || process.env.ADMIN_USERNAME || 'admin',
    adminPasswordHash: overrides.adminPasswordHash
      || process.env.ADMIN_PASSWORD_HASH
      || required('ADMIN_PASSWORD_HASH'),
    secureCookies: overrides.secureCookies
      ?? (process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production'),
    trustProxy: overrides.trustProxy ?? (process.env.TRUST_PROXY === '1'),
  };
}
