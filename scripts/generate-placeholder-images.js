'use strict';

/**
 * generate-placeholder-images.js
 *
 * Creates minimal valid PNG placeholder images for the pass template.
 * Run once before starting the server in development:
 *
 *   node scripts/generate-placeholder-images.js
 *
 * Replace these with real artwork before going to production.
 * Required image dimensions (Apple Wallet spec):
 *
 *   icon.png      — 29×29   (shown on notification banner)
 *   icon@2x.png   — 58×58
 *   icon@3x.png   — 87×87
 *   logo.png      — 160×50  (top-left of pass)
 *   logo@2x.png   — 320×100
 *   strip.png     — 375×123 (background strip below header)
 *   strip@2x.png  — 750×246
 */

const fs   = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, '../passes/loyalty.pass');

// ── Minimal PNG encoder ───────────────────────────────────────────────────────
// We encode a raw uncompressed PNG using deflate with no compression (type 0).
// This avoids any external dependency while still producing a spec-valid PNG.

const zlib = require('zlib');

/**
 * Build a 4-byte big-endian Buffer from a number.
 */
function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/**
 * Compute CRC32 of a Buffer (PNG uses CRC32 for chunks).
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a single PNG chunk: length(4) + type(4) + data(n) + crc(4)
 */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const dataBytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const lenBytes  = u32be(dataBytes.length);
  const crcInput  = Buffer.concat([typeBytes, dataBytes]);
  const crcBytes  = u32be(crc32(crcInput));
  return Buffer.concat([lenBytes, typeBytes, dataBytes, crcBytes]);
}

/**
 * Create a solid-colour PNG of the given dimensions.
 *
 * @param {number} width
 * @param {number} height
 * @param {number[]} rgba  — [r, g, b, a] each 0–255
 * @returns {Buffer}
 */
function makePNG(width, height, [r, g, b, a = 255]) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width(4), height(4), bitDepth(1)=8, colorType(1)=6 (RGBA), ...
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 6;  // color type: RGBA
  ihdrData[10] = 0;  // compression: deflate
  ihdrData[11] = 0;  // filter: adaptive
  ihdrData[12] = 0;  // interlace: none

  // Build raw scanlines: each row is [filterByte=0, r, g, b, a, r, g, b, a, ...]
  const rowBytes = 1 + width * 4;
  const raw      = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px]     = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  // Compress scanlines with zlib (deflate)
  const compressed = zlib.deflateSync(raw, { level: 1 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Image definitions ─────────────────────────────────────────────────────────

// Brand red: rgb(180, 50, 30)   Semi-dark strip colour: rgb(160, 40, 20)
const BRAND_RED    = [180,  50,  30, 255];
const DARK_RED     = [140,  30,  15, 255];
const WHITE        = [255, 255, 255, 255];

const images = [
  // Icons (white on brand red)
  { name: 'icon.png',      w:  29,  h:  29,  color: BRAND_RED },
  { name: 'icon@2x.png',   w:  58,  h:  58,  color: BRAND_RED },
  { name: 'icon@3x.png',   w:  87,  h:  87,  color: BRAND_RED },

  // Logo (white background — the logo image is overlaid on the pass header)
  { name: 'logo.png',      w: 160,  h:  50,  color: WHITE     },
  { name: 'logo@2x.png',   w: 320,  h: 100,  color: WHITE     },

  // Strip image (rendered behind secondary/auxiliary fields on a storeCard)
  { name: 'strip.png',     w: 375,  h: 123,  color: DARK_RED  },
  { name: 'strip@2x.png',  w: 750,  h: 246,  color: DARK_RED  },
];

// ── Write files ───────────────────────────────────────────────────────────────

console.log(`Writing placeholder PNGs to ${TEMPLATE_DIR}\n`);

let created = 0;
let skipped = 0;

for (const img of images) {
  const dest = path.join(TEMPLATE_DIR, img.name);

  // Don't overwrite real artwork if it already exists and is larger than a
  // tiny placeholder (>2 KB is a reasonable heuristic).
  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest);
    if (stat.size > 2048) {
      console.log(`  SKIP  ${img.name}  (${stat.size} bytes — looks like real artwork)`);
      skipped++;
      continue;
    }
  }

  const png = makePNG(img.w, img.h, img.color);
  fs.writeFileSync(dest, png);
  console.log(`  WRITE ${img.name}  ${img.w}×${img.h}  (${png.length} bytes)`);
  created++;
}

console.log(`\nDone. Created ${created} file(s), skipped ${skipped} existing file(s).`);
console.log('Replace these placeholders with real artwork before going to production.\n');
