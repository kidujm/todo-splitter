'use strict';

/**
 * 픽셀 고양이 아이콘(icon.ico)을 만든다. 외부 패키지 없이 ICO 파일을 직접 쓴다.
 *   node tools/make-icon.js
 *
 * 아래 MAP이 그림 전부다. 글자 하나가 1픽셀:
 *   _ 투명 · b 테두리(먹색) · L 배경(레몬) · w 얼굴(크림) · p 볼(분홍)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PALETTE = {
  _: null,
  b: '#2d2a3e',
  L: '#ffd670',
  w: '#fff5e4',
  p: '#ff8fab',
};

const MAP = [
  '_bbbbbbbbbbbbbb_',
  'bLLLLLLLLLLLLLLb',
  'bLLLLLLLLLLLLLLb',
  'bL.bb......bb.Lb',
  'bL.bwb....bwb.Lb',
  'bL.bwwbbbbwwb.Lb',
  'bLbwwwwwwwwwwbLb',
  'bLbwbbwwwwbbwbLb',
  'bLbwbbwwwwbbwbLb',
  'bLbpwwwbbwwwpbLb',
  'bLbwwwbwwbwwwbLb',
  'bLbwwwwbbwwwwbLb',
  'bL.bwwwwwwwwb.Lb',
  'bL..bbbbbbbb..Lb',
  'bLLLLLLLLLLLLLLb',
  '_bbbbbbbbbbbbbb_',
];

// 고양이 바깥의 '.'은 배경색으로 채운다 (그림 그릴 때 눈이 편하라고 남겨둔 표시)
const SIZE = 16;
const grid = MAP.map((row) => [...row].map((ch) => (ch === '.' ? 'L' : ch)));

for (const [y, row] of grid.entries()) {
  if (row.length !== SIZE) throw new Error(`${y}번째 줄이 ${row.length}칸입니다. ${SIZE}칸이어야 합니다.`);
}
if (grid.length !== SIZE) throw new Error(`${grid.length}줄입니다. ${SIZE}줄이어야 합니다.`);

function rgba(ch) {
  const hex = PALETTE[ch];
  if (hex === undefined) throw new Error(`팔레트에 없는 글자: ${ch}`);
  if (hex === null) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
    a: 255,
  };
}

/** 16x16 원본을 정수배로 늘린다. 픽셀이 흐려지지 않게 최근접 확대만 쓴다. */
function scaled(size) {
  if (size % SIZE !== 0) throw new Error(`${size}는 ${SIZE}의 배수가 아닙니다.`);
  const factor = size / SIZE;
  const out = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      row.push(rgba(grid[Math.floor(y / factor)][Math.floor(x / factor)]));
    }
    out.push(row);
  }
  return out;
}

/**
 * ICO 안에 들어가는 한 장. BITMAPINFOHEADER + BGRA 픽셀 + 1비트 마스크.
 * BMP는 아래에서 위로 쌓이므로 행을 뒤집어 넣는다.
 */
function bmpImage(size) {
  const pixels = scaled(size);

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: 그림 + 마스크라서 두 배
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  let at = 0;
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
      const { r, g, b, a } = pixels[y][x];
      xor[at] = b;
      xor[at + 1] = g;
      xor[at + 2] = r;
      xor[at + 3] = a;
      at += 4;
    }
  }

  // 마스크는 한 줄을 4바이트 단위로 맞춰야 한다
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size);
  for (let y = size - 1, row = 0; y >= 0; y -= 1, row += 1) {
    for (let x = 0; x < size; x += 1) {
      if (pixels[y][x].a !== 0) continue; // 투명한 칸만 마스크를 세운다
      and[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  return Buffer.concat([header, xor, and]);
}

/* ── 256px용 PNG 인코더 ──────────────────────
   큰 아이콘은 PNG로 넣는 게 ICO 표준이다. BMP로 넣으면 윈도우가
   더 작은 항목을 늘려 쓰면서 픽셀이 뭉개진다. */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngImage(size) {
  const pixels = scaled(size);

  // 스캔라인마다 필터 바이트(0 = 필터 없음)를 앞에 붙인다
  const raw = Buffer.alloc(size * (1 + size * 4));
  let at = 0;
  for (let y = 0; y < size; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < size; x += 1) {
      const { r, g, b, a } = pixels[y][x];
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
      at += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 채널당 8비트
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // 압축 방식
  ihdr[11] = 0; // 필터 방식
  ihdr[12] = 0; // 인터레이스 없음

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(sizes) {
  // 256 이상은 PNG, 그 아래는 BMP. 옛 윈도우도 작은 크기는 BMP로 읽는다.
  const images = sizes.map((size) => (size >= 256 ? pngImage(size) : bmpImage(size)));

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // 예약
  dir.writeUInt16LE(1, 2); // 1 = 아이콘
  dir.writeUInt16LE(sizes.length, 4);

  const entries = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;

  sizes.forEach((size, i) => {
    const base = i * 16;
    entries[base] = size >= 256 ? 0 : size; // 0은 256을 뜻한다
    entries[base + 1] = size >= 256 ? 0 : size;
    entries[base + 2] = 0; // 팔레트 없음
    entries[base + 3] = 0; // 예약
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bpp
    entries.writeUInt32LE(images[i].length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += images[i].length;
  });

  return Buffer.concat([dir, entries, ...images]);
}

const target = path.join(__dirname, '..', 'icon.ico');
const ico = buildIco([16, 32, 48, 64, 128, 256]);
fs.writeFileSync(target, ico);
console.log(`아이콘을 만들었습니다: ${target} (${ico.length.toLocaleString()} 바이트, 6가지 크기)`);
