// Renders the Decltr icon (a rounded gradient square holding three tidy tab bars)
// to PNG files with no dependencies. Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(out, { recursive: true });

// Signed distance to a rounded rectangle centered at (cx, cy) with half-size (hx, hy).
const sdRoundRect = (x, y, cx, cy, hx, hy, r) => {
  const qx = Math.abs(x - cx) - (hx - r);
  const qy = Math.abs(y - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  const top = [99, 102, 241]; // indigo
  const bottom = [168, 85, 247]; // violet

  // Three bars in a 0..1 box: [centerX, centerY, halfWidth, halfHeight]
  const bars = [
    [0.5, 0.33, 0.27, 0.058],
    [0.5, 0.5, 0.2, 0.058],
    [0.5, 0.67, 0.13, 0.058],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.23) > 0) continue;
          let col = mix(top, bottom, (u + v) / 2);
          let alpha = 1;
          for (const [cx, cy, hx, hy] of bars) {
            if (sdRoundRect(u, v, cx, cy, hx, hy, hy) <= 0) {
              col = [255, 255, 255];
              break;
            }
          }
          r += col[0] * alpha; g += col[1] * alpha; b += col[2] * alpha; a += alpha;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const raw = render(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The store logo (Edge Add-ons asks for 300x300) lives outside the extension, so it is not packaged.
const store = join(dirname(fileURLToPath(import.meta.url)), '..', 'store');
mkdirSync(store, { recursive: true });
writeFileSync(join(store, 'logo-300.png'), png(300));
console.log('store/logo-300.png');
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(out, `icon${size}.png`), png(size));
  console.log(`icons/icon${size}.png`);
}
