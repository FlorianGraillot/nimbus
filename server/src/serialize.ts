import { db } from './db.js';
import { effectiveStatus } from './hub.js';
import { serializeAttachment } from './attachments.js';
import type {
  AttachmentDTO,
  AttachmentRow,
  ChannelDTO,
  ChannelRow,
  FriendDTO,
  GuildDTO,
  GuildRow,
  InviteDTO,
  InviteRow,
  MemberDTO,
  MessageAuthor,
  MessageDTO,
  MessageRow,
  PublicUser,
  ReactionSummary,
  UserRow,
} from './types.js';

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Stable, cache-busting path for a user's picture (null when unset). */
export function avatarUrl(u: UserRow): string | null {
  if (!u.avatar_data) return null;
  return `/api/users/${u.id}/avatar?v=${u.avatar_updated_at ?? 0}`;
}

export function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: avatarUrl(u),
    bio: u.bio,
    status: effectiveStatus(u.id, u.status, u.simulated_presence === 1),
    customStatus: u.custom_status,
    createdAt: u.created_at,
  };
}

export function messageAuthor(u: UserRow): MessageAuthor {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: avatarUrl(u),
  };
}

export function serializeGuild(g: GuildRow): GuildDTO {
  return { id: g.id, name: g.name, iconColor: g.icon_color, ownerId: g.owner_id, createdAt: g.created_at };
}

export function serializeChannel(row: ChannelRow): ChannelDTO {
  const dto: ChannelDTO = {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    type: row.type,
    topic: row.topic,
    position: row.position,
    parentId: row.parent_id,
    threadRootId: row.thread_root_id,
    createdAt: row.created_at,
    allowAttachments: row.allow_attachments !== 0,
  };
  if (row.type === 'dm' || row.type === 'group') {
    const users = db
      .prepare('SELECT u.* FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? ORDER BY cm.joined_at')
      .all(row.id) as UserRow[];
    dto.recipients = users.map(messageAuthor);
  }
  return dto;
}

export function serializeMember(
  user: UserRow,
  nickname: string,
  joinedAt: number,
  ownerId: string,
  role: string,
): MemberDTO {
  const isOwner = user.id === ownerId;
  return {
    ...publicUser(user),
    nickname,
    joinedAt,
    isOwner,
    role: isOwner ? 'owner' : role === 'admin' ? 'admin' : 'member',
  };
}

export function serializeFriends(rows: { requester_id: string; addressee_id: string; status: string; created_at: number }[], viewerId: string): FriendDTO[] {
  const out: FriendDTO[] = [];
  for (const row of rows) {
    const otherId = row.requester_id === viewerId ? row.addressee_id : row.requester_id;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId) as UserRow | undefined;
    if (!user) continue;
    const state: FriendDTO['state'] =
      row.status === 'accepted' ? 'accepted' : row.requester_id === viewerId ? 'outgoing' : 'incoming';
    out.push({ user: publicUser(user), state, since: row.created_at });
  }
  return out;
}

export function inviteIsActive(row: InviteRow, at = Date.now()): boolean {
  if (row.revoked_at) return false;
  if (row.expires_at !== null && row.expires_at <= at) return false;
  if (row.max_uses !== null && row.uses >= row.max_uses) return false;
  return true;
}

export function serializeInvite(row: InviteRow): InviteDTO {
  const creator = db.prepare('SELECT * FROM users WHERE id = ?').get(row.created_by) as UserRow | undefined;
  return {
    code: row.code,
    guildId: row.guild_id,
    url: `nimbus://invite/${row.code}`,
    createdAt: row.created_at,
    createdBy: creator ? messageAuthor(creator) : null,
    uses: row.uses,
    maxUses: row.max_uses,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    active: inviteIsActive(row),
  };
}

