import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fallback = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'config.example.json'), 'utf8'),
).licenseServerUrl;
const apiUrl = process.env.GAOKAO_LICENSE_API_URL || fallback;
const parsed = new URL(apiUrl);
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHosts.has(parsed.hostname))) {
  throw new Error('license server URL must use HTTPS unless it targets localhost');
}

const outputPath = path.join(projectRoot, 'dist', 'license-config.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ licenseServerUrl: parsed.href.replace(/\/$/, '') }, null, 2));
console.log(`license server URL embedded: ${parsed.href.replace(/\/$/, '')}`);
