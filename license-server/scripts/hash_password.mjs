import { hashPassword } from '../src/security.mjs';

const password = process.argv[2] || process.env.ADMIN_PASSWORD;
if (!password) {
  throw new Error('usage: node scripts/hash_password.mjs <password>');
}
console.log(hashPassword(password));
