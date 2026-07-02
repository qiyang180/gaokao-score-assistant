import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kid = process.argv[2] || 'prod-2026-01';
if (!/^[a-z0-9][a-z0-9-]{2,40}$/i.test(kid)) {
  throw new Error('key id must contain only letters, numbers, and hyphens');
}

const secretsDir = path.join(projectRoot, '.license-secrets');
const publicDir = path.join(projectRoot, 'app', 'licensing', 'keys');
const privateKeyPath = path.join(secretsDir, `${kid}-private.pem`);
const passphrasePath = path.join(secretsDir, `${kid}-passphrase.txt`);
const publicKeyPath = path.join(publicDir, `${kid}.pem`);

const privateExists = fs.existsSync(privateKeyPath);
const passphraseExists = fs.existsSync(passphrasePath);
const publicExists = fs.existsSync(publicKeyPath);
if (privateExists || passphraseExists || publicExists) {
  if (privateExists && passphraseExists && !publicExists) {
    const existingPrivateKey = fs.readFileSync(privateKeyPath, 'utf8');
    const existingPassphrase = fs.readFileSync(passphrasePath, 'utf8').trim();
    const recoveredPublicKey = crypto.createPublicKey({
      key: existingPrivateKey,
      format: 'pem',
      passphrase: existingPassphrase,
    }).export({ type: 'spki', format: 'pem' });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(publicKeyPath, recoveredPublicKey, 'utf8');
    console.log(`recovered public key ${kid}: ${publicKeyPath}`);
    process.exit(0);
  }
  throw new Error(`refusing to overwrite existing key material for ${kid}`);
}

const passphrase = crypto.randomBytes(32).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase,
  },
});

fs.mkdirSync(secretsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(passphrasePath, `${passphrase}\n`, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKey, 'utf8');

console.log(`generated Ed25519 key ${kid}`);
console.log(`public key: ${publicKeyPath}`);
console.log(`private key: ${privateKeyPath}`);
console.log(`passphrase: ${passphrasePath}`);
console.log('Back up the private key and passphrase separately before publishing licenses.');
