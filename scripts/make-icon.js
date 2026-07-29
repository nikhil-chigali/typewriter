'use strict';

// Generates build/icon.ico (a 256x256 PNG-in-ICO) from a 16x16 pixel-art map.
// No dependencies: PNG is assembled by hand, ICO wraps it.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PALETTE = {
  '.': [0, 0, 0, 0],
  C: [0xf5, 0xed, 0xe0, 255], // cream
  D: [0x22, 0x22, 0x22, 255], // ink
  K: [0x11, 0x11, 0x11, 255], // border
  R: [0xc1, 0x44, 0x3c, 255], // red
  G: [0x44, 0x44, 0x44, 255], // roller
};

const ART = [
  '................',
  '...CCCCCCCCCC...',
  '...CCCCCCCCCC...',
  '...CCCCCCCCCC...',
  '..KKKKKKKKKKKK..',
  '..KGGGGGGGGGGK..',
  '..KKKKKKKKKKKK..',
  '.KKRRRRRRRRRRKK.',
  '.KRRDDDDDDDDRRK.',
  '.KRRCCCCCCCCRRK.',
  '.KRRRRRRRRRRRRK.',
  '.KRCRCRCRCRCRCK.',
  '.KRRRRRRRRRRRRK.',
  '.KRCRCRCRCRCRCK.',
  '.KKKKKKKKKKKKKK.',
  '................',
];

const SCALE = 16;
const SIZE = ART.length * SCALE; // 256

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function buildPng() {
  // Raw scanlines: one filter byte (0 = none) followed by RGBA pixels.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0;
    const row = ART[Math.floor(y / SCALE)];
    for (let x = 0; x < SIZE; x++) {
      const px = PALETTE[row[Math.floor(x / SCALE)]] || PALETTE['.'];
      raw[o++] = px[0];
      raw[o++] = px[1];
      raw[o++] = px[2];
      raw[o++] = px[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO

function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0;  // width 256 is encoded as 0
  entry[1] = 0;  // height 256
  entry[2] = 0;  // palette size
  entry[3] = 0;  // reserved
  entry.writeUInt16LE(1, 4);            // colour planes
  entry.writeUInt16LE(32, 6);           // bits per pixel
  entry.writeUInt32LE(png.length, 8);   // size
  entry.writeUInt32LE(22, 12);          // offset

  return Buffer.concat([header, entry, png]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildIco(buildPng()));
console.log(`wrote ${out}`);
