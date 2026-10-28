import { Router } from 'express';
import { z } from 'zod';
import { db, newId, now } from '../db.js';
import {
  consumeRefreshToken,
  createAccessToken,
  getUserById,
  hashPassword,
  issueRefreshToken,
  requireAuth,
  revokeAllRefreshTokens,
  verifyPassword,
} from '../auth.js';
import { HttpError } from '../access.js';
import { publicUser } from '../serialize.js';
import { AVATAR_COLORS, parse } from '../validate.js';
import type { UserRow } from '../types.js';

export const authRouter = Router();

const credentials = {
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
};

const registerSchema = z.object({
  email: credentials.email,
  password: credentials.password,
  username: z
    .string()
    .trim()
    .min(2, 'Username must be at least 2 characters')
    .max(32, 'Username must be 32 characters or fewer')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dots, dashes or underscores'),
  displayName: z.string().trim().min(1).max(32).optional(),
});

const loginSchema = z.object({
  email: credentials.email,
  password: z.string().min(1, 'Enter your password'),
});

function session(user: UserRow) {
  const access = createAccessToken(user.id);
  return {
    user: publicUser(user),
    accessToken: access.token,
    expiresIn: access.expiresIn,
    refreshToken: issueRefreshToken(user.id),
  };
}

authRouter.post('/register', (req, res) => {
  const body = parse(registerSchema, req.body);

  const existingEmail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
  if (existingEmail) throw new HttpError(409, 'An account with that email already exists');
  const existingName = db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username);
  if (existingName) throw new HttpError(409, 'That username is taken');

  const user: UserRow = {
    id: newId(),
    email: body.email,
    username: body.username,
    display_name: body.displayName?.trim() || body.username,
    password_hash: hashPassword(body.password),
    avatar_color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    bio: '',
    status: 'online',
    custom_status: '',
    simulated_presence: 0,
    created_at: now(),
    avatar_data: null,
    avatar_updated_at: null,
  };

  db.prepare(
    `INSERT INTO users (id, email, username, display_name, password_hash, avatar_color, bio, status, custom_status, created_at)
     VALUES (@id, @email, @username, @display_name, @password_hash, @avatar_color, @bio, @status, @custom_status, @created_at)`,
  ).run(user);

  res.status(201).json(session(user));
});

authRouter.post('/login', (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as UserRow | undefined;
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    throw new HttpError(401, 'Email or password is incorrect');
  }
  res.json(session(user));
});

authRouter.post('/refresh', (req, res) => {
  const body = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
  const userId = consumeRefreshToken(body.refreshToken);
  if (!userId) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  const user = getUserById(userId);
  if (!user) throw new HttpError(401, 'Account no longer exists');
  res.json(session(user));
});

authRouter.post('/logout', requireAuth, (req, res) => {
  const body = req.body as { refreshToken?: unknown };
  if (typeof body?.refreshToken === 'string') {
    consumeRefreshToken(body.refreshToken);
  }
  res.json({ ok: true });
});

authRouter.post('/logout-all', requireAuth, (req, res) => {
  revokeAllRefreshTokens(req.user!.id);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user!) });
});
