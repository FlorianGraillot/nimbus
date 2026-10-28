import { HttpError } from './access.js';

/**
 * Shared image plumbing for anything the client uploads as a data URL
 * (profile pictures, message pictures). The desktop client already crops and
 * resizes before uploading, but the server still checks what it is handed:
 * a real PNG/JPEG/WebP within a size budget.
 */
export type ImageMime = 'image/webp' | 'image/png' | 'image/jpeg';

const DATA_URL = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const MIME: Record<string, ImageMime> = { webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg' };

/** Reads the magic bytes rather than trusting the declared MIME type. */
export function sniffImage(bytes: Buffer): ImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface ParsedImage {
  /** Normalised data URL, safe to store and re-serve. */
  dataUrl: string;
  mime: ImageMime;
  bytes: Buffer;
}

/** Validates a client-supplied data URL, or throws a 400/413. */
export function parseImageDataUrl(input: string, maxBytes: number): ParsedImage {
  const match = DATA_URL.exec(input.trim());
  if (!match) {
    throw new HttpError(400, 'That image format is not supported. Use a PNG, JPEG or WebP picture.');
  }

  const declared = MIME[match[1]];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'That image looks empty.');
  if (bytes.length > maxBytes) throw new HttpError(413, 'That picture is too large. Try a smaller one.');

  const actual = sniffImage(bytes);
  if (!actual || actual !== declared) {
    throw new HttpError(400, 'That file is not a valid PNG, JPEG or WebP picture.');
  }

  return { dataUrl: `data:${actual};base64,${bytes.toString('base64')}`, mime: actual, bytes };
}

/** Reads a stored data URL back into bytes for serving. */
export function readImageDataUrl(
  dataUrl: string | null,
  maxBytes: number,
): { mime: ImageMime; bytes: Buffer } | null {
  if (!dataUrl) return null;
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  return { mime: MIME[match[1]], bytes };
}
