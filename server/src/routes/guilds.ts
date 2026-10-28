import { Router } from 'express';
import { z } from 'zod';
import { db, newId, now, tx } from '../db.js';
import { requireAuth } from '../auth.js';
import { assertGuildOwner, getChannel, getGuild, HttpError, requireGuildAdmin, requireGuildMember } from '../access.js';
import { parse, AVATAR_COLORS } from '../validate.js';
import { emitToGuild, sendToUser } from '../hub.js';
import { guildPayload, guildChannels, guildMembers } from '../payloads.js';
import { serializeChannel, serializeGuild } from '../serialize.js';
import { dropVoiceForChannel, dropVoiceForGuild, dropVoiceForUserInGuild } from '../voice.js';
import type { GuildRow } from '../types.js';

export const guildsRouter = Router();
guildsRouter.use(requireAuth);

const slugify = (input: string) =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'channel';

guildsRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT g.* FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
       WHERE gm.user_id = ? ORDER BY g.created_at ASC`,
    )
    .all(req.user!.id) as GuildRow[];
  res.json({
    guilds: rows.map((g) => ({
      guild: serializeGuild(g),
      channels: guildChannels(g.id),
      members: guildMembers(g.id),
    })),
  });
});

const createGuildSchema = z.object({
  name: z.string().trim().min(1, 'Give your server a name').max(64, 'Name is too long'),
});

guildsRouter.post('/', (req, res) => {
  const body = parse(createGuildSchema, req.body);
  const userId = req.user!.id;
  const guildId = newId();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  tx(() => {
    db.prepare('INSERT INTO guilds (id, name, icon_color, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
      guildId,
      body.name,
      color,
      userId,
      now(),
    );
    db.prepare('INSERT INTO guild_members (guild_id, user_id, nickname, joined_at) VALUES (?, ?, ?, ?)').run(
      guildId,
      userId,
      '',
      now(),
    );
    const defaults = ['general', 'random'];
    defaults.forEach((name, index) => {
      db.prepare(
        `INSERT INTO channels (id, guild_id, name, type, topic, position, created_at)
         VALUES (?, ?, ?, 'text', ?, ?, ?)`,
      ).run(
        newId(),
        guildId,
        name,
        name === 'general' ? 'The place where it all begins.' : 'Off-topic chatter and fun stuff.',
        index,
        now(),
      );
    });
  });

  const payload = guildPayload(guildId, userId);
  if (payload) sendToUser(userId, { t: 'GUILD_CREATE', d: payload });
  res.status(201).json(payload);
});

guildsRouter.get('/:id', (req, res) => {
  requireGuildMember(req.params.id, req.user!.id);
  res.json(guildPayload(req.params.id, req.user!.id));
});

const patchGuildSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

guildsRouter.patch('/:id', (req, res) => {
  const guild = getGuild(req.params.id);
  assertGuildOwner(guild, req.user!.id);
  const body = parse(patchGuildSchema, req.body);
  db.prepare('UPDATE guilds SET name = ?, icon_color = ? WHERE id = ?').run(
    body.name ?? guild.name,
    body.iconColor ?? guild.icon_color,
    guild.id,
  );
  const updated = getGuild(guild.id);
  emitToGuild(guild.id, { t: 'GUILD_UPDATE', d: serializeGuild(updated) });
  res.json({ guild: serializeGuild(updated) });
});

guildsRouter.delete('/:id', (req, res) => {
  const guild = getGuild(req.params.id);
  assertGuildOwner(guild, req.user!.id);
  dropVoiceForGuild(guild.id);
  emitToGuild(guild.id, { t: 'GUILD_DELETE', d: { id: guild.id } });
  db.prepare('DELETE FROM guilds WHERE id = ?').run(guild.id);
  res.json({ ok: true });
});

const createChannelSchema = z.object({
  name: z.string().trim().min(1, 'Channel name is required').max(64),
  topic: z.string().max(1024).optional(),
  type: z.enum(['text', 'voice']).optional(),
});

guildsRouter.post('/:id/channels', (req, res) => {
  const guild = getGuild(req.params.id);
  requireGuildAdmin(guild, req.user!.id);
  const body = parse(createChannelSchema, req.body);
  const type = body.type ?? 'text';

  const name = slugify(body.name);
  const exists = db.prepare('SELECT 1 FROM channels WHERE guild_id = ? AND name = ? AND type = ?').get(guild.id, name, type);
  if (exists) throw new HttpError(409, 'A channel with that name already exists');

  const position = (
    db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE guild_id = ?').get(guild.id) as {
      next: number;
    }
  ).next;

  const id = newId();
  db.prepare(
    `INSERT INTO channels (id, guild_id, name, type, topic, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, guild.id, name, type, body.topic ?? '', position, now());

  const channel = serializeChannel(getChannel(id));
  emitToGuild(guild.id, { t: 'CHANNEL_CREATE', d: channel });
  res.status(201).json({ channel });
});

guildsRouter.get('/:id/members', (req, res) => {
  requireGuildMember(req.params.id, req.user!.id);
  res.json({ members: guildMembers(req.params.id) });
});

const memberRoleSchema = z.object({ role: z.enum(['admin', 'member']) });

