import type { ClimateProfile, TreeSpecies } from '../types';

/** Fixed species order used for all weight vectors in this module. */
export const SPECIES: TreeSpecies[] = [
  'birch', 'oak', 'linden', 'chestnut', 'poplar', 'alder', 'apple',
  'hickory', 'plane', 'pine', 'spruce', 'bush', 'palm', 'eucalyptus',
];
export const NS = SPECIES.length;
const ix = (s: TreeSpecies) => SPECIES.indexOf(s);

export const SP = {
  birch: ix('birch'), oak: ix('oak'), linden: ix('linden'), chestnut: ix('chestnut'),
  poplar: ix('poplar'), alder: ix('alder'), apple: ix('apple'), hickory: ix('hickory'),
  plane: ix('plane'), pine: ix('pine'), spruce: ix('spruce'), bush: ix('bush'), palm: ix('palm'),
} as const;

export type Biome =
  | 'boreal' | 'hemiboreal' | 'temperateEU' | 'temperateNA'
  | 'mediterranean' | 'arid' | 'steppe' | 'tropical' | 'polar';

/** Placement groups: what kind of ground the tree stands on. */
export const Group = { Tree: 0, Shrub: 1, Wetland: 2, Park: 3, Built: 4, Lone: 5, Mangrove: 6 } as const;
export type Group = (typeof Group)[keyof typeof Group];
export const NGROUPS = 7;

function vec(w: Partial<Record<TreeSpecies, number>>): Float32Array {
  const v = new Float32Array(NS);
  for (const k of Object.keys(w) as TreeSpecies[]) v[ix(k)] = w[k] ?? 0;
  return v;
}

const BASE: Record<Biome, Float32Array> = {
  boreal: vec({ birch: 0.24, poplar: 0.03, alder: 0.05, pine: 0.3, spruce: 0.35, bush: 0.03 }),
  hemiboreal: vec({
    birch: 0.18, oak: 0.08, linden: 0.04, poplar: 0.03, alder: 0.06, pine: 0.22, spruce: 0.32, bush: 0.02,
  }),
  temperateEU: vec({
    birch: 0.12, oak: 0.24, linden: 0.15, chestnut: 0.1, poplar: 0.06, alder: 0.04, apple: 0.02,
    plane: 0.02, pine: 0.12, spruce: 0.1, bush: 0.03,
  }),
  temperateNA: vec({
    birch: 0.06, oak: 0.24, linden: 0.06, chestnut: 0.02, poplar: 0.06, alder: 0.02, apple: 0.01,
    hickory: 0.17, plane: 0.12, pine: 0.17, spruce: 0.05, bush: 0.02,
  }),
  mediterranean: vec({
    pine: 0.36, oak: 0.22, bush: 0.22, poplar: 0.04, chestnut: 0.04, plane: 0.05, palm: 0.02, apple: 0.02, alder: 0.01,
  }),
  arid: vec({ bush: 0.88, palm: 0.02, plane: 0.03, poplar: 0.03, pine: 0.02, oak: 0.02 }),
  steppe: vec({
    bush: 0.6, oak: 0.08, pine: 0.1, poplar: 0.06, birch: 0.06, plane: 0.04, chestnut: 0.03, linden: 0.03,
  }),
  tropical: vec({
    palm: 0.3, plane: 0.17, chestnut: 0.15, oak: 0.08, bush: 0.15, linden: 0.05, poplar: 0.04, alder: 0.03, apple: 0.03,
  }),
  polar: vec({ birch: 0.45, bush: 0.45, spruce: 0.05, pine: 0.05 }),
};

const CONIFERS = [SP.pine, SP.spruce];
const BROADLEAF = [SP.oak, SP.linden, SP.chestnut, SP.hickory, SP.plane, SP.apple, SP.poplar, SP.alder, SP.birch];
const PARK_LOVE = [SP.linden, SP.chestnut, SP.plane, SP.oak, SP.apple, SP.hickory];

function scaled(base: Float32Array, f: (i: number) => number): Float32Array {
  const v = new Float32Array(NS);
  for (let i = 0; i < NS; i++) v[i] = base[i] * f(i);
  return v;
}

