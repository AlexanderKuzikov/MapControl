'use strict';

const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(projectRoot, 'desktop');
const bundleDir = path.join(desktopDir, 'bundle');
const appDir = path.join(bundleDir, 'app');
const nodeDir = path.join(bundleDir, 'bin');
const outputExe = path.join(desktopDir, 'MapControl.exe');
const buildOutputExe = path.join(desktopDir, 'MapControl.build.exe');
const ports = Array.from({ length: 101 }, (_, index) => 5179 + index);
const bundledEnvironmentKeys = [
  'YANDEX_MAPS_API_KEY',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'MAIL_TO',
  'INBOX_TOKEN',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout.trim();
}

function parseBuildOptions(args) {
  const unknown = args.filter((argument) => argument !== '--with-keys');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  return { withKeys: args.includes('--with-keys') };
}

function parseEnvironmentFile(filePath) {
  const dotenv = require(path.join(appDir, 'node_modules', 'dotenv'));
  return dotenv.parse(fs.readFileSync(filePath));
}

function siteInboxEnabled() {
  try {
    const site = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'site.json'), 'utf8'));
    return site && site.inbox && site.inbox.enabled === true;
  } catch {
    return false;
  }
}

function readLiveEnvironment() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) throw new Error('Live .env not found in the project root');
  const parsed = parseEnvironmentFile(envPath);
  let required = bundledEnvironmentKeys;
  if (!siteInboxEnabled()) {
    required = required.filter((key) => key !== 'INBOX_TOKEN');
    console.log('Inbox disabled in config/site.json — INBOX_TOKEN not required (warn only).');
  }
  const missing = required.filter((key) => !parsed[key] || parsed[key].trim() === '');
  if (missing.length > 0) {
    throw new Error(`Live .env is missing required keys: ${missing.join(', ')}`);
  }
  return Object.fromEntries(bundledEnvironmentKeys.map((key) => [key, parsed[key] || '']));
}

function createBundledEnvironment(values) {
  const example = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  const bundledKeys = new Set(bundledEnvironmentKeys);
  const lines = example.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !bundledKeys.has(match[1]);
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push('', ...bundledEnvironmentKeys.map((key) => `${key}=${JSON.stringify(values[key])}`));
  return `${lines.join('\n')}\n`;
}

function writeBundledEnvironment(withKeys) {
  if (!withKeys) return;
  const content = createBundledEnvironment(readLiveEnvironment());
  fs.writeFileSync(path.join(appDir, '.env'), content, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(appDir, '.env.example'), content, { encoding: 'utf8', mode: 0o600 });
  console.log(`Bundled environment: ${bundledEnvironmentKeys.length} whitelist entries (hidden)`);
}

async function fetchResponse(url, timeout = 120000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response;
}