/** Owner-only: grant or revoke the admin role. */
guildsRouter.patch('/:id/members/:userId', (req, res) => {
  const guild = getGuild(req.params.id);
  assertGuildOwner(guild, req.user!.id);
  const body = parse(memberRoleSchema, req.body);
  if (req.params.userId === guild.owner_id) throw new HttpError(400, "The owner's role cannot be changed");
  const member = db
    .prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?')
    .get(guild.id, req.params.userId);
  if (!member) throw new HttpError(404, 'That user is not a member');

  db.prepare('UPDATE guild_members SET role = ? WHERE guild_id = ? AND user_id = ?').run(
    body.role,
    guild.id,
    req.params.userId,
  );
  const updated = guildMembers(guild.id).find((m) => m.id === req.params.userId) ?? null;
  if (updated) emitToGuild(guild.id, { t: 'MEMBER_UPDATE', d: { guildId: guild.id, member: updated } });
  res.json({ member: updated });
});

guildsRouter.delete('/:id/members/:userId', (req, res) => {
  const guild = getGuild(req.params.id);
  assertGuildOwner(guild, req.user!.id);
  if (req.params.userId === req.user!.id) throw new HttpError(400, 'Use the leave endpoint to leave a server');
  const member = db
    .prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?')
    .get(guild.id, req.params.userId);
  if (!member) throw new HttpError(404, 'That user is not a member');
  db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?').run(guild.id, req.params.userId);
  dropVoiceForUserInGuild(req.params.userId, guild.id);
  sendToUser(req.params.userId, { t: 'GUILD_DELETE', d: { id: guild.id } });
  emitToGuild(guild.id, { t: 'MEMBER_REMOVE', d: { guildId: guild.id, userId: req.params.userId } });
  res.json({ ok: true });
});

guildsRouter.post('/:id/leave', (req, res) => {
  const guild = getGuild(req.params.id);
  const userId = req.user!.id;
  requireGuildMember(guild.id, userId);

  const otherMembers = db
    .prepare('SELECT user_id FROM guild_members WHERE guild_id = ? AND user_id != ? ORDER BY joined_at ASC')
    .all(guild.id, userId) as { user_id: string }[];

  if (otherMembers.length === 0) {
    dropVoiceForGuild(guild.id);
    emitToGuild(guild.id, { t: 'GUILD_DELETE', d: { id: guild.id } });
    db.prepare('DELETE FROM guilds WHERE id = ?').run(guild.id);
    res.json({ ok: true });
    return;
  }

  db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?').run(guild.id, userId);
  dropVoiceForUserInGuild(userId, guild.id);
  if (guild.owner_id === userId) {
    const next = otherMembers[0].user_id;
    db.prepare('UPDATE guilds SET owner_id = ? WHERE id = ?').run(next, guild.id);
    emitToGuild(guild.id, { t: 'GUILD_UPDATE', d: serializeGuild(getGuild(guild.id)) });
  }
  sendToUser(userId, { t: 'GUILD_DELETE', d: { id: guild.id } });
  emitToGuild(guild.id, { t: 'MEMBER_REMOVE', d: { guildId: guild.id, userId } });
  res.json({ ok: true });
});

const patchChannelSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  topic: z.string().max(1024).optional(),
  position: z.number().int().min(0).max(10000).optional(),
  /** False = members may only send text; owners/admins keep the ability. */
  allowAttachments: z.boolean().optional(),
});

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

channelsRouter.get('/:id', (req, res) => {
  const channel = getChannel(req.params.id);
  if (channel.guild_id) requireGuildMember(channel.guild_id, req.user!.id);
  res.json({ channel: serializeChannel(channel) });
});

channelsRouter.patch('/:id', (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel.guild_id) throw new HttpError(400, 'Cannot edit a direct message');
  requireGuildAdmin(getGuild(channel.guild_id), req.user!.id);
  const body = parse(patchChannelSchema, req.body);

  const name = body.name !== undefined ? slugify(body.name) : channel.name;
  const allowAttachments =
    body.allowAttachments === undefined ? channel.allow_attachments : body.allowAttachments ? 1 : 0;
  db.prepare('UPDATE channels SET name = ?, topic = ?, position = ? WHERE id = ?').run(
    name,
    body.topic ?? channel.topic,
    body.position ?? channel.position,
    channel.id,
  );

  /* Threads inherit the picture policy, so flipping it has to reach them too
   * (and their own threads, hence the recursive walk). */
  if (allowAttachments !== channel.allow_attachments) {
    const ids = (
      db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM channels WHERE id = ?
             UNION ALL
             SELECT c.id FROM channels c JOIN tree t ON c.parent_id = t.id
           ) SELECT id FROM tree`,
        )
        .all(channel.id) as { id: string }[]
    ).map((row) => row.id);

    db.prepare(
      `UPDATE channels SET allow_attachments = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).run(allowAttachments, ...ids);

    for (const threadId of ids) {
      if (threadId === channel.id) continue;
      emitToGuild(channel.guild_id, { t: 'CHANNEL_UPDATE', d: serializeChannel(getChannel(threadId)) });
    }
  }

  const dto = serializeChannel(getChannel(channel.id));
  emitToGuild(channel.guild_id, { t: 'CHANNEL_UPDATE', d: dto });
  res.json({ channel: dto });
});

channelsRouter.delete('/:id', (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel.guild_id) throw new HttpError(400, 'Cannot delete a direct message');
  requireGuildAdmin(getGuild(channel.guild_id), req.user!.id);
  const remaining = db
    .prepare(`SELECT COUNT(*) AS c FROM channels WHERE guild_id = ? AND type = 'text'`)
    .get(channel.guild_id) as { c: number };
  if (remaining.c <= 1) throw new HttpError(400, 'A server needs at least one text channel');
  dropVoiceForChannel(channel.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
  emitToGuild(channel.guild_id, { t: 'CHANNEL_DELETE', d: { id: channel.id, guildId: channel.guild_id } });
  res.json({ ok: true });
});
