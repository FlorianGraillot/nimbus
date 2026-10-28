import { canvasToDataUrl, closeImage, decodeImage, type DecodedImage } from './image';

/**
 * Turns a picked file into a square, reasonably small profile picture.
 *
 * The picture is centre-cropped (like Discord) rather than letterboxed, resized
 * to 256×256 and encoded as WebP. If the result is still heavy for the JSON
 * budget, quality and then size step down until it fits.
 */
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const TARGET_CHARS = 96_000;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const SIZES = [256, 224, 192];
const QUALITIES = [0.86, 0.74, 0.62];

export function isSupportedImage(file: File): boolean {
  return ACCEPTED.includes(file.type);
}

function toDataUrl(source: DecodedImage, size: number, quality: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare that picture');

  const width = 'width' in source ? source.width : 0;
  const height = 'height' in source ? source.height : 0;
  const side = Math.min(width, height);
  // Centre crop: take the largest square from the middle of the image.
  const sx = Math.max(0, Math.round((width - side) / 2));
  const sy = Math.max(0, Math.round((height - side) / 2));

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, sx, sy, side, side, 0, 0, size, size);

  return canvasToDataUrl(canvas, quality);
}

export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!isSupportedImage(file)) throw new Error('Choose a PNG, JPEG, WebP or GIF picture');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That picture is larger than 12 MB');

  const source = await decodeImage(file);
  try {
    let smallest = '';
    for (const size of SIZES) {
      for (const quality of QUALITIES) {
        const dataUrl = toDataUrl(source, size, quality);
        smallest = dataUrl;
        if (dataUrl.length <= TARGET_CHARS) return dataUrl;
      }
    }
    return smallest;
  } finally {
    closeImage(source);
  }
}
