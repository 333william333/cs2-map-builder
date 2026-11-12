import { describe, expect, it } from 'vitest';
import {
  aggregateMonthly, classifyKoppen, climateUrl, loadClimate, themeForLongitude, type DailySeries,
} from './climate';
import type { FetchBytes, Selection } from '../types';

const k = (t: number[], p: number[], lat: number) => classifyKoppen(t, p, lat);

describe('classifyKoppen', () => {
  it('Af: tropical rainforest (Singapore)', () => {
    const t = [26.5, 27, 27.5, 28, 28.3, 28.3, 28, 28, 27.8, 27.7, 26.9, 26.4];
    const p = [240, 115, 170, 170, 170, 135, 160, 150, 150, 170, 255, 270];
    expect(k(t, p, 1.3)).toBe('Af');
  });
  it('Aw: tropical savanna with dry winter', () => {
    const t = [24, 25, 26, 27, 27, 26, 25, 25, 25, 25, 24, 24];
    const p = [250, 220, 200, 100, 40, 10, 5, 5, 30, 90, 180, 240];
    expect(k(t, p, 10)).toBe('Aw');
  });
  it('BWh: hot desert (Cairo)', () => {
    const t = [14, 15.5, 18, 22, 26, 28.5, 29.5, 29.5, 27.5, 24.5, 20, 15.5];
    const p = [5, 4, 4, 1, 0.5, 0, 0, 0, 0, 0.5, 3, 5];
    expect(k(t, p, 30)).toBe('BWh');
  });
  it('BSk: cold steppe', () => {
    const t = [-4, -2, 3, 9, 14, 19, 22, 21, 15, 8, 1, -3];
    const p = [15, 15, 20, 28, 45, 50, 30, 25, 20, 20, 15, 15];
    expect(k(t, p, 45)).toBe('BSk');
  });
  it('Csa: hot-summer Mediterranean', () => {
    const t = [9, 10, 12, 15, 19, 23, 26, 26, 23, 18, 13, 10];
    const p = [70, 60, 50, 45, 30, 10, 3, 5, 25, 70, 90, 80];
    expect(k(t, p, 39)).toBe('Csa');
  });
  it('Cfb: oceanic (Bergen)', () => {
    const t = [1, 1.4, 2.8, 5.6, 9.3, 13.2, 14.3, 14, 12, 7.7, 4, 1.9];
    const p = [250, 220, 190, 107, 120, 119, 190, 222, 260, 307, 240, 293];
    expect(k(t, p, 60.4)).toBe('Cfb');
  });
  it('Dfb: humid continental (Uppsala)', () => {
    const t = [-1.7, -0.9, 1.2, 5.1, 10.7, 16.1, 17.8, 16.7, 12.6, 7.2, 2.9, -0.6];
    const p = [46, 33, 38, 30, 54, 55, 71, 78, 54, 56, 49, 42];
    expect(k(t, p, 59.9)).toBe('Dfb');
  });
  it('Dfc: subarctic', () => {
    const t = [-14, -12, -6, 0, 7, 12, 15, 12, 6, -1, -8, -13];
    const p = [30, 25, 25, 30, 40, 60, 80, 70, 50, 45, 40, 35];
    expect(k(t, p, 65)).toBe('Dfc');
  });
  it('ET: tundra', () => {
    const t = [-20, -20, -17, -10, -2, 3, 7, 6, 1, -7, -14, -18];
    const p = [15, 12, 12, 12, 15, 25, 35, 40, 30, 25, 18, 15];
    expect(k(t, p, 72)).toBe('ET');
  });
  it('southern hemisphere: Cfb (Melbourne-like) and Csa (winter-wet)', () => {
    const t = [20, 20.5, 18.5, 15.5, 12.5, 10, 9.5, 10.5, 12.5, 14.5, 16.5, 18.5];
    const p = [47, 47, 50, 58, 56, 50, 47, 48, 58, 67, 60, 59];
    expect(k(t, p, -37.8)).toBe('Cfb');
    // winter rain (Jun-Aug) with a dry Dec-Feb summer: Mediterranean in the south
    const pw = [10, 12, 20, 45, 90, 130, 140, 110, 70, 40, 20, 12];
    const tw = [22, 22, 20, 17, 14, 12, 11, 12, 13, 16, 18, 20];
    expect(k(tw, pw, -33.9)).toBe("Csa");
  });
  it('southern hemisphere: summer is Oct-Mar (Aw with wet southern summer)', () => {
    const t = [27, 27, 26, 25, 23, 21, 21, 22, 24, 26, 27, 27];
    const p = [250, 250, 200, 80, 20, 10, 5, 8, 25, 70, 140, 220];
    expect(k(t, p, -15)).toBe('Aw');
    // same table in the north has its rain in winter: tropical monsoon-dry-summer logic must still give A
    expect(k(t, p, 15).startsWith('A')).toBe(true);
  });
});

