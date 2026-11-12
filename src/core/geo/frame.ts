import { CS2, type Pt, type Selection } from '../types';

const R = 6371008.8; // mean earth radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Converts between Geo (lat/lon) and Game coordinates for one selection.
 * Uses a spherical azimuthal-equidistant projection centred on the selection,
 * so the square is metrically square on the ground at any latitude.
 */
export interface Frame {
  sel: Selection;
  /** game metres per real metre */
  scale: number;
  geoToGame(lat: number, lon: number): Pt;
  /** returns [lat, lon] */
  gameToGeo(gx: number, gz: number): [number, number];
  /** [south, west, north, east] covering a centred square with side extentGameM (game metres) */
  bbox(extentGameM: number): [number, number, number, number];
  /** corners as [lat, lon]: top-left, top-right, bottom-right, bottom-left */
  corners(extentGameM: number): [number, number][];
}

export function createFrame(sel: Selection): Frame {
  const lat0 = sel.centerLat * D2R;
  const lon0 = sel.centerLon * D2R;
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const th = sel.rotationDeg * D2R;
  const cosT = Math.cos(th);
  const sinT = Math.sin(th);
  const scale = CS2.PLAYABLE_SIZE_M / sel.sizeMeters;

  function geoToGame(lat: number, lon: number): Pt {
    const phi = lat * D2R;
    const dl = lon * D2R - lon0;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const cosC = Math.min(1, Math.max(-1, sinLat0 * sinPhi + cosLat0 * cosPhi * Math.cos(dl)));
    const c = Math.acos(cosC);
    const k = c < 1e-12 ? 1 : c / Math.sin(c);
    const east = R * k * cosPhi * Math.sin(dl);
    const north = R * k * (cosLat0 * sinPhi - sinLat0 * cosPhi * Math.cos(dl));
    const rx = east * cosT - north * sinT;
    const ry = east * sinT + north * cosT;
    return [rx * scale, ry * scale];
  }

  function gameToGeo(gx: number, gz: number): [number, number] {
    const rx = gx / scale;
    const ry = gz / scale;
    const east = rx * cosT + ry * sinT;
    const north = -rx * sinT + ry * cosT;
    const rho = Math.hypot(east, north);
    if (rho < 1e-9) return [sel.centerLat, sel.centerLon];
    const c = rho / R;
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const phi = Math.asin(cosC * sinLat0 + (north * sinC * cosLat0) / rho);
    const lam = lon0 + Math.atan2(east * sinC, rho * cosLat0 * cosC - north * sinLat0 * sinC);
    let lon = lam * R2D;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return [phi * R2D, lon];
  }

  function corners(extentGameM: number): [number, number][] {
    const h = extentGameM / 2;
    return [gameToGeo(-h, h), gameToGeo(h, h), gameToGeo(h, -h), gameToGeo(-h, -h)];
  }

  function bbox(extentGameM: number): [number, number, number, number] {
    const h = extentGameM / 2;
    const n = 16;
    let s = 90, w = 180, nn = -90, e = -180;
    for (let i = 0; i <= n; i++) {
      const t = -h + (2 * h * i) / n;
      for (const [gx, gz] of [[t, h], [t, -h], [h, t], [-h, t]] as Pt[]) {
        const [lat, lon] = gameToGeo(gx, gz);
        if (lat < s) s = lat;
        if (lat > nn) nn = lat;
        if (lon < w) w = lon;
        if (lon > e) e = lon;
      }
    }
    return [s, w, nn, e];
  }

  return { sel, scale, geoToGame, gameToGeo, bbox, corners };
}
