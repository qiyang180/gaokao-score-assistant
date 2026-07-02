const crypto = require('node:crypto');

const PRODUCT_ID = 'gaokao-score-agent';
const LICENSE_VERSION = 1;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

class LicenseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LicenseError';
    this.code = code;
  }
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeToken(token) {
  const text = String(token || '').trim();
  const parts = text.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new LicenseError('INVALID_TOKEN', '许可证格式无效');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new LicenseError('INVALID_TOKEN', '许可证内容无法解析');
  }

  return {
    payload,
    payloadPart: parts[0],
    signature: Buffer.from(parts[1], 'base64url'),
  };
}

function signLicense(payload, privateKey, passphrase) {
  const payloadPart = encodePayload(payload);
  const signature = crypto.sign(
    null,
    Buffer.from(payloadPart, 'utf8'),
    passphrase ? { key: privateKey, passphrase } : privateKey,
  );
  return `${payloadPart}.${signature.toString('base64url')}`;
}

function requireIsoDate(payload, field) {
  const value = payload[field];
  const timestamp = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(timestamp)) {
    throw new LicenseError('INVALID_PAYLOAD', `许可证字段 ${field} 无效`);
  }
  return timestamp;
}

function verifyLicense(token, trustedKeys, options = {}) {
  const decoded = decodeToken(token);
  const { payload, payloadPart, signature } = decoded;
  const publicKey = trustedKeys?.[payload.kid];
  if (!publicKey) {
    throw new LicenseError('UNKNOWN_KEY', '许可证签发密钥不受信任');
  }

  const signatureValid = crypto.verify(
    null,
    Buffer.from(payloadPart, 'utf8'),
    publicKey,
    signature,
  );
  if (!signatureValid) {
    throw new LicenseError('INVALID_SIGNATURE', '许可证签名无效');
  }

  if (payload.v !== LICENSE_VERSION) {
    throw new LicenseError('UNSUPPORTED_VERSION', '许可证版本不受支持');
  }
  for (const field of ['licenseId', 'product', 'deviceId', 'customer', 'mode', 'issuedAt', 'expiresAt']) {
    if (typeof payload[field] !== 'string' || !payload[field]) {
      throw new LicenseError('INVALID_PAYLOAD', `许可证缺少字段 ${field}`);
    }
  }
  if (!['online', 'offline'].includes(payload.mode)) {
    throw new LicenseError('INVALID_PAYLOAD', '许可证模式无效');
  }
  if (!Array.isArray(payload.features)) {
    throw new LicenseError('INVALID_PAYLOAD', '许可证功能列表无效');
  }

  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  const issuedAt = requireIsoDate(payload, 'issuedAt');
  const expiresAt = requireIsoDate(payload, 'expiresAt');
  if (issuedAt > now + CLOCK_SKEW_MS) {
    throw new LicenseError('CLOCK_INVALID', '系统时间早于许可证签发时间');
  }
  if (!options.allowExpired && expiresAt <= now) {
    throw new LicenseError('LICENSE_EXPIRED', '许可证已到期');
  }
  if (options.product && payload.product !== options.product) {
    throw new LicenseError('WRONG_PRODUCT', '许可证不适用于当前软件');
  }
  if (options.deviceId && payload.deviceId !== options.deviceId) {
    throw new LicenseError('WRONG_DEVICE', '许可证与当前设备不匹配');
  }

  if (payload.mode === 'online') {
    requireIsoDate(payload, 'checkAfter');
    requireIsoDate(payload, 'graceUntil');
    if (!Number.isInteger(payload.activationRevision) || payload.activationRevision < 1) {
      throw new LicenseError('INVALID_PAYLOAD', '在线许可证修订号无效');
    }
  }

  return payload;
}

module.exports = {
  CLOCK_SKEW_MS,
  LICENSE_VERSION,
  LicenseError,
  PRODUCT_ID,
  decodeToken,
  encodePayload,
  signLicense,
  verifyLicense,
};
