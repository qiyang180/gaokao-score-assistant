const crypto = require('node:crypto');
const path = require('node:path');
const { PRODUCT_ID, decodeToken, verifyLicense } = require('../../shared/license_protocol.cjs');
const { formatDeviceCode, getDeviceId } = require('./device.cjs');
const { LicenseApiClient } = require('./client.cjs');
const { LicenseStorage } = require('./storage.cjs');
const { loadTrustedKeys } = require('./trusted_keys.cjs');

const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;

function errorState(error, deviceId) {
  return {
    status: error.code || 'LICENSE_ERROR',
    usable: false,
    message: error.message || '许可证无效',
    deviceId,
    deviceCode: formatDeviceCode(deviceId),
  };
}

class LicenseManager {
  constructor({ app, safeStorage, apiUrl, appVersion }) {
    this.deviceId = getDeviceId();
    this.appVersion = appVersion;
    this.storage = new LicenseStorage({
      filePath: path.join(app.getPath('userData'), 'license.dat'),
      safeStorage,
    });
    this.trustedKeys = loadTrustedKeys();
    this.api = new LicenseApiClient({ baseUrl: apiUrl });
  }

  stateFromPayload(payload, extra = {}) {
    return {
      status: 'licensed',
      usable: true,
      message: '',
      deviceId: this.deviceId,
      deviceCode: formatDeviceCode(this.deviceId),
      customer: payload.customer,
      expiresAt: payload.expiresAt,
      mode: payload.mode,
      features: payload.features,
      checkAfter: payload.checkAfter || '',
      graceUntil: payload.graceUntil || '',
      ...extra,
    };
  }

  verifyToken(token, now = Date.now()) {
    return verifyLicense(token, this.trustedKeys, {
      product: PRODUCT_ID,
      deviceId: this.deviceId,
      now,
    });
  }

  saveToken(token, payload, previous = {}, options = {}) {
    const nowIso = new Date().toISOString();
    const candidates = options.resetClock
      ? [payload.issuedAt, nowIso]
      : [previous.lastSeenAt, payload.issuedAt, nowIso];
    this.storage.write({
      token,
      lastSeenAt: candidates.filter(Boolean).sort().at(-1),
    });
  }

  async refreshRecord(record) {
    const response = await this.api.refresh({
      token: record.token,
      deviceId: this.deviceId,
      appVersion: this.appVersion,
    });
    const signedIssuedAt = Date.parse(decodeToken(response.token).payload.issuedAt);
    const payload = this.verifyToken(
      response.token,
      Number.isFinite(signedIssuedAt) ? signedIssuedAt : Date.now(),
    );
    if (payload.mode !== 'online') {
      throw new Error('授权服务器返回了错误的许可证模式');
    }
    this.saveToken(response.token, payload, record, { resetClock: true });
    return { token: response.token, payload };
  }

  async inspect({ refreshIfNeeded = true } = {}) {
    let record;
    try {
      record = this.storage.read();
    } catch (error) {
      return errorState(error, this.deviceId);
    }
    if (!record?.token) {
      return {
        status: 'unlicensed',
        usable: false,
        message: '请输入激活码或导入离线许可证',
        deviceId: this.deviceId,
        deviceCode: formatDeviceCode(this.deviceId),
      };
    }

    const now = Date.now();
    try {
      let payload = this.verifyToken(record.token, now);
      const lastSeen = Date.parse(record.lastSeenAt || '');
      const clockRollback = Number.isFinite(lastSeen) && now + CLOCK_ROLLBACK_TOLERANCE_MS < lastSeen;
      const refreshDue = payload.mode === 'online' && now >= Date.parse(payload.checkAfter);

      if (payload.mode === 'online' && refreshIfNeeded && (clockRollback || refreshDue)) {
        try {
          const refreshed = await this.refreshRecord(record);
          payload = refreshed.payload;
          return this.stateFromPayload(payload);
        } catch (error) {
          const withinGrace = !clockRollback && now <= Date.parse(payload.graceUntil);
          if (!withinGrace) {
            return errorState(
              Object.assign(
                new Error(clockRollback ? '检测到系统时间回退，需要联网验证' : error.message),
                { code: clockRollback ? 'CLOCK_ROLLBACK' : (error.code || 'REFRESH_REQUIRED') },
              ),
              this.deviceId,
            );
          }
          return this.stateFromPayload(payload, {
            status: 'grace',
            message: `授权服务器暂不可用，将在 ${payload.graceUntil} 后停止运行`,
          });
        }
      }

      if (clockRollback) {
        return errorState(
          Object.assign(new Error('检测到系统时间回退，需要联网验证'), { code: 'CLOCK_ROLLBACK' }),
          this.deviceId,
        );
      }

      this.saveToken(record.token, payload, record);
      return this.stateFromPayload(payload);
    } catch (error) {
      return errorState(error, this.deviceId);
    }
  }

  async activate(activationCode) {
    const code = String(activationCode || '').trim().toUpperCase();
    if (!code) {
      throw new Error('请输入激活码');
    }
    const response = await this.api.activate({
      activationCode: code,
      deviceId: this.deviceId,
      appVersion: this.appVersion,
      requestId: crypto.randomUUID(),
    });
    const payload = this.verifyToken(response.token);
    if (payload.mode !== 'online') {
      throw new Error('授权服务器返回了错误的许可证模式');
    }
    this.saveToken(response.token, payload);
    return this.inspect({ refreshIfNeeded: false });
  }

  async refresh() {
    const record = this.storage.read();
    if (!record?.token) {
      throw new Error('当前没有可刷新的许可证');
    }
    const payload = this.verifyToken(record.token);
    if (payload.mode !== 'online') {
      throw new Error('离线许可证不需要联网刷新');
    }
    await this.refreshRecord(record);
    return this.inspect({ refreshIfNeeded: false });
  }

  createOfflineRequest() {
    return {
      v: 1,
      requestId: crypto.randomUUID(),
      product: PRODUCT_ID,
      deviceId: this.deviceId,
      deviceCode: formatDeviceCode(this.deviceId),
      appVersion: this.appVersion,
      createdAt: new Date().toISOString(),
    };
  }

  async importOfflineLicense(content) {
    let parsed;
    try {
      parsed = JSON.parse(String(content || ''));
    } catch {
      throw new Error('离线许可证文件不是有效 JSON');
    }
    const payload = this.verifyToken(parsed.token);
    if (payload.mode !== 'offline') {
      throw new Error('导入文件不是离线许可证');
    }
    this.saveToken(parsed.token, payload);
    return this.inspect({ refreshIfNeeded: false });
  }

  async assertUsable() {
    const state = await this.inspect({ refreshIfNeeded: true });
    if (!state.usable) {
      const error = new Error(state.message || '软件尚未授权');
      error.code = state.status;
      throw error;
    }
    const record = this.storage.read();
    return {
      ...state,
      token: record.token,
    };
  }
}

module.exports = {
  LicenseManager,
};
