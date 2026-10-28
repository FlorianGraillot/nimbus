import { canvasToDataUrl, closeImage, dataUrlBytes, decodeImage } from './image';

/**
 * Prepares a picked picture for sending: longest edge at most 1600 px, WebP,
 * then step down until the encoded string fits comfortably in the upload
 * request. The data URL doubles as the local preview, so nothing has to be
 * re-read after sending.
 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const TARGET_CHARS = 1_500_000;
const EDGES = [1600, 1280, 1024];
const QUALITIES = [0.86, 0.72, 0.6];

/** Matches the server's limit (`MAX_ATTACHMENTS`). */
export const MAX_ATTACHMENTS = 4;

export interface PreparedAttachment {
  dataUrl: string;
  /** Same value as `dataUrl`; kept separate so the intent is obvious. */
  previewUrl: string;
  width: number;
  height: number;
  /** Decoded size in bytes. */
  size: number;
  name: string;
}

export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  if (!file.type.startsWith('image/')) throw new Error('Only pictures can be sent');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That picture is larger than 20 MB');

  const source = await decodeImage(file);
  try {
    const sourceWidth = 'width' in source ? source.width : 0;
    const sourceHeight = 'height' in source ? source.height : 0;
    if (!sourceWidth || !sourceHeight) throw new Error('Could not read that picture');

    let last: { dataUrl: string; width: number; height: number } | null = null;

    for (const edge of EDGES) {
      const scale = Math.min(1, edge / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));

      for (const quality of QUALITIES) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare that picture');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, width, height);

        const dataUrl = canvasToDataUrl(canvas, quality);
        last = { dataUrl, width, height };
        if (dataUrl.length <= TARGET_CHARS) {
          return {
            dataUrl,
            previewUrl: dataUrl,
            width,
            height,
            size: dataUrlBytes(dataUrl),
            name: file.name,
          };
        }
      }
    }

    if (!last) throw new Error('Could not prepare that picture');
    return {
      dataUrl: last.dataUrl,
      previewUrl: last.dataUrl,
      width: last.width,
      height: last.height,
      size: dataUrlBytes(last.dataUrl),
      name: file.name,
    };
  } finally {
    closeImage(source);
  }
}
