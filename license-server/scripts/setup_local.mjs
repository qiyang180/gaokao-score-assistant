import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/security.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(serverRoot, '.env');
const passwordPath = path.join(serverRoot, '.local-admin-password.txt');
if (fs.existsSync(envPath) || fs.existsSync(passwordPath)) {
  throw new Error('local server configuration already exists; refusing to overwrite it');
}

const adminPassword = crypto.randomBytes(18).toString('base64url');
const pepper = crypto.randomBytes(32).toString('base64url');
const env = [
  'PORT=8787',
  'DB_PATH=./data/licenses.sqlite',
  'LICENSE_KEY_ID=prod-2026-01',
  'LICENSE_PRIVATE_KEY_PATH=../.license-secrets/prod-2026-01-private.pem',
  'LICENSE_KEY_PASSPHRASE_FILE=../.license-secrets/prod-2026-01-passphrase.txt',
  `ACTIVATION_KEY_PEPPER=${pepper}`,
  'ADMIN_USERNAME=admin',
  `ADMIN_PASSWORD_HASH=${hashPassword(adminPassword)}`,
  'SECURE_COOKIES=false',
  'TRUST_PROXY=0',
  '',
].join('\n');

fs.writeFileSync(envPath, env, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(passwordPath, `${adminPassword}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`local configuration created: ${envPath}`);
console.log(`local admin password saved to: ${passwordPath}`);
