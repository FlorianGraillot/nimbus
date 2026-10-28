import { db } from './db.js';
import { blockedIds } from './blocks.js';
import { notificationPrefs } from './prefs.js';
import { messageAuthor, publicUser, serializeChannel, serializeGuild, serializeMember } from './serialize.js';
import type {
  ChannelDTO,
  ChannelRow,
  FriendDTO,
  GuildDTO,
  InboxChannelDTO,
  InboxDTO,
  InboxMentionDTO,
  MemberDTO,
  MessageAuthor,
  NotificationPrefDTO,
  PublicUser,
  UserRow,
  VoiceParticipantDTO,
} from './types.js';
import { serializeFriends } from './serialize.js';
import { voiceStatesFor } from './voice.js';

export function guildMembers(guildId: string): MemberDTO[] {
  const guild = db.prepare('SELECT owner_id FROM guilds WHERE id = ?').get(guildId) as { owner_id: string } | undefined;
  if (!guild) return [];
  const rows = db
    .prepare(
      `SELECT u.*, gm.nickname, gm.role, gm.joined_at FROM guild_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ?
       ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all(guildId) as (UserRow & { nickname: string; role: string; joined_at: number })[];
  return rows.map((r) => serializeMember(r, r.nickname, r.joined_at, guild.owner_id, r.role));
}

export function guildChannels(guildId: string): ChannelDTO[] {
  const rows = db
    .prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY position ASC, created_at ASC')
    .all(guildId) as ChannelRow[];
  return rows.map(serializeChannel);
}

export function guildPayload(guildId: string, viewerId: string) {
  const guild = db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId) as
    | { id: string; name: string; icon_color: string; owner_id: string; created_at: number }
    | undefined;
  if (!guild) return null;
  return {
    guild: serializeGuild(guild),
    channels: guildChannels(guildId),
    members: guildMembers(guildId),
    viewerId,
  };
}

export function dmPayload(channelId: string) {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
  return row ? serializeChannel(row) : null;
}

export function readStates(userId: string): Record<string, number> {
  const rows = db.prepare('SELECT channel_id, last_seq FROM read_states WHERE user_id = ?').all(userId) as {
    channel_id: string;
    last_seq: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.channel_id] = r.last_seq;
  return out;
}

export interface UnreadInfo {
  count: number;
  mentions: number;
}

export function unreadCounts(userId: string, channelIds: string[]): Record<string, UnreadInfo> {
  if (channelIds.length === 0) return {};
  const me = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined;
  if (!me) return {};

  const placeholders = channelIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.channel_id AS channel_id,
              COUNT(*) AS count,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM mentions mn WHERE mn.message_id = m.id AND mn.user_id = ?
                  ) THEN 1 ELSE 0 END) AS mentions
       FROM messages m
       LEFT JOIN read_states rs ON rs.channel_id = m.channel_id AND rs.user_id = ?
       WHERE m.channel_id IN (${placeholders})
         AND m.seq > COALESCE(rs.last_seq, 0)
         AND m.deleted_at IS NULL
         AND m.author_id != ?
       GROUP BY m.channel_id`,
    )
    .all(userId, userId, ...channelIds, userId) as {
    channel_id: string;
    count: number;
    mentions: number;
  }[];

  const out: Record<string, UnreadInfo> = {};
  for (const r of rows) out[r.channel_id] = { count: r.count, mentions: r.mentions ?? 0 };
  return out;
}

