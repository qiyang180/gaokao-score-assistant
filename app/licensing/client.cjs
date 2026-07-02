class LicenseApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'LicenseApiError';
    this.code = code;
    this.status = status;
  }
}

class LicenseApiClient {
  constructor({ baseUrl, timeoutMs = 10000 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    if (this.baseUrl) {
      const parsed = new URL(this.baseUrl);
      const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHosts.has(parsed.hostname))) {
        throw new LicenseApiError('INSECURE_SERVER_URL', '授权服务器必须使用 HTTPS');
      }
    }
  }

  async post(pathname, body) {
    if (!this.baseUrl) {
      throw new LicenseApiError('SERVER_NOT_CONFIGURED', '未配置授权服务器地址');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new LicenseApiError(
          data.code || 'SERVER_ERROR',
          data.message || `授权服务器返回 ${response.status}`,
          response.status,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof LicenseApiError) {
        throw error;
      }
      if (error.name === 'AbortError') {
        throw new LicenseApiError('NETWORK_TIMEOUT', '连接授权服务器超时');
      }
      throw new LicenseApiError('NETWORK_ERROR', `无法连接授权服务器：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  activate(payload) {
    return this.post('/api/v1/activate', payload);
  }

  refresh(payload) {
    return this.post('/api/v1/refresh', payload);
  }
}

module.exports = {
  LicenseApiClient,
  LicenseApiError,
};
