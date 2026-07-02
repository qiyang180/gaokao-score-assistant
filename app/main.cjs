const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LicenseManager } = require('./licensing/manager.cjs');

const EVENT_PREFIX = '@@GAOKAO_EVENT@@ ';
const projectRoot = app.getAppPath();

let mainWindow = null;
let currentRun = null;
let licenseManager = null;
let licenseManagerError = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    title: '高考成绩查询助手',
    webPreferences: {
      preload: path.join(projectRoot, 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(projectRoot, 'dist', 'renderer', 'index.html'));
  }
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function nowStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  if (text.length <= 4) {
    return '*'.repeat(text.length);
  }
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim())) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) {
      rows.push(row);
    }
  }
  return rows;
}

function readStudentsCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return [];
  }
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((row, index) => {
    const record = {};
    headers.forEach((header, headerIndex) => {
      record[header] = (row[headerIndex] || '').trim();
    });
    return {
      index: index + 1,
      className: record['班级'] || '',
      name: record['姓名'] || '',
      idCardMasked: maskSecret(record['身份证号']),
      admissionNoMasked: maskSecret(record['准考证号']),
      examineeNoMasked: maskSecret(record['考生号']),
      registrationNoMasked: maskSecret(record['报名序号']),
      status: 'pending',
    };
  });
}

