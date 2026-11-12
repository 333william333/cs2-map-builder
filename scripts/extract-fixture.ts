/**
 * Cut a small real-data fixture for the road regression tests.
 *
 *   npx tsx scripts/extract-fixture.ts <area> <name> <x> <z> <half> <classes,comma,separated>
 *
 * Reads exports/<area>-vectors.json (and exports/<area>-terrain.bin when present), keeps the ways
 * of the given classes near the square of half-size <half> around (x, z), recentres them on (0, 0)
 * and, with terrain, stores a height / water subgrid around the square. Writes
 * src/core/roads/fixtures/<name>.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sampleHeight } from '../src/core/roads/elevation';
import type { Pt, RawWay } from '../src/core/types';
import { readTerrain } from './terrainFile';

const [area, name, xs, zs, hs, classes] = process.argv.slice(2);
if (!classes) {
  console.error('usage: npx tsx scripts/extract-fixture.ts <area> <name> <x> <z> <half> <classes>');
  process.exit(1);
}
const cx = Number(xs);
const cz = Number(zs);
const h = Number(hs);
const keep = new Set(classes.split(','));
const raw = JSON.parse(readFileSync(`exports/${area}-vectors.json`, 'utf8'));
const inside = (p: Pt) => Math.abs(p[0] - cx) <= h && Math.abs(p[1] - cz) <= h;
const r2 = (v: number) => Math.round(v * 100) / 100;
const ways: RawWay[] = [];
for (const w of raw.ways as RawWay[]) {
  if (!keep.has(w.cls)) continue;
  let piece: Pt[] = [];
  let k = 0;
  const flush = () => {
    if (piece.length >= 2) ways.push({ ...w, id: w.id * 100 + k++, pts: piece.map((p) => [r2(p[0] - cx), r2(p[1] - cz)] as Pt) });
    piece = [];
  };
  for (let i = 0; i < w.pts.length; i++) {
    const near = inside(w.pts[i]) || (i > 0 && inside(w.pts[i - 1])) || (i + 1 < w.pts.length && inside(w.pts[i + 1]));
    if (near) piece.push(w.pts[i]);
    else flush();
  }
  flush();
}
const out: Record<string, unknown> = { source: `${area}-vectors.json`, center: [cx, cz], half: h, scale: raw.scale ?? 1, ways };
const tf = `exports/${area}-terrain.bin`;
if (existsSync(tf)) {
  const t = readTerrain(tf);
  const N = t.playable.size;
  const ext = t.playable.extentM;
  const cell = ext / N;
  const pad = h + 300;
  const n = Math.ceil((2 * pad) / cell);
  const heights: number[] = [];
  const mask: number[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = cx - pad + (c + 0.5) * cell;
      const z = cz + pad - (r + 0.5) * cell;
      heights.push(r2(sampleHeight(t.playable, x, z)));
      const mc = Math.floor((x + ext / 2) / cell);
      const mr = Math.floor((ext / 2 - z) / cell);
      mask.push(mc < 0 || mr < 0 || mc >= N || mr >= N ? 0 : t.waterMask[mr * N + mc]);
    }
  }
  out.terrain = { n, cell, pad, heights, mask, seaLevel: t.seaLevel, hasSea: t.hasSea };
}
writeFileSync(`src/core/roads/fixtures/${name}.json`, JSON.stringify(out));
console.log(`${name}: ${ways.length} ways${out.terrain ? ', with terrain' : ''}`);
