import type {
  Attachment,
  AuthResponse,
  Bootstrap,
  Channel,
  Friend,
  Guild,
  Inbox,
  Invite,
  Member,
  Message,
  NotificationLevel,
  NotificationPref,
  PublicUser,
  SearchResult,
  Unread,
} from './types';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:4000';

/** Resolves a server-relative asset path (avatars, …) into something <img> can load. */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${API_BASE}${path}`;
}

const ACCESS_KEY = 'nimbus.access';
const REFRESH_KEY = 'nimbus.refresh';

let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);
let refreshing: Promise<boolean> | null = null;

export const tokens = {
  get access(): string | null {
    return accessToken;
  },
  get hasRefresh(): boolean {
    return Boolean(refreshToken);
  },
  set(access: string, refresh: string): void {
    accessToken = access;
    refreshToken = refresh;
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear(): void {
    accessToken = null;
    refreshToken = null;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function doRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        tokens.clear();
        return false;
      }
      const data = (await res.json()) as AuthResponse;
      tokens.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}, retry = true): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the Nimbus server. Is it running?');
  }

  if (res.status === 401 && retry && refreshToken) {
    const ok = await doRefresh();
    if (ok) return request<T>(path, options, false);
  }

  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  /* auth */
  register: (input: { email: string; password: string; username: string; displayName?: string }) =>
    request<AuthResponse>('/api/auth/register', { method: 'POST', body: input, auth: false }),
  login: (input: { email: string; password: string }) =>
    request<AuthResponse>('/api/auth/login', { method: 'POST', body: input, auth: false }),
  logout: (refreshToken: string | null) =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: { refreshToken } }),
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  /* users */
  updateProfile: (input: Partial<{ displayName: string; bio: string; avatarColor: string; status: string; customStatus: string }>) =>
    request<{ user: PublicUser }>('/api/users/@me', { method: 'PATCH', body: input }),
  uploadAvatar: (dataUrl: string) =>
    request<{ user: PublicUser }>('/api/users/@me/avatar', { method: 'POST', body: { dataUrl } }),
  removeAvatar: () => request<{ user: PublicUser }>('/api/users/@me/avatar', { method: 'DELETE' }),
  searchUsers: (q: string) => request<{ users: PublicUser[] }>(`/api/users/search?q=${encodeURIComponent(q)}`),
  getUser: (id: string) => request<{ user: PublicUser }>(`/api/users/${id}`),

  /* guilds + channels */
  createGuild: (name: string) =>
    request<{ guild: Guild; channels: Channel[]; members: Member[] }>('/api/guilds', { method: 'POST', body: { name } }),
  updateGuild: (id: string, input: { name?: string; iconColor?: string }) =>
    request<{ guild: Guild }>(`/api/guilds/${id}`, { method: 'PATCH', body: input }),
  deleteGuild: (id: string) => request<{ ok: boolean }>(`/api/guilds/${id}`, { method: 'DELETE' }),
  leaveGuild: (id: string) => request<{ ok: boolean }>(`/api/guilds/${id}/leave`, { method: 'POST' }),
  kickMember: (guildId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/guilds/${guildId}/members/${userId}`, { method: 'DELETE' }),
  updateMemberRole: (guildId: string, userId: string, role: 'admin' | 'member') =>
    request<{ member: Member }>(`/api/guilds/${guildId}/members/${userId}`, { method: 'PATCH', body: { role } }),
  createChannel: (guildId: string, name: string, type: 'text' | 'voice' = 'text', topic?: string) =>
    request<{ channel: Channel }>(`/api/guilds/${guildId}/channels`, { method: 'POST', body: { name, type, topic } }),
  updateChannel: (id: string, input: { name?: string; topic?: string; allowAttachments?: boolean }) =>
    request<{ channel: Channel }>(`/api/channels/${id}`, { method: 'PATCH', body: input }),
  deleteChannel: (id: string) => request<{ ok: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),

  /* invites */
  createInvite: (guildId: string, options: { maxUses?: number | null; expiresInMinutes?: number | null } = {}) =>
    request<Invite & { code: string; url: string }>(`/api/guilds/${guildId}/invites`, {
      method: 'POST',
      body: options,
    }),
  listInvites: (guildId: string) => request<{ invites: Invite[] }>(`/api/guilds/${guildId}/invites`),
  revokeInvite: (guildId: string, code: string) =>
    request<{ invite: Invite }>(`/api/guilds/${guildId}/invites/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  previewInvite: (code: string) =>
    request<{ code: string; guild: { id: string; name: string; iconColor: string; memberCount: number }; alreadyMember: boolean }>(
      `/api/invites/${encodeURIComponent(code)}`,
      { auth: false },
    ),
  joinInvite: (code: string) =>
    request<{ guild: Guild; channels: Channel[]; members: Member[] }>(`/api/invites/${encodeURIComponent(code)}/join`, {
      method: 'POST',
    }),

  /* messages */
  fetchMessages: (channelId: string, before?: number, limit = 50) =>
    request<{ messages: Message[]; hasMore: boolean; channelId: string }>(
      `/api/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
    ),
  sendMessage: (
    channelId: string,
    input: { content: string; replyToId?: string | null; attachmentIds?: string[]; nonce?: string },
  ) =>
    request<{ message: Message; nonce: string | null }>(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: input,
    }),
  editMessage: (messageId: string, content: string) =>
    request<{ message: Message }>(`/api/messages/${messageId}`, { method: 'PATCH', body: { content } }),
  deleteMessage: (messageId: string) =>
    request<{ ok: boolean }>(`/api/messages/${messageId}`, { method: 'DELETE' }),
  addReaction: (messageId: string, emoji: string) =>
    request<{ ok: boolean }>(`/api/messages/${messageId}/reactions`, { method: 'POST', body: { emoji } }),
  removeReaction: (messageId: string, emoji: string) =>
    request<{ ok: boolean }>(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: 'DELETE',
    }),
  sendTyping: (channelId: string) =>
    request<{ ok: boolean }>(`/api/channels/${channelId}/typing`, { method: 'POST' }),
  markRead: (channelId: string, seq?: number) =>
    request<{ ok: boolean; seq: number }>(`/api/channels/${channelId}/read`, { method: 'POST', body: { seq } }),
  markUnread: (channelId: string, seq?: number) =>
    request<{ ok: boolean; seq: number; lastSeq: number; unread: Unread }>(`/api/channels/${channelId}/unread`, {
      method: 'POST',
      body: { seq },
    }),
  fetchMessage: (messageId: string) =>
    request<{ message: Message; channel: Channel }>(`/api/messages/${encodeURIComponent(messageId)}`),
  fetchPins: (channelId: string) => request<{ messages: Message[] }>(`/api/channels/${channelId}/pins`),
  pinMessage: (messageId: string) =>
    request<{ message: Message }>(`/api/messages/${encodeURIComponent(messageId)}/pin`, { method: 'PUT' }),
  unpinMessage: (messageId: string) =>
    request<{ message: Message }>(`/api/messages/${encodeURIComponent(messageId)}/pin`, { method: 'DELETE' }),
  createThread: (messageId: string, name?: string) =>
    request<{ channel: Channel }>(`/api/messages/${messageId}/thread`, { method: 'POST', body: { name } }),
  fetchThreads: (channelId: string) => request<{ threads: Channel[] }>(`/api/channels/${channelId}/threads`),

  /* pictures */
  uploadAttachment: (input: { dataUrl: string; width: number; height: number }) =>
    request<{ attachment: Attachment }>('/api/attachments', { method: 'POST', body: input }),
  search: (q: string, opts: { guildId?: string; channelId?: string } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.guildId) params.set('guildId', opts.guildId);
    if (opts.channelId) params.set('channelId', opts.channelId);
    return request<SearchResult>(`/api/search?${params.toString()}`);
  },

  /* inbox */
  inbox: () => request<Inbox>('/api/inbox'),
  markInboxRead: () => request<{ ok: boolean }>('/api/inbox/read', { method: 'POST', body: {} }),

  /* social */
  friends: () => request<{ friends: Friend[] }>('/api/friends'),
  sendFriendRequest: (username: string) =>
    request<{ friend: Friend }>('/api/friends/requests', { method: 'POST', body: { username } }),
  acceptFriend: (userId: string) =>
    request<{ friend: Friend }>(`/api/friends/requests/${userId}/accept`, { method: 'POST' }),
  cancelFriendRequest: (userId: string) =>
    request<{ ok: boolean }>(`/api/friends/requests/${userId}`, { method: 'DELETE' }),
  removeFriend: (userId: string) => request<{ ok: boolean }>(`/api/friends/${userId}`, { method: 'DELETE' }),
  listDms: () => request<{ dms: Channel[] }>('/api/dms'),
  createDm: (recipientIds: string[]) =>
    request<{ channel: Channel }>('/api/dms', { method: 'POST', body: { recipientIds } }),
  addDmMember: (channelId: string, userId: string) =>
    request<{ channel: Channel }>(`/api/dms/${channelId}/members`, { method: 'POST', body: { userId } }),
  closeDm: (channelId: string) => request<{ ok: boolean }>(`/api/dms/${channelId}`, { method: 'DELETE' }),

  /* notification preferences + blocks */
  setNotificationPref: (input: { scope: 'channel' | 'guild'; targetId: string; level: NotificationLevel | null }) =>
    request<{ notificationPrefs: NotificationPref[] }>('/api/notification-prefs', { method: 'PUT', body: input }),
  blockUser: (userId: string) =>
    request<{ blocked: string[] }>(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'PUT' }),
  unblockUser: (userId: string) =>
    request<{ blocked: string[] }>(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'DELETE' }),
  listBlocks: () => request<{ blocked: PublicUser[] }>('/api/blocks'),
};

export type { Unread };
