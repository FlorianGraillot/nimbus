import { Router } from 'express';
import { z } from 'zod';
import { db, now } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError } from '../access.js';
import { publicUser } from '../serialize.js';
import { AVATAR_COLORS, parse } from '../validate.js';
import { broadcastPresence, emitUserUpdate } from '../hub.js';
import { parseAvatarDataUrl, readAvatarData } from '../avatars.js';
import type { UserRow } from '../types.js';

export const usersRouter = Router();

/**
 * Profile pictures are served without auth so a plain <img> can load them.
 * Registered before the auth middleware below; the URL is unguessable enough
 * for a local-first app and contains no more than the picture itself.
 */
usersRouter.get('/:id/avatar', (req, res) => {
  const row = db.prepare('SELECT avatar_data FROM users WHERE id = ?').get(req.params.id) as
    | { avatar_data: string | null }
    | undefined;
  const picture = readAvatarData(row?.avatar_data ?? null);
  if (!picture) {
    res.status(404).json({ error: 'No profile picture' });
    return;
  }
  res.set('Content-Type', picture.mime);
  // The URL carries ?v=<upload time>, so this content never changes in place.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(picture.bytes);
});

usersRouter.use(requireAuth);

usersRouter.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ users: [] });
    return;
  }
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
       ORDER BY (username = ?) DESC, username ASC LIMIT 12`,
    )
    .all(req.user!.id, `%${q}%`, `%${q}%`, q) as UserRow[];
  res.json({ users: rows.map(publicUser) });
});

usersRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as UserRow | undefined;
  if (!row) throw new HttpError(404, 'User not found');
  res.json({ user: publicUser(row) });
});

const updateSchema = z.object({
  displayName: z.string().trim().min(1, 'Display name cannot be empty').max(32).optional(),
  bio: z.string().max(190).optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid color')
    .optional(),
  status: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
  customStatus: z.string().max(128).optional(),
});

usersRouter.patch('/@me', (req, res) => {
  const body = parse(updateSchema, req.body);
  const user = req.user!;

  const next = {
    display_name: body.displayName ?? user.display_name,
    bio: body.bio ?? user.bio,
    avatar_color: body.avatarColor ?? user.avatar_color,
    status: body.status ?? user.status,
    custom_status: body.customStatus ?? user.custom_status,
  };

  db.prepare(
    `UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, status = ?, custom_status = ? WHERE id = ?`,
  ).run(next.display_name, next.bio, next.avatar_color, next.status, next.custom_status, user.id);

  const updated = { ...user, ...next } as UserRow;

  if (body.status && body.status !== user.status) {
    broadcastPresence(user.id, body.status);
  }

  const dto = publicUser(updated);
  emitUserUpdate(dto);
  res.json({ user: dto });
});

const avatarSchema = z.object({
  dataUrl: z.string().min(32).max(220_000, 'That picture is too large. Try a smaller one.'),
});

usersRouter.post('/@me/avatar', (req, res) => {
  const body = parse(avatarSchema, req.body);
  const picture = parseAvatarDataUrl(body.dataUrl);
  const stamp = now();
  db.prepare('UPDATE users SET avatar_data = ?, avatar_updated_at = ? WHERE id = ?').run(
    picture.dataUrl,
    stamp,
    req.user!.id,
  );

  const updated = { ...req.user!, avatar_data: picture.dataUrl, avatar_updated_at: stamp } as UserRow;
  const dto = publicUser(updated);
  emitUserUpdate(dto);
  res.json({ user: dto });
});

usersRouter.delete('/@me/avatar', (req, res) => {
  const stamp = now();
  db.prepare('UPDATE users SET avatar_data = NULL, avatar_updated_at = ? WHERE id = ?').run(stamp, req.user!.id);
  const updated = { ...req.user!, avatar_data: null, avatar_updated_at: stamp } as UserRow;
  const dto = publicUser(updated);
  emitUserUpdate(dto);
  res.json({ user: dto });
});

usersRouter.get('/@me/colors', (_req, res) => {
  res.json({ colors: AVATAR_COLORS, now: now() });
});
