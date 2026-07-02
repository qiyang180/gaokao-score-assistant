import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import licenseProtocol from '../../shared/license_protocol.cjs';
import { openDatabase } from '../src/database.mjs';
import { createLicenseService } from '../src/license_service.mjs';

function fixture() {
  const keys = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let currentTime = Date.parse('2026-06-30T08:00:00.000Z');
  const db = openDatabase(':memory:');
  const config = {
    keyId: 'test',
    keyPepper: 'test-pepper-that-is-long-enough',
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    passphrase: '',
  };
  const service = createLicenseService({
    db,
    config,
    now: () => currentTime,
  });
  return {
    config,
    db,
    service,
    now: () => currentTime,
    advance: (milliseconds) => {
      currentTime += milliseconds;
    },
  };
}

const deviceOne = '1'.repeat(64);
const deviceTwo = '2'.repeat(64);

test('one activation code binds one device and allows same-device reactivation', () => {
  const f = fixture();
  const code = f.service.createCode({
    customer: '学校 A',
    expiresAt: new Date(f.now() + 30 * 86400000).toISOString(),
  });
  const first = f.service.activate({
    activationCode: code.activationCode,
    deviceId: deviceOne,
    appVersion: '1.0.0',
    requestId: 'r1',
  });
  const second = f.service.activate({
    activationCode: code.activationCode,
    deviceId: deviceOne,
    appVersion: '1.0.0',
    requestId: 'r2',
  });
  assert.equal(first.payload.deviceId, deviceOne);
  assert.equal(second.payload.deviceId, deviceOne);
  assert.throws(
    () => f.service.activate({
      activationCode: code.activationCode,
      deviceId: deviceTwo,
      appVersion: '1.0.0',
      requestId: 'r3',
    }),
    (error) => error.code === 'DEVICE_LIMIT',
  );
  f.db.close();
});

test('refresh, reset, replacement device, and revoke follow server state', () => {
  const f = fixture();
  const code = f.service.createCode({
    customer: '学校 B',
    expiresAt: new Date(f.now() + 30 * 86400000).toISOString(),
  });
  const activated = f.service.activate({
    activationCode: code.activationCode,
    deviceId: deviceOne,
    appVersion: '1.0.0',
    requestId: 'r1',
  });
  const refreshed = f.service.refresh({
    token: activated.token,
    deviceId: deviceOne,
    appVersion: '1.0.1',
  });
  assert.equal(refreshed.payload.mode, 'online');

  f.service.resetCode(code.id);
  assert.throws(
    () => f.service.refresh({
      token: refreshed.token,
      deviceId: deviceOne,
      appVersion: '1.0.1',
    }),
    (error) => error.code === 'LICENSE_REVOKED',
  );
  const replacement = f.service.activate({
    activationCode: code.activationCode,
    deviceId: deviceTwo,
    appVersion: '1.0.1',
    requestId: 'r2',
  });
  assert.equal(replacement.payload.deviceId, deviceTwo);

  f.service.revokeCode(code.id);
  assert.throws(
    () => f.service.refresh({
      token: replacement.token,
      deviceId: deviceTwo,
      appVersion: '1.0.1',
    }),
    (error) => error.code === 'KEY_REVOKED',
  );
  f.db.close();
});

test('offline request creates a device-bound fixed-expiry license', () => {
  const f = fixture();
  const code = f.service.createCode({
    customer: '学校 C',
    expiresAt: new Date(f.now() + 30 * 86400000).toISOString(),
  });
  const result = f.service.issueOffline({
    codeId: code.id,
    request: {
      v: 1,
      requestId: 'offline-request',
      product: licenseProtocol.PRODUCT_ID,
      deviceId: deviceOne,
      appVersion: '1.0.0',
      createdAt: new Date(f.now()).toISOString(),
    },
  });
  const payload = licenseProtocol.verifyLicense(
    result.file.token,
    { test: f.config.publicKey },
    {
      product: licenseProtocol.PRODUCT_ID,
      deviceId: deviceOne,
      now: f.now(),
    },
  );
  assert.equal(payload.mode, 'offline');
  assert.equal(payload.expiresAt, code.expires_at);
  f.db.close();
});

test('expired activation code cannot activate or refresh', () => {
  const f = fixture();
  const code = f.service.createCode({
    customer: '学校 D',
    expiresAt: new Date(f.now() + 1000).toISOString(),
  });
  f.advance(2000);
  assert.throws(
    () => f.service.activate({
      activationCode: code.activationCode,
      deviceId: deviceOne,
      appVersion: '1.0.0',
      requestId: 'late',
    }),
    (error) => error.code === 'KEY_EXPIRED',
  );
  f.db.close();
});