function runBuffered(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: app.isPackaged ? process.resourcesPath : projectRoot,
      windowsHide: true,
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

function bundledPath(...segments) {
  return path.join(projectRoot, ...segments);
}

function electronNodeOptions(options = {}) {
  const env = {
    ...process.env,
    ...(options.env || {}),
    ELECTRON_RUN_AS_NODE: '1',
  };
  const browsersPath = runtimeBrowsersPath();
  if (browsersPath) {
    env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }
  return {
    ...options,
    env,
  };
}

function runNodeBuffered(args, options = {}) {
  return runBuffered(process.execPath, args, electronNodeOptions(options));
}

function appendRunLog(run, stream, text) {
  if (!run?.logPath || !text) {
    return;
  }
  fs.appendFileSync(run.logPath, `[${stream}] ${text}`, 'utf8');
}

function appendEvent(run, type, payload = {}) {
  const event = {
    type,
    at: new Date().toISOString(),
    ...payload,
  };
  if (run?.eventsPath) {
    fs.appendFileSync(run.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }
  send('gaokao:run-event', event);
}

function handleProcessLine(run, stream, rawLine) {
  const line = rawLine.replace(/\r$/, '');
  if (!line.trim()) {
    return;
  }
  if (line.startsWith(EVENT_PREFIX)) {
    try {
      const event = JSON.parse(line.slice(EVENT_PREFIX.length));
      if (event.type === 'student:start' || event.type === 'student:retrying') {
        run.studentActive = true;
      } else if (event.type === 'student:ok' || event.type === 'student:failed') {
        run.studentActive = false;
      }
      send('gaokao:run-event', event);
    } catch {
      send('gaokao:log', { stream, text: line });
    }
    return;
  }
  send('gaokao:log', { stream, text: line });
}

function handleProcessOutput(run, stream, chunk) {
  const text = chunk.toString();
  appendRunLog(run, stream, text);
  run.outputBuffers[stream] += text;
  const lines = run.outputBuffers[stream].split('\n');
  run.outputBuffers[stream] = lines.pop() || '';
  for (const line of lines) {
    handleProcessLine(run, stream, line);
  }
}

function flushProcessOutput(run, stream) {
  const remaining = run.outputBuffers[stream];
  run.outputBuffers[stream] = '';
  if (remaining) {
    handleProcessLine(run, stream, remaining);
  }
}

function resolveConfigPath(preferredPath = '') {
  const candidates = [
    preferredPath,
    path.join(app.getPath('userData'), 'config.local.json'),
    path.join(projectRoot, 'config.local.json'),
    path.join(projectRoot, 'config.example.json'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function getLicenseManager() {
  if (licenseManagerError) {
    throw licenseManagerError;
  }
  if (!licenseManager) {
    throw new Error('授权模块尚未初始化');
  }
  return licenseManager;
}

function resolveLicenseApiUrl() {
  if (process.env.GAOKAO_LICENSE_API_URL) {
    return process.env.GAOKAO_LICENSE_API_URL;
  }
  const buildConfig = readJson(bundledPath('dist', 'license-config.json'));
  if (buildConfig.licenseServerUrl) {
    return buildConfig.licenseServerUrl;
  }
  const config = readJson(resolveConfigPath());
  return config.licenseServerUrl || 'http://127.0.0.1:8787';
}

function defaultOutputRoot() {
  if (app.isPackaged) {
    return path.join(app.getPath('documents'), '高考成绩查询助手', '运行结果');
  }
  return path.join(projectRoot, 'output', 'gui-runs');
}

function runtimeBrowsersPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'playwright-browsers');
  }
  const projectBrowsers = path.join(projectRoot, 'vendor', 'playwright-browsers');
  if (fs.existsSync(projectBrowsers)) {
    return projectBrowsers;
  }
  return process.env.PLAYWRIGHT_BROWSERS_PATH || '';
}

function hasChromium(browsersPath) {
  if (!browsersPath || !fs.existsSync(browsersPath)) {
    return false;
  }
  return fs.readdirSync(browsersPath, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'));
}

async function buildSummary(run, finalStatus = 'completed') {
  send('gaokao:log', { stream: 'system', text: '正在生成 Excel 汇总表...' });
  await runNodeBuffered([
    bundledPath('tools', 'build_summary.mjs'),
    '--results',
    run.resultsPath,
    '--students',
    run.studentsCsv,
    '--out',
    run.summaryPath,
  ]);
  appendEvent(run, 'summary:done', { path: run.summaryPath });
  send('gaokao:run-closed', {
    status: finalStatus,
    runDir: run.runDir,
    summaryPath: run.summaryPath,
    resultsPath: run.resultsPath,
    eventsPath: run.eventsPath,
    screenshotsDir: run.screenshotsDir,
    failedLogPath: run.failedLogPath,
    logPath: run.logPath,
  });
}

function writeControl(command) {
  if (!currentRun?.controlFile) {
    return;
  }
  fs.writeFileSync(
    currentRun.controlFile,
    JSON.stringify({ command, updatedAt: new Date().toISOString() }),
    'utf8',
  );
}

ipcMain.handle('gaokao:get-defaults', async () => {
  const configPath = resolveConfigPath();
  const config = readJson(configPath);
  const browsersPath = runtimeBrowsersPath();
  return {
    projectRoot,
    configPath,
    queryUrl: config.queryUrl || '',
    outputRoot: defaultOutputRoot(),
    browserReady: app.isPackaged ? hasChromium(browsersPath) : true,
    minDelayMs: Number(config.minDelayMs ?? 1000),
    maxDelayMs: Number(config.maxDelayMs ?? 2000),
    resultTimeoutMs: Number(config.resultTimeoutMs ?? 10000),
  };
});

ipcMain.handle('gaokao:get-license-state', async () => {
  return getLicenseManager().inspect({ refreshIfNeeded: true });
});

ipcMain.handle('gaokao:activate-license', async (_event, { activationCode }) => {
  return getLicenseManager().activate(activationCode);
});

ipcMain.handle('gaokao:refresh-license', async () => {
  return getLicenseManager().refresh();
});

ipcMain.handle('gaokao:export-offline-request', async () => {
  const manager = getLicenseManager();
  const request = manager.createOfflineRequest();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出离线授权申请',
    defaultPath: path.join(
      app.getPath('documents'),
      `高考查询授权-${request.deviceCode}.gkreq`,
    ),
    filters: [{ name: '离线授权申请', extensions: ['gkreq'] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  fs.writeFileSync(result.filePath, JSON.stringify(request, null, 2), 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('gaokao:import-offline-license', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入离线许可证',
    properties: ['openFile'],
    filters: [{ name: '离线许可证', extensions: ['gklic'] }],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  const content = fs.readFileSync(result.filePaths[0], 'utf8');
  const state = await getLicenseManager().importOfflineLicense(content);
  return { canceled: false, state };
});

ipcMain.handle('gaokao:select-students', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择学生 Excel/CSV',
    properties: ['openFile'],
    filters: [
      { name: '学生表', extensions: ['xlsx', 'csv'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('gaokao:select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('gaokao:preview-students', async (_event, { studentsFile }) => {
  await getLicenseManager().assertUsable();
  if (!studentsFile || !fs.existsSync(studentsFile)) {
    throw new Error('学生表不存在');
  }
  const previewDir = path.join(app.getPath('userData'), 'work');
  const previewCsv = path.join(previewDir, 'gui_preview_students.csv');
  const previewReport = path.join(previewDir, 'gui_preview_report.json');
  await runNodeBuffered([
    bundledPath('tools', 'normalize_students.mjs'),
    '--input',
    studentsFile,
    '--out',
    previewCsv,
    '--report',
    previewReport,
    '--preview',
  ]);
  const students = readStudentsCsv(previewCsv);
  const report = readJson(previewReport, {
    stats: { total: students.length, valid: students.length, invalid: 0 },
    errors: [],
  });
  return {
    csvPath: previewCsv,
    students,
    stats: report.stats,
    errors: report.errors || [],
  };
});

ipcMain.handle('gaokao:start-run', async (_event, options) => {
  const license = await getLicenseManager().assertUsable();
  if (currentRun?.queryProcess) {
    throw new Error('已有查询任务正在运行');
  }
  if (!options.studentsFile || !fs.existsSync(options.studentsFile)) {
    throw new Error('请先选择有效学生表');
  }
  if (app.isPackaged && !hasChromium(runtimeBrowsersPath())) {
    throw new Error('安装包缺少 Playwright Chromium，请重新安装完整版本');
  }

  const outputRoot = options.outputRoot || path.join(projectRoot, 'output', 'gui-runs');
  const runDir = path.join(outputRoot, `run-${nowStamp()}`);
  const studentsCsv = path.join(runDir, 'students.csv');
  const resultsPath = path.join(runDir, 'results.jsonl');
  const eventsPath = path.join(runDir, 'events.jsonl');
  const failedLogPath = path.join(runDir, 'failed_students.csv');
  const controlFile = path.join(runDir, 'control.json');
  const summaryPath = path.join(runDir, 'score_summary.xlsx');
  const screenshotsDir = path.join(runDir, 'screenshots');
  const logPath = path.join(runDir, 'run.log');
  const importReportPath = path.join(runDir, 'import_report.json');

  ensureDir(runDir);
  ensureDir(screenshotsDir);
  fs.writeFileSync(logPath, '', 'utf8');

  await runNodeBuffered([
    bundledPath('tools', 'normalize_students.mjs'),
    '--input',
    options.studentsFile,
    '--out',
    studentsCsv,
    '--report',
    importReportPath,
  ]);

  const configPath = resolveConfigPath(options.configPath);
  if (!configPath) {
    throw new Error('未找到可用配置文件');
  }
  const minDelayMs = Number(options.minDelayMs);
  const maxDelayMs = Number(options.maxDelayMs);
  const resultTimeoutMs = Number(options.resultTimeoutMs);
  if (
    !Number.isFinite(minDelayMs)
    || !Number.isFinite(maxDelayMs)
    || !Number.isFinite(resultTimeoutMs)
    || minDelayMs < 0
    || maxDelayMs < minDelayMs
    || resultTimeoutMs < 1000
  ) {
    throw new Error('查询间隔或结果等待时间设置无效');
  }

  const args = [
    bundledPath('src', 'query_scores.mjs'),
    '--students',
    studentsCsv,
    '--config',
    configPath,
    '--output-dir',
    runDir,
    '--results',
    resultsPath,
    '--events',
    eventsPath,
    '--failed-log',
    failedLogPath,
    '--control-file',
    controlFile,
    '--min-delay-ms',
    String(minDelayMs),
    '--max-delay-ms',
    String(maxDelayMs),
    '--result-timeout-ms',
    String(resultTimeoutMs),
    '--reset-results',
  ];
  if (options.queryUrl) {
    args.push('--url', options.queryUrl);
  }

  const run = {
    runDir,
    studentsCsv,
    resultsPath,
    eventsPath,
    failedLogPath,
    controlFile,
    summaryPath,
    screenshotsDir,
    logPath,
    queryProcess: null,
    stoppedByUser: false,
    studentActive: false,
    outputBuffers: {
      stdout: '',
      stderr: '',
    },
  };
  currentRun = run;
  writeControl('resume');

  const child = spawn(process.execPath, args, electronNodeOptions({
    cwd: app.isPackaged ? process.resourcesPath : projectRoot,
    windowsHide: false,
    env: {
      GAOKAO_LICENSE_TOKEN: license.token,
    },
  }));
  run.queryProcess = child;
  send('gaokao:run-started', {
    runDir,
    resultsPath,
    eventsPath,
    failedLogPath,
    summaryPath,
    screenshotsDir,
    logPath,
  });
  child.stdout.on('data', (chunk) => handleProcessOutput(run, 'stdout', chunk));
  child.stderr.on('data', (chunk) => handleProcessOutput(run, 'stderr', chunk));
  child.on('error', (error) => {
    send('gaokao:run-closed', { status: 'failed', error: error.message, runDir });
    currentRun = null;
  });
  child.on('close', async (code) => {
    flushProcessOutput(run, 'stdout');
    flushProcessOutput(run, 'stderr');
    run.queryProcess = null;
    run.studentActive = false;
    if (run.stoppedByUser) {
      if (fs.existsSync(resultsPath) && fs.statSync(resultsPath).size > 0) {
        try {
          await buildSummary(run, 'stopped');
        } catch (error) {
          send('gaokao:run-closed', { status: 'stopped', error: error.message, runDir, resultsPath, eventsPath, failedLogPath, logPath });
        }
      } else {
        send('gaokao:run-closed', { status: 'stopped', runDir, resultsPath, eventsPath, failedLogPath, logPath });
      }
      currentRun = null;
      return;
    }
    if (code !== 0) {
      send('gaokao:run-closed', { status: 'failed', error: `查询进程退出码 ${code}`, runDir, logPath });
      currentRun = null;
      return;
    }
    try {
      await buildSummary(run);
    } catch (error) {
      send('gaokao:run-closed', { status: 'failed', error: error.message, runDir, logPath });
    } finally {
      currentRun = null;
    }
  });

  return { ok: true, runDir };
});

ipcMain.handle('gaokao:control', async (_event, { command }) => {
  if (!['pause', 'resume', 'skip', 'retry', 'stop'].includes(command)) {
    throw new Error(`不支持的控制命令：${command}`);
  }
  if (!currentRun) {
    return { ok: false, message: '当前没有运行中的任务' };
  }
  if ((command === 'skip' || command === 'retry') && !currentRun.studentActive) {
    return { ok: false, message: '当前没有可跳过或重试的学生' };
  }
  if (command === 'stop') {
    currentRun.stoppedByUser = true;
  }
  writeControl(command);
  if (command === 'stop' && currentRun.queryProcess) {
    setTimeout(() => {
      if (currentRun?.queryProcess) {
        currentRun.queryProcess.kill();
      }
    }, 1500);
  }
  return { ok: true };
});

ipcMain.handle('gaokao:open-path', async (_event, targetPath) => {
  if (!targetPath) {
    return 'empty path';
  }
  return shell.openPath(targetPath);
});

app.whenReady().then(() => {
  try {
    licenseManager = new LicenseManager({
      app,
      safeStorage,
      apiUrl: resolveLicenseApiUrl(),
      appVersion: app.getVersion(),
    });
  } catch (error) {
    licenseManagerError = error;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (currentRun?.queryProcess) {
    writeControl('stop');
    currentRun.queryProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
