import crypto from 'node:crypto';
import licenseProtocol from '../../shared/license_protocol.cjs';
import deviceModule from '../../app/licensing/device.cjs';

const kid = 'test';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export function getTestTrustedKeys() {
  return { [kid]: publicKey };
}

export function createTestLicense(options = {}) {
  const now = options.now || Date.now();
  const mode = options.mode || 'online';
  const payload = {
    v: 1,
    kid,
    licenseId: options.licenseId || `test-${now}`,
    activationId: options.activationId || 'test-activation',
    product: licenseProtocol.PRODUCT_ID,
    deviceId: options.deviceId || deviceModule.getDeviceId(),
    customer: options.customer || '自动化测试',
    features: ['query', 'export'],
    mode,
    issuedAt: new Date(now).toISOString(),
    expiresAt: options.expiresAt || new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    activationRevision: 1,
  };
  if (mode === 'online') {
    payload.checkAfter = new Date(now + 60 * 60 * 1000).toISOString();
    payload.graceUntil = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  }
  return licenseProtocol.signLicense(payload, privateKey);
}
