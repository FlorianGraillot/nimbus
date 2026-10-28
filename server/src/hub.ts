import type { WebSocket } from 'ws';
import { db } from './db.js';
import type { ChannelRow, EffectiveStatus, PresenceStatus, PublicUser } from './types.js';

interface Conn {
  id: string;
  userId: string;
  socket: WebSocket;
  alive: boolean;
}

const conns = new Set<Conn>();
const byUser = new Map<string, Set<Conn>>();

export function addConnection(id: string, userId: string, socket: WebSocket): Conn {
  const conn: Conn = { id, userId, socket, alive: true };
  conns.add(conn);
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(conn);
  return conn;
}

export function removeConnection(conn: Conn): void {
  conns.delete(conn);
  const set = byUser.get(conn.userId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) byUser.delete(conn.userId);
}

export function isConnected(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

export function connectionCount(): number {
  return conns.size;
}

export function allConnections(): Conn[] {
  return [...conns];
}

export function sendToUser(userId: string, event: unknown): void {
  const set = byUser.get(userId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const conn of set) {
    if (conn.socket.readyState === 1) conn.socket.send(payload);
  }
}

export function sendToUsers(userIds: Iterable<string>, event: unknown): void {
  const payload = JSON.stringify(event);
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const set = byUser.get(userId);
    if (!set) continue;
    for (const conn of set) {
      if (conn.socket.readyState === 1) conn.socket.send(payload);
    }
  }
}

export function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const conn of conns) {
    if (conn.socket.readyState === 1) conn.socket.send(payload);
  }
}

/** Effective status as other users see it. */
export function effectiveStatus(userId: string, preferred: PresenceStatus, simulated = false): EffectiveStatus {
  if (preferred === 'invisible') return 'offline';
  return isConnected(userId) || simulated ? preferred : 'offline';
}

export function broadcastPresence(userId: string, preferred: PresenceStatus): void {
  const row = db.prepare('SELECT simulated_presence FROM users WHERE id = ?').get(userId) as
    | { simulated_presence: number }
    | undefined;
  broadcast({
    t: 'PRESENCE_UPDATE',
    d: { userId, status: effectiveStatus(userId, preferred, row?.simulated_presence === 1) },
  });
}

export function onlineUserIds(): string[] {
  return [...byUser.keys()];
}

/** Everyone who can see a channel: guild members, or DM participants. */
export function channelAudience(channel: ChannelRow): string[] {
  if (channel.guild_id) {
    const rows = db.prepare('SELECT user_id FROM guild_members WHERE guild_id = ?').all(channel.guild_id) as {
      user_id: string;
    }[];
    return rows.map((r) => r.user_id);
  }
  const rows = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id) as {
    user_id: string;
  }[];
  return rows.map((r) => r.user_id);
}

export function emitToChannel(channel: ChannelRow, event: unknown): void {
  sendToUsers(channelAudience(channel), event);
}

export function emitToGuild(guildId: string, event: unknown): void {
  const rows = db.prepare('SELECT user_id FROM guild_members WHERE guild_id = ?').all(guildId) as { user_id: string }[];
  sendToUsers(
    rows.map((r) => r.user_id),
    event,
  );
}

/**
 * Everyone who could already see this person's profile: fellow server members,
 * people sharing a DM or group, and accepted friends. Used for profile changes
 * so nobody receives a user they have no relationship with.
 */
export function userAudience(userId: string): string[] {
  const ids = new Set<string>([userId]);

  const guilds = db.prepare('SELECT guild_id FROM guild_members WHERE user_id = ?').all(userId) as {
    guild_id: string;
  }[];
  for (const guild of guilds) {
    const rows = db.prepare('SELECT user_id FROM guild_members WHERE guild_id = ?').all(guild.guild_id) as {
      user_id: string;
    }[];
    for (const row of rows) ids.add(row.user_id);
  }

  const channels = db.prepare('SELECT channel_id FROM channel_members WHERE user_id = ?').all(userId) as {
    channel_id: string;
  }[];
  for (const channel of channels) {
    const rows = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.channel_id) as {
      user_id: string;
    }[];
    for (const row of rows) ids.add(row.user_id);
  }

  const friends = db
    .prepare(
      `SELECT requester_id, addressee_id FROM friendships
       WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
    )
    .all(userId, userId) as { requester_id: string; addressee_id: string }[];
  for (const friend of friends) {
    ids.add(friend.requester_id === userId ? friend.addressee_id : friend.requester_id);
  }

  return [...ids];
}

export function emitUserUpdate(user: PublicUser): void {
  sendToUsers(userAudience(user.id), { t: 'USER_UPDATE', d: user });
}
