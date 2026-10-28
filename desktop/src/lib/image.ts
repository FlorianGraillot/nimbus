/**
 * Shared browser-side image helpers. Both profile pictures and message
 * pictures are decoded once, drawn onto a canvas and re-encoded as WebP so
 * the bytes that reach the server are small and predictable.
 */
export type DecodedImage = ImageBitmap | HTMLImageElement;

export async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Honour EXIF rotation so phone photos do not come out sideways.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    // The decoded element keeps its own copy, so the blob URL can go.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  // Very old runtimes: fall back to JPEG, which is always available.
  return canvas.toDataURL('image/jpeg', quality);
}

export function closeImage(image: DecodedImage): void {
  if ('close' in image) image.close();
}

/** Approximate decoded size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((payload.length * 3) / 4);
}
