// png-squeeze: lossless PNG re-encoder.
// Reads each /input/<id>/image.png (1280x720 RGBA stored PNG) and writes the
// same pixels back as the smallest PNG it can: colour-type reduction
// (grey / palette / RGB / RGBA), per-row adaptive filter choice by MSAD,
// zlib level 9. Zero dependencies (node:fs, node:path, node:zlib only).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC32 (table-based) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG decode to RGBA ----------
interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array; // width*height*4
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const out = new Uint8Array(rowBytes * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const rowOff = y * rowBytes;
    const prevOff = rowOff - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src++];
      const left = x >= bpp ? out[rowOff + x - bpp] : 0;
      const up = y > 0 ? out[prevOff + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevOff + x - bpp] : 0;
      let recon: number;
      switch (filter) {
        case 0: recon = v; break;
        case 1: recon = v + left; break;
        case 2: recon = v + up; break;
        case 3: recon = v + ((left + up) >> 1); break;
        case 4: recon = v + paeth(left, up, upLeft); break;
        default: throw new Error('bad filter ' + filter);
      }
      out[rowOff + x] = recon & 0xff;
    }
  }
  return out;
}

function decodePng(buf: Buffer): Decoded {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idatParts: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idatParts));
  const px = unfilter(raw, width, height, channels);
  const rgba = new Uint8Array(width * height * 4);
  const n = width * height;
  if (colorType === 6) {
    rgba.set(px);
  } else if (colorType === 2) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = px[i * 3];
      rgba[i * 4 + 1] = px[i * 3 + 1];
      rgba[i * 4 + 2] = px[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < n; i++) {
      const g = px[i * 2];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = px[i * 2 + 1];
    }
  } else if (colorType === 0) {
    for (let i = 0; i < n; i++) {
      const g = px[i];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    throw new Error('unsupported colour type ' + colorType);
  }
  return { width, height, rgba };
}

// ---------- PNG encode ----------
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function filterRow(
  filter: number,
  cur: Uint8Array,
  curOff: number,
  prev: Uint8Array | null,
  prevOff: number,
  rowBytes: number,
  bpp: number,
  dest: Uint8Array,
  destOff: number
): void {
  for (let x = 0; x < rowBytes; x++) {
    const v = cur[curOff + x];
    const left = x >= bpp ? cur[curOff + x - bpp] : 0;
    const up = prev ? prev[prevOff + x] : 0;
    const upLeft = prev && x >= bpp ? prev[prevOff + x - bpp] : 0;
    let pred: number;
    switch (filter) {
      case 0: pred = 0; break;
      case 1: pred = left; break;
      case 2: pred = up; break;
      case 3: pred = (left + up) >> 1; break;
      default: pred = paeth(left, up, upLeft); break;
    }
    dest[destOff + x] = (v - pred) & 0xff;
  }
}

function msad(buf: Uint8Array, off: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[off + i];
    s += b <= 127 ? b : 256 - b;
  }
  return s;
}

/** Filter every row adaptively (MSAD-minimal filter per row). Returns the filtered stream. */
function filterAdaptive(raw: Uint8Array, width: number, height: number, bpp: number): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc(height * (rowBytes + 1));
  const scratch = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const curOff = y * rowBytes;
    const prev = y > 0 ? raw : null;
    const prevOff = curOff - rowBytes;
    const outOff = y * (rowBytes + 1);
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      filterRow(f, raw, curOff, prev, prevOff, rowBytes, bpp, scratch, 0);
      const score = msad(scratch, 0, rowBytes);
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        out.set(scratch, outOff + 1);
      }
    }
    out[outOff] = bestFilter;
  }
  return out;
}

/** Filter every row with one fixed filter type. Returns the filtered stream. */
function filterFixed(
  raw: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  filter: number
): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const curOff = y * rowBytes;
    const prev = y > 0 ? raw : null;
    const prevOff = curOff - rowBytes;
    const outOff = y * (rowBytes + 1);
    out[outOff] = filter;
    filterRow(filter, raw, curOff, prev, prevOff, rowBytes, bpp, out, outOff + 1);
  }
  return out;
}

