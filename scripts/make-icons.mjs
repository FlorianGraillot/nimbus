#!/usr/bin/env node
/**
 * Rebuilds the Windows app icons from the supplied Nimbus artwork.
 *
 *   node scripts/make-icons.mjs
 *
 * Source:  desktop/src/assets/nimbus-logo.png  (the artwork used in the app)
 * Outputs: desktop/build/icon.png   (512×512, used by Electron at runtime)
 *          desktop/build/icon.ico   (16/24/32/48/64/128/256, used by Windows)
 *
 * Pure Node: a small PNG decoder, box-filter downscaler and ICO container writer,
 * so no native image tooling is required.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'desktop', 'build');
const sourcePath = join(root, 'desktop', 'src', 'assets', 'nimbus-logo.png');

/* ------------------------------ PNG decoder ------------------------------ */

const PNG_SIGNATURE = 0x89504e47;

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== PNG_SIGNATURE) throw new Error('Not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error('Icon source must be an 8-bit RGBA, non-interlaced PNG');
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(width * height * bpp);
  let position = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const row = y * stride;
    const previous = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[position];
      position += 1;
      const left = x >= bpp ? pixels[row + x - bpp] : 0;
      const up = y > 0 ? pixels[previous + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[previous + x - bpp] : 0;
      let result;

      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          result = value + predictor;
          break;
        }
        default:
          throw new Error(`Unsupported PNG filter ${filter}`);
      }

      pixels[row + x] = result & 0xff;
    }
  }

  return { width, height, pixels };
}

/* -------------------------------- resizing ------------------------------- */

/** Area-average resize with premultiplied alpha (crisp, no dark fringes). */
function resize(source, size) {
  const { width, height, pixels } = source;
  const out = Buffer.alloc(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 4;
          const alpha = pixels[index + 3];
          r += pixels[index] * alpha;
          g += pixels[index + 1] * alpha;
          b += pixels[index + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }

      const index = (y * size + x) * 4;
      if (a === 0) continue;
      out[index] = Math.round(r / a);
      out[index + 1] = Math.round(g / a);
      out[index + 2] = Math.round(b / a);
      out[index + 3] = Math.round(a / count);
    }
  }

  return out;
}

/* --------------------------------- PNG ----------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- ICO ----------------------------------- */

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

/* --------------------------------- main ---------------------------------- */

mkdirSync(outDir, { recursive: true });

const source = decodePng(readFileSync(sourcePath));
console.log(`source     ${source.width}×${source.height}  ${sourcePath}`);

const png = encodePng(512, resize(source, 512));
writeFileSync(join(outDir, 'icon.png'), png);
console.log(`icon.png   512×512  ${(png.length / 1024).toFixed(1)} KiB`);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeIco(sizes.map((size) => ({ size, png: encodePng(size, resize(source, size)) })));
writeFileSync(join(outDir, 'icon.ico'), ico);
console.log(`icon.ico   ${sizes.join(', ')}  ${(ico.length / 1024).toFixed(1)} KiB`);
