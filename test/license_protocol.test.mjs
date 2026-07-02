import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import licenseProtocol from '../shared/license_protocol.cjs';
import deviceModule from '../app/licensing/device.cjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const now = Date.parse('2026-06-30T08:00:00.000Z');
const deviceId = deviceModule.hashMachineGuid('test-machine-guid');
const trustedKeys = { test: publicKey };

function payload(overrides = {}) {
  return {
    v: 1,
    kid: 'test',
    licenseId: 'license-1',
    activationId: 'activation-1',
    product: licenseProtocol.PRODUCT_ID,
    deviceId,
    customer: '测试客户',
    features: ['query', 'export'],
    mode: 'online',
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
    checkAfter: new Date(now + 3600000).toISOString(),
    graceUntil: new Date(now + 7200000).toISOString(),
    activationRevision: 1,
    ...overrides,
  };
}

test('valid signed license verifies for the expected product and device', () => {
  const token = licenseProtocol.signLicense(payload(), privateKey);
  const verified = licenseProtocol.verifyLicense(token, trustedKeys, {
    product: licenseProtocol.PRODUCT_ID,
    deviceId,
    now,
  });
  assert.equal(verified.customer, '测试客户');
});

test('tampered signature is rejected', () => {
  const token = licenseProtocol.signLicense(payload(), privateKey);
  const [body, signature] = token.split('.');
  const tampered = `${body}.${signature.slice(0, -1)}A`;
  assert.throws(
    () => licenseProtocol.verifyLicense(tampered, trustedKeys, { now }),
    (error) => error.code === 'INVALID_SIGNATURE',
  );
});

test('wrong product, wrong device, and expiry are rejected', () => {
  const token = licenseProtocol.signLicense(payload(), privateKey);
  assert.throws(
    () => licenseProtocol.verifyLicense(token, trustedKeys, { product: 'other', now }),
    (error) => error.code === 'WRONG_PRODUCT',
  );
  assert.throws(
    () => licenseProtocol.verifyLicense(token, trustedKeys, { deviceId: 'x'.repeat(64), now }),
    (error) => error.code === 'WRONG_DEVICE',
  );
  assert.throws(
    () => licenseProtocol.verifyLicense(token, trustedKeys, { now: now + 2 * 86400000 }),
    (error) => error.code === 'LICENSE_EXPIRED',
  );
});

test('offline license does not require online lease fields', () => {
  const token = licenseProtocol.signLicense(payload({
    mode: 'offline',
    checkAfter: undefined,
    graceUntil: undefined,
  }), privateKey);
  const verified = licenseProtocol.verifyLicense(token, trustedKeys, { deviceId, now });
  assert.equal(verified.mode, 'offline');
});
