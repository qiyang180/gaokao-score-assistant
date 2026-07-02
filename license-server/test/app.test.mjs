import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/database.mjs';
import { hashPassword } from '../src/security.mjs';

test('admin login, CSRF protection, code creation, and public activation work end to end', async () => {
  const keys = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const db = openDatabase(':memory:');
  const config = {
    keyId: 'test',
    keyPepper: 'http-test-pepper-that-is-long-enough',
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    passphrase: '',
    adminUsername: 'admin',
    adminPasswordHash: hashPassword('correct-password'),
    secureCookies: false,
    trustProxy: false,
  };
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const app = createApp({
    db,
    config,
    publicDir: path.join(serverRoot, 'public'),
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const loginResponse = await fetch(`${baseUrl}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-password' }),
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    assert.ok(login.csrfToken);

    const denied = await fetch(`${baseUrl}/admin/api/codes`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ customer: 'HTTP 测试' }),
    });
    assert.equal(denied.status, 403);

    const createResponse = await fetch(`${baseUrl}/admin/api/codes`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': login.csrfToken,
      },
      body: JSON.stringify({
        customer: 'HTTP 测试',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    assert.equal(createResponse.status, 201);
    const code = await createResponse.json();
    assert.match(code.activationCode, /^GK26-/);

    const activationResponse = await fetch(`${baseUrl}/api/v1/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activationCode: code.activationCode,
        deviceId: 'a'.repeat(64),
        appVersion: '1.0.0',
        requestId: 'http-test',
      }),
    });
    assert.equal(activationResponse.status, 200);
    const activation = await activationResponse.json();
    assert.ok(activation.token);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
