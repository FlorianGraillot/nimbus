import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db, now } from '../db.js';
import { optionalAuth, requireAuth } from '../auth.js';
import { getGuild, HttpError, isGuildMember, requireGuildAdmin } from '../access.js';
import { parse } from '../validate.js';
import { emitToGuild, sendToUser } from '../hub.js';
import { guildPayload, guildMembers } from '../payloads.js';
import { inviteIsActive, serializeInvite } from '../serialize.js';
import type { GuildRow, InviteRow } from '../types.js';

export const invitesRouter = Router();

function getInvite(code: string): InviteRow {
  const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as InviteRow | undefined;
  if (!row) throw new HttpError(404, 'That invite is invalid or has expired');
  return row;
}

function requireUsableInvite(code: string): InviteRow {
  const row = getInvite(code);
  if (!inviteIsActive(row)) throw new HttpError(410, 'That invite has expired or been revoked');
  return row;
}

const createSchema = z.object({
  maxUses: z.number().int().min(1).max(100).nullable().optional(),
  expiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).nullable().optional(),
});

invitesRouter.post('/guilds/:id/invites', requireAuth, (req, res) => {
  const guild = getGuild(String(req.params.id));
  if (!isGuildMember(guild.id, req.user!.id)) throw new HttpError(403, 'You are not a member of this server');
  const body = parse(createSchema, req.body ?? {});
  const hasOptions = body.maxUses != null || body.expiresInMinutes != null;

  // Reuse the newest usable invite when no limits were requested, so the
  // "Invite people" dialog does not litter the server with dead codes.
  if (!hasOptions) {
    const existing = db
      .prepare('SELECT * FROM invites WHERE guild_id = ? AND created_by = ? ORDER BY created_at DESC')
      .all(guild.id, req.user!.id) as InviteRow[];
    const reusable = existing.find((row) => inviteIsActive(row));
    if (reusable) {
      res.status(201).json({ ...serializeInvite(reusable), code: reusable.code, url: `nimbus://invite/${reusable.code}` });
      return;
    }
  }

  const code = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
  const expiresAt = body.expiresInMinutes != null ? now() + body.expiresInMinutes * 60_000 : null;
  db.prepare(
    'INSERT INTO invites (code, guild_id, created_by, created_at, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(code, guild.id, req.user!.id, now(), body.maxUses ?? null, expiresAt);

  const invite = serializeInvite(getInvite(code));
  res.status(201).json({ ...invite, code: invite.code, url: invite.url });
});

invitesRouter.get('/guilds/:id/invites', requireAuth, (req, res) => {
  const guild = getGuild(String(req.params.id));
  requireGuildAdmin(guild, req.user!.id);
  const rows = db
    .prepare('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at DESC')
    .all(guild.id) as InviteRow[];
  res.json({ invites: rows.map(serializeInvite) });
});

invitesRouter.delete('/guilds/:id/invites/:code', requireAuth, (req, res) => {
  const guild = getGuild(String(req.params.id));
  requireGuildAdmin(guild, req.user!.id);
  const row = getInvite(String(req.params.code));
  if (row.guild_id !== guild.id) throw new HttpError(404, 'That invite does not belong to this server');
  db.prepare('UPDATE invites SET revoked_at = ? WHERE code = ?').run(now(), row.code);
  res.json({ invite: serializeInvite(getInvite(row.code)) });
});

invitesRouter.get('/invites/:code', optionalAuth, (req, res) => {
  const row = getInvite(String(req.params.code));
  if (!inviteIsActive(row)) throw new HttpError(410, 'That invite has expired or been revoked');

  const guild = getGuild(row.guild_id) as GuildRow;
  const members = guildMembers(guild.id);
  res.json({
    code: row.code,
    guild: {
      id: guild.id,
      name: guild.name,
      iconColor: guild.icon_color,
      memberCount: members.length,
    },
    alreadyMember: req.user ? isGuildMember(guild.id, req.user.id) : false,
  });
});

invitesRouter.post('/invites/:code/join', requireAuth, (req, res) => {
  const row = requireUsableInvite(String(req.params.code));
  const guild = getGuild(row.guild_id);
  const userId = req.user!.id;

  if (!isGuildMember(guild.id, userId)) {
    db.prepare('INSERT INTO guild_members (guild_id, user_id, nickname, joined_at) VALUES (?, ?, ?, ?)').run(
      guild.id,
      userId,
      '',
      now(),
    );
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(row.code);

    const member = guildMembers(guild.id).find((m) => m.id === userId);
    if (member) emitToGuild(guild.id, { t: 'MEMBER_JOIN', d: { guildId: guild.id, member } });
  }

  const payload = guildPayload(guild.id, userId);
  if (payload) sendToUser(userId, { t: 'GUILD_CREATE', d: payload });
  res.json(payload);
});
