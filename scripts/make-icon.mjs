// Generates build/icon.ico (256x256, PNG-embedded): teal map pin on a dark rounded square. No external assets.
import { encode } from 'fast-png';
import { mkdirSync, writeFileSync } from 'node:fs';

const N = 256;
const px = new Uint8Array(N * N * 4);
const bg = [14, 19, 23];
const teal = [45, 212, 191];
const R = 44;
const inRound = (x, y) => {
  const cx = Math.min(Math.max(x, R), N - 1 - R);
  const cy = Math.min(Math.max(y, R), N - 1 - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
const hx = 128, hy = 105, hr = 62, tipY = 215;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!inRound(x, y)) continue;
    const d = Math.hypot(x - hx, y - hy);
    const head = d <= hr;
    const tip = y >= hy && y <= tipY && Math.abs(x - hx) <= (hr * (tipY - y)) / (tipY - hy);
    const c = (head || tip) && d > 24 ? teal : bg;
    const i = (y * N + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
}
const png = Buffer.from(encode({ width: N, height: N, data: px, channels: 4, depth: 8 }));
const hdr = Buffer.alloc(22);
hdr.writeUInt16LE(1, 2); // type: icon
hdr.writeUInt16LE(1, 4); // one image
hdr.writeUInt16LE(1, 10); // planes
hdr.writeUInt16LE(32, 12); // bpp
hdr.writeUInt32LE(png.length, 14);
hdr.writeUInt32LE(22, 18);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.ico', Buffer.concat([hdr, png]));
console.log('build/icon.ico written');
