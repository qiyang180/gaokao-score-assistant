import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = path.join(
  projectRoot,
  'dist-electron',
  'win-unpacked',
  '高考成绩查询助手.exe',
);

if (!fs.existsSync(executablePath)) {
  throw new Error(`packaged executable not found: ${executablePath}`);
}

const queryUrl = pathToFileURL(path.join(projectRoot, 'demo', 'mock_query.html'));
queryUrl.searchParams.set('autoCaptcha', '1');

const app = await electron.launch({ executablePath });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('text=高考成绩查询助手');
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
}
