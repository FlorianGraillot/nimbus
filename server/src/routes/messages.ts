import { Router } from 'express';
import { z } from 'zod';
import { db, newId, now, tx } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  assertChannelAccess,
  getChannel,
  getGuild,
  guildMemberRole,
  HttpError,
  requireGuildAdmin,
} from '../access.js';
import { parse } from '../validate.js';
import { channelAudience, emitToChannel, emitToGuild } from '../hub.js';
import { serializeChannel, serializeMessage, serializeMessages } from '../serialize.js';
import { clearChannelMentions, recordMentions, syncMentions } from '../mentions.js';
import { blockedBetween } from '../blocks.js';
import { unreadCounts } from '../payloads.js';
import { MAX_ATTACHMENTS } from '../attachments.js';
import type { AttachmentRow, ChannelRow, MessageRow } from '../types.js';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const MAX_CONTENT = 4000;

/** Blocked users cannot message each other, even inside a shared group. */
function assertMessagingAllowed(channel: ChannelRow, userId: string): void {
  if (channel.type !== 'dm' && channel.type !== 'group') return;
  const rows = db
    .prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ?')
    .all(channel.id, userId) as { user_id: string }[];
  if (rows.some((row) => blockedBetween(userId, row.user_id))) {
    throw new HttpError(403, 'You cannot message this conversation right now');
  }
}

/**
 * Per-channel picture policy. Owners and admins decide it, and keep the
 * ability to post pictures themselves; DMs and group DMs have no roles, so
 * their members can always attach.
 */
function assertAttachmentsAllowed(channel: ChannelRow, userId: string): void {
  if (!channel.guild_id) return;
  if (channel.allow_attachments !== 0) return;
  const guild = getGuild(channel.guild_id);
  if (guild.owner_id === userId) return;
  if (guildMemberRole(guild, userId) === 'admin') return;
  throw new HttpError(403, 'Pictures are turned off in this channel. You can still send text.');
}

/** Resolves upload ids into rows, in the order the sender picked them. */
function claimableAttachments(ids: string[], userId: string): AttachmentRow[] {
  const rows = db
    .prepare(`SELECT * FROM attachments WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as AttachmentRow[];
  if (rows.length !== ids.length) throw new HttpError(400, 'One of those pictures is no longer available');

  for (const row of rows) {
    if (row.uploader_id !== userId) throw new HttpError(403, 'You can only send pictures you uploaded');
    if (row.message_id) throw new HttpError(400, 'That picture has already been sent');
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)!);
}

function touchRead(userId: string, channelId: string, seq: number): void {
  db.prepare(
    `INSERT INTO read_states (user_id, channel_id, last_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
  ).run(userId, channelId, seq, now());
}

messagesRouter.get('/channels/:id/messages', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before);
  const beforeSeq = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;

  const rows = db
    .prepare('SELECT * FROM messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(channel.id, beforeSeq, limit) as MessageRow[];

  res.json({
    messages: serializeMessages(rows.reverse(), req.user!.id),
    hasMore: rows.length === limit,
    channelId: channel.id,
  });
});

/** Resolves a message id to its channel + sequence so deep links can jump. */
messagesRouter.get('/messages/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row || row.deleted_at) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  assertChannelAccess(channel, req.user!.id);
  res.json({ message: serializeMessage(row, req.user!.id), channel: serializeChannel(channel) });
});

const sendSchema = z.object({
  content: z.string().max(MAX_CONTENT, 'Message is too long').optional(),
  replyToId: z.string().optional().nullable(),
  attachmentIds: z
    .array(z.string())
    .max(MAX_ATTACHMENTS, `You can attach up to ${MAX_ATTACHMENTS} pictures`)
    .optional(),
  nonce: z.string().max(64).optional(),
});

