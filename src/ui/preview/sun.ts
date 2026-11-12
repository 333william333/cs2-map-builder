/**
 * Sun position and a matching sky palette for the 3D preview. Pure, no three.js.
 *
 * Scene frame: x = gx, y = up, z = -gz. The selection's top edge (+gz) points `rotationDeg`
 * clockwise from true north, so a true azimuth becomes `az - rotationDeg` in the game frame.
 */

export type Vec3 = [number, number, number];

export interface SunState {
  /** unit vector from the ground towards the sun, scene frame */
  dir: Vec3;
  /** degrees above the horizon (negative = below) */
  elevationDeg: number;
  /** true azimuth, degrees clockwise from north */
  azimuthDeg: number;
}

const RAD = Math.PI / 180;

/** Day of year used for "summer": mid July in the north, mid January in the south. */
export function summerDay(latitude: number): number {
  return latitude < 0 ? 15 : 196;
}

/**
 * Sun direction for a latitude, day of year (1..365) and local SOLAR time in hours (12 = noon).
 * Uses the usual declination / hour angle approximation (good to about a degree).
 */
export function sunPosition(latitude: number, dayOfYear: number, solarHour: number, rotationDeg = 0): SunState {
  const phi = Math.max(-89.9, Math.min(89.9, latitude)) * RAD;
  const decl = -23.44 * RAD * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
  const H = (solarHour - 12) * 15 * RAD;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  let az = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(phi) - Math.sin(phi) * Math.cos(H)) / RAD;
  az = (az + 360) % 360;
  const gAz = (az - rotationDeg) * RAD;
  const ca = Math.cos(alt);
  const gx = Math.sin(gAz) * ca;
  const gz = Math.cos(gAz) * ca;
  return { dir: [gx, Math.sin(alt), -gz], elevationDeg: alt / RAD, azimuthDeg: az };
}

export interface SkyPalette {
  /** all LINEAR rgb */
  zenith: Vec3;
  horizon: Vec3;
  /** colour of direct sunlight (already scaled by its strength, ~1 at noon) */
  sun: Vec3;
  /** hemisphere ambient: sky and ground bounce */
  ambientSky: Vec3;
  ambientGround: Vec3;
}

function lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linHex(h: number): Vec3 {
  return [lin(((h >> 16) & 255) / 255), lin(((h >> 8) & 255) / 255), lin((h & 255) / 255)];
}
function mix3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const ZENITH_DAY = linHex(0x4a7fc0);
const ZENITH_LOW = linHex(0x3b5f94);
const ZENITH_NIGHT = linHex(0x0d1626);
const HORIZON_DAY = linHex(0xb3c7da);
const HORIZON_LOW = linHex(0xe8b98c);
const HORIZON_NIGHT = linHex(0x26334a);
const SUN_DAY = linHex(0xfff3e2);
const SUN_LOW = linHex(0xffa25a);

/** Sky colours that agree with a sun at `elevationDeg`. */
export function skyPalette(elevationDeg: number): SkyPalette {
  const day = sstep(-4, 22, elevationDeg); // 0 = twilight, 1 = full day
  const low = 1 - sstep(2, 20, elevationDeg); // warm tint near the horizon
  const lit = sstep(-3, 6, elevationDeg);
  let zenith = mix3(ZENITH_NIGHT, ZENITH_LOW, sstep(-6, 4, elevationDeg));
  zenith = mix3(zenith, ZENITH_DAY, day);
  let horizon = mix3(HORIZON_NIGHT, HORIZON_LOW, sstep(-6, 2, elevationDeg));
  horizon = mix3(horizon, HORIZON_DAY, 1 - low);
  const sunCol = mix3(SUN_DAY, SUN_LOW, low);
  const strength = lit * (0.55 + 0.45 * sstep(4, 35, elevationDeg));
  const sun: Vec3 = [sunCol[0] * strength, sunCol[1] * strength, sunCol[2] * strength];
  const amb = 0.25 + 0.75 * sstep(-6, 18, elevationDeg);
  const skyMix = mix3(zenith, horizon, 0.45);
  const lum = skyMix[0] * 0.2126 + skyMix[1] * 0.7152 + skyMix[2] * 0.0722;
  // soft, mostly neutral ambient with a hint of sky blue (CS2 keeps shadow sides readable)
  const ambientSky = mix3(skyMix, [lum, lum, lum], 0.55).map((c) => c * amb * 1.5) as Vec3;
  const ambientGround: Vec3 = [0.2 * amb, 0.2 * amb, 0.15 * amb];
  return { zenith, horizon, sun, ambientSky, ambientGround };
}

/** "15:30" style label for a solar hour. */
export function formatHour(h: number): string {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
