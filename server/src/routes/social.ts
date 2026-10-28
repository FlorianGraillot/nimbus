import { Router } from 'express';
import { z } from 'zod';
import { db, newId, now, tx } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError, isFriend } from '../access.js';
import { parse } from '../validate.js';
import { sendToUser } from '../hub.js';
import { friendList } from '../payloads.js';
import { publicUser, serializeChannel } from '../serialize.js';
import { blockedBetween, blockedIds, blockUser, unblockUser } from '../blocks.js';
import type { ChannelRow, UserRow } from '../types.js';

export const socialRouter = Router();
socialRouter.use(requireAuth);

/* ------------------------------- friends -------------------------------- */

socialRouter.get('/friends', (req, res) => {
  res.json({ friends: friendList(req.user!.id) });
});

const requestSchema = z.object({ username: z.string().trim().min(1, 'Enter a username') });

socialRouter.post('/friends/requests', (req, res) => {
  const body = parse(requestSchema, req.body);
  const me = req.user!;
  const target = db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(body.username.replace(/^@/, ''), body.username.toLowerCase()) as UserRow | undefined;
  if (!target) throw new HttpError(404, 'No account found with that username');
  if (target.id === me.id) throw new HttpError(400, 'You cannot add yourself');
  if (blockedBetween(me.id, target.id)) throw new HttpError(403, 'You cannot send a friend request to that user');

  const existing = db
    .prepare(
      `SELECT * FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    )
    .get(me.id, target.id, target.id, me.id) as
    | { requester_id: string; addressee_id: string; status: string }
    | undefined;

  if (existing) {
    if (existing.status === 'accepted') throw new HttpError(409, 'You are already friends');
    if (existing.requester_id === me.id) throw new HttpError(409, 'You already sent that person a request');
    // They already asked us — accept it instead of creating a duplicate.
    db.prepare('UPDATE friendships SET status = ? WHERE requester_id = ? AND addressee_id = ?').run(
      'accepted',
      target.id,
      me.id,
    );
    const accepted = { user: publicUser(target), state: 'accepted' as const, since: now() };
    sendToUser(target.id, { t: 'FRIEND_ADD', d: { user: publicUser(me), state: 'accepted', since: now() } });
    sendToUser(me.id, { t: 'FRIEND_ADD', d: accepted });
    res.status(201).json({ friend: accepted });
    return;
  }

  db.prepare('INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?)').run(
    me.id,
    target.id,
    'pending',
    now(),
  );
  sendToUser(target.id, {
    t: 'FRIEND_REQUEST',
    d: { user: publicUser(me), state: 'incoming', since: now() },
  });
  res.status(201).json({ friend: { user: publicUser(target), state: 'outgoing', since: now() } });
});

socialRouter.post('/friends/requests/:userId/accept', (req, res) => {
  const me = req.user!;
  const otherId = req.params.userId;
  const row = db
    .prepare('SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = ?')
    .get(otherId, me.id, 'pending');
  if (!row) throw new HttpError(404, 'No pending request from that user');

  db.prepare('UPDATE friendships SET status = ? WHERE requester_id = ? AND addressee_id = ?').run(
    'accepted',
    otherId,
    me.id,
  );
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId) as UserRow | undefined;
  if (other) {
    sendToUser(other.id, { t: 'FRIEND_ADD', d: { user: publicUser(me), state: 'accepted', since: now() } });
  }
  res.json({ friend: { user: other ? publicUser(other) : null, state: 'accepted', since: now() } });
});

socialRouter.delete('/friends/requests/:userId', (req, res) => {
  const me = req.user!;
  const otherId = req.params.userId;
  const info = db
    .prepare(
      `DELETE FROM friendships WHERE status = 'pending'
       AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    )
    .run(me.id, otherId, otherId, me.id);
  if (info.changes === 0) throw new HttpError(404, 'No pending request found');
  sendToUser(otherId, { t: 'FRIEND_REMOVE', d: { userId: me.id } });
  res.json({ ok: true });
});

socialRouter.delete('/friends/:userId', (req, res) => {
  const me = req.user!;
  const otherId = req.params.userId;
  const info = db
    .prepare(
      `DELETE FROM friendships
       WHERE status = 'accepted'
       AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    )
    .run(me.id, otherId, otherId, me.id);
  if (info.changes === 0) throw new HttpError(404, 'You are not friends with that user');
  sendToUser(otherId, { t: 'FRIEND_REMOVE', d: { userId: me.id } });
  res.json({ ok: true });
});

/* -------------------------------- blocks -------------------------------- */

socialRouter.get('/blocks', (req, res) => {
  const ids = blockedIds(req.user!.id);
  const users = ids
    .map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined)
    .filter((u): u is UserRow => Boolean(u))
    .map(publicUser);
  res.json({ blocked: users });
});

socialRouter.put('/users/:id/block', (req, res) => {
  const me = req.user!;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as UserRow | undefined;
  if (!target) throw new HttpError(404, 'User not found');
  if (target.id === me.id) throw new HttpError(400, 'You cannot block yourself');
  blockUser(me.id, target.id);
  sendToUser(target.id, { t: 'FRIEND_REMOVE', d: { userId: me.id } });
  res.json({ blocked: blockedIds(me.id) });
});

socialRouter.delete('/users/:id/block', (req, res) => {
  unblockUser(req.user!.id, req.params.id);
  res.json({ blocked: blockedIds(req.user!.id) });
});

/* --------------------------------- DMs ---------------------------------- */

function sharesGuild(a: string, b: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM guild_members x
         JOIN guild_members y ON y.guild_id = x.guild_id
         WHERE x.user_id = ? AND y.user_id = ? LIMIT 1`,
      )
      .get(a, b),
  );
}

