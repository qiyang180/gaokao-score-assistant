import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browsersPath = path.join(projectRoot, 'vendor', 'playwright-browsers');
const playwrightCli = path.join(
  path.dirname(require.resolve('playwright/package.json')),
  'cli.js',
);

fs.mkdirSync(browsersPath, { recursive: true });
if (!fs.existsSync(playwrightCli)) {
  throw new Error(`Playwright CLI not found: ${playwrightCli}`);
}

const child = spawn(process.execPath, [playwrightCli, 'install', 'chromium'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  },
});

const exitCode = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code) => resolve(code ?? 1));
});

if (exitCode !== 0) {
  throw new Error(`Playwright Chromium installation failed with exit code ${exitCode}`);
}

const chromiumDirs = fs.readdirSync(browsersPath)
  .filter((name) => name.startsWith('chromium-'));
if (!chromiumDirs.length) {
  throw new Error(`Chromium was not installed into ${browsersPath}`);
}

console.log(`Playwright Chromium ready: ${browsersPath}`);