export function accessibleChannelIds(userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT c.id FROM channels c
       JOIN guild_members gm ON gm.guild_id = c.guild_id AND gm.user_id = ?
       UNION
       SELECT c.id FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?`,
    )
    .all(userId, userId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function friendList(userId: string): FriendDTO[] {
  const rows = db
    .prepare('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?')
    .all(userId, userId) as { requester_id: string; addressee_id: string; status: string; created_at: number }[];
  return serializeFriends(rows, userId);
}

export interface Bootstrap {
  user: PublicUser;
  guilds: GuildDTO[];
  channels: ChannelDTO[];
  members: Record<string, MemberDTO[]>;
  dms: ChannelDTO[];
  friends: FriendDTO[];
  reads: Record<string, number>;
  unread: Record<string, UnreadInfo>;
  notificationPrefs: NotificationPrefDTO[];
  blocked: string[];
  /** Live voice sessions the viewer can see, keyed by channel id. */
  voice: Record<string, VoiceParticipantDTO[]>;
}

export function bootstrapPayload(userId: string): Bootstrap {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  const guildRows = db
    .prepare(
      `SELECT g.* FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
       WHERE gm.user_id = ? ORDER BY g.created_at ASC`,
    )
    .all(userId) as { id: string; name: string; icon_color: string; owner_id: string; created_at: number }[];

  const guilds = guildRows.map(serializeGuild);
  const channels: ChannelDTO[] = [];
  const members: Record<string, MemberDTO[]> = {};
  for (const g of guildRows) {
    channels.push(...guildChannels(g.id));
    members[g.id] = guildMembers(g.id);
  }

  const dmRows = db
    .prepare(
      `SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
       WHERE cm.user_id = ? AND c.type IN ('dm','group') ORDER BY c.created_at ASC`,
    )
    .all(userId) as ChannelRow[];
  const dms = dmRows.map(serializeChannel);

  const ids = [...channels.map((c) => c.id), ...dms.map((c) => c.id)];

  return {
    user: publicUser(user),
    guilds,
    channels,
    members,
    dms,
    friends: friendList(userId),
    reads: readStates(userId),
    unread: unreadCounts(userId, ids),
    notificationPrefs: notificationPrefs(userId),
    blocked: blockedIds(userId),
    voice: voiceStatesFor(userId),
  };
}

export function memberAuthor(userId: string): MessageAuthor | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!row) return null;
  return messageAuthor(row);
}

/* ---------------------------------- inbox --------------------------------- */

/**
 * The Inbox is one screen for "what did I miss": unread @mentions first, then a
 * per-channel unread digest. Both lists are newest-first.
 *
 * A mention disappears once its channel is read, because we compare the
 * message seq against the user's read state (and `read_at` handles the explicit
 * "mark everything read" action).
 */
export function inboxPayload(userId: string): InboxDTO {
  const mentionRows = db
    .prepare(
      `SELECT m.id, m.seq, m.channel_id, m.content, m.created_at, m.author_id,
              c.guild_id, g.name AS guild_name,
              EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments
       FROM mentions mn
       JOIN messages m ON m.id = mn.message_id
       JOIN channels c ON c.id = mn.channel_id
       LEFT JOIN guilds g ON g.id = c.guild_id
       LEFT JOIN read_states rs ON rs.channel_id = mn.channel_id AND rs.user_id = mn.user_id
       WHERE mn.user_id = ?
         AND mn.read_at IS NULL
         AND m.deleted_at IS NULL
         AND m.seq > COALESCE(rs.last_seq, 0)
         AND (c.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
              OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
       ORDER BY m.created_at DESC, m.seq DESC
       LIMIT 50`,
    )
    .all(userId, userId, userId) as {
    id: string;
    seq: number;
    channel_id: string;
    content: string;
    created_at: number;
    author_id: string;
    guild_id: string | null;
    guild_name: string | null;
    has_attachments: number;
  }[];

  const authorIds = [...new Set(mentionRows.map((r) => r.author_id))];
  const authors = new Map<string, UserRow>();
  if (authorIds.length > 0) {
    for (const row of db
      .prepare(`SELECT * FROM users WHERE id IN (${authorIds.map(() => '?').join(',')})`)
      .all(...authorIds) as UserRow[]) {
      authors.set(row.id, row);
    }
  }

  const mentions: InboxMentionDTO[] = [];
  for (const row of mentionRows) {
    const author = authors.get(row.author_id);
    if (!author) continue;
    mentions.push({
      id: row.id,
      seq: row.seq,
      channelId: row.channel_id,
      content: row.content,
      createdAt: row.created_at,
      author: messageAuthor(author),
      guildId: row.guild_id,
      guildName: row.guild_name,
      hasAttachments: row.has_attachments === 1,
    });
  }

  const unreadRows = db
    .prepare(
      `SELECT m.channel_id,
              COUNT(*) AS count,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM mentions mn WHERE mn.message_id = m.id AND mn.user_id = ?
                  ) THEN 1 ELSE 0 END) AS mentions,
              MAX(m.seq) AS last_seq
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN read_states rs ON rs.channel_id = m.channel_id AND rs.user_id = ?
       WHERE m.seq > COALESCE(rs.last_seq, 0)
         AND m.deleted_at IS NULL
         AND m.author_id != ?
         AND c.type != 'thread'
         AND (c.guild_id IN (SELECT guild_id FROM guild_members WHERE user_id = ?)
              OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
       GROUP BY m.channel_id
       ORDER BY last_seq DESC
       LIMIT 50`,
    )
    .all(userId, userId, userId, userId, userId) as {
    channel_id: string;
    count: number;
    mentions: number;
    last_seq: number;
  }[];

  const lastStmt = db.prepare(
    `SELECT m.id, m.seq, m.content, m.created_at, m.author_id,
            EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments
     FROM messages m WHERE m.channel_id = ? AND m.deleted_at IS NULL
     ORDER BY m.seq DESC LIMIT 1`,
  );

  const unread: InboxChannelDTO[] = [];
  for (const row of unreadRows) {
    const last = lastStmt.get(row.channel_id) as
      | {
          id: string;
          seq: number;
          content: string;
          created_at: number;
          author_id: string;
          has_attachments: number;
        }
      | undefined;
    const author = last
      ? (db.prepare('SELECT * FROM users WHERE id = ?').get(last.author_id) as UserRow | undefined)
      : undefined;
    unread.push({
      channelId: row.channel_id,
      count: row.count,
      mentions: row.mentions ?? 0,
      last:
        last && author
          ? {
              id: last.id,
              seq: last.seq,
              content: last.content,
              createdAt: last.created_at,
              author: messageAuthor(author),
              hasAttachments: last.has_attachments === 1,
            }
          : null,
    });
  }

  unread.sort((a, b) => (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0));

  return { mentions, unread };
}
