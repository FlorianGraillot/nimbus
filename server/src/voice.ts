import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { getChannel, isChannelMember, isGuildMember } from './access.js';
import { blockedBetween } from './blocks.js';
import { channelAudience, isConnected, sendToUser, sendToUsers } from './hub.js';
import { avatarUrl } from './serialize.js';
import type { ChannelRow, UserRow, VoiceParticipantDTO } from './types.js';

/**
 * Voice sessions are deliberately ephemeral. Nothing is written to SQLite:
 * a call only exists while people are connected, and the gateway connection is
 * the source of truth for who is present.
 *
 * Media never touches this server. It only relays WebRTC signalling (SDP and
 * ICE candidates) between peers that are in the same session, which is why a
 * mesh call works with no extra infrastructure.
 */

export const VOICE_MAX = 5;

const MAX_SIGNAL_BYTES = 200_000;

interface VoiceMember {
  userId: string;
  channelId: string;
  sessionId: string;
  muted: boolean;
  deafened: boolean;
  joinedAt: number;
}

const members = new Map<string, VoiceMember>();

/* ------------------------------- helpers -------------------------------- */

function channelOrNull(channelId: string): ChannelRow | null {
  try {
    return getChannel(channelId);
  } catch {
    return null;
  }
}

/** Who is in a session, oldest first. */
function participants(channelId: string): VoiceParticipantDTO[] {
  const list = [...members.values()]
    .filter((member) => member.channelId === channelId)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  if (list.length === 0) return [];

  const ids = list.map((member) => member.userId);
  const rows = db
    .prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as UserRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const out: VoiceParticipantDTO[] = [];
  for (const member of list) {
    const user = byId.get(member.userId);
    if (!user) continue;
    out.push({
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarColor: user.avatar_color,
      avatarUrl: avatarUrl(user),
      muted: member.muted,
      deafened: member.deafened,
      joinedAt: member.joinedAt,
    });
  }
  return out;
}

/** Every session the user is allowed to see, for the bootstrap payload. */
export function voiceStatesFor(userId: string): Record<string, VoiceParticipantDTO[]> {
  const channelIds = [...new Set([...members.values()].map((member) => member.channelId))];
  const out: Record<string, VoiceParticipantDTO[]> = {};
  for (const channelId of channelIds) {
    const channel = channelOrNull(channelId);
    if (!channel) continue;
    const allowed = channel.guild_id
      ? isGuildMember(channel.guild_id, userId)
      : isChannelMember(channel.id, userId);
    if (!allowed) continue;
    out[channelId] = participants(channelId);
  }
  return out;
}

function broadcastChannel(channelId: string): void {
  const channel = channelOrNull(channelId);
  if (!channel) return;
  sendToUsers(channelAudience(channel), {
    t: 'VOICE_STATE_UPDATE',
    d: { channelId, participants: participants(channelId) },
  });
}

/**
 * Resolves a channel id into something that may host a call. Server channels
 * have to be real voice channels; direct messages and groups can always call.
 */
function callableChannel(channelId: unknown, userId: string): ChannelRow {
  if (typeof channelId !== 'string' || !channelId) throw new Error('Missing conversation');
  const channel = getChannel(channelId);

  if (channel.guild_id) {
    if (!isGuildMember(channel.guild_id, userId)) throw new Error('You are not a member of this server');
    if (channel.type !== 'voice') throw new Error('That is not a voice channel');
    return channel;
  }

  if (channel.type !== 'dm' && channel.type !== 'group') throw new Error('That conversation cannot host a call');
  if (!isChannelMember(channel.id, userId)) throw new Error('You do not have access to this conversation');
  return channel;
}

/* -------------------------------- actions -------------------------------- */

