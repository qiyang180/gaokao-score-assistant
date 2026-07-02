import crypto from 'node:crypto';
import {
  PRODUCT_ID,
  signLicense,
  verifyLicense,
} from '../../shared/license_protocol.cjs';

const ONLINE_CHECK_MS = 7 * 24 * 60 * 60 * 1000;
const ONLINE_GRACE_MS = 10 * 24 * 60 * 60 * 1000;

export class ServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function normalizeActivationCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function activationCodeHash(value, pepper) {
  return crypto.createHmac('sha256', pepper)
    .update(normalizeActivationCode(value))
    .digest('hex');
}

function formatActivationCode(bytes = crypto.randomBytes(16)) {
  return `GK26-${bytes.toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}`;
}

function validateDeviceId(deviceId) {
  if (!/^[a-f0-9]{64}$/i.test(String(deviceId || ''))) {
    throw new ServiceError('INVALID_DEVICE', '设备标识无效');
  }
}

export function createLicenseService({ db, config, now = () => Date.now() }) {
  const trustedKeys = { [config.keyId]: config.publicKey };

  function audit(event, actor, targetId, details = {}) {
    db.prepare(`
      INSERT INTO audit_log (event, actor, target_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event, actor, targetId || null, JSON.stringify(details), nowIso(now()));
  }

  function getCodeById(codeId) {
    return db.prepare('SELECT * FROM activation_codes WHERE id = ?').get(codeId);
  }

  function assertUsableCode(code) {
    if (!code) {
      throw new ServiceError('INVALID_KEY', '激活码不存在', 404);
    }
    if (code.status !== 'active') {
      throw new ServiceError('KEY_REVOKED', '激活码已被吊销', 403);
    }
    if (Date.parse(code.expires_at) <= now()) {
      throw new ServiceError('KEY_EXPIRED', '激活码已到期', 403);
    }
  }

  function bindDevice(code, deviceId, mode) {
    const existing = db.prepare(`
      SELECT * FROM activations WHERE code_id = ? AND device_id = ?
    `).get(code.id, deviceId);
    if (existing?.status === 'active') {
      db.prepare(`
        UPDATE activations SET last_activated_at = ?, mode = ? WHERE id = ?
      `).run(nowIso(now()), mode, existing.id);
      return { ...existing, mode, last_activated_at: nowIso(now()) };
    }

    const activeCount = db.prepare(`
      SELECT COUNT(*) AS count FROM activations WHERE code_id = ? AND status = 'active'
    `).get(code.id).count;
    if (activeCount >= code.device_limit) {
      throw new ServiceError('DEVICE_LIMIT', '该激活码已绑定其他设备', 409);
    }

    const timestamp = nowIso(now());
    if (existing) {
      db.prepare(`
        UPDATE activations
        SET status = 'active', mode = ?, first_activated_at = ?, last_activated_at = ?
        WHERE id = ?
      `).run(mode, timestamp, timestamp, existing.id);
      return { ...existing, status: 'active', mode, first_activated_at: timestamp, last_activated_at: timestamp };
    }

    const activation = {
      id: crypto.randomUUID(),
      code_id: code.id,
      device_id: deviceId,
      mode,
      status: 'active',
      first_activated_at: timestamp,
      last_activated_at: timestamp,
    };
    db.prepare(`
      INSERT INTO activations
      (id, code_id, device_id, mode, status, first_activated_at, last_activated_at)
      VALUES (@id, @code_id, @device_id, @mode, @status, @first_activated_at, @last_activated_at)
    `).run(activation);
    return activation;
  }

  function issueLicense(code, activation, mode) {
    const issuedAtMs = now();
    const licenseId = crypto.randomUUID();
    const payload = {
      v: 1,
      kid: config.keyId,
      licenseId,
      activationId: activation.id,
      product: PRODUCT_ID,
      deviceId: activation.device_id,
      customer: code.customer,
      features: JSON.parse(code.features_json),
      mode,
      issuedAt: nowIso(issuedAtMs),
      expiresAt: code.expires_at,
      activationRevision: code.revision,
    };
    if (mode === 'online') {
      payload.checkAfter = nowIso(issuedAtMs + ONLINE_CHECK_MS);
      payload.graceUntil = nowIso(issuedAtMs + ONLINE_GRACE_MS);
    }
    const token = signLicense(payload, config.privateKey, config.passphrase);
    db.prepare(`
      INSERT INTO issued_licenses
      (id, code_id, activation_id, device_id, mode, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      licenseId,
      code.id,
      activation.id,
      activation.device_id,
      mode,
      payload.issuedAt,
      payload.expiresAt,
    );
    return { token, payload };
  }

  function createCode({ customer, expiresAt, features = ['query', 'export'] }, actor = 'admin') {
    if (!String(customer || '').trim()) {
      throw new ServiceError('INVALID_CUSTOMER', '客户名称不能为空');
    }
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now()) {
      throw new ServiceError('INVALID_EXPIRY', '到期时间必须晚于当前时间');
    }
    const activationCode = formatActivationCode();
    const normalized = normalizeActivationCode(activationCode);
    const timestamp = nowIso(now());
    const record = {
      id: crypto.randomUUID(),
      key_hash: activationCodeHash(normalized, config.keyPepper),
      key_prefix: activationCode.slice(0, 14),
      customer: String(customer).trim(),
      expires_at: new Date(expiry).toISOString(),
      features_json: JSON.stringify(features),
      status: 'active',
      device_limit: 1,
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    };
    db.prepare(`
      INSERT INTO activation_codes
      (id, key_hash, key_prefix, customer, expires_at, features_json, status,
       device_limit, revision, created_at, updated_at)
      VALUES (@id, @key_hash, @key_prefix, @customer, @expires_at, @features_json,
              @status, @device_limit, @revision, @created_at, @updated_at)
    `).run(record);
    audit('code.created', actor, record.id, { customer: record.customer, expiresAt: record.expires_at });
    return { ...record, activationCode };
  }

  function activate({ activationCode, deviceId, appVersion, requestId }) {
    validateDeviceId(deviceId);
    const keyHash = activationCodeHash(activationCode, config.keyPepper);
    const code = db.prepare('SELECT * FROM activation_codes WHERE key_hash = ?').get(keyHash);
    assertUsableCode(code);
    const activation = bindDevice(code, deviceId, 'online');
    const issued = issueLicense(code, activation, 'online');
    audit('license.activated', 'client', code.id, { deviceId, appVersion, requestId });
    return { ...issued, serverTime: nowIso(now()) };
  }

  function refresh({ token, deviceId, appVersion }) {
    validateDeviceId(deviceId);
    let payload;
    try {
      payload = verifyLicense(token, trustedKeys, {
        product: PRODUCT_ID,
        deviceId,
        now: now(),
        allowExpired: true,
      });
    } catch (error) {
      throw new ServiceError(error.code || 'INVALID_LICENSE', error.message, 403);
    }
    if (payload.mode !== 'online') {
      throw new ServiceError('OFFLINE_LICENSE', '离线许可证不能刷新', 400);
    }
    const code = getCodeById(
      db.prepare('SELECT code_id FROM activations WHERE id = ?').get(payload.activationId)?.code_id,
    );
    assertUsableCode(code);
    const activation = db.prepare(`
      SELECT * FROM activations WHERE id = ? AND device_id = ? AND status = 'active'
    `).get(payload.activationId, deviceId);
    if (!activation || payload.activationRevision !== code.revision) {
      throw new ServiceError('LICENSE_REVOKED', '设备授权已失效', 403);
    }
    db.prepare('UPDATE activations SET last_activated_at = ? WHERE id = ?')
      .run(nowIso(now()), activation.id);
    const issued = issueLicense(code, activation, 'online');
    audit('license.refreshed', 'client', code.id, { deviceId, appVersion });
    return { ...issued, serverTime: nowIso(now()) };
  }

  function issueOffline({ codeId, request }, actor = 'admin') {
    if (
      request?.v !== 1
      || request.product !== PRODUCT_ID
      || !request.requestId
      || !Number.isFinite(Date.parse(request.createdAt))
    ) {
      throw new ServiceError('INVALID_REQUEST', '离线申请文件无效');
    }
    if (now() - Date.parse(request.createdAt) > 30 * 24 * 60 * 60 * 1000) {
      throw new ServiceError('REQUEST_EXPIRED', '离线申请文件已超过 30 天');
    }
    validateDeviceId(request.deviceId);
    const code = getCodeById(codeId);
    assertUsableCode(code);
    const activation = bindDevice(code, request.deviceId, 'offline');
    const issued = issueLicense(code, activation, 'offline');
    audit('license.offline_issued', actor, code.id, {
      deviceId: request.deviceId,
      requestId: request.requestId,
    });
    return {
      file: {
        v: 1,
        product: PRODUCT_ID,
        token: issued.token,
      },
      payload: issued.payload,
    };
  }

  function revokeCode(codeId, actor = 'admin') {
    const code = getCodeById(codeId);
    if (!code) {
      throw new ServiceError('NOT_FOUND', '激活码不存在', 404);
    }
    db.prepare(`
      UPDATE activation_codes
      SET status = 'revoked', revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(nowIso(now()), codeId);
    audit('code.revoked', actor, codeId);
  }

  function resetCode(codeId, actor = 'admin') {
    const code = getCodeById(codeId);
    if (!code) {
      throw new ServiceError('NOT_FOUND', '激活码不存在', 404);
    }
    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE activations SET status = 'reset' WHERE code_id = ? AND status = 'active'
      `).run(codeId);
      db.prepare(`
        UPDATE activation_codes
        SET revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(nowIso(now()), codeId);
    });
    transaction();
    audit('code.device_reset', actor, codeId);
  }

  function listCodes() {
    return db.prepare(`
      SELECT c.id, c.key_prefix AS keyPrefix, c.customer, c.expires_at AS expiresAt,
             c.status, c.revision, c.created_at AS createdAt,
             a.device_id AS deviceId, a.mode, a.last_activated_at AS lastActivatedAt
      FROM activation_codes c
      LEFT JOIN activations a ON a.code_id = c.id AND a.status = 'active'
      ORDER BY c.created_at DESC
    `).all();
  }

  function listAudit(limit = 100) {
    return db.prepare(`
      SELECT id, event, actor, target_id AS targetId, details_json AS details,
             created_at AS createdAt
      FROM audit_log ORDER BY id DESC LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map((row) => ({ ...row, details: JSON.parse(row.details) }));
  }

  return {
    activate,
    createCode,
    issueOffline,
    listAudit,
    listCodes,
    refresh,
    resetCode,
    revokeCode,
  };
}
