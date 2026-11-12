import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Not PORT: launchers set PORT for the web UI (vite), which would make both listen on the same port.
const PORT = Number(process.env.CS2MB_SERVER_PORT ?? 5174);
const USER_AGENT = 'CS2MapBuilder/0.1';

// Project root = parent of server/ (also when bundled to server-dist/server.mjs). Never the working directory.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Packaged app: CS2MB_DATA_DIR points at a per-user folder; otherwise cache and exports live in the project.
const DATA_DIR = process.env.CS2MB_DATA_DIR ? path.resolve(process.env.CS2MB_DATA_DIR) : ROOT_DIR;
const DIST_DIR = process.env.CS2MB_DIST_DIR ? path.resolve(process.env.CS2MB_DIST_DIR) : path.join(ROOT_DIR, 'dist');
const SERVE_DIST = process.env.CS2MB_SERVE_DIST === '1';
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

const ALLOWED_HOSTS = new Set([
  's3.amazonaws.com',
  'esa-worldcover.s3.eu-central-1.amazonaws.com',
  'overpass-api.de',
  'overpass.kumi.systems',
  'archive-api.open-meteo.com',
  'api.open-meteo.com',
  'nominatim.openstreetmap.org',
  'tiles.maps.eox.at',
  'tiles.openfreemap.org',
]);

const app = express();

// ------------------------------------------------------------------ caching fetch proxy

