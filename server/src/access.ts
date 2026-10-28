import { db } from './db.js';
import type { ChannelRow, GuildRole, GuildRow } from './types.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getGuild(guildId: string): GuildRow {
  const row = db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId) as GuildRow | undefined;
  if (!row) throw new HttpError(404, 'Server not found');
  return row;
}

export function getChannel(channelId: string): ChannelRow {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
  if (!row) throw new HttpError(404, 'Channel not found');
  return row;
}

export function isGuildMember(guildId: string, userId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guildId, userId));
}

/** Owner > admin > member, or null when the user is not in the server. */
export function guildMemberRole(guild: GuildRow, userId: string): GuildRole | null {
  if (guild.owner_id === userId) return 'owner';
  const row = db.prepare('SELECT role FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guild.id, userId) as
    | { role: string }
    | undefined;
  if (!row) return null;
  return row.role === 'admin' ? 'admin' : 'member';
}

export function canManageChannels(guild: GuildRow, userId: string): boolean {
  const role = guildMemberRole(guild, userId);
  return role === 'owner' || role === 'admin';
}

export function requireGuildAdmin(guild: GuildRow, userId: string): void {
  if (!canManageChannels(guild, userId)) {
    throw new HttpError(403, 'Only the server owner or admins can do that');
  }
}

export function requireGuildMember(guildId: string, userId: string): void {
  if (!isGuildMember(guildId, userId)) throw new HttpError(403, 'You are not a member of this server');
}

export function isChannelMember(channelId: string, userId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId));
}

/** Throws unless the user is allowed to read/write the channel. */
export function assertChannelAccess(channel: ChannelRow, userId: string): void {
  if (channel.guild_id) {
    requireGuildMember(channel.guild_id, userId);
    return;
  }
  if (!isChannelMember(channel.id, userId)) throw new HttpError(403, 'You do not have access to this conversation');
}

export function assertGuildOwner(guild: GuildRow, userId: string): void {
  if (guild.owner_id !== userId) throw new HttpError(403, 'Only the server owner can do that');
}

export function isFriend(a: string, b: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM friendships
         WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
      )
      .get(a, b, b, a),
  );
}
