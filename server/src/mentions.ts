import { db, now } from './db.js';
import type { ChannelRow, MessageRow } from './types.js';

/**
 * @mentions are stored as rows instead of being re-parsed with LIKE on every
 * read. That keeps the Inbox exact (no `@aria` matching `@ariane`) and lets a
 * mention stay in the inbox until the channel is actually read.
 */

const TOKEN = /@([a-zA-Z0-9._-]{2,32})/g;

interface MentionableMember {
  id: string;
  username: string;
  display_name: string;
}

function guildMembersForMentions(guildId: string, authorId: string): MentionableMember[] {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name FROM guild_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.guild_id = ? AND u.id != ?`,
    )
    .all(guildId, authorId) as MentionableMember[];
}

function channelMembersForMentions(channelId: string, authorId: string): MentionableMember[] {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = ? AND u.id != ?`,
    )
    .all(channelId, authorId) as MentionableMember[];
}

/** People who can be mentioned in this channel (server members, or DM members). */
function mentionableMembers(channel: ChannelRow, authorId: string): MentionableMember[] {
  return channel.guild_id
    ? guildMembersForMentions(channel.guild_id, authorId)
    : channelMembersForMentions(channel.id, authorId);
}

/** User ids mentioned in `content`, resolved against the channel's audience. */
export function extractMentionIds(content: string, channel: ChannelRow, authorId: string): string[] {
  if (!content.includes('@')) return [];

  const tokens = new Set<string>();
  for (const match of content.matchAll(TOKEN)) tokens.add(match[1].toLowerCase());
  if (tokens.size === 0) return [];

  const members = mentionableMembers(channel, authorId);
  const ids = new Set<string>();

  if (tokens.has('everyone')) {
    for (const member of members) ids.add(member.id);
  }

  for (const member of members) {
    if (tokens.has(member.username.toLowerCase())) {
      ids.add(member.id);
      continue;
    }
    // `@Aria Chen` cannot be typed as a single token, so accept `@aria-chen`
    // and `@ariachen` shapes as well.
    const squashed = member.display_name.toLowerCase().replace(/\s+/g, '');
    if (tokens.has(squashed)) ids.add(member.id);
  }

  return [...ids];
}

/** Records mention rows for a freshly inserted message. Returns the user ids. */
export function recordMentions(message: MessageRow, channel: ChannelRow): string[] {
  const ids = extractMentionIds(message.content, channel, message.author_id);
  if (ids.length === 0) return ids;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO mentions (message_id, user_id, channel_id, guild_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const at = message.created_at;
  for (const userId of ids) {
    insert.run(message.id, userId, message.channel_id, channel.guild_id, at);
  }
  return ids;
}

/**
 * Reconciles mention rows after an edit without resurrecting a mention the
 * reader already cleared: existing rows keep their `read_at`, only added or
 * removed names change.
 */
export function syncMentions(message: MessageRow, channel: ChannelRow): void {
  const next = new Set(extractMentionIds(message.content, channel, message.author_id));
  const existingRows = db.prepare('SELECT user_id FROM mentions WHERE message_id = ?').all(message.id) as {
    user_id: string;
  }[];
  const existing = new Set(existingRows.map((r) => r.user_id));

  const remove = db.prepare('DELETE FROM mentions WHERE message_id = ? AND user_id = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO mentions (message_id, user_id, channel_id, guild_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const userId of existing) {
    if (!next.has(userId)) remove.run(message.id, userId);
  }
  for (const userId of next) {
    if (!existing.has(userId)) insert.run(message.id, userId, message.channel_id, channel.guild_id, message.created_at);
  }
}

/** Reading a channel clears its mentions from the inbox. */
export function clearChannelMentions(userId: string, channelId: string): void {
  db.prepare('UPDATE mentions SET read_at = ? WHERE user_id = ? AND channel_id = ? AND read_at IS NULL').run(
    now(),
    userId,
    channelId,
  );
}

export function clearAllMentions(userId: string): void {
  db.prepare('UPDATE mentions SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), userId);
}

/**
 * Backfills mentions for messages that predate the mentions table (or were
 * written straight to SQLite by the seed script). Runs once per database.
 */
export function backfillMentions(): void {
  const key = 'mentions_backfill_v1';
  const done = db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(key);
  if (done) return;

  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted_at IS NULL AND instr(m.content, '@') > 0`,
    )
    .all() as MessageRow[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO mentions (message_id, user_id, channel_id, guild_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const row of rows) {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(row.channel_id) as ChannelRow | undefined;
      if (!channel) continue;
      for (const userId of extractMentionIds(row.content, channel, row.author_id)) {
        insert.run(row.id, userId, row.channel_id, channel.guild_id, row.created_at);
      }
    }
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, String(now()));
  })();

  if (rows.length > 0) console.log(`[nimbus] mentions backfilled from ${rows.length} message(s)`);
}