async function installPortableNode() {
  const indexResponse = await fetchResponse('https://nodejs.org/dist/index.json');
  const releases = await indexResponse.json();
  const release = releases.find((item) => item.lts && Array.isArray(item.files) && item.files.includes('win-x64-zip'));
  if (!release) throw new Error('No Windows x64 Node.js LTS release found');

  const archiveName = `node-${release.version}-win-x64.zip`;
  const archiveUrl = `https://nodejs.org/dist/${release.version}/${archiveName}`;
  const checksumsResponse = await fetchResponse(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`);
  const checksums = await checksumsResponse.text();
  const checksumLine = checksums.split(/\r?\n/).find((line) => line.endsWith(` ${archiveName}`));
  if (!checksumLine) throw new Error(`Checksum not found for ${archiveName}`);
  const expectedHash = checksumLine.split(/\s+/)[0].toLowerCase();

  const downloadDir = path.join(bundleDir, '.download');
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  try {
    const archiveResponse = await fetchResponse(archiveUrl, 900000);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const actualHash = createHash('sha256').update(archive).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`SHA256 mismatch for ${archiveName}`);
    }

    const archivePath = path.join(downloadDir, archiveName);
    fs.writeFileSync(archivePath, archive);
    run('tar.exe', ['-xf', archivePath, '-C', downloadDir]);

    const extractedNode = path.join(downloadDir, `node-${release.version}-win-x64`, 'node.exe');
    if (!fs.existsSync(extractedNode)) throw new Error(`node.exe missing after extracting ${archiveName}`);
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.copyFileSync(extractedNode, path.join(nodeDir, 'node.exe'));

    const installedVersion = commandOutput(path.join(nodeDir, 'node.exe'), ['--version']);
    if (installedVersion !== release.version) {
      throw new Error(`Portable Node version mismatch: ${installedVersion} != ${release.version}`);
    }
    console.log(`Portable Node: ${installedVersion}`);
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

function installApplicationDependencies(withKeys) {
  fs.cpSync(path.join(projectRoot, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.cpSync(path.join(projectRoot, 'public'), path.join(appDir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'config', 'site.json'), path.join(appDir, 'config', 'site.json'));
  fs.copyFileSync(path.join(projectRoot, '.env.example'), path.join(appDir, '.env.example'));
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(appDir, 'package.json'));
  fs.copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(appDir, 'package-lock.json'));

  const npmArgs = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
  if (process.platform === 'win32') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error(`npm CLI not found: ${npmCli}`);
    run(process.execPath, [npmCli, ...npmArgs], { cwd: appDir });
  } else {
    run('npm', npmArgs, { cwd: appDir });
  }
  fs.rmSync(path.join(appDir, 'package-lock.json'), { force: true });
  writeBundledEnvironment(withKeys);
}

function writeBundleMetadata(withKeys) {
  const commit = commandOutput('git', ['rev-parse', '--short=12', 'HEAD']);
  if (!/^[a-f0-9]+$/i.test(commit)) throw new Error(`Unexpected git commit hash: ${commit}`);
  const timestamp = new Date().toISOString().replace(/[^0-9TZ]/g, '');
  const worktreeState = commandOutput('git', ['status', '--porcelain', '--untracked-files=all']) ? '-dirty' : '';
  const keyMarker = withKeys ? '-keys' : '';
  const version = `${commit}${worktreeState}-${timestamp}${keyMarker}`;
  fs.writeFileSync(path.join(bundleDir, 'version.txt'), `${version}\n`, 'utf8');

  const setupSteps = withKeys
    ? '2. При первом запуске MapControl создаст папку %APPDATA%\\MapControl и готовые настройки в .env.\r\n3. Существующий .env не перезаписывается, поэтому следующие сборки не заменят настройки оператора.'
    : '2. При первом запуске MapControl создаст папку %APPDATA%\\MapControl и скопирует туда пример настроек из файла .env.\r\n3. Впишите ключи и адреса в %APPDATA%\\MapControl\\.env, сохраните файл и запустите MapControl снова.';
  const operatorReadme = `# MapControl\r\n\r\n1. Сохраните MapControl.exe в любую папку и запустите двойным щелчком.\r\n${setupSteps}\r\n4. Все заявки и фотографии хранятся в %APPDATA%\\MapControl\\data\\submissions. Не удаляйте эту папку при переносе данных оператора.\r\n5. Эта копия инструкции также находится в %APPDATA%\\MapControl\\ПРОЧТИ.txt.\r\n\r\nWindows может показать предупреждение SmartScreen, потому что новый файл MapControl.exe не имеет цифровой подписи. Нажмите «Подробнее» и выберите «Выполнить в любом случае» только если файл получен из доверенного источника и размер совпадает с указанным сборщиком.\r\n\r\nЕсли Defender неожиданно блокирует MapControl.exe, не отключайте защиту Windows. Отправьте файл на проверку Microsoft через страницу Microsoft Defender: сведения о файле, который мог быть заблокирован.\r\n`;
  fs.writeFileSync(path.join(bundleDir, 'ПРОЧТИ.txt'), operatorReadme, 'utf8');
  return version;
}

function buildExecutable(outputPath) {
  run('go', ['build', '-ldflags=-s -w -H windowsgui', '-o', outputPath, '.'], { cwd: desktopDir });
  const size = fs.statSync(outputPath).size;
  const sizeMib = size / (1024 * 1024);
  console.log(`MapControl.exe: ${sizeMib.toFixed(2)} MiB`);
  if (size > 150 * 1024 * 1024) {
    throw new Error(`MapControl.exe is ${sizeMib.toFixed(2)} MiB; stop and ask the dispatcher`);
  }
  return size;
}

async function readConfig(port) {
  try {
    const response = await fetch(`http://localhost:${port}/api/config`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.yandexMaps !== undefined ? data : null;
  } catch {
    return null;
  }
}

async function findRunningInstance() {
  for (const port of ports) {
    if (await readConfig(port)) return port;
  }
  return null;
}

async function assertNoRunningInstance() {
  const port = await findRunningInstance();
  if (port !== null) throw new Error(`MapControl is already running on port ${port}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForInstance(child, getSpawnError) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (processExited(child)) throw new Error(`MapControl.exe exited with code ${child.exitCode}`);
    for (const port of ports) {
      if (await readConfig(port)) return port;
    }
    await delay(200);
  }
  throw new Error('MapControl did not become ready in 45 seconds');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

async function waitForFile(filePath, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await delay(100);
  }
  throw new Error(`File was not created: ${filePath}`);
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateTree(child) {
  if (!child.pid || processExited(child)) return;
  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5000),
  ]);
  if (processExited(child)) return;
  if (result.status !== 0) {
    throw new Error(`taskkill.exe failed with exit code ${result.status}`);
  }
  throw new Error(`MapControl.exe process ${child.pid} did not terminate`);
}

async function stopInstance(child, port) {
  try {
    await requestJson(`http://localhost:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` },
      body: '{}',
    });
  } catch {
  }
  await delay(250);
  await terminateTree(child);
}

