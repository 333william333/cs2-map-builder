/** Uniform-grid spatial hashes for segments and points (insert-only, owner flags handled by callers). */

const OFF = 1 << 15;
const cellKey = (cx: number, cz: number) => (cx + OFF) * 65536 + (cz + OFF);

class Growable {
  a: Float64Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Float64Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

export class SegGrid {
  readonly cell: number;
  readonly buckets = new Map<number, number[]>();
  private ax = new Growable();
  private az = new Growable();
  private bx = new Growable();
  private bz = new Growable();
  private ow = new Growable();
  private ix = new Growable();
  private stamp = new Uint32Array(1024);
  private cur = 0;
  count = 0;

  constructor(cell: number) {
    this.cell = cell;
  }

  get(id: number): [number, number, number, number] {
    return [this.ax.a[id], this.az.a[id], this.bx.a[id], this.bz.a[id]];
  }
  owner(id: number) {
    return this.ow.a[id];
  }
  aux(id: number) {
    return this.ix.a[id];
  }
  x1(id: number) { return this.ax.a[id]; }
  z1(id: number) { return this.az.a[id]; }
  x2(id: number) { return this.bx.a[id]; }
  z2(id: number) { return this.bz.a[id]; }

  add(ax: number, az: number, bx: number, bz: number, owner: number, aux = 0): number {
    const id = this.count++;
    this.ax.push(ax);
    this.az.push(az);
    this.bx.push(bx);
    this.bz.push(bz);
    this.ow.push(owner);
    this.ix.push(aux);
    const c = this.cell;
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (c * 0.5)));
    let last = -1;
    let px = ax;
    let pz = az;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const qx = ax + (bx - ax) * t;
      const qz = az + (bz - az) * t;
      const x0 = Math.floor(Math.min(px, qx) / c);
      const x1 = Math.floor(Math.max(px, qx) / c);
      const z0 = Math.floor(Math.min(pz, qz) / c);
      const z1 = Math.floor(Math.max(pz, qz) / c);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = cellKey(cx, cz);
          if (key === last) continue;
          let b = this.buckets.get(key);
          if (!b) {
            b = [];
            this.buckets.set(key, b);
          }
          if (b[b.length - 1] !== id) b.push(id);
          last = key;
        }
      }
      px = qx;
      pz = qz;
    }
    return id;
  }

  /** visit every segment whose cells overlap the box (each once) */
  query(minx: number, minz: number, maxx: number, maxz: number, cb: (id: number) => void) {
    if (this.stamp.length < this.count) {
      const s = new Uint32Array(Math.max(this.count, this.stamp.length * 2));
      s.set(this.stamp);
      this.stamp = s;
    }
    this.cur++;
    if (this.cur === 0xffffffff) {
      this.stamp.fill(0);
      this.cur = 1;
    }
    const c = this.cell;
    const x0 = Math.floor(minx / c);
    const x1 = Math.floor(maxx / c);
    const z0 = Math.floor(minz / c);
    const z1 = Math.floor(maxz / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const b = this.buckets.get(cellKey(cx, cz));
        if (!b) continue;
        for (const id of b) {
          if (this.stamp[id] === this.cur) continue;
          this.stamp[id] = this.cur;
          cb(id);
        }
      }
    }
  }
}

export class PointGrid {
  readonly cell: number;
  private buckets = new Map<number, number[]>();
  xs: number[] = [];
  zs: number[] = [];
  ids: number[] = [];
  constructor(cell: number) {
    this.cell = cell;
  }
  add(x: number, z: number, id: number) {
    const k = cellKey(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let b = this.buckets.get(k);
    if (!b) {
      b = [];
      this.buckets.set(k, b);
    }
    b.push(this.xs.length);
    this.xs.push(x);
    this.zs.push(z);
    this.ids.push(id);
  }
  /** visit entries within radius r: cb(id, distance) */
  near(x: number, z: number, r: number, cb: (id: number, d: number) => void) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c);
    const z1 = Math.floor((z + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const b = this.buckets.get(cellKey(cx, cz));
        if (!b) continue;
        for (const e of b) {
          const d = Math.hypot(this.xs[e] - x, this.zs[e] - z);
          if (d <= r) cb(this.ids[e], d);
        }
      }
    }
  }
}
