const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');
const net = require('net');
const fs = require('fs');

const BASE_PORT = 5179;
const MAX_PORT = 5279;
const HOST = 'localhost';
const SERVER_PATH = path.join(__dirname, 'src', 'server.js');
const PID_FILE = path.join(__dirname, 'server.pid');
const LOG_DIR = path.join(__dirname, 'logs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openBrowser(url) {
  exec(`start "" "${url}"`, { windowsHide: true });
}

function httpGet(url, timeout) {
  timeout = timeout || 2000;
  return new Promise(function (resolve) {
    var req = http.get(url, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ ok: true, status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', function () { resolve({ ok: false }); });
    req.setTimeout(timeout, function () { req.destroy(); resolve({ ok: false }); });
  });
}

function isOurServer(data) {
  return data && typeof data === 'object' && data.yandexMaps !== undefined;
}

function findFreePort(start) {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.listen(start, HOST, function () {
      var p = srv.address().port;
      srv.close(function () { resolve(p); });
    });
    srv.on('error', function (err) {
      if (err.code === 'EADDRINUSE') {
        if (start >= MAX_PORT) return reject(new Error('No free ports in range 5179-5279'));
        resolve(findFreePort(start + 1));
      } else {
        reject(err);
      }
    });
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function main() {
  ensureDir(LOG_DIR);

  // 1. Check if OUR server already runs on base port
  var existing = await httpGet('http://' + HOST + ':' + BASE_PORT + '/api/config');
  if (existing.ok && isOurServer(existing.data)) {
    openBrowser('http://' + HOST + ':' + BASE_PORT);
    return;
  }

  // 2. Find free port starting from BASE_PORT
  var port = await findFreePort(BASE_PORT);

  // 3. Start server, pipe stdout/stderr to log file
  var logFile = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');

  var child = spawn('node', [SERVER_PATH], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    detached: false,
    windowsHide: true,
    stdio: ['ignore', logFile, logFile]
  });

  fs.writeFileSync(PID_FILE, String(child.pid));

  // 4. Wait until server responds (up to 30s)
  var ready = false;
  for (var i = 0; i < 60; i++) {
    await sleep(500);
    var check = await httpGet('http://' + HOST + ':' + port + '/api/config');
    if (check.ok && isOurServer(check.data)) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    child.kill();
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(1);
  }

  // 5. Open browser
  openBrowser('http://' + HOST + ':' + port);

  // 6. Keep alive; cleanup on child exit
  child.on('exit', function (code) {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(code || 0);
  });

  process.on('SIGINT', function () { child.kill(); });
  process.on('SIGTERM', function () { child.kill(); });
}

main().catch(function (e) {
  console.error(e.message);
  process.exit(1);
});