function joinVoice(userId: string, data: Record<string, unknown>): void {
  const channel = callableChannel(data.channelId, userId);
  const muted = data.muted === true;
  const deafened = data.deafened === true;

  const current = members.get(userId);
  if (current && current.channelId !== channel.id) leaveVoice(userId);

  const existing = [...members.values()].filter(
    (member) => member.channelId === channel.id && member.userId !== userId,
  );

  if (existing.length >= VOICE_MAX) {
    throw new Error(`This call is full — ${VOICE_MAX} people at most`);
  }

  if (channel.type === 'dm' || channel.type === 'group') {
    for (const member of existing) {
      if (blockedBetween(userId, member.userId)) throw new Error('You cannot join this call right now');
    }
  }

  const sameSession = members.get(userId);
  if (sameSession && sameSession.channelId === channel.id) {
    sameSession.muted = muted;
    sameSession.deafened = deafened;
  } else {
    members.set(userId, {
      userId,
      channelId: channel.id,
      sessionId: randomUUID(),
      muted,
      deafened,
      joinedAt: Date.now(),
    });
  }

  sendToUser(userId, {
    t: 'VOICE_JOINED',
    d: {
      channelId: channel.id,
      participants: participants(channel.id),
      self: { muted, deafened },
    },
  });
  broadcastChannel(channel.id);
}

export function leaveVoice(userId: string): void {
  const member = members.get(userId);
  if (!member) return;
  members.delete(userId);

  sendToUser(userId, { t: 'VOICE_LEFT', d: { channelId: member.channelId } });
  const channel = channelOrNull(member.channelId);

  /*
   * A direct or group call is a conversation, not a room: there is nothing to
   * sit in alone. When the second-to-last person leaves, close the call for the
   * last one as well. Doing this on the server keeps the state authoritative
   * even if that client is backgrounded, disconnected or simply slow to react.
   */
  if (channel && !channel.guild_id) {
    const remaining = [...members.values()].filter((other) => other.channelId === channel.id);
    if (remaining.length <= 1) {
      for (const other of remaining) {
        members.delete(other.userId);
        sendToUser(other.userId, {
          t: 'VOICE_CLOSED',
          d: { channelId: channel.id, reason: 'peer-left' },
        });
      }
    }
  }

  broadcastChannel(member.channelId);

  // A ring has no server-side lifetime, so tell anyone still waiting that the
  // caller walked away. Clients ignore this unless they are ringing for them.
  if (channel && !channel.guild_id) {
    sendToUsers(channelAudience(channel), {
      t: 'VOICE_RING_END',
      d: { channelId: channel.id, userId },
    });
  }
}

function updateState(userId: string, data: Record<string, unknown>): void {
  const member = members.get(userId);
  if (!member) return;
  member.muted = data.muted === true;
  member.deafened = data.deafened === true;
  broadcastChannel(member.channelId);
}

/** Rings the other people in a DM or group. Returns nothing; failures are sent. */
function ring(userId: string, data: Record<string, unknown>): void {
  const channel = callableChannel(data.channelId, userId);
  if (channel.guild_id) throw new Error('Start a call from a direct message');

  const others = db
    .prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ?')
    .all(channel.id, userId) as { user_id: string }[];

  for (const other of others) {
    if (blockedBetween(userId, other.user_id)) throw new Error('You cannot call this person');
  }

  const targets = others.filter((other) => isConnected(other.user_id) && !members.has(other.user_id));
  if (targets.length === 0) {
    sendToUser(userId, {
      t: 'VOICE_ERROR',
      d: {
        channelId: channel.id,
        message: others.length > 0 ? 'They are already in another call' : 'Nobody else is here right now',
      },
    });
    return;
  }

  const caller = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!caller) return;

  sendToUsers(
    targets.map((target) => target.user_id),
    {
      t: 'VOICE_RING',
      d: {
        channelId: channel.id,
        from: {
          id: caller.id,
          username: caller.username,
          displayName: caller.display_name,
          avatarColor: caller.avatar_color,
          avatarUrl: avatarUrl(caller),
        },
        group: channel.type === 'group',
      },
    },
  );
  sendToUser(userId, { t: 'VOICE_RING_SENT', d: { channelId: channel.id, count: targets.length } });
}

function decline(userId: string, data: Record<string, unknown>): void {
  const channel = callableChannel(data.channelId, userId);
  const targets = [...members.values()].filter(
    (member) => member.channelId === channel.id && member.userId !== userId,
  );
  sendToUsers(
    targets.map((member) => member.userId),
    { t: 'VOICE_DECLINE', d: { channelId: channel.id, fromUserId: userId } },
  );
}