messagesRouter.post('/channels/:id/messages', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);
  if (channel.type === 'voice') throw new HttpError(400, 'Voice channels do not take messages');
  assertMessagingAllowed(channel, req.user!.id);
  const body = parse(sendSchema, req.body);
  const content = (body.content ?? '').trim();
  const attachmentIds = [...new Set(body.attachmentIds ?? [])];
  if (!content && attachmentIds.length === 0) throw new HttpError(400, 'Message cannot be empty');

  let attachments: AttachmentRow[] = [];
  if (attachmentIds.length > 0) {
    assertAttachmentsAllowed(channel, req.user!.id);
    attachments = claimableAttachments(attachmentIds, req.user!.id);
  }

  let replyToId: string | null = null;
  if (body.replyToId) {
    const parent = db.prepare('SELECT id, channel_id FROM messages WHERE id = ?').get(body.replyToId) as
      | { id: string; channel_id: string }
      | undefined;
    if (!parent || parent.channel_id !== channel.id) throw new HttpError(400, 'Cannot reply to that message');
    replyToId = parent.id;
  }

  const id = newId();
  const createdAt = now();
  const row = tx(() => {
    const info = db
      .prepare(
        `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, channel.id, req.user!.id, content, replyToId, createdAt);
    const created = db.prepare('SELECT * FROM messages WHERE seq = ?').get(info.lastInsertRowid) as MessageRow;
    for (const attachment of attachments) {
      db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(id, attachment.id);
    }
    return created;
  });

  recordMentions(row, channel);
  touchRead(req.user!.id, channel.id, row.seq);

  const dto = serializeMessage(row, req.user!.id);
  emitToChannel(channel, { t: 'MESSAGE_CREATE', d: { ...dto, nonce: body.nonce ?? null } });

  if (channel.type === 'thread' && channel.parent_id) {
    const parent = db.prepare('SELECT id FROM channels WHERE id = ?').get(channel.parent_id) as { id: string } | undefined;
    if (parent) {
      emitToChannel(channel, {
        t: 'THREAD_ACTIVITY',
        d: { threadId: channel.id, parentId: parent.id, messageId: row.id },
      });
    }
  }

  res.status(201).json({ message: dto, nonce: body.nonce ?? null });
});

const editSchema = z.object({ content: z.string().min(1).max(MAX_CONTENT) });

messagesRouter.patch('/messages/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  assertChannelAccess(channel, req.user!.id);
  if (row.author_id !== req.user!.id) throw new HttpError(403, 'You can only edit your own messages');
  if (row.deleted_at) throw new HttpError(400, 'That message was deleted');

  const body = parse(editSchema, req.body);
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(body.content.trim(), now(), row.id);
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
  syncMentions(updated, channel);
  const dto = serializeMessage(updated, req.user!.id);
  emitToChannel(channel, { t: 'MESSAGE_UPDATE', d: dto });
  res.json({ message: dto });
});

messagesRouter.delete('/messages/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  assertChannelAccess(channel, req.user!.id);

  let canDelete = row.author_id === req.user!.id;
  if (!canDelete && channel.guild_id) {
    const guild = getGuild(channel.guild_id);
    canDelete = guild.owner_id === req.user!.id;
  }
  if (!canDelete) throw new HttpError(403, 'You cannot delete this message');

  db.prepare('UPDATE messages SET deleted_at = ?, content = ? WHERE id = ?').run(now(), '', row.id);
  db.prepare('DELETE FROM mentions WHERE message_id = ?').run(row.id);
  // Pictures go with the message: signed links that were handed out stop working.
  db.prepare('DELETE FROM attachments WHERE message_id = ?').run(row.id);
  emitToChannel(channel, { t: 'MESSAGE_DELETE', d: { id: row.id, channelId: channel.id } });
  res.json({ ok: true });
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

messagesRouter.post('/messages/:id/reactions', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row || row.deleted_at) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  assertChannelAccess(channel, req.user!.id);
  const body = parse(reactionSchema, req.body);

  db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(
    row.id,
    req.user!.id,
    body.emoji,
    now(),
  );
  emitToChannel(channel, {
    t: 'REACTION_UPDATE',
    d: { messageId: row.id, channelId: channel.id, emoji: body.emoji, userId: req.user!.id, action: 'add' },
  });
  res.json({ ok: true });
});

messagesRouter.delete('/messages/:id/reactions/:emoji', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  assertChannelAccess(channel, req.user!.id);

  const emoji = decodeURIComponent(req.params.emoji);
  db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
    row.id,
    req.user!.id,
    emoji,
  );
  emitToChannel(channel, {
    t: 'REACTION_UPDATE',
    d: { messageId: row.id, channelId: channel.id, emoji, userId: req.user!.id, action: 'remove' },
  });
  res.json({ ok: true });
});

messagesRouter.post('/channels/:id/typing', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);
  const audience = channelAudience(channel).filter((id) => id !== req.user!.id);
  for (const userId of audience) {
    // targeted send keeps typing cheap
    void userId;
  }
  emitToChannel(channel, {
    t: 'TYPING_START',
    d: {
      channelId: channel.id,
      userId: req.user!.id,
      displayName: req.user!.display_name,
    },
  });
  res.json({ ok: true });
});

messagesRouter.post('/channels/:id/read', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);
  const body = req.body as { seq?: number };
  const seq =
    typeof body?.seq === 'number'
      ? body.seq
      : ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE channel_id = ?').get(channel.id) as {
          maxSeq: number;
        }).maxSeq ?? 0);
  touchRead(req.user!.id, channel.id, seq);
  clearChannelMentions(req.user!.id, channel.id);
  res.json({ ok: true, seq });
});

/** Marks a channel unread again so it shows up with a "New messages" divider. */
messagesRouter.post('/channels/:id/unread', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);
  const body = req.body as { seq?: number };
  const latest =
    typeof body?.seq === 'number' && Number.isFinite(body.seq)
      ? body.seq
      : ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE channel_id = ?').get(channel.id) as {
          maxSeq: number;
        }).maxSeq ?? 0);
  const lastSeq = Math.max(0, latest - 1);
  db.prepare(
    `INSERT INTO read_states (user_id, channel_id, last_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
  ).run(req.user!.id, channel.id, lastSeq, now());
  res.json({
    ok: true,
    seq: latest,
    lastSeq,
    unread: unreadCounts(req.user!.id, [channel.id])[channel.id] ?? { count: 0, mentions: 0 },
  });
});

/* ---------------------------------- pins --------------------------------- */

messagesRouter.get('/channels/:id/pins', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL
       ORDER BY pinned_at DESC`,
    )
    .all(channel.id) as MessageRow[];
  res.json({ messages: serializeMessages(rows, req.user!.id) });
});

function pinMessage(req: { params: { id: string }; user?: { id: string } }, pinned: boolean) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row || row.deleted_at) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  const userId = req.user!.id;
  assertChannelAccess(channel, userId);
  // Pinning is a curation action: in a server only the owner and admins may do
  // it. DMs and group DMs have no roles, so their members keep the ability.
  if (channel.guild_id) requireGuildAdmin(getGuild(channel.guild_id), userId);

  if (pinned) {
    db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(now(), userId, row.id);
  } else {
    db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(row.id);
  }
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
  const dto = serializeMessage(updated, userId);
  emitToChannel(channel, { t: 'MESSAGE_UPDATE', d: dto });
  return dto;
}

messagesRouter.put('/messages/:id/pin', (req, res) => {
  res.json({ message: pinMessage(req, true) });
});

messagesRouter.delete('/messages/:id/pin', (req, res) => {
  res.json({ message: pinMessage(req, false) });
});

const threadSchema = z.object({ name: z.string().trim().max(64).optional() });

messagesRouter.post('/messages/:id/thread', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id) as MessageRow | undefined;
  if (!row || row.deleted_at) throw new HttpError(404, 'Message not found');
  const channel = getChannel(row.channel_id);
  if (!channel.guild_id) throw new HttpError(400, 'Threads are only available in servers');
  assertChannelAccess(channel, req.user!.id);

  const existing = db.prepare('SELECT * FROM channels WHERE thread_root_id = ?').get(row.id) as ChannelRow | undefined;
  if (existing) {
    res.json({ channel: serializeChannel(existing) });
    return;
  }

  const body = parse(threadSchema, req.body ?? {});
  const fallback = row.content.slice(0, 48).trim() || 'photo';
  const position = (
    db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE guild_id = ?').get(channel.guild_id) as {
      next: number;
    }
  ).next;

  const id = newId();
  db.prepare(
    `INSERT INTO channels (id, guild_id, name, type, topic, position, parent_id, thread_root_id, created_by, created_at, allow_attachments)
     VALUES (?, ?, ?, 'thread', '', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    channel.guild_id,
    (body.name || fallback).slice(0, 64),
    position,
    channel.id,
    row.id,
    req.user!.id,
    now(),
    channel.allow_attachments,
  );

  const dto = serializeChannel(getChannel(id));
  emitToGuild(channel.guild_id, { t: 'THREAD_CREATE', d: dto });
  res.status(201).json({ channel: dto });
});