/** Normalised weights for (biome, group). */
export function weightsFor(biome: Biome, group: Group): Float32Array {
  const base = BASE[biome];
  const tropicalWet = biome === 'tropical';
  switch (group) {
    case Group.Tree:
      return base;
    case Group.Shrub: {
      const v = scaled(base, (i) => (i === SP.bush ? 6 : 0.25));
      v[SP.bush] += 0.5;
      return v;
    }
    case Group.Wetland:
      return tropicalWet
        ? vec({ palm: 0.4, bush: 0.3, alder: 0.1, poplar: 0.1, plane: 0.1 })
        : scaled(vec({ alder: 0.35, birch: 0.25, poplar: 0.15, bush: 0.15, oak: 0.05, spruce: 0.05 }), (i) =>
          (biome === 'arid' && i === SP.bush ? 3 : 1));
    case Group.Park:
      return scaled(base, (i) => (PARK_LOVE.includes(i) ? 2.2 : CONIFERS.includes(i) ? 0.5 : i === SP.bush ? 0.3 : 1));
    case Group.Built:
      return scaled(base, (i) =>
        (PARK_LOVE.includes(i) ? 2 : CONIFERS.includes(i) ? 0.2 : i === SP.bush ? 0.3 : i === SP.palm ? 1.3 : 1));
    case Group.Lone:
      return scaled(base, (i) => (CONIFERS.includes(i) ? 0.5 : 1));
    case Group.Mangrove:
      return vec({ bush: 0.55, palm: 0.45 });
  }
}

/** Multipliers for explicit leaf type (index 0 unknown, 1 broadleaved, 2 needleleaved, 3 mixed). */
export const LEAF_FACTOR: Float32Array[] = (() => {
  const unknown = new Float32Array(NS).fill(1);
  const broad = new Float32Array(NS).fill(1);
  const needle = new Float32Array(NS).fill(0.12);
  for (const i of CONIFERS) { broad[i] = 0.12; needle[i] = 3; }
  for (const i of BROADLEAF) broad[i] = 1.5;
  needle[SP.birch] = 0.5;
  needle[SP.bush] = 0.6;
  broad[SP.bush] = 0.8;
  return [unknown, broad, needle, unknown];
})();

/** Multipliers near fresh water (rivers, lakes). */
export const NEAR_WATER_FACTOR: Float32Array = (() => {
  const v = new Float32Array(NS).fill(1);
  v[SP.poplar] = 3; v[SP.alder] = 4; v[SP.birch] = 1.3; v[SP.pine] = 0.5; v[SP.palm] = 2;
  return v;
})();

/** Multipliers on steep or dry ground. */
export const DRY_FACTOR: Float32Array = (() => {
  const v = new Float32Array(NS).fill(1);
  v[SP.pine] = 2; v[SP.poplar] = 0.4; v[SP.alder] = 0.3; v[SP.spruce] = 0.8; v[SP.bush] = 1.3;
  return v;
})();

/** Multipliers near the sea (palms love coasts). */
export const COAST_FACTOR: Float32Array = (() => {
  const v = new Float32Array(NS).fill(1);
  v[SP.palm] = 4; v[SP.pine] = 1.2;
  return v;
})();

/** Multipliers at full cold (warmest month about 10 C); interpolated by coldness. */
export const COLD_FACTOR: Float32Array = (() => {
  const v = new Float32Array(NS).fill(0.15);
  v[SP.spruce] = 2.5; v[SP.birch] = 2; v[SP.pine] = 1.5; v[SP.bush] = 1.5; v[SP.alder] = 0.8; v[SP.palm] = 0;
  v[SP.apple] = 0.05;
  return v;
})();

/** Just below the tree line: stunted birch and bush only. */
export const STUNTED: Float32Array = vec({ birch: 0.55, bush: 0.45 });

export function biomeFromClimate(climate: ClimateProfile | undefined, lat: number): Biome {
  const alat = Math.abs(lat);
  if (!climate) {
    if (alat < 20) return 'tropical';
    if (alat < 35) return 'mediterranean';
    if (alat < 52) return 'temperateEU';
    if (alat < 60) return 'hemiboreal';
    if (alat < 67) return 'boreal';
    return 'polar';
  }
  const code = climate.koppen;
  const a = code[0];
  const second = code[1] ?? '';
  const third = code[2] ?? '';
  const na = climate.theme === 'northAmerican';
  if (a === 'A') return 'tropical';
  if (a === 'B') return second === 'S' ? 'steppe' : 'arid';
  if (a === 'E') return 'polar';
  if (a === 'C' && second === 's') return 'mediterranean';
  if (a === 'D' && (third === 'c' || third === 'd')) return 'boreal';
  if (a === 'C' || a === 'D') {
    if (alat >= 58 && !na) return 'hemiboreal';
    if (alat >= 56 && a === 'D' && !na) return 'hemiboreal';
    if (na) return alat >= 50 && a === 'D' ? 'boreal' : 'temperateNA';
    return 'temperateEU';
  }
  return 'temperateEU';
}

/** Warmest-month mean temperature at the selection centre, with a latitude fallback. */
export function warmestMonthC(climate: ClimateProfile | undefined, lat: number): number {
  if (climate && climate.monthlyMeanC.length === 12) return Math.max(...climate.monthlyMeanC);
  return Math.min(28, 34 - 0.3 * Math.abs(lat));
}