function cancelRing(userId: string, data: Record<string, unknown>): void {
  const channel = callableChannel(data.channelId, userId);
  sendToUsers(
    channelAudience(channel).filter((id) => id !== userId),
    { t: 'VOICE_CANCEL', d: { channelId: channel.id, fromUserId: userId } },
  );
}

function signal(userId: string, data: Record<string, unknown>): void {
  const kind = data.kind;
  // `screen` is a tiny state frame: replaceTrack(null) mutes the remote track
  // instead of ending it, so the sharer tells peers when a share really stops.
  if (kind !== 'offer' && kind !== 'answer' && kind !== 'candidate' && kind !== 'screen') return;
  const toUserId = data.toUserId;
  if (typeof toUserId !== 'string') return;

  const from = members.get(userId);
  const to = members.get(toUserId);
  // Signalling only makes sense between two people already in the same call.
  if (!from || !to || from.channelId !== to.channelId) return;

  if (!data.payload || typeof data.payload !== 'object') return;
  if (JSON.stringify(data.payload).length > MAX_SIGNAL_BYTES) return;

  sendToUser(toUserId, {
    t: 'VOICE_SIGNAL',
    d: { channelId: from.channelId, fromUserId: userId, kind, payload: data.payload },
  });
}

/** Kicks everyone out when a channel is deleted. */
export function dropVoiceForChannel(channelId: string, reason = 'channel-deleted'): void {
  for (const member of [...members.values()]) {
    if (member.channelId !== channelId) continue;
    members.delete(member.userId);
    sendToUser(member.userId, { t: 'VOICE_CLOSED', d: { channelId, reason } });
  }
}

/** Kicks everyone out of every voice channel in a server. */
export function dropVoiceForGuild(guildId: string): void {
  const rows = db.prepare('SELECT id FROM channels WHERE guild_id = ?').all(guildId) as { id: string }[];
  for (const row of rows) dropVoiceForChannel(row.id, 'server-removed');
}

/** Used when someone is kicked or leaves a server while sitting in voice. */
export function dropVoiceForUserInGuild(userId: string, guildId: string): void {
  const member = members.get(userId);
  if (!member) return;
  const row = db.prepare('SELECT guild_id FROM channels WHERE id = ?').get(member.channelId) as
    | { guild_id: string | null }
    | undefined;
  if (row?.guild_id === guildId) leaveVoice(userId);
}

/* ------------------------------- gateway -------------------------------- */

export interface GatewayFrame {
  t?: string;
  d?: unknown;
}

/**
 * Handles client → server voice frames. Returns false when the frame is not a
 * voice frame so the caller can keep its own handling (PING, …).
 */
export function handleVoiceFrame(userId: string, frame: GatewayFrame): boolean {
  const type = frame.t;
  if (typeof type !== 'string' || !type.startsWith('VOICE_')) return false;

  const data = (frame.d && typeof frame.d === 'object' ? frame.d : {}) as Record<string, unknown>;
  const channelId = typeof data.channelId === 'string' ? data.channelId : null;

  try {
    switch (type) {
      case 'VOICE_JOIN':
        joinVoice(userId, data);
        break;
      case 'VOICE_LEAVE':
        leaveVoice(userId);
        break;
      case 'VOICE_STATE':
        updateState(userId, data);
        break;
      case 'VOICE_RING':
        ring(userId, data);
        break;
      case 'VOICE_DECLINE':
        decline(userId, data);
        break;
      case 'VOICE_CANCEL':
        cancelRing(userId, data);
        break;
      case 'VOICE_SIGNAL':
        signal(userId, data);
        break;
      default:
        break;
    }
  } catch (error) {
    // Bad signalling is dropped silently: a stale peer should not tear down a
    // healthy call. Everything else gets a visible error.
    if (type !== 'VOICE_SIGNAL') {
      sendToUser(userId, {
        t: 'VOICE_ERROR',
        d: {
          channelId,
          stage: type,
          message: error instanceof Error ? error.message : 'Voice is unavailable right now',
        },
      });
    }
  }
  return true;
}
