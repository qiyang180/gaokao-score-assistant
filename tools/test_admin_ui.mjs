import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passwordPath = path.join(projectRoot, 'license-server', '.local-admin-password.txt');
const screenshotPath = path.join(projectRoot, 'output', 'playwright', 'admin-dashboard.png');
if (!fs.existsSync(passwordPath)) {
  throw new Error('local admin password missing; run npm --prefix license-server run setup:local');
}
fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:8787/admin/');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill(fs.readFileSync(passwordPath, 'utf8').trim());
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#dashboard-view').waitFor({ state: 'visible' });
  await page.locator('#create-form').waitFor({ state: 'visible' });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`admin dashboard UI passed: ${screenshotPath}`);
} finally {
  await browser.close();
}
