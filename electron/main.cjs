// Thin Electron shell: starts the bundled server (server-dist/server.mjs) on a free port in production
// mode, waits for it, then opens the UI in a window. Closing the window stops the server.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'server-dist', 'server.mjs');

let serverProc = null;
let win = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(main).catch(fail);
}

function fail(err) {
  dialog.showErrorBox('CS2 Map Builder', String((err && err.message) || err));
  stopServer();
  app.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, proc) {
  const url = `http://127.0.0.1:${port}/api/cs2/paths`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`The server exited unexpectedly (code ${proc.exitCode}).`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('The server did not answer within 30 seconds.');
}

function stopServer() {
  if (serverProc && serverProc.exitCode === null) {
    try {
      serverProc.kill();
    } catch {
      // already gone
    }
  }
  serverProc = null;
}

async function main() {
  if (!fs.existsSync(SERVER_FILE)) throw new Error(`Cannot find ${SERVER_FILE}. Run "npm start" to build it.`);
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('Cannot find dist/index.html. Run "npm start" to build it.');

  const port = await freePort();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CS2MB_SERVE_DIST: '1',
    CS2MB_SERVER_PORT: String(port),
    CS2MB_EXIT_ON_STDIN_CLOSE: '1',
  };
  // Packaged build: cache and exports go to a per-user folder instead of next to the program.
  if (app.isPackaged) env.CS2MB_DATA_DIR = app.getPath('userData');

  serverProc = spawn(process.execPath, [SERVER_FILE], { env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  serverProc.on('exit', (code) => {
    if (!quitting) {
      quitting = true;
      dialog.showErrorBox('CS2 Map Builder', `The server stopped (code ${code}). The program will exit.`);
      app.exit(1);
    }
  });
  await waitForServer(port, serverProc);
  console.log(`[electron] server answered on port ${port}`);

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1317',
    title: 'CS2 Map Builder',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  // Keep our title instead of the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault());

  const origin = `http://127.0.0.1:${port}`;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
  });
  await win.loadURL(origin + '/');
  console.log('[electron] window loaded');
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  stopServer();
});
process.on('exit', stopServer);
