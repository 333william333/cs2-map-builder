import type { ClimateProfile, FetchBytes, Selection } from '../types';

const YEAR_FROM = 2014;
const YEAR_TO = 2023;

/** Daily series as returned by the Open-Meteo archive API (`daily` object). */
export interface DailySeries {
  time: string[];
  temperature_2m_mean?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  precipitation_sum?: (number | null)[];
  /** percent 0..100 */
  cloud_cover_mean?: (number | null)[];
}

export interface MonthlyNormals {
  meanC: number[];
  minC: number[];
  maxC: number[];
  precipMm: number[];
  /** 0..1 */
  cloud: number[];
}

export function climateUrl(lat: number, lon: number): string {
  // 2 decimals (about 1 km) so the caching proxy gets hits for nearby selections
  const la = (Math.round(lat * 100) / 100).toFixed(2);
  const lo = (Math.round(lon * 100) / 100).toFixed(2);
  return (
    'https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${la}&longitude=${lo}` +
    `&start_date=${YEAR_FROM}-01-01&end_date=${YEAR_TO}-12-31` +
    '&daily=temperature_2m_mean,temperature_2m_min,temperature_2m_max,precipitation_sum,cloud_cover_mean' +
    '&timezone=UTC'
  );
}

/** Aggregates a daily series to 12 monthly normals (January first). Null values are skipped. */
export function aggregateMonthly(d: DailySeries): MonthlyNormals {
  const sums = {
    mean: new Float64Array(12), min: new Float64Array(12), max: new Float64Array(12), cloud: new Float64Array(12),
  };
  const counts = {
    mean: new Int32Array(12), min: new Int32Array(12), max: new Int32Array(12), cloud: new Int32Array(12),
  };
  // precipitation: monthly totals per (year, month), then averaged over the years that have data
  const precipTotals = new Map<number, number>();
  const n = d.time.length;
  for (let i = 0; i < n; i++) {
    const t = d.time[i];
    const year = parseInt(t.slice(0, 4), 10);
    const m = parseInt(t.slice(5, 7), 10) - 1;
    if (!(m >= 0 && m < 12)) continue;
    const add = (key: 'mean' | 'min' | 'max' | 'cloud', arr: (number | null)[] | undefined) => {
      const v = arr?.[i];
      if (v == null || !Number.isFinite(v)) return;
      sums[key][m] += v;
      counts[key][m]++;
    };
    add('mean', d.temperature_2m_mean);
    add('min', d.temperature_2m_min);
    add('max', d.temperature_2m_max);
    add('cloud', d.cloud_cover_mean);
    const p = d.precipitation_sum?.[i];
    if (p != null && Number.isFinite(p)) {
      const key = year * 12 + m;
      precipTotals.set(key, (precipTotals.get(key) ?? 0) + p);
    }
  }
  const precipSum = new Float64Array(12);
  const precipYears = new Int32Array(12);
  for (const [key, total] of precipTotals) {
    const m = key % 12;
    precipSum[m] += total;
    precipYears[m]++;
  }
  const out: MonthlyNormals = { meanC: [], minC: [], maxC: [], precipMm: [], cloud: [] };
  for (let m = 0; m < 12; m++) {
    if (counts.mean[m] === 0 || precipYears[m] === 0) throw new Error(`Climate: no data for month ${m + 1}`);
    const mean = sums.mean[m] / counts.mean[m];
    out.meanC.push(mean);
    out.minC.push(counts.min[m] ? sums.min[m] / counts.min[m] : mean - 4);
    out.maxC.push(counts.max[m] ? sums.max[m] / counts.max[m] : mean + 4);
    out.precipMm.push(precipSum[m] / precipYears[m]);
    out.cloud.push(counts.cloud[m] ? Math.min(1, Math.max(0, sums.cloud[m] / counts.cloud[m] / 100)) : 0.5);
  }
  return out;
}

