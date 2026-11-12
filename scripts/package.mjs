// npm run package: UI build, server bundle, electron-builder (NSIS installer + portable exe), then the mod zip.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: cmd === 'npm' || cmd === 'npx', ...opts });
  if (r.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync('build/icon.ico')) run(process.execPath, ['scripts/make-icon.mjs']);
run('npm', ['run', 'build']);
run(process.execPath, ['scripts/bundle-server.mjs']);
run('npx', ['electron-builder', '--win', 'nsis', 'portable', '--x64', '--publish', 'never'], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

// mod zip: mod/dist/CS2MapBuilder + install/uninstall scripts + README
const modDir = 'mod/dist/CS2MapBuilder';
if (existsSync(modDir)) {
  mkdirSync('release', { recursive: true });
  const zip = path.resolve('release', `CS2MapBuilder-mod-${version}.zip`);
  rmSync(zip, { force: true });
  // same layout as mod/, so install.ps1 finds dist\CS2MapBuilder next to itself
  const stage = path.resolve('release', '.mod-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, 'dist'), { recursive: true });
  cpSync(modDir, path.join(stage, 'dist', 'CS2MapBuilder'), { recursive: true });
  for (const f of ['install.ps1', 'uninstall.ps1', 'README.md']) cpSync(path.join('mod', f), path.join(stage, f));
  const star = path.join(stage, '*');
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Force -Path '${star}' -DestinationPath '${zip}'`], { shell: false });
  rmSync(stage, { recursive: true, force: true });
  console.log('Mod zip: ' + zip);
} else {
  console.warn('mod/dist/CS2MapBuilder not found: mod zip skipped (run mod/build.ps1 first).');
}
