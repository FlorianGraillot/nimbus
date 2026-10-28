import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db, now } from './db.js';
import type { UserRow } from './types.js';

const JWT_SECRET = process.env.NIMBUS_JWT_SECRET ?? 'nimbus-dev-secret-do-not-use-in-production';
const ACCESS_TTL_SECONDS = 60 * 15;
const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/* ------------------------------------------------------------------ */
/* Passwords (scrypt, salt-per-user)                                   */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ */
/* JWT (HS256 only)                                                    */
/* ------------------------------------------------------------------ */

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(data: string): string {
  return b64url(createHmac('sha256', JWT_SECRET).update(data).digest());
}

/* ------------------------------------------------------------------ */
/* Signed media links (message pictures)                               */
/* ------------------------------------------------------------------ */

/**
 * Message pictures are loaded by plain <img> tags, which cannot send an
 * Authorization header. The DTO carries a signature over the attachment id,
 * so only people who were given the message can fetch the image. The key is
 * domain-separated from JWTs so a signature can never be replayed as a token.
 */
export function signMediaId(id: string): string {
  return b64url(createHmac('sha256', JWT_SECRET).update(`media:${id}`).digest());
}

export function verifyMediaSignature(id: string, signature: string): boolean {
  const expected = Buffer.from(signMediaId(id));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createAccessToken(userId: string): { token: string; expiresIn: number } {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: userId,
      iss: 'nimbus',
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS,
    }),
  );
  const body = `${header}.${payload}`;
  return { token: `${body}.${sign(body)}`, expiresIn: ACCESS_TTL_SECONDS };
}

export function verifyAccessToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  let parsedHeader: { alg?: string };
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (parsedHeader.alg !== 'HS256') return null;

  const expected = Buffer.from(sign(`${header}.${payload}`));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
      sub?: string;
      exp?: number;
      iss?: string;
    };
    if (claims.iss !== 'nimbus' || !claims.sub) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Refresh tokens (opaque, hashed at rest, rotated on use)             */
/* ------------------------------------------------------------------ */

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function issueRefreshToken(userId: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    userId,
    hashToken(token),
    now(),
    now() + REFRESH_TTL_MS,
  );
  return token;
}

export function consumeRefreshToken(token: string): string | null {
  const row = db
    .prepare('SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ?')
    .get(hashToken(token)) as { id: string; user_id: string; expires_at: number } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(row.id);
  if (row.expires_at < now()) return null;
  return row.user_id;
}

export function revokeAllRefreshTokens(userId: string): void {
  db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

export function getUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing access token' });
    return;
  }
  const userId = verifyAccessToken(token);
  const user = userId ? getUserById(userId) : undefined;
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired access token' });
    return;
  }
  req.user = user;
  next();
}

/** For routes where the caller may be anonymous (invite previews). */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const userId = verifyAccessToken(token);
    const user = userId ? getUserById(userId) : undefined;
    if (user) req.user = user;
  }
  next();
}
