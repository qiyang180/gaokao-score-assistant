import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const devServerUrl = 'http://127.0.0.1:5173';

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) {
      return;
    }
    await delay(300);
  }
  throw new Error(`Vite dev server did not start within ${timeoutMs}ms`);
}

const vite = run('npm', ['run', 'app:vite', '--', '--host', '127.0.0.1']);
await waitForServer(devServerUrl);

const electron = run('electron', ['.'], {
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
