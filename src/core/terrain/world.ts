import { downsampleArea } from './filters';

/** Centre region [lo, hi) in world cells that covers the playable area (the centre quarter). */
export function centreRegion(Nw: number): { lo: number; hi: number } {
  const lo = Math.round((Nw * 3) / 8);
  const hi = Math.round((Nw * 5) / 8);
  return { lo, hi };
}

/**
 * Overwrites the world grid's centre quarter with the area-averaged playable grid (CS2 requires them
 * to match) and fades the difference out over a narrow band so there is no seam.
 */
export function embedPlayable(
  world: Float32Array, Nw: number, play: Float32Array, Np: number, bandFraction = 1 / 16,
): void {
  const { lo, hi } = centreRegion(Nw);
  const S = hi - lo;
  const centre = downsampleArea(play, Np, S);
  const diff = new Float32Array(S * S);
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const wi = (lo + r) * Nw + lo + c;
      diff[r * S + c] = centre[r * S + c] - world[wi];
      world[wi] = centre[r * S + c];
    }
  }
  const B = Math.max(4, Math.round(S * bandFraction));
  // The difference along each edge is extended outward and blurred along the edge by a window that
  // grows with the distance, so fine detail of the playable edge does not streak into the world.
  const prefix = (get: (k: number) => number) => {
    const P = new Float64Array(S + 1);
    for (let k = 0; k < S; k++) P[k + 1] = P[k] + get(k);
    return P;
  };
  const top = prefix((k) => diff[k]);
  const bottom = prefix((k) => diff[(S - 1) * S + k]);
  const left = prefix((k) => diff[k * S]);
  const right = prefix((k) => diff[k * S + S - 1]);
  const win = (P: Float64Array, k: number, d: number) => {
    const a = Math.max(0, k - d), b = Math.min(S - 1, k + d);
    return (P[b + 1] - P[a]) / (b - a + 1);
  };
  const r0 = Math.max(0, lo - B);
  const r1 = Math.min(Nw - 1, hi - 1 + B);
  for (let r = r0; r <= r1; r++) {
    const dr = r < lo ? lo - r : r >= hi ? r - (hi - 1) : 0;
    for (let c = r0; c <= r1; c++) {
      const dc = c < lo ? lo - c : c >= hi ? c - (hi - 1) : 0;
      if (dr === 0 && dc === 0) continue;
      const dist = Math.hypot(dr, dc);
      if (dist >= B) continue;
      const rowSide = r < lo ? top : bottom;
      const colSide = c < lo ? left : right;
      let d: number;
      if (dc === 0) d = win(rowSide, c - lo, dr - 1);
      else if (dr === 0) d = win(colSide, r - lo, dc - 1);
      else {
        const rad = Math.round(dist) - 1;
        d = 0.5 * (win(rowSide, c < lo ? 0 : S - 1, rad) + win(colSide, r < lo ? 0 : S - 1, rad));
      }
      const u = dist / B;
      world[r * Nw + c] += d * (1 - u * u * (3 - 2 * u));
    }
  }
}

/**
 * Water kind and surface level of the world centre quarter from the playable grid: majority kind of
 * each block (water when at least half of it is water), mean surface of its water cells.
 */
export function embedPlayableWater(
  wWater: Uint8Array, wLevel: Float32Array, Nw: number,
  pWater: Uint8Array, pLevel: Float32Array, Np: number,
): void {
  const { lo, hi } = centreRegion(Nw);
  const S = hi - lo;
  const f = Np / S;
  const cnt = [0, 0, 0, 0];
  for (let r = 0; r < S; r++) {
    const pr0 = Math.floor(r * f), pr1 = Math.max(pr0 + 1, Math.floor((r + 1) * f));
    for (let c = 0; c < S; c++) {
      const pc0 = Math.floor(c * f), pc1 = Math.max(pc0 + 1, Math.floor((c + 1) * f));
      cnt[0] = cnt[1] = cnt[2] = cnt[3] = 0;
      let sum = 0, nl = 0;
      for (let pr = pr0; pr < pr1; pr++) {
        for (let pc = pc0; pc < pc1; pc++) {
          const i = pr * Np + pc;
          const k = pWater[i];
          cnt[k]++;
          if (k !== 0 && pLevel[i] === pLevel[i]) { sum += pLevel[i]; nl++; }
        }
      }
      const total = (pr1 - pr0) * (pc1 - pc0);
      const wi = (lo + r) * Nw + lo + c;
      if (cnt[1] + cnt[2] + cnt[3] >= total / 2 && nl > 0) {
        let k = 1;
        if (cnt[2] > cnt[k]) k = 2;
        if (cnt[3] > cnt[k]) k = 3;
        wWater[wi] = k;
        wLevel[wi] = sum / nl;
      } else {
        wWater[wi] = 0;
        wLevel[wi] = NaN;
      }
    }
  }
}