messagesRouter.get('/channels/:id/threads', (req, res) => {
  const channel = getChannel(req.params.id);
  assertChannelAccess(channel, req.user!.id);
  const rows = db
    .prepare(`SELECT * FROM channels WHERE parent_id = ? AND type = 'thread' ORDER BY created_at DESC`)
    .all(channel.id) as ChannelRow[];
  res.json({ threads: rows.map(serializeChannel) });
});

interface SearchQuery {
  text: string;
  from: string | null;
  in: string | null;
  before: number | null;
  after: number | null;
}

/**
 * Splits `from:aria in:design before:2026-01-01 fix login` into the free-text
 * part and its operators. Unknown date values are ignored rather than failing
 * the whole search.
 */
function parseSearchQuery(raw: string): SearchQuery {
  const query: SearchQuery = { text: '', from: null, in: null, before: null, after: null };
  const text = raw
    .replace(/\b(from|in|before|after):("[^"]*"|\S+)/gi, (_match, rawKey: string, rawValue: string) => {
      const key = rawKey.toLowerCase();
      const value = rawValue.replace(/^"|"$/g, '').trim();
      if (!value) return ' ';
      if (key === 'from') query.from = value.replace(/^@/, '').toLowerCase();
      else if (key === 'in') query.in = value.replace(/^#/, '').toLowerCase();
      else {
        const at = Date.parse(value);
        if (Number.isFinite(at)) {
          if (key === 'before') query.before = at;
          else query.after = at;
        }
      }
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  query.text = text;
  return query;
}

messagesRouter.get('/search', (req, res) => {
  const userId = req.user!.id;
  const raw = String(req.query.q ?? '').trim();
  const guildId = req.query.guildId ? String(req.query.guildId) : null;
  const channelId = req.query.channelId ? String(req.query.channelId) : null;
  const parsed = parseSearchQuery(raw);
  const hasOperators = Boolean(parsed.from || parsed.in || parsed.before || parsed.after);
  if (!hasOperators && parsed.text.length < 2) {
    res.json({ messages: [], operators: parsed });
    return;
  }

  const where = [
    'm.deleted_at IS NULL',
    `(c.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
      OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))`,
  ];
  const params: unknown[] = [userId, userId];

  if (guildId) {
    where.push('c.guild_id = ?');
    params.push(guildId);
  }
  if (channelId) {
    where.push('c.id = ?');
    params.push(channelId);
  }
  if (parsed.text) {
    where.push(`m.content LIKE ? ESCAPE '\\'`);
    params.push(`%${parsed.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (parsed.from) {
    const author = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(parsed.from) as
      | { id: string }
      | undefined;
    if (!author) {
      res.json({ messages: [], operators: parsed });
      return;
    }
    where.push('m.author_id = ?');
    params.push(author.id);
  }
  if (parsed.in) {
    const target = db
      .prepare(
        `SELECT c.id FROM channels c
         WHERE (c.id = ? OR c.name = ? COLLATE NOCASE)
           AND (c.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
                OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
         LIMIT 1`,
      )
      .get(parsed.in, parsed.in, userId, userId) as { id: string } | undefined;
    if (!target) {
      res.json({ messages: [], operators: parsed });
      return;
    }
    where.push('c.id = ?');
    params.push(target.id);
  }
  if (parsed.before) {
    where.push('m.created_at < ?');
    params.push(parsed.before);
  }
  if (parsed.after) {
    where.push('m.created_at >= ?');
    params.push(parsed.after);
  }

  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN channels c ON c.id = m.channel_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.seq DESC LIMIT 40`,
    )
    .all(...params) as MessageRow[];

  res.json({ messages: serializeMessages(rows, userId), operators: parsed });
});
