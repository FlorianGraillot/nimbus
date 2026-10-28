import { Router } from 'express';
import { z } from 'zod';
import { db, newId, now } from '../db.js';
import { requireAuth, verifyMediaSignature } from '../auth.js';
import { HttpError } from '../access.js';
import { parse } from '../validate.js';
import {
  ORPHAN_TTL_MS,
  parseAttachmentDataUrl,
  readAttachmentData,
  serializeAttachment,
} from '../attachments.js';
import type { AttachmentRow } from '../types.js';

export const mediaRouter = Router();

/**
 * Serves a message picture. Registered before the auth middleware: <img> tags
 * cannot send headers, so access is granted by the signature carried in the
 * URL (see `attachmentUrl`).
 */
mediaRouter.get('/:id', (req, res) => {
  const signature = String(req.query.sig ?? '');
  if (!verifyMediaSignature(req.params.id, signature)) {
    throw new HttpError(403, 'That image link is not valid');
  }
  const row = db.prepare('SELECT data FROM attachments WHERE id = ?').get(req.params.id) as
    | { data: string }
    | undefined;
  const image = readAttachmentData(row?.data ?? null);
  if (!image) throw new HttpError(404, 'Image not found');

  res.set('Content-Type', image.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  // The id is unique and its bytes never change, so this can be cached forever.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(image.bytes);
});

mediaRouter.use(requireAuth);

const uploadSchema = z.object({
  dataUrl: z.string().min(32).max(6_000_000, 'That picture is too large. Try a smaller one.'),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
});

/**
 * Uploads a picture and returns it unattached. Sending the message then claims
 * the upload by id, which keeps the (large) image body out of the message
 * request and makes retries cheap.
 */
mediaRouter.post('/', (req, res) => {
  const body = parse(uploadSchema, req.body);
  const image = parseAttachmentDataUrl(body.dataUrl);

  // Drop uploads that were never sent so abandoned picks do not pile up.
  db.prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?').run(now() - ORPHAN_TTL_MS);

  const id = newId();
  const createdAt = now();
  db.prepare(
    `INSERT INTO attachments (id, message_id, uploader_id, mime, width, height, bytes, data, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, req.user!.id, image.mime, body.width, body.height, image.bytes.length, image.dataUrl, createdAt);

  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow;
  res.status(201).json({ attachment: serializeAttachment(row) });
});