async function smokeTest(executablePath, withKeys) {
  if (process.platform !== 'win32') throw new Error('The desktop executable can only be smoke-tested on Windows');
  await assertNoRunningInstance();

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mapcontrol-dist-smoke-'));
  const runDir = path.join(smokeRoot, 'run');
  const userDir = path.join(smokeRoot, 'user');
  fs.mkdirSync(runDir);
  fs.mkdirSync(userDir);
  const smokeExe = path.join(runDir, 'MapControl.exe');
  fs.copyFileSync(executablePath, smokeExe);

  const smokeEnvironment = { ...process.env, MC_USER_DIR: userDir };
  const isolatedKeys = new Set(bundledEnvironmentKeys.map((key) => key.toUpperCase()));
  for (const key of Object.keys(smokeEnvironment)) {
    if (key.toLowerCase() === 'path' || isolatedKeys.has(key.toUpperCase())) {
      delete smokeEnvironment[key];
    }
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  smokeEnvironment.Path = path.join(systemRoot, 'System32');

  const child = spawn(smokeExe, [], {
    cwd: runDir,
    env: smokeEnvironment,
    stdio: 'ignore',
    windowsHide: false,
  });
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  let activePort = null;
  try {
    activePort = await waitForInstance(child, () => spawnError);
    const draft = await requestJson(`http://localhost:${activePort}/api/submissions/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!draft || typeof draft.submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(draft.submissionId)) {
      throw new Error('Draft endpoint returned an invalid submission id');
    }

    const draftRoot = path.join(userDir, 'data', 'submissions', 'draft', draft.submissionId);
    await waitForFile(path.join(draftRoot, 'meta.json'));

    const form = new FormData();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    form.append('images', new Blob([image], { type: 'image/png' }), 'smoke.png');
    const upload = await requestJson(`http://localhost:${activePort}/api/submissions/draft/${draft.submissionId}/images`, {
      method: 'POST',
      body: form,
    });
    if (!upload || !Array.isArray(upload.images) || upload.images.length !== 1 || upload.images[0].filename !== 'upload_01.webp') {
      throw new Error('Image upload did not produce the expected WebP');
    }
    await waitForFile(path.join(draftRoot, 'images', 'upload_01.webp'));

    const userEnvPath = path.join(userDir, '.env');
    const exampleEnvPath = path.join(appDir, '.env.example');
    const bundledEnvPath = path.join(appDir, '.env');
    if (!fs.existsSync(userEnvPath)) throw new Error('User .env was not created');
    if (!fs.existsSync(path.join(userDir, 'ПРОЧТИ.txt'))) throw new Error('Operator ПРОЧТИ.txt was not created');

    if (withKeys) {
      if (!fs.existsSync(bundledEnvPath)) throw new Error('Bundled .env was not created');
      if (!fs.readFileSync(exampleEnvPath).equals(fs.readFileSync(bundledEnvPath))) {
        throw new Error('Bundled .env.example does not match the ready .env');
      }
      const actual = parseEnvironmentFile(userEnvPath);
      const expected = readLiveEnvironment();
      const mismatched = bundledEnvironmentKeys.filter((key) => actual[key] !== expected[key]);
      if (mismatched.length > 0) {
        throw new Error(`User .env does not match bundled values: ${mismatched.join(', ')}`);
      }
      let response;
      try {
        response = await fetch(`https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(actual.YANDEX_MAPS_API_KEY)}&lang=ru_RU`, {
          headers: { Referer: `http://localhost:${activePort}/` },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new Error('Yandex Maps key validation request failed');
      }
      if (response.status !== 200) {
        throw new Error(`Yandex Maps key validation returned HTTP ${response.status}`);
      }
      await response.text();
      console.log('Smoke test: /api/config, draft, WebP upload, 12/12 exact env entries, Yandex Maps 200 — OK');
    } else {
      if (fs.existsSync(bundledEnvPath)) throw new Error('Default bundle unexpectedly contains .env');
      if (!fs.readFileSync(userEnvPath).equals(fs.readFileSync(exampleEnvPath))) {
        throw new Error('Default user .env does not match .env.example');
      }
      console.log('Smoke test: /api/config, draft, WebP upload, example-only user .env — OK');
    }
  } finally {
    try {
      const cleanupPort = activePort !== null ? activePort : await findRunningInstance();
      if (cleanupPort !== null) await stopInstance(child, cleanupPort);
      else await terminateTree(child);
      const remainingPort = await findRunningInstance();
      if (remainingPort !== null) {
        throw new Error(`Port ${remainingPort} is still serving after smoke-test cleanup`);
      }
    } finally {
      fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

async function main(args = process.argv.slice(2)) {
  const { withKeys } = parseBuildOptions(args);
  fs.rmSync(outputExe, { force: true });
  fs.rmSync(buildOutputExe, { force: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, '.gitkeep'), '');

  fs.mkdirSync(appDir, { recursive: true });
  await installPortableNode();
  installApplicationDependencies(withKeys);
  const version = writeBundleMetadata(withKeys);
  buildExecutable(buildOutputExe);
  await smokeTest(buildOutputExe, withKeys);
  fs.renameSync(buildOutputExe, outputExe);
  console.log(`Distribution ready: ${outputExe} (${version})`);
}

main().catch((error) => {
  fs.rmSync(buildOutputExe, { force: true });
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