interface Candidate {
  colorType: number;
  raw: Uint8Array; // unfiltered pixel rows in this colour type's layout
  bpp: number;
  plte?: Uint8Array;
  trns?: Uint8Array;
}

function assemble(width: number, height: number, cand: Candidate, filtered: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = cand.colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  const compressed = deflateSync(filtered, { level: 9, memLevel: 9 });
  const parts: Buffer[] = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
  ];
  if (cand.plte) parts.push(chunk('PLTE', cand.plte));
  if (cand.trns) parts.push(chunk('tRNS', cand.trns));
  parts.push(chunk('IDAT', compressed));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}

function encodeCandidate(width: number, height: number, cand: Candidate): Buffer {
  // Try both the adaptive (per-row MSAD) stream and a fixed-Paeth stream;
  // MSAD is a heuristic, so on some rows the uniform Paeth stream deflates
  // smaller. Keep whichever complete PNG is fewer bytes.
  const adaptive = assemble(width, height, cand, filterAdaptive(cand.raw, width, height, cand.bpp));
  const paeth = assemble(width, height, cand, filterFixed(cand.raw, width, height, cand.bpp, 4));
  return paeth.length < adaptive.length ? paeth : adaptive;
}

// ---------- re-encode one image ----------
function reencode(img: Decoded): Buffer {
  const { width, height, rgba } = img;
  const n = width * height;

  // Analyse once.
  let allOpaque = true;
  let allGrey = true;
  const uniq = new Map<number, number>(); // rgba key -> palette index (first-seen order)
  let tooManyColors = false;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) allGrey = false;
    if (!tooManyColors) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!uniq.has(key)) {
        if (uniq.size >= 256) tooManyColors = true;
        else uniq.set(key, uniq.size);
      }
    }
  }

  const candidates: Candidate[] = [];

  // Direct candidate (grey / RGB / RGBA).
  if (allGrey) {
    if (allOpaque) {
      const raw = new Uint8Array(n);
      for (let i = 0; i < n; i++) raw[i] = rgba[i * 4];
      candidates.push({ colorType: 0, raw, bpp: 1 });
    } else {
      const raw = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        raw[i * 2] = rgba[i * 4];
        raw[i * 2 + 1] = rgba[i * 4 + 3];
      }
      candidates.push({ colorType: 4, raw, bpp: 2 });
    }
  } else if (allOpaque) {
    const raw = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      raw[i * 3] = rgba[i * 4];
      raw[i * 3 + 1] = rgba[i * 4 + 1];
      raw[i * 3 + 2] = rgba[i * 4 + 2];
    }
    candidates.push({ colorType: 2, raw, bpp: 3 });
  } else {
    candidates.push({ colorType: 6, raw: rgba, bpp: 4 });
  }

  // Palette candidate when the colour count fits.
  if (!tooManyColors) {
    const count = uniq.size;
    const plte = new Uint8Array(count * 3);
    const alphas = new Uint8Array(count);
    for (const [key, idx] of uniq) {
      plte[idx * 3] = (key >>> 24) & 0xff;
      plte[idx * 3 + 1] = (key >>> 16) & 0xff;
      plte[idx * 3 + 2] = (key >>> 8) & 0xff;
      alphas[idx] = key & 0xff;
    }
    let trnsLen = count;
    while (trnsLen > 0 && alphas[trnsLen - 1] === 255) trnsLen--;
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const key =
        ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
      raw[i] = uniq.get(key) as number;
    }
    candidates.push({
      colorType: 3,
      raw,
      bpp: 1,
      plte,
      trns: trnsLen > 0 ? alphas.subarray(0, trnsLen) : undefined,
    });
  }

  let best: Buffer | null = null;
  for (const cand of candidates) {
    const png = encodeCandidate(width, height, cand);
    if (best === null || png.length < best.length) best = png;
  }
  return best as Buffer;
}

// ---------- main ----------
const ids = readdirSync(INPUT_DIR).sort();
for (const id of ids) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  let buf: Buffer;
  try {
    buf = readFileSync(inPath);
  } catch {
    continue;
  }
  const img = decodePng(buf);
  const out = reencode(img);
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'image.png'), out);
}
