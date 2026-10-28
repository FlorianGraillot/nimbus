import { parseImageDataUrl, readImageDataUrl, type ImageMime } from './images.js';

/**
 * Profile pictures arrive already square-cropped and resized by the desktop
 * client (see `desktop/src/lib/avatar.ts`). They live in SQLite as data URLs
 * rather than on disk, so a Nimbus install is still a single database file.
 */
const MAX_BYTES = 160 * 1024;

export type AvatarMime = ImageMime;
export type ParsedAvatar = ReturnType<typeof parseImageDataUrl>;

/** Validates a client-supplied data URL, or throws a 400. */
export function parseAvatarDataUrl(input: string): ParsedAvatar {
  return parseImageDataUrl(input, MAX_BYTES);
}

/** Reads a stored data URL back into bytes for serving. */
export function readAvatarData(dataUrl: string | null): { mime: AvatarMime; bytes: Buffer } | null {
  return readImageDataUrl(dataUrl, MAX_BYTES);
}