describe('aggregateMonthly', () => {
  it('averages temperatures and sums precipitation per year before averaging', () => {
    const time: string[] = [];
    const mean: number[] = [];
    const prec: number[] = [];
    for (const y of [2014, 2015]) {
      for (let m = 1; m <= 12; m++) {
        for (const day of [1, 2]) {
          time.push(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
          mean.push(m + (y === 2015 ? 2 : 0));
          prec.push(y === 2014 ? 1 : 3);
        }
      }
    }
    const d: DailySeries = {
      time,
      temperature_2m_mean: mean,
      temperature_2m_min: mean.map((v) => v - 3),
      temperature_2m_max: mean.map((v) => v + 5),
      precipitation_sum: prec,
      cloud_cover_mean: mean.map(() => 50),
    };
    const r = aggregateMonthly(d);
    expect(r.meanC[0]).toBeCloseTo(2); // (1 + 3) / 2
    expect(r.minC[0]).toBeCloseTo(-1);
    expect(r.maxC[11]).toBeCloseTo(18);
    expect(r.precipMm[5]).toBeCloseTo(4); // (2 + 6) / 2
    expect(r.cloud[3]).toBeCloseTo(0.5);
  });
  it('skips null values and throws when a month is empty', () => {
    const d: DailySeries = {
      time: ['2014-01-01', '2014-01-02'],
      temperature_2m_mean: [null, 4],
      precipitation_sum: [null, 2],
    };
    expect(() => aggregateMonthly(d)).toThrow();
  });
});

describe('loadClimate', () => {
  it('requests the rounded centre once and returns a profile', async () => {
    const time: string[] = [];
    const t: number[] = [];
    const p: number[] = [];
    for (let m = 1; m <= 12; m++) {
      time.push(`2020-${String(m).padStart(2, '0')}-15`);
      t.push(m <= 6 ? m * 3 - 3 : (13 - m) * 3 - 3); // 0..15..0 so warmest is June
      p.push(50);
    }
    const urls: string[] = [];
    const fake: FetchBytes = async (url) => {
      urls.push(url);
      return new TextEncoder().encode(JSON.stringify({
        daily: { time, temperature_2m_mean: t, temperature_2m_min: t, temperature_2m_max: t, precipitation_sum: p, cloud_cover_mean: t.map(() => 60) },
      }));
    };
    const sel: Selection = { centerLat: 59.85861, centerLon: 17.63894, sizeMeters: 14336, rotationDeg: 0 };
    const c = await loadClimate(sel, fake);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('latitude=59.86&longitude=17.64');
    expect(urls[0]).toContain('timezone=UTC');
    expect(c.monthlyMeanC).toHaveLength(12);
    expect(c.theme).toBe('european');
    expect(c.monthlyCloud[0]).toBeCloseTo(0.6);
    expect(climateUrl(1.234, -5.678)).toContain('latitude=1.23&longitude=-5.68');
  });
  it('theme by longitude', () => {
    expect(themeForLongitude(-100)).toBe('northAmerican');
    expect(themeForLongitude(-20)).toBe('european');
    expect(themeForLongitude(139)).toBe('european');
    expect(themeForLongitude(-175)).toBe('european');
  });
});