interface CacheMeta {
  status: number;
  contentType?: string;
  contentRange?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchUpstream(url: string, method: string, headers: Record<string, string>, body?: string) {
  const attempt = () => fetch(url, { method, headers, body, redirect: 'follow' });
  let res = await attempt();
  if (res.status === 429 || res.status >= 500) {
    await sleep(1500);
    res = await attempt();
  }
  return res;
}

async function handleFetch(req: express.Request, res: express.Response) {
  const raw = req.query.url;
  if (typeof raw !== 'string' || !raw) {
    res.status(400).json({ error: 'missing url' });
    return;
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || !ALLOWED_HOSTS.has(target.hostname)) {
    res.status(403).json({ error: `host not allowed: ${target.hostname}` });
    return;
  }

  const method = req.method === 'POST' ? 'POST' : 'GET';
  const range = typeof req.headers.range === 'string' ? req.headers.range : '';
  const body = method === 'POST' && typeof req.body === 'string' ? req.body : '';
  const key = createHash('sha1').update([method, target.href, range, body].join('\n')).digest('hex');
  const binPath = path.join(CACHE_DIR, `${key}.bin`);
  const metaPath = path.join(CACHE_DIR, `${key}.json`);

  const send = (meta: CacheMeta, data: Buffer, cache: 'HIT' | 'MISS') => {
    res.status(meta.status);
    if (meta.contentType) res.setHeader('Content-Type', meta.contentType);
    if (meta.contentRange) res.setHeader('Content-Range', meta.contentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Cache', cache);
    res.setHeader('Content-Length', data.length);
    res.end(data);
  };

  try {
    if (existsSync(metaPath) && existsSync(binPath)) {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as CacheMeta;
      send(meta, await readFile(binPath), 'HIT');
      return;
    }
  } catch {
    // corrupt cache entry: fall through and refetch
  }

  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (range) headers.Range = range;
  if (method === 'POST') headers['Content-Type'] = 'text/plain;charset=UTF-8';

  try {
    const up = await fetchUpstream(target.href, method, headers, method === 'POST' ? body : undefined);
    const data = Buffer.from(await up.arrayBuffer());
    const meta: CacheMeta = {
      status: up.status,
      contentType: up.headers.get('content-type') ?? undefined,
      contentRange: up.headers.get('content-range') ?? undefined,
    };
    if (up.status === 200 || up.status === 206) {
      await mkdir(CACHE_DIR, { recursive: true });
      // write the body first and the meta last, via temp files, so a half-written entry is never served
      const tmp = `${binPath}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, binPath);
      await writeFile(metaPath, JSON.stringify(meta));
    }
    send(meta, data, 'MISS');
  } catch (err) {
    res.status(502).json({ error: `upstream fetch failed: ${(err as Error).message}` });
  }
}

app.get('/api/fetch', (req, res) => void handleFetch(req, res));
app.post('/api/fetch', express.text({ type: () => true, limit: '20mb' }), (req, res) => void handleFetch(req, res));

// ------------------------------------------------------------------ CS2 paths

function cs2Paths() {
  const home = process.env.USERPROFILE ?? os.homedir();
  const dataDir = path.join(home, 'AppData', 'LocalLow', 'Colossal Order', 'Cities Skylines II');
  return {
    dataDir,
    heightmapsDir: path.join(dataDir, 'Heightmaps'),
    mapsDir: path.join(dataDir, 'Maps'),
    overlaysDir: path.join(dataDir, 'Overlays'),
    packagesDir: path.join(dataDir, 'ModsData', 'CS2MapBuilder', 'packages'),
    exists: existsSync(dataDir),
  };
}

app.get('/api/cs2/paths', (_req, res) => {
  res.json(cs2Paths());
});

// ------------------------------------------------------------------ export

const ALLOWED_EXPORT_EXT = new Set(['.png', '.tiff', '.zip', '.json', '.bin']);
const EXPORT_TARGETS = new Set(['heightmaps', 'package', 'overlay', 'cs2package']);
const safeSegment = (s: string) => s.replace(/[^\w.\- ()]/g, '_');

app.post('/api/export', express.raw({ type: () => true, limit: '400mb' }), async (req, res) => {
  try {
    const target = req.query.target;
    const rawName = req.query.name;
    if (typeof target !== 'string' || !EXPORT_TARGETS.has(target)) {
      res.status(400).json({ error: `target must be one of ${[...EXPORT_TARGETS].join(', ')}` });
      return;
    }
    if (typeof rawName !== 'string' || !rawName) {
      res.status(400).json({ error: 'missing name' });
      return;
    }
    const name = path.basename(rawName.replace(/\\/g, '/')).replace(/[^\w.\- ()]/g, '_');
    const ext = path.extname(name).toLowerCase();
    if (!name || name.startsWith('.') || !ALLOWED_EXPORT_EXT.has(ext)) {
      res.status(400).json({ error: `invalid file name or extension (allowed: ${[...ALLOWED_EXPORT_EXT].join(' ')})` });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty body' });
      return;
    }
    const paths = cs2Paths();
    let dir = EXPORTS_DIR;
    if (target === 'heightmaps') dir = paths.heightmapsDir;
    else if (target === 'overlay') dir = paths.overlaysDir;
    else if (target === 'cs2package') {
      // ModsData/CS2MapBuilder/packages/<pkg>/[resources/]<name>, read by the importer mod
      const pkg = typeof req.query.pkg === 'string' ? safeSegment(path.basename(req.query.pkg)) : '';
      if (!pkg || pkg.startsWith('.')) {
        res.status(400).json({ error: 'missing or invalid pkg' });
        return;
      }
      dir = path.join(paths.packagesDir, pkg);
      if (req.query.sub === 'resources') dir = path.join(dir, 'resources');
    }
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, req.body);
    res.json({ path: file });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ------------------------------------------------------------------ built UI (production mode)

if (SERVE_DIST) {
  if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error(`CS2MB_SERVE_DIST=1 but ${path.join(DIST_DIR, 'index.html')} is missing. Run "npm run build".`);
    process.exit(1);
  }
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not found' }));
  app.use(express.static(DIST_DIR));
  app.get('/', (_req, res) => void res.sendFile(path.join(DIST_DIR, 'index.html')));
}

// Bound to loopback only in production mode; the dev server keeps its old behaviour.
const server = SERVE_DIST
  ? app.listen(PORT, '127.0.0.1', onListening)
  : app.listen(PORT, onListening);

function onListening() {
  console.log(`CS2 Map Builder server on http://${SERVE_DIST ? '127.0.0.1' : 'localhost'}:${PORT}${SERVE_DIST ? ' (serving dist/)' : ''}`);
}

// Spawned by the Electron shell: exit when the parent goes away (stdin pipe closes), so no orphan keeps the port.
if (process.env.CS2MB_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.resume();
}
process.on('SIGTERM', () => server.close(() => process.exit(0)));
