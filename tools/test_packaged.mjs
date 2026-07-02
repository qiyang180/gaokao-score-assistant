import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createApp } from '../license-server/src/app.mjs';
import { openDatabase } from '../license-server/src/database.mjs';
import { createLicenseService } from '../license-server/src/license_service.mjs';
import { hashPassword } from '../license-server/src/security.mjs';
import { readLocalSigningMaterial } from './lib/test_license.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = path.join(
  projectRoot,
  'dist-electron',
  'win-unpacked',
  '高考成绩查询助手.exe',
);
const profileDir = path.join(projectRoot, 'output', 'package-license-profile');

if (!fs.existsSync(executablePath)) {
  throw new Error(`packaged executable not found: ${executablePath}`);
}

fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });

const signing = readLocalSigningMaterial();
const db = openDatabase(':memory:');
const serverConfig = {
  keyId: signing.kid,
  keyPepper: 'packaged-test-pepper-that-is-long-enough',
  privateKey: signing.privateKey,
  publicKey: signing.publicKey,
  passphrase: signing.passphrase,
  adminUsername: 'admin',
  adminPasswordHash: hashPassword('packaged-test-password'),
  secureCookies: false,
  trustProxy: false,
};
const licenseService = createLicenseService({ db, config: serverConfig });
const activationCode = licenseService.createCode({
  customer: '安装包自动化测试',
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
}).activationCode;
const licenseApp = createApp({
  db,
  config: serverConfig,
  publicDir: path.join(projectRoot, 'license-server', 'public'),
});
const licenseServer = await new Promise((resolve) => {
  const server = licenseApp.listen(0, '127.0.0.1', () => resolve(server));
});
const licenseUrl = `http://127.0.0.1:${licenseServer.address().port}`;

const queryUrl = pathToFileURL(path.join(projectRoot, 'demo', 'mock_query.html'));
queryUrl.searchParams.set('autoCaptcha', '1');

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${profileDir}`],
  env: {
    ...process.env,
    GAOKAO_LICENSE_API_URL: licenseUrl,
  },
});
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '软件授权' }).waitFor();
  await page.getByLabel('激活码').fill(activationCode);
  await page.getByRole('button', { name: '在线激活' }).click();
  await page.getByRole('heading', { name: '高考成绩查询助手' }).waitFor();
  const defaults = await page.evaluate(() => window.gaokao.getDefaults());
  const closed = page.evaluate(async (options) => {
    return new Promise(async (resolve, reject) => {
      const unsubscribe = window.gaokao.onRunClosed((data) => {
        unsubscribe();
        resolve(data);
      });
      try {
        await window.gaokao.startRun(options);
      } catch (error) {
        unsubscribe();
        reject(error);
      }
    });
  }, {
    studentsFile: path.join(projectRoot, 'demo', 'students.csv'),
    outputRoot: path.join(projectRoot, 'output', 'package-smoke'),
    queryUrl: queryUrl.href,
    configPath: path.join(projectRoot, 'demo', 'config.demo.json'),
    minDelayMs: defaults.minDelayMs,
    maxDelayMs: defaults.maxDelayMs,
    resultTimeoutMs: defaults.resultTimeoutMs,
  });

  const result = await closed;
  const resultLines = fs.readFileSync(result.resultsPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const checks = {
    browserReady: defaults.browserReady,
    completed: result.status === 'completed',
    twoResults: resultLines.length === 2,
    summaryExists: fs.existsSync(result.summaryPath),
    screenshotsExist: fs.existsSync(result.screenshotsDir),
  };
  const failed = Object.entries(checks).filter(([, value]) => !value);
  if (failed.length) {
    throw new Error(`packaged smoke test failed: ${failed.map(([key]) => key).join(', ')}`);
  }
  console.log('packaged smoke test passed: browser, query, screenshots, summary');
} finally {
  await app.close();
  await new Promise((resolve) => licenseServer.close(resolve));
  db.close();
}
