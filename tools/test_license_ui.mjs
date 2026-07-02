import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = path.join(projectRoot, 'output', 'license-ui-profile');
const screenshotDir = path.join(projectRoot, 'output', 'playwright');
const adminPassword = fs.readFileSync(
  path.join(projectRoot, 'license-server', '.local-admin-password.txt'),
  'utf8',
).trim();
const baseUrl = 'http://127.0.0.1:8787';

fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

async function createActivationCode() {
  const loginResponse = await fetch(`${baseUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  if (!loginResponse.ok) {
    throw new Error(`admin login failed: ${loginResponse.status}`);
  }
  const login = await loginResponse.json();
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const createResponse = await fetch(`${baseUrl}/admin/api/codes`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': login.csrfToken,
    },
    body: JSON.stringify({
      customer: 'Electron 自动化测试',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`create activation code failed: ${createResponse.status}`);
  }
  return (await createResponse.json()).activationCode;
}

async function launchApp() {
  return electron.launch({
    args: ['.', `--user-data-dir=${profileDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      GAOKAO_LICENSE_API_URL: baseUrl,
    },
  });
}

const activationCode = await createActivationCode();
let app = await launchApp();
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '软件授权' }).waitFor();
  const blocked = await page.evaluate(async (studentsFile) => {
    try {
      await window.gaokao.previewStudents({ studentsFile });
      return false;
    } catch {
      return true;
    }
  }, path.join(projectRoot, 'demo', 'students.csv'));
  if (!blocked) {
    throw new Error('previewStudents was not blocked before activation');
  }
  await page.screenshot({
    path: path.join(screenshotDir, 'electron-license-required.png'),
  });
  await page.getByLabel('激活码').fill(activationCode);
  await page.getByRole('button', { name: '在线激活' }).click();
  await page.getByRole('heading', { name: '高考成绩查询助手' }).waitFor();
  await page.screenshot({
    path: path.join(screenshotDir, 'electron-license-activated.png'),
  });
} finally {
  await app.close();
}

app = await launchApp();
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '高考成绩查询助手' }).waitFor();
  const state = await page.evaluate(() => window.gaokao.getLicenseState());
  if (!state.usable || state.customer !== 'Electron 自动化测试') {
    throw new Error(`persisted license invalid: ${JSON.stringify(state)}`);
  }
  console.log('Electron license UI passed: blocked, activated, and persisted');
} finally {
  await app.close();
}
