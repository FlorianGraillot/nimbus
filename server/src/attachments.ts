import { signMediaId } from './auth.js';
import { parseImageDataUrl, readImageDataUrl } from './images.js';
import type { AttachmentDTO, AttachmentRow } from './types.js';

/**
 * Pictures sent as messages. The client downsizes them before uploading, so
 * these limits are generous safety rails rather than the normal path.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
/** Uploads that never get sent are deleted after a day. */
export const ORPHAN_TTL_MS = 1000 * 60 * 60 * 24;

/**
 * Image URLs are signed so a plain <img> can load them without an
 * Authorization header, while people outside the conversation still cannot
 * fetch them by guessing an id.
 */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}?sig=${signMediaId(id)}`;
}

export function serializeAttachment(row: AttachmentRow): AttachmentDTO {
  return {
    id: row.id,
    url: attachmentUrl(row.id),
    mime: row.mime,
    width: row.width,
    height: row.height,
    size: row.bytes,
  };
}

export function parseAttachmentDataUrl(input: string) {
  return parseImageDataUrl(input, MAX_ATTACHMENT_BYTES);
}

export function readAttachmentData(dataUrl: string | null) {
  return readImageDataUrl(dataUrl, MAX_ATTACHMENT_BYTES);
}
