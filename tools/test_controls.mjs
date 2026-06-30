import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'output', 'control-tests');
const eventPrefix = '@@GAOKAO_EVENT@@ ';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function resetScenarioDir(name) {
  const scenarioDir = path.resolve(outputRoot, name);
  assert(
    scenarioDir.startsWith(`${path.resolve(outputRoot)}${path.sep}`),
    `unsafe control-test output path: ${scenarioDir}`,
  );
  fs.rmSync(scenarioDir, { recursive: true, force: true });
  fs.mkdirSync(scenarioDir, { recursive: true });
  return scenarioDir;
}

function writeControl(controlFile, command) {
  fs.writeFileSync(
    controlFile,
    JSON.stringify({ command, updatedAt: new Date().toISOString() }),
    'utf8',
  );
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function runScenario(name, onEvent) {
  const scenarioDir = resetScenarioDir(name);
  const controlFile = path.join(scenarioDir, 'control.json');
  const resultsFile = path.join(scenarioDir, 'results.jsonl');
  const eventsFile = path.join(scenarioDir, 'events.jsonl');
  const failedFile = path.join(scenarioDir, 'failed_students.csv');
  const demoUrl = pathToFileURL(path.join(projectRoot, 'demo', 'mock_query.html'));
  demoUrl.searchParams.set('autoCaptcha', '1');

  const child = spawn(process.execPath, [
    'src/query_scores.mjs',
    '--students',
    'demo/students.csv',
    '--config',
    'demo/config.demo.json',
    '--output-dir',
    scenarioDir,
    '--results',
    resultsFile,
    '--events',
    eventsFile,
    '--failed-log',
    failedFile,
    '--control-file',
    controlFile,
    '--url',
    demoUrl.href,
    '--reset-results',
  ], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const events = [];
  let stderr = '';
  let actionError = null;
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.startsWith(eventPrefix)) {
      return;
    }
    const event = JSON.parse(line.slice(eventPrefix.length));
    events.push(event);
    if (!actionError) {
      try {
        onEvent(event, { controlFile, writeControl });
      } catch (error) {
        actionError = error;
        child.kill();
      }
    }
  });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} timed out`));
    }, 45000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  lines.close();

  if (actionError) {
    throw actionError;
  }
  assert(exitCode === 0, `${name} exited with ${exitCode}: ${stderr.trim()}`);
  return {
    events,
    results: readJsonl(resultsFile),
  };
}

async function testPauseRetrySkip() {
  let firstStartCount = 0;
  let pauseRequested = false;
  let retryRequested = false;
  let skipRequested = false;

  const outcome = await runScenario('pause-retry-skip', (event, control) => {
    if (event.type === 'student:start' && event.index === 1) {
      firstStartCount += 1;
      if (!pauseRequested) {
        pauseRequested = true;
        control.writeControl(control.controlFile, 'pause');
      }
    } else if (event.type === 'run:paused') {
      control.writeControl(control.controlFile, 'resume');
    } else if (event.type === 'run:resumed' && !retryRequested) {
      retryRequested = true;
      control.writeControl(control.controlFile, 'retry');
    } else if (event.type === 'student:start' && event.index === 2 && !skipRequested) {
      skipRequested = true;
      control.writeControl(control.controlFile, 'skip');
    }
  });

  assert(outcome.events.some((event) => event.type === 'run:paused'), 'pause event missing');
  assert(outcome.events.some((event) => event.type === 'run:resumed'), 'resume event missing');
  assert(outcome.events.some((event) => event.type === 'student:retrying'), 'retry event missing');
  assert(firstStartCount === 2, `expected student 1 to start twice, got ${firstStartCount}`);
  assert(outcome.results.length === 2, `expected 2 results, got ${outcome.results.length}`);
  assert(outcome.results[0].status === 'ok', `student 1 status: ${outcome.results[0].status}`);
  assert(outcome.results[1].status === 'skipped', `student 2 status: ${outcome.results[1].status}`);
}

async function testStop() {
  let stopRequested = false;
  const outcome = await runScenario('stop', (event, control) => {
    if (event.type === 'student:start' && !stopRequested) {
      stopRequested = true;
      control.writeControl(control.controlFile, 'stop');
    }
  });

  assert(outcome.events.some((event) => event.type === 'run:stopped'), 'stop event missing');
  assert(outcome.results.length === 0, `stop scenario wrote ${outcome.results.length} results`);
}

await testPauseRetrySkip();
await testStop();
console.log('control tests passed: pause, resume, retry, skip, stop');
