// npm start: build the UI if dist/ is missing or older than src/, bundle the server, launch Electron.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const require = createRequire(import.meta.url);

function newest(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  for (const e of readdirSync(p)) m = Math.max(m, newest(path.join(p, e)));
  return m;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: cmd === 'npm' && process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

const distIndex = path.join(root, 'dist', 'index.html');
const sources = ['src', 'index.html', 'vite.config.ts', 'package.json'].filter(existsSync);
const stale = !existsSync(distIndex) || Math.max(...sources.map((s) => newest(s))) > statSync(distIndex).mtimeMs;
if (stale) {
  console.log('Building the UI (dist/ is missing or older than src/) ...');
  run('npm', ['run', 'build']);
} else {
  console.log('The UI is already built.');
}

run(process.execPath, ['scripts/bundle-server.mjs']);

// npm 11 may skip electron's postinstall (which downloads the program); do it here if needed.
let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.log('Downloading Electron (once, about 100 MB) ...');
  run(process.execPath, ['node_modules/electron/install.js']);
  delete require.cache[require.resolve('electron')];
  electronPath = require('electron');
}

console.log('Starting CS2 Map Builder ...');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
