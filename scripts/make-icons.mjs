// 앱 아이콘 PNG 생성 (외부 라이브러리 없이): 초록 배경 + 상승 그래프 선
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
fs.mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function makeIcon(size) {
  const bg = [31, 92, 74];
  const fg = [255, 255, 255];
  const sun = [233, 162, 59];
  // 0..1 좌표의 상승 선 (아이콘 안쪽 안전 영역에 배치)
  const line = [[0.2, 0.68], [0.38, 0.52], [0.52, 0.6], [0.8, 0.32]];
  const thick = 0.055;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let col = bg;
      // 해(아침) 원
      const ds = Math.hypot(u - 0.7, v - 0.3);
      let a = 0;
      let c2 = col;
      if (ds < 0.11) { c2 = sun; a = Math.min(1, (0.11 - ds) * size); }
      col = col.map((c, i) => c + (c2[i] - c) * a);
      // 그래프 선 (안티앨리어싱)
      let d = Infinity;
      for (let i = 0; i < line.length - 1; i++) d = Math.min(d, distToSeg(u, v, ...line[i], ...line[i + 1]));
      const cov = Math.max(0, Math.min(1, (thick / 2 - d) * size + 0.5));
      col = col.map((c, i) => c + (fg[i] - c) * cov);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${s}.png`), makeIcon(s));
  console.log(`icons/icon-${s}.png`);
}
