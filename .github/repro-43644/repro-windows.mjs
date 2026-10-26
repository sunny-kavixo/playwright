import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const playwrightRoot = process.env.PLAYWRIGHT_CORE_ROOT;
const executablePath = process.env.FIREFOX_PATH;
const trials = Number(process.env.TRIALS || 1);
const pressureThreads = Number(process.env.PRESSURE_THREADS || 0);
const profileRoot = process.env.PROFILE_ROOT || await fs.mkdtemp(path.join(os.tmpdir(), 'pw43644-'));
const resultsPath = process.env.RESULTS_PATH;
const timeoutMs = Number(process.env.TRIAL_TIMEOUT_MS || 30_000);
const firefoxChannel = 'moz-firefox';

if (!playwrightRoot)
  throw new Error('PLAYWRIGHT_CORE_ROOT is required');
if (!executablePath)
  throw new Error('FIREFOX_PATH is required');
if (!resultsPath)
  throw new Error('RESULTS_PATH is required');

const playwrightPackage = JSON.parse(await fs.readFile(path.join(playwrightRoot, 'package.json'), 'utf8'));
const playwrightModule = await import(pathToFileURL(path.join(playwrightRoot, 'index.js')).href);
const playwright = playwrightModule.default ?? playwrightModule;
const firefox = playwright.firefox;
const workers = [];

await fs.mkdir(path.dirname(resultsPath), { recursive: true });
await fs.mkdir(profileRoot, { recursive: true });

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code: 'TIMEOUT' })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function append(record) {
  await fs.appendFile(resultsPath, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (!firefox || typeof firefox.launch !== 'function' || typeof firefox.launchPersistentContext !== 'function')
  throw new Error('playwright-core preflight failed: expected firefox.launch and firefox.launchPersistentContext');

await append({
  type: 'preflight',
  playwrightVersion: playwrightPackage.version,
  launcher: 'firefox',
  launch: 'function',
  launchPersistentContext: 'function',
  channel: firefoxChannel,
  backend: 'webdriver-bidi',
});

async function launch(profile) {
  return firefox.launchPersistentContext(profile, {
    channel: firefoxChannel,
    executablePath,
    headless: true,
    timeout: timeoutMs,
  });
}

function classifyError(error, stage) {
  if (error?.code === 'TIMEOUT')
    return 'timeout-failure';
  if (stage.includes('launch'))
    return 'browser-launch-failure';
  return 'infrastructure-failure';
}

for (let i = 0; i < pressureThreads; i++)
  workers.push(new Worker('while (true) {}', { eval: true }));

try {
  for (let trial = 1; trial <= trials; trial++) {
    const profile = path.join(profileRoot, `profile-${trial}`);
    const expected = `persistent-${trial}`;
    let context;
    let stage = 'warm-launch';
    let first;
    let second;
    const record = {
      type: 'trial',
      trial,
      expected,
      first: null,
      second: null,
      status: 'infrastructure-failure',
      stage,
      pressureThreads,
      playwrightVersion: playwrightPackage.version,
      node: process.version,
      platform: `${process.platform} ${process.arch} ${os.release()}`,
    };

    try {
      const warm = await withTimeout(launch(profile), 'warm browser launch');
      await withTimeout(warm.close(), 'warm browser close');

      stage = 'second-launch';
      context = await withTimeout(launch(profile), 'second browser launch');
      const page = context.pages()[0] || await withTimeout(context.newPage(), 'new page');

      stage = 'navigation';
      const navigationStart = performance.now();
      await withTimeout(page.goto(`data:text/html,<title>${expected}</title>`), 'navigation');
      record.gotoMs = performance.now() - navigationStart;

      stage = 'first-title';
      const firstStart = performance.now();
      first = await withTimeout(page.title(), 'first page.title');
      record.firstTitleMs = performance.now() - firstStart;

      stage = 'second-title';
      const secondStart = performance.now();
      second = await withTimeout(page.title(), 'second page.title');
      record.secondTitleMs = performance.now() - secondStart;

      record.first = first;
      record.second = second;
      record.status = first === expected && second === expected ? 'passed' : 'title-failure';
      record.stage = stage;
    } catch (error) {
      record.status = classifyError(error, stage);
      record.stage = stage;
      record.error = String(error?.stack || error);
      record.first = first ?? null;
      record.second = second ?? null;
    } finally {
      if (context) {
        try {
          await withTimeout(context.close(), 'context close');
        } catch (error) {
          record.closeError = String(error?.stack || error);
          if (record.status === 'passed')
            record.status = 'infrastructure-failure';
        }
      }
    }

    await append(record);
  }
} finally {
  await Promise.all(workers.map(worker => worker.terminate()));
}

const lines = (await fs.readFile(resultsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const trialRecords = lines.filter(record => record.type === 'trial');
const summary = {
  type: 'summary',
  playwrightVersion: playwrightPackage.version,
  node: process.version,
  platform: `${process.platform} ${process.arch} ${os.release()}`,
  cpuCount: os.cpus().length,
  pressureThreads,
  trials: trialRecords.length,
  passed: trialRecords.filter(record => record.status === 'passed').length,
  titleFailures: trialRecords.filter(record => record.status === 'title-failure').length,
  browserLaunchFailures: trialRecords.filter(record => record.status === 'browser-launch-failure').length,
  timeoutFailures: trialRecords.filter(record => record.status === 'timeout-failure').length,
  infrastructureFailures: trialRecords.filter(record => record.status === 'infrastructure-failure').length,
  firstTitleEmpty: trialRecords.filter(record => record.first === '').length,
  secondTitleExpected: trialRecords.filter(record => record.second === record.expected).length,
  profileRoot,
};
await append(summary);

if (summary.browserLaunchFailures > 0)
  process.exitCode = 1;
