import crypto from 'node:crypto';

export function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  if (String(password).length < 10) {
    throw new Error('管理员密码至少需要 10 个字符');
  }
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedText] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedText) {
    return false;
  }
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedText, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) {
          return [part, ''];
        }
        return [
          decodeURIComponent(part.slice(0, index)),
          decodeURIComponent(part.slice(index + 1)),
        ];
      }),
  );
}