/**
 * Köppen-Geiger classification (Peel et al. 2007 rules) from 12 monthly mean temperatures (C, January
 * first) and 12 monthly precipitation totals (mm). The sign of `latitude` picks the hemisphere, which
 * decides what counts as summer (Apr-Sep north, Oct-Mar south).
 */
export function classifyKoppen(meanC: number[], precipMm: number[], latitude: number): string {
  const tAnn = meanC.reduce((a, b) => a + b, 0) / 12;
  const pAnn = precipMm.reduce((a, b) => a + b, 0);
  const tMin = Math.min(...meanC);
  const tMax = Math.max(...meanC);

  const isSummer = (m: number) => (latitude >= 0 ? m >= 3 && m <= 8 : m >= 9 || m <= 2);
  const summerP: number[] = [];
  const winterP: number[] = [];
  for (let m = 0; m < 12; m++) (isSummer(m) ? summerP : winterP).push(precipMm[m]);
  const pSummer = summerP.reduce((a, b) => a + b, 0);
  const pWinter = winterP.reduce((a, b) => a + b, 0);

  // polar
  if (tMax < 10) return tMax > 0 ? 'ET' : 'EF';

  // arid
  let pThresh: number;
  if (pAnn > 0 && pWinter >= 0.7 * pAnn) pThresh = 2 * tAnn;
  else if (pAnn > 0 && pSummer >= 0.7 * pAnn) pThresh = 2 * tAnn + 28;
  else pThresh = 2 * tAnn + 14;
  pThresh = Math.max(0, pThresh);
  if (pAnn < 10 * pThresh) {
    const kind = pAnn <= 5 * pThresh ? 'BW' : 'BS';
    return kind + (tAnn >= 18 ? 'h' : 'k');
  }

  // tropical
  const pDry = Math.min(...precipMm);
  if (tMin >= 18) {
    if (pDry >= 60) return 'Af';
    if (pDry >= 100 - pAnn / 25) return 'Am';
    return 'Aw';
  }

  // temperate (C) or continental (D)
  const first = tMin > 0 ? 'C' : 'D';
  const psDry = Math.min(...summerP);
  const psWet = Math.max(...summerP);
  const pwDry = Math.min(...winterP);
  const pwWet = Math.max(...winterP);
  let second = 'f';
  if (psDry < 40 && psDry < pwWet / 3) second = 's';
  else if (pwDry < psWet / 10) second = 'w';

  let third: string;
  const warmMonths = meanC.filter((t) => t >= 10).length;
  if (tMax >= 22) third = 'a';
  else if (warmMonths >= 4) third = 'b';
  else if (first === 'D' && tMin <= -38) third = 'd';
  else third = 'c';
  return first + second + third;
}

export function themeForLongitude(lon: number): 'european' | 'northAmerican' {
  return lon > -170 && lon < -30 ? 'northAmerican' : 'european';
}

export async function loadClimate(sel: Selection, fetch: FetchBytes): Promise<ClimateProfile> {
  const url = climateUrl(sel.centerLat, sel.centerLon);
  let bytes: Uint8Array;
  try {
    bytes = await fetch(url);
  } catch {
    bytes = await fetch(url); // one retry
  }
  const json = JSON.parse(new TextDecoder().decode(bytes)) as { daily?: DailySeries; error?: boolean; reason?: string };
  if (json.error || !json.daily || !Array.isArray(json.daily.time)) {
    throw new Error(`Climate: bad response${json.reason ? ` (${json.reason})` : ''}`);
  }
  const m = aggregateMonthly(json.daily);
  return {
    latitude: sel.centerLat,
    longitude: sel.centerLon,
    koppen: classifyKoppen(m.meanC, m.precipMm, sel.centerLat),
    monthlyMeanC: m.meanC,
    monthlyMinC: m.minC,
    monthlyMaxC: m.maxC,
    monthlyPrecipMm: m.precipMm,
    monthlyCloud: m.cloud,
    theme: themeForLongitude(sel.centerLon),
  };
}