socialRouter.get('/dms', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
       WHERE cm.user_id = ? AND c.type IN ('dm','group') ORDER BY c.created_at ASC`,
    )
    .all(req.user!.id) as ChannelRow[];
  res.json({ dms: rows.map(serializeChannel) });
});

const createDmSchema = z.object({ recipientIds: z.array(z.string()).min(1).max(9) });

socialRouter.post('/dms', (req, res) => {
  const me = req.user!;
  const body = parse(createDmSchema, req.body);
  const recipientIds = [...new Set(body.recipientIds)].filter((id) => id !== me.id);
  if (recipientIds.length === 0) throw new HttpError(400, 'Pick at least one person');

  const users: UserRow[] = [];
  for (const id of recipientIds) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!user) throw new HttpError(404, 'One of those users no longer exists');
    if (blockedBetween(me.id, id)) throw new HttpError(403, 'You cannot message that user');
    if (!isFriend(me.id, id) && !sharesGuild(me.id, id)) {
      throw new HttpError(403, 'You can only message friends or people in your servers');
    }
    users.push(user);
  }

  if (recipientIds.length === 1) {
    const existing = db
      .prepare(
        `SELECT c.* FROM channels c
         JOIN channel_members a ON a.channel_id = c.id AND a.user_id = ?
         JOIN channel_members b ON b.channel_id = c.id AND b.user_id = ?
         WHERE c.type = 'dm' LIMIT 1`,
      )
      .get(me.id, recipientIds[0]) as ChannelRow | undefined;
    if (existing) {
      res.json({ channel: serializeChannel(existing) });
      return;
    }
  }

  const id = newId();
  const type = recipientIds.length === 1 ? 'dm' : 'group';
  tx(() => {
    db.prepare('INSERT INTO channels (id, guild_id, name, type, created_at) VALUES (?, NULL, ?, ?, ?)').run(
      id,
      '',
      type,
      now(),
    );
    for (const userId of [me.id, ...recipientIds]) {
      db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, userId, now());
    }
  });

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow;
  for (const userId of [me.id, ...recipientIds]) {
    sendToUser(userId, { t: 'DM_CREATE', d: serializeChannel(channel) });
  }
  res.status(201).json({ channel: serializeChannel(channel) });
});

socialRouter.post('/dms/:id/members', (req, res) => {
  const me = req.user!;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id) as ChannelRow | undefined;
  if (!channel || channel.type === 'dm' || channel.type === 'text' || channel.type === 'thread') {
    throw new HttpError(400, 'That conversation cannot accept new members');
  }
  const member = db
    .prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .get(channel.id, me.id);
  if (!member) throw new HttpError(403, 'You are not in this conversation');

  const body = parse(z.object({ userId: z.string() }), req.body);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(body.userId) as UserRow | undefined;
  if (!user) throw new HttpError(404, 'User not found');
  if (blockedBetween(me.id, user.id)) throw new HttpError(403, 'You cannot add that user to this conversation');

  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)').run(
    channel.id,
    user.id,
    now(),
  );
  db.prepare(`UPDATE channels SET type = 'group' WHERE id = ?`).run(channel.id);
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id) as ChannelRow;

  const dto = serializeChannel(updated);
  const rows = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id) as {
    user_id: string;
  }[];
  for (const row of rows) sendToUser(row.user_id, { t: 'DM_UPDATE', d: dto });
  res.json({ channel: dto });
});

socialRouter.delete('/dms/:id', (req, res) => {
  const me = req.user!;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id) as ChannelRow | undefined;
  if (!channel || !channel.type.match(/^(dm|group)$/)) throw new HttpError(404, 'Conversation not found');
  const info = db
    .prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .run(channel.id, me.id);
  if (info.changes === 0) throw new HttpError(404, 'You are not in this conversation');

  const left = db.prepare('SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?').get(channel.id) as {
    c: number;
  };
  if (left.c === 0) {
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
  } else {
    const rows = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id) as {
      user_id: string;
    }[];
    for (const row of rows) sendToUser(row.user_id, { t: 'DM_UPDATE', d: serializeChannel(channel) });
  }
  sendToUser(me.id, { t: 'DM_DELETE', d: { id: channel.id } });
  res.json({ ok: true });
});