export function serializeMessages(rows: MessageRow[], viewerId: string): MessageDTO[] {
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const authors = new Map<string, UserRow>();
  for (const row of db
    .prepare(`SELECT * FROM users WHERE id IN (${placeholders(authorIds.length)})`)
    .all(...authorIds) as UserRow[]) {
    authors.set(row.id, row);
  }

  const pinnerIds = [...new Set(rows.map((r) => r.pinned_by).filter((v): v is string => Boolean(v)))].filter(
    (id) => !authors.has(id),
  );
  if (pinnerIds.length > 0) {
    for (const row of db
      .prepare(`SELECT * FROM users WHERE id IN (${placeholders(pinnerIds.length)})`)
      .all(...pinnerIds) as UserRow[]) {
      authors.set(row.id, row);
    }
  }

  const messageIds = rows.map((r) => r.id);
  const reactionRows = db
    .prepare(
      `SELECT message_id, emoji, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
       FROM reactions WHERE message_id IN (${placeholders(messageIds.length)})
       GROUP BY message_id, emoji ORDER BY MIN(created_at)`,
    )
    .all(viewerId, ...messageIds) as { message_id: string; emoji: string; count: number; me: number }[];

  const reactionsByMessage = new Map<string, ReactionSummary[]>();
  for (const r of reactionRows) {
    const list = reactionsByMessage.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, me: r.me === 1 });
    reactionsByMessage.set(r.message_id, list);
  }

  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((v): v is string => Boolean(v)))];
  const replies = new Map<
    string,
    { id: string; content: string; authorId: string; authorName: string; hasAttachments: boolean }
  >();
  if (replyIds.length) {
    const replyRows = db
      .prepare(
        `SELECT m.id, m.content, m.author_id, u.display_name,
                EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments
         FROM messages m
         JOIN users u ON u.id = m.author_id WHERE m.id IN (${placeholders(replyIds.length)})`,
      )
      .all(...replyIds) as {
      id: string;
      content: string;
      author_id: string;
      display_name: string;
      has_attachments: number;
    }[];
    for (const r of replyRows) {
      replies.set(r.id, {
        id: r.id,
        content: r.content,
        authorId: r.author_id,
        authorName: r.display_name,
        hasAttachments: r.has_attachments === 1,
      });
    }
  }

  const threadRows = db
    .prepare(`SELECT id, thread_root_id FROM channels WHERE thread_root_id IN (${placeholders(messageIds.length)})`)
    .all(...messageIds) as { id: string; thread_root_id: string }[];
  const threadByRoot = new Map(threadRows.map((t) => [t.thread_root_id, t.id]));

  const mentionRows = db
    .prepare(
      `SELECT message_id, user_id FROM mentions WHERE message_id IN (${placeholders(messageIds.length)})`,
    )
    .all(...messageIds) as { message_id: string; user_id: string }[];
  const mentionsByMessage = new Map<string, string[]>();
  for (const row of mentionRows) {
    const list = mentionsByMessage.get(row.message_id) ?? [];
    list.push(row.user_id);
    mentionsByMessage.set(row.message_id, list);
  }

  const attachmentRows = db
    .prepare(
      `SELECT * FROM attachments WHERE message_id IN (${placeholders(messageIds.length)})
       ORDER BY created_at, id`,
    )
    .all(...messageIds) as AttachmentRow[];
  const attachmentsByMessage = new Map<string, AttachmentDTO[]>();
  for (const row of attachmentRows) {
    if (!row.message_id) continue;
    const list = attachmentsByMessage.get(row.message_id) ?? [];
    list.push(serializeAttachment(row));
    attachmentsByMessage.set(row.message_id, list);
  }

  return rows.map((row) => {
    const author = authors.get(row.author_id);
    return {
      seq: row.seq,
      id: row.id,
      channelId: row.channel_id,
      content: row.deleted_at ? '' : row.content,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      system: row.system === 1,
      author: author
        ? messageAuthor(author)
        : { id: row.author_id, username: 'deleted', displayName: 'Deleted user', avatarColor: '#4b4d54', avatarUrl: null },
      replyTo: row.reply_to_id ? replies.get(row.reply_to_id) ?? null : null,
      reactions: reactionsByMessage.get(row.id) ?? [],
      attachments: row.deleted_at ? [] : attachmentsByMessage.get(row.id) ?? [],
      threadId: threadByRoot.get(row.id) ?? null,
      mentions: mentionsByMessage.get(row.id) ?? [],
      pinnedAt: row.pinned_at,
      pinnedBy: row.pinned_by && authors.get(row.pinned_by) ? messageAuthor(authors.get(row.pinned_by)!) : null,
    };
  });
}

export function serializeMessage(row: MessageRow, viewerId: string): MessageDTO {
  return serializeMessages([row], viewerId)[0];
}
