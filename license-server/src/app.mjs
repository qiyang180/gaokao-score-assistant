import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createLicenseService, ServiceError } from './license_service.mjs';
import {
  hashText,
  parseCookies,
  randomToken,
  verifyPassword,
} from './security.mjs';

const SESSION_COOKIE = 'gaokao_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;

export function createApp({ db, config, publicDir }) {
  const app = express();
  const service = createLicenseService({ db, config });
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '64kb' }));

  const activationLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  function jsonError(res, error) {
    const status = error instanceof ServiceError ? error.status : 500;
    res.status(status).json({
      code: error.code || 'INTERNAL_ERROR',
      message: status === 500 ? '授权服务器内部错误' : error.message,
    });
  }

  function sessionForRequest(req) {
    const raw = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (!raw) {
      return null;
    }
    const session = db.prepare(`
      SELECT * FROM admin_sessions WHERE id_hash = ? AND expires_at > ?
    `).get(hashText(raw), new Date().toISOString());
    return session ? { raw, ...session } : null;
  }

  function requireAdmin(req, res, next) {
    const session = sessionForRequest(req);
    if (!session) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: '请先登录' });
      return;
    }
    req.adminSession = session;
    next();
  }

  function requireCsrf(req, res, next) {
    if (req.headers['x-csrf-token'] !== req.adminSession.csrf_token) {
      res.status(403).json({ code: 'CSRF_INVALID', message: '页面令牌已失效，请刷新页面' });
      return;
    }
    next();
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/v1/activate', activationLimiter, (req, res) => {
    try {
      res.json(service.activate(req.body || {}));
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/api/v1/refresh', activationLimiter, (req, res) => {
    try {
      res.json(service.refresh(req.body || {}));
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/admin/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (
      username !== config.adminUsername
      || !verifyPassword(password, config.adminPasswordHash)
    ) {
      res.status(401).json({ code: 'LOGIN_FAILED', message: '用户名或密码错误' });
      return;
    }
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
    const raw = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
    db.prepare(`
      INSERT INTO admin_sessions (id_hash, csrf_token, expires_at) VALUES (?, ?, ?)
    `).run(hashText(raw), csrfToken, expiresAt);
    res.cookie(SESSION_COOKIE, raw, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'strict',
      maxAge: SESSION_MS,
      path: '/',
    });
    res.json({ ok: true, csrfToken, expiresAt });
  });

  app.get('/admin/api/session', (req, res) => {
    const session = sessionForRequest(req);
    if (!session) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      username: config.adminUsername,
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
    });
  });

  app.post('/admin/api/logout', requireAdmin, requireCsrf, (req, res) => {
    db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(req.adminSession.id_hash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/admin/api/codes', requireAdmin, (_req, res) => {
    res.json({ codes: service.listCodes() });
  });

  app.post('/admin/api/codes', requireAdmin, requireCsrf, (req, res) => {
    try {
      const record = service.createCode(req.body || {}, config.adminUsername);
      res.status(201).json(record);
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/admin/api/codes/:id/revoke', requireAdmin, requireCsrf, (req, res) => {
    try {
      service.revokeCode(req.params.id, config.adminUsername);
      res.json({ ok: true });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/admin/api/codes/:id/reset', requireAdmin, requireCsrf, (req, res) => {
    try {
      service.resetCode(req.params.id, config.adminUsername);
      res.json({ ok: true });
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.post('/admin/api/offline-license', requireAdmin, requireCsrf, (req, res) => {
    try {
      res.json(service.issueOffline(req.body || {}, config.adminUsername));
    } catch (error) {
      jsonError(res, error);
    }
  });

  app.get('/admin/api/audit', requireAdmin, (req, res) => {
    res.json({ events: service.listAudit(req.query.limit) });
  });

  app.use('/admin', express.static(publicDir, { index: 'admin.html' }));
  app.get('/', (_req, res) => res.redirect('/admin/'));

  app.use((error, _req, res, _next) => {
    console.error(error);
    jsonError(res, error);
  });

  return app;
}
