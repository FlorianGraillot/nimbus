import { create } from 'zustand';
import { api, ApiError, tokens } from '../lib/api';
import { notify, setBadge, flashWindow } from '../lib/desktop';
import { startGateway, stopGateway, type GatewayStatus } from '../lib/gateway';
import type {
  Attachment,
  Bootstrap,
  Channel,
  EffectiveStatus,
  Friend,
  Guild,
  Inbox,
  InboxMention,
  Invite,
  Member,
  Message,
  ModalKind,
  NotificationLevel,
  NotificationPref,
  PublicUser,
  Toast,
  TypingUser,
  Unread,
  UserStatus,
  VoiceParticipant,
} from '../lib/types';

const LAST_CHANNEL = 'nimbus.lastChannel';
const LAST_GUILD = 'nimbus.lastGuild';
const DRAFT_PREFIX = 'nimbus.drafts.';

const lastReadPost = new Map<string, number>();
const lastTypingPost = new Map<string, number>();
let lastInboxLoad = 0;

/**
 * Voice events are handled by the voice store, which owns the WebRTC peers.
 * The main store only keeps the participant lists (for the sidebar) so the two
 * modules stay independent and there is no import cycle.
 */
let voiceEventSink: ((event: { t: string; d: any }) => void) | null = null;

export function setVoiceEventSink(sink: ((event: { t: string; d: any }) => void) | null): void {
  voiceEventSink = sink;
}

function readDrafts(userId: string | null | undefined): Record<string, string> {
  if (!userId) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_PREFIX + userId) ?? '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[channelId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function upsertMessageList(list: Message[], message: Message, nonce?: string | null): Message[] {
  const existing = list.findIndex((m) => m.id === message.id);
  if (existing >= 0) {
    const next = list.slice();
    next[existing] = message;
    return next;
  }
  if (nonce) {
    const temp = list.findIndex((m) => m.nonce === nonce || m.id === `temp-${nonce}`);
    if (temp >= 0) {
      const next = list.slice();
      next[temp] = message;
      return next;
    }
  }
  return [...list, message];
}

function addUnread(unread: Record<string, Unread>, channelId: string, mention: boolean): Record<string, Unread> {
  const current = unread[channelId] ?? { count: 0, mentions: 0 };
  return {
    ...unread,
    [channelId]: { count: current.count + 1, mentions: current.mentions + (mention ? 1 : 0) },
  };
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function channelLabel(channel: Channel | undefined, me: PublicUser | null): string {
  if (!channel) return 'Nimbus';
  if (channel.type === 'dm') {
    const other = channel.recipients?.find((r) => r.id !== me?.id);
    return other?.displayName ?? 'Direct message';
  }
  if (channel.type === 'group') {
    return (
      channel.recipients
        ?.filter((r) => r.id !== me?.id)
        .map((r) => r.displayName)
        .join(', ') || 'Group'
    );
  }
  return `#${channel.name}`;
}

function pickInitial(data: Bootstrap): { guildId: string | null; channelId: string | null; view: 'guild' | 'friends' } {
  const all = [...data.channels, ...data.dms];
  const lastChannel = localStorage.getItem(LAST_CHANNEL);
  if (lastChannel) {
    const channel = all.find((c) => c.id === lastChannel);
    if (channel) {
      return {
        guildId: channel.guildId,
        channelId: channel.id,
        view: channel.guildId ? 'guild' : 'friends',
      };
    }
  }
  const lastGuild = localStorage.getItem(LAST_GUILD);
  const guild = data.guilds.find((g) => g.id === lastGuild) ?? data.guilds[0];
  if (!guild) return { guildId: null, channelId: null, view: 'friends' };
  const channel = data.channels.find((c) => c.guildId === guild.id && c.type === 'text');
  return { guildId: guild.id, channelId: channel?.id ?? null, view: 'guild' };
}

export interface Store {
  phase: 'booting' | 'auth' | 'ready';
  bootError: string | null;
  me: PublicUser | null;
  guilds: Guild[];
  channels: Channel[];
  members: Record<string, Member[]>;
  dms: Channel[];
  friends: Friend[];
  reads: Record<string, number>;
  unread: Record<string, Unread>;
  unreadMarkers: Record<string, number>;
  notificationPrefs: NotificationPref[];
  blocked: string[];
  /** Live voice sessions, keyed by channel id. */
  voice: Record<string, VoiceParticipant[]>;
  drafts: Record<string, string>;
  pins: Record<string, Message[]>;
  pinsLoading: Record<string, boolean>;
  inbox: Inbox | null;
  inboxLoading: boolean;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  loadingChannels: Record<string, boolean>;
  presence: Record<string, EffectiveStatus>;
  typing: Record<string, TypingUser[]>;
  activeGuildId: string | null;
  activeChannelId: string | null;
  view: 'guild' | 'friends' | 'inbox';
  threadChannelId: string | null;
  highlightMessageId: string | null;
  memberListOpen: boolean;
  modal: ModalKind;
  modalPayload: string | null;
  profileUserId: string | null;
  toasts: Toast[];
  gatewayStatus: GatewayStatus;

  boot: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; username: string; displayName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  applyBootstrap: (data: Bootstrap, preserveSelection?: boolean) => void;
  resync: () => Promise<void>;

  selectGuild: (guildId: string) => void;
  selectChannel: (channelId: string) => void;
  goHome: () => void;
  openFriends: () => void;
  setHighlight: (messageId: string | null) => void;
  jumpToMessage: (channelId: string, messageId: string, seq?: number) => Promise<void>;
  openThread: (channelId: string) => void;
  closeThread: () => void;

  openInbox: () => void;
  openMessage: (message: InboxMention) => Promise<void>;
  loadInbox: () => Promise<void>;
  markInboxRead: () => Promise<void>;

  loadMessages: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (
    channelId: string,
    content: string,
    replyToId?: string | null,
    attachments?: Attachment[],
  ) => Promise<boolean>;
  uploadAttachment: (input: { dataUrl: string; width: number; height: number }) => Promise<Attachment>;
  editMessage: (messageId: string, channelId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string, channelId: string) => Promise<void>;
  toggleReaction: (messageId: string, channelId: string, emoji: string, active: boolean) => Promise<void>;
  startTyping: (channelId: string) => void;
  markRead: (channelId: string, seq?: number) => void;
  markUnread: (channelId: string, seq?: number) => Promise<void>;
  setDraft: (channelId: string, value: string) => void;
  loadPins: (channelId: string) => Promise<void>;
  togglePin: (messageId: string, channelId: string, pinned: boolean) => Promise<void>;
  setNotificationLevel: (scope: 'channel' | 'guild', targetId: string, level: NotificationLevel | null) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  createThread: (messageId: string, channelId: string) => Promise<void>;

  createGuild: (name: string) => Promise<void>;
  joinInvite: (code: string) => Promise<void>;
  createChannel: (guildId: string, name: string, type?: 'text' | 'voice') => Promise<void>;
  updateChannel: (channelId: string, patch: { name?: string; topic?: string; allowAttachments?: boolean }) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  updateGuild: (guildId: string, patch: { name?: string; iconColor?: string }) => Promise<void>;
  leaveGuild: (guildId: string) => Promise<void>;
  deleteGuild: (guildId: string) => Promise<void>;
  kickMember: (guildId: string, userId: string) => Promise<void>;
  setMemberRole: (guildId: string, userId: string, role: 'admin' | 'member') => Promise<void>;
  createInvite: (
    guildId: string,
    options?: { maxUses?: number | null; expiresInMinutes?: number | null },
  ) => Promise<Invite>;
  listInvites: (guildId: string) => Promise<Invite[]>;
  revokeInvite: (guildId: string, code: string) => Promise<void>;

  sendFriendRequest: (username: string) => Promise<void>;
  acceptFriend: (userId: string) => Promise<void>;
  cancelFriendRequest: (userId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  openDm: (userId: string) => Promise<void>;
  createGroupDm: (userIds: string[]) => Promise<void>;
  closeDm: (channelId: string) => Promise<void>;

  updateProfile: (patch: Partial<{ displayName: string; bio: string; avatarColor: string; customStatus: string; status: UserStatus }>) => Promise<void>;
  uploadAvatar: (dataUrl: string) => Promise<void>;
  removeAvatar: () => Promise<void>;
  setStatus: (status: UserStatus) => Promise<void>;

  openModal: (modal: ModalKind, payload?: string) => void;
  closeModal: () => void;
  openProfile: (userId: string) => void;
  closeProfile: () => void;
  toggleMemberList: () => void;
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  handleEvent: (event: { t: string; d: any }) => void;
  refreshBadge: () => void;
}

export const useStore = create<Store>()((set, get) => ({
  phase: 'booting',
  bootError: null,
  me: null,
  guilds: [],
  channels: [],
  members: {},
  dms: [],
  friends: [],
  reads: {},
  unread: {},
  unreadMarkers: {},
  notificationPrefs: [],
  blocked: [],
  voice: {},
  drafts: {},
  pins: {},
  pinsLoading: {},
  inbox: null,
  inboxLoading: false,
  messages: {},
  hasMore: {},
  loadingChannels: {},
  presence: {},
  typing: {},
  activeGuildId: null,
  activeChannelId: null,
  view: 'friends',
  threadChannelId: null,
  highlightMessageId: null,
  memberListOpen: true,
  modal: null,
  modalPayload: null,
  profileUserId: null,
  toasts: [],
  gatewayStatus: 'offline',

  boot: async () => {
    if (!tokens.hasRefresh) {
      set({ phase: 'auth' });
      return;
    }
    try {
      const data = await api.bootstrap();
      get().applyBootstrap(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        tokens.clear();
      }
      set({ phase: 'auth', bootError: error instanceof Error ? error.message : null });
    }
  },

  login: async (email, password) => {
    const res = await api.login({ email, password });
    tokens.set(res.accessToken, res.refreshToken);
    const data = await api.bootstrap();
    get().applyBootstrap(data);
  },

  register: async (input) => {
    const res = await api.register(input);
    tokens.set(res.accessToken, res.refreshToken);
    const data = await api.bootstrap();
    get().applyBootstrap(data);
  },

  logout: async () => {
    try {
      await api.logout(tokens.hasRefresh ? localStorage.getItem('nimbus.refresh') : null);
    } catch {
      /* best effort */
    }
    stopGateway();
    tokens.clear();
    localStorage.removeItem(LAST_CHANNEL);
    localStorage.removeItem(LAST_GUILD);
    set({
      phase: 'auth',
      me: null,
      guilds: [],
      channels: [],
      members: {},
      dms: [],
      friends: [],
      reads: {},
      unread: {},
      unreadMarkers: {},
      notificationPrefs: [],
      blocked: [],
      voice: {},
      drafts: {},
      pins: {},
      pinsLoading: {},
      inbox: null,
      inboxLoading: false,
      messages: {},
      hasMore: {},
      presence: {},
      typing: {},
      activeGuildId: null,
      activeChannelId: null,
      threadChannelId: null,
      view: 'friends',
      modal: null,
      profileUserId: null,
    });
    setBadge(0);
    document.title = 'Nimbus';
  },

  applyBootstrap: (data, preserveSelection = false) => {
    const presence: Record<string, EffectiveStatus> = {};
    for (const member of Object.values(data.members).flat()) presence[member.id] = member.status;
    for (const friend of data.friends) presence[friend.user.id] = friend.user.status;
    presence[data.user.id] = data.user.status;

    const previous = get();
    const selection =
      preserveSelection && (previous.activeChannelId || previous.view === 'inbox')
        ? {
            guildId: previous.activeGuildId,
            channelId: previous.activeChannelId,
            view: previous.view,
          }
        : pickInitial(data);

    set({
      phase: 'ready',
      me: data.user,
      guilds: data.guilds,
      channels: data.channels,
      members: data.members,
      dms: data.dms,
      friends: data.friends,
      reads: data.reads,
      unread: data.unread,
      notificationPrefs: data.notificationPrefs ?? [],
      blocked: data.blocked ?? [],
      voice: data.voice ?? {},
      drafts: readDrafts(data.user.id),
      presence,
      bootError: null,
      activeGuildId: selection.guildId,
      activeChannelId: selection.channelId,
      view: selection.view,
      threadChannelId: preserveSelection ? previous.threadChannelId : null,
      inbox: preserveSelection ? previous.inbox : null,
    });

    if (!preserveSelection) {
      startGateway({
        onEvent: (event) => get().handleEvent(event),
        onStatus: (status) => set({ gatewayStatus: status }),
        onReconnect: () => {
          void get().resync();
        },
      });
    }

    if (selection.channelId) void get().loadMessages(selection.channelId);
    if (selection.view === 'inbox') void get().loadInbox();
    get().refreshBadge();
  },

  resync: async () => {
    try {
      const data = await api.bootstrap();
      get().applyBootstrap(data, true);
      const channelId = get().activeChannelId;
      if (channelId) {
        const res = await api.fetchMessages(channelId, undefined, 50);
        set((state) => ({
          messages: { ...state.messages, [channelId]: res.messages },
          hasMore: { ...state.hasMore, [channelId]: res.hasMore },
        }));
      }
    } catch {
      /* the gateway will retry */
    }
  },

  selectGuild: (guildId) => {
    const state = get();
    const guildChannels = state.channels.filter((c) => c.guildId === guildId && c.type === 'text');
    const remembered = guildChannels.find((c) => c.id === localStorage.getItem(LAST_CHANNEL));
    const target = remembered ?? guildChannels[0];
    localStorage.setItem(LAST_GUILD, guildId);
    set({ activeGuildId: guildId, view: 'guild', threadChannelId: null });
    if (target) get().selectChannel(target.id);
    else set({ activeChannelId: null });
  },

  selectChannel: (channelId) => {
    const state = get();
    const channel =
      state.channels.find((c) => c.id === channelId) ?? state.dms.find((c) => c.id === channelId);
    if (!channel) return;

    // Capture where the unread run starts before markRead advances the cursor,
    // so the list can render a "New messages" divider for this visit.
    const unreadCount = state.unread[channel.id]?.count ?? 0;
    const readSeq = state.reads[channel.id] ?? 0;
    const unreadMarkers = { ...state.unreadMarkers };
    if (unreadCount > 0) unreadMarkers[channel.id] = readSeq;
    else delete unreadMarkers[channel.id];

    set({
      activeChannelId: channel.id,
      activeGuildId: channel.guildId ?? state.activeGuildId,
      view: channel.guildId ? 'guild' : 'friends',
      threadChannelId: null,
      unreadMarkers,
    });
    localStorage.setItem(LAST_CHANNEL, channel.id);
    if (channel.guildId) localStorage.setItem(LAST_GUILD, channel.guildId);

    get().markRead(channel.id);
    if (channel.type !== 'voice' && !get().messages[channel.id]) void get().loadMessages(channel.id);
  },

  goHome: () => {
    set({ view: 'friends', activeChannelId: null, threadChannelId: null });
    localStorage.removeItem(LAST_CHANNEL);
  },

  openFriends: () => {
    set({ view: 'friends', activeChannelId: null, threadChannelId: null });
    localStorage.removeItem(LAST_CHANNEL);
  },

  setHighlight: (messageId) => set({ highlightMessageId: messageId }),

  jumpToMessage: async (channelId, messageId, seq) => {
    const channel = selectChannelById(get(), channelId);
    if (!channel) {
      get().pushToast('That conversation is no longer available', 'error');
      return;
    }

    let targetSeq = seq;
    if (!targetSeq) {
      try {
        const res = await api.fetchMessage(messageId);
        targetSeq = res.message.seq;
      } catch (error) {
        get().pushToast(error instanceof Error ? error.message : 'Could not find that message', 'error');
        return;
      }
    }

    const isThread = channel.type === 'thread' && Boolean(channel.parentId);
    get().selectChannel(isThread ? channel.parentId! : channel.id);
    if (isThread) get().openThread(channel.id);
    set({ highlightMessageId: messageId });

    const loaded = get().messages[channel.id] ?? [];
    if (!loaded.some((m) => m.id === messageId)) {
      try {
        // Load the page that ends on the target message, then let MessageList
        // scroll to it once it renders.
        const res = await api.fetchMessages(channel.id, targetSeq + 1, 50);
        set((s) => ({
          messages: { ...s.messages, [channel.id]: res.messages },
          hasMore: { ...s.hasMore, [channel.id]: res.hasMore },
        }));
      } catch {
        /* nothing to jump to — leave the current page in place */
      }
    }
  },

  openThread: (channelId) => {
    set({ threadChannelId: channelId });
    if (!get().messages[channelId]) void get().loadMessages(channelId);
    get().markRead(channelId);
  },

  closeThread: () => set({ threadChannelId: null }),

  openInbox: () => {
    set({ view: 'inbox', activeChannelId: null, threadChannelId: null });
    localStorage.removeItem(LAST_CHANNEL);
    void get().loadInbox();
  },

  openMessage: async (mention) => {
    await get().jumpToMessage(mention.channelId, mention.id, mention.seq);
  },

  loadInbox: async () => {
    if (get().inboxLoading) return;
    set({ inboxLoading: true });
    try {
      const inbox = await api.inbox();
      set({ inbox, inboxLoading: false });
    } catch {
      set({ inboxLoading: false });
    }
  },

  markInboxRead: async () => {
    try {
      await api.markInboxRead();
      set({ inbox: { mentions: [], unread: [] }, unread: {} });
      get().refreshBadge();
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not clear the inbox', 'error');
    }
  },

  loadMessages: async (channelId) => {
    if (get().loadingChannels[channelId]) return;
    set((state) => ({ loadingChannels: { ...state.loadingChannels, [channelId]: true } }));
    try {
      const res = await api.fetchMessages(channelId);
      set((state) => ({
        messages: { ...state.messages, [channelId]: res.messages },
        hasMore: { ...state.hasMore, [channelId]: res.hasMore },
      }));

      // The first visit to an unread channel has no cached last seq, so the
      // read state can only be advanced once the page arrives.
      const last = res.messages[res.messages.length - 1];
      const current = get();
      if (last && (current.activeChannelId === channelId || current.threadChannelId === channelId)) {
        get().markRead(channelId, last.seq);
      }
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not load messages', 'error');
    } finally {
      set((state) => ({ loadingChannels: { ...state.loadingChannels, [channelId]: false } }));
    }
  },

  loadOlder: async (channelId) => {
    const state = get();
    if (state.loadingChannels[channelId] || state.hasMore[channelId] === false) return;
    const existing = state.messages[channelId] ?? [];
    const first = existing[0];
    if (!first || first.seq <= 0) return;

    set((s) => ({ loadingChannels: { ...s.loadingChannels, [channelId]: true } }));
    try {
      const res = await api.fetchMessages(channelId, first.seq);
      set((s) => ({
        messages: { ...s.messages, [channelId]: [...res.messages, ...(s.messages[channelId] ?? [])] },
        hasMore: { ...s.hasMore, [channelId]: res.hasMore },
      }));
    } finally {
      set((s) => ({ loadingChannels: { ...s.loadingChannels, [channelId]: false } }));
    }
  },

  sendMessage: async (channelId, content, replyToId, attachments = []) => {
    const state = get();
    const me = state.me;
    if (!me) return false;
    const trimmed = content.trim();
    if (!trimmed && attachments.length === 0) return false;

    const nonce = crypto.randomUUID();
    const replied = replyToId ? (state.messages[channelId] ?? []).find((m) => m.id === replyToId) : null;
    const optimistic: Message = {
      seq: Number.MAX_SAFE_INTEGER,
      id: `temp-${nonce}`,
      channelId,
      content: trimmed,
      createdAt: Date.now(),
      editedAt: null,
      deletedAt: null,
      system: false,
      author: me,
      replyTo: replied
        ? {
            id: replied.id,
            content: replied.content,
            authorId: replied.author.id,
            authorName: replied.author.displayName,
          }
        : null,
      reactions: [],
      attachments,
      threadId: null,
      mentions: [],
      pinnedAt: null,
      pinnedBy: null,
      nonce,
    };

    set((s) => ({
      messages: { ...s.messages, [channelId]: [...(s.messages[channelId] ?? []), optimistic] },
    }));

    try {
      const res = await api.sendMessage(channelId, {
        content: trimmed,
        replyToId,
        attachmentIds: attachments.map((attachment) => attachment.id),
        nonce,
      });
      set((s) => ({
        messages: {
          ...s.messages,
          [channelId]: upsertMessageList(s.messages[channelId] ?? [], res.message, nonce),
        },
      }));
      return true;
    } catch (error) {
      set((s) => ({
        messages: {
          ...s.messages,
          [channelId]: (s.messages[channelId] ?? []).filter((m) => m.id !== optimistic.id),
        },
      }));
      get().pushToast(error instanceof Error ? error.message : 'Could not send message', 'error');
      return false;
    }
  },

  uploadAttachment: async (input) => {
    const res = await api.uploadAttachment(input);
    return res.attachment;
  },

  editMessage: async (messageId, channelId, content) => {
    try {
      const res = await api.editMessage(messageId, content);
      set((s) => ({
        messages: {
          ...s.messages,
          [channelId]: upsertMessageList(s.messages[channelId] ?? [], res.message),
        },
      }));
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not edit message', 'error');
    }
  },

  deleteMessage: async (messageId, channelId) => {
    try {
      await api.deleteMessage(messageId);
      set((s) => ({
        messages: {
          ...s.messages,
          [channelId]: (s.messages[channelId] ?? []).map((m) =>
            m.id === messageId ? { ...m, deletedAt: Date.now(), content: '', attachments: [] } : m,
          ),
        },
      }));
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not delete message', 'error');
    }
  },

  toggleReaction: async (messageId, channelId, emoji, active) => {
    try {
      if (active) await api.removeReaction(messageId, emoji);
      else await api.addReaction(messageId, emoji);
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not react', 'error');
    }
  },

  startTyping: (channelId) => {
    const now = Date.now();
    if ((lastTypingPost.get(channelId) ?? 0) + 3500 > now) return;
    lastTypingPost.set(channelId, now);
    api.sendTyping(channelId).catch(() => {});
  },

  markRead: (channelId, seq) => {
    const state = get();
    const lastMessage = state.messages[channelId]?.[state.messages[channelId].length - 1];
    const target = seq ?? lastMessage?.seq;
    if (!target || target <= 0) return;

    const alreadyRead = (state.reads[channelId] ?? 0) >= target;
    const hasUnread = (state.unread[channelId]?.count ?? 0) > 0;
    if (alreadyRead && !hasUnread) return;

    set((s) => ({
      reads: { ...s.reads, [channelId]: Math.max(s.reads[channelId] ?? 0, target) },
      unread: { ...s.unread, [channelId]: { count: 0, mentions: 0 } },
    }));

    const now = Date.now();
    if ((lastReadPost.get(channelId) ?? 0) + 1500 > now) {
      get().refreshBadge();
      return;
    }
    lastReadPost.set(channelId, now);
    api.markRead(channelId, target).catch(() => {});
    get().refreshBadge();
  },

  markUnread: async (channelId, seq) => {
    try {
      const res = await api.markUnread(channelId, seq);
      set((s) => ({
        reads: { ...s.reads, [channelId]: res.lastSeq },
        unread: { ...s.unread, [channelId]: res.unread },
        unreadMarkers: { ...s.unreadMarkers, [channelId]: res.lastSeq },
      }));
      get().refreshBadge();
      get().pushToast('Marked as unread', 'success');
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not mark as unread', 'error');
    }
  },

  setDraft: (channelId, value) => {
    const userId = get().me?.id;
    if (!userId) return;
    const next = { ...get().drafts };
    if (value.trim()) next[channelId] = value;
    else delete next[channelId];
    set({ drafts: next });
    try {
      localStorage.setItem(DRAFT_PREFIX + userId, JSON.stringify(next));
    } catch {
      /* storage full — drafts stay in memory for this session */
    }
  },

  loadPins: async (channelId) => {
    if (get().pinsLoading[channelId]) return;
    set((s) => ({ pinsLoading: { ...s.pinsLoading, [channelId]: true } }));
    try {
      const res = await api.fetchPins(channelId);
      set((s) => ({ pins: { ...s.pins, [channelId]: res.messages } }));
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not load pins', 'error');
    } finally {
      set((s) => ({ pinsLoading: { ...s.pinsLoading, [channelId]: false } }));
    }
  },

  togglePin: async (messageId, channelId, pinned) => {
    try {
      const res = pinned ? await api.unpinMessage(messageId) : await api.pinMessage(messageId);
      set((s) => {
        const list = s.messages[channelId] ?? [];
        const messages = {
          ...s.messages,
          [channelId]: list.map((m) => (m.id === messageId ? res.message : m)),
        };
        const existing = s.pins[channelId];
        let pins = s.pins;
        if (existing) {
          const without = existing.filter((m) => m.id !== messageId);
          pins = {
            ...s.pins,
            [channelId]: res.message.pinnedAt ? [res.message, ...without] : without,
          };
        }
        return { messages, pins };
      });
      get().pushToast(pinned ? 'Message unpinned' : 'Message pinned', 'success');
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not update pin', 'error');
    }
  },

  setNotificationLevel: async (scope, targetId, level) => {
    try {
      const res = await api.setNotificationPref({ scope, targetId, level });
      set({ notificationPrefs: res.notificationPrefs });
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not update notifications', 'error');
    }
  },

  blockUser: async (userId) => {
    try {
      const res = await api.blockUser(userId);
      set((s) => ({
        blocked: res.blocked,
        friends: s.friends.filter((f) => !(f.user.id === userId && f.state !== 'accepted')),
      }));
      get().pushToast('User blocked', 'info');
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not block that user', 'error');
    }
  },

  unblockUser: async (userId) => {
    try {
      const res = await api.unblockUser(userId);
      set({ blocked: res.blocked });
      get().pushToast('User unblocked', 'info');
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not unblock that user', 'error');
    }
  },

  createThread: async (messageId, channelId) => {
    try {
      const res = await api.createThread(messageId);
      set((s) => ({
        channels: s.channels.some((c) => c.id === res.channel.id) ? s.channels : [...s.channels, res.channel],
        messages: {
          ...s.messages,
          [channelId]: (s.messages[channelId] ?? []).map((m) =>
            m.id === messageId ? { ...m, threadId: res.channel.id } : m,
          ),
        },
      }));
      get().openThread(res.channel.id);
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not start thread', 'error');
    }
  },

  createGuild: async (name) => {
    const payload = await api.createGuild(name);
    get().handleEvent({ t: 'GUILD_CREATE', d: payload });
    const first = payload.channels.find((c) => c.type === 'text');
    set({ activeGuildId: payload.guild.id, view: 'guild' });
    if (first) get().selectChannel(first.id);
  },

  joinInvite: async (code) => {
    const payload = await api.joinInvite(code);
    get().handleEvent({ t: 'GUILD_CREATE', d: payload });
    const first = payload.channels.find((c) => c.type === 'text');
    set({ activeGuildId: payload.guild.id, view: 'guild' });
    if (first) get().selectChannel(first.id);
    get().pushToast(`Welcome to ${payload.guild.name}`, 'success');
  },

  createChannel: async (guildId, name, type = 'text') => {
    const res = await api.createChannel(guildId, name, type);
    set((s) => ({
      channels: s.channels.some((c) => c.id === res.channel.id) ? s.channels : [...s.channels, res.channel],
    }));
    get().selectChannel(res.channel.id);
  },

  updateChannel: async (channelId, patch) => {
    const res = await api.updateChannel(channelId, patch);
    set((s) => ({ channels: s.channels.map((c) => (c.id === channelId ? res.channel : c)) }));
    get().pushToast('Channel updated', 'success');
  },

  deleteChannel: async (channelId) => {
    const channel = get().channels.find((c) => c.id === channelId);
    await api.deleteChannel(channelId);
    set((s) => ({ channels: s.channels.filter((c) => c.id !== channelId) }));
    if (get().activeChannelId === channelId && channel?.guildId) {
      const next = get().channels.find((c) => c.guildId === channel.guildId && c.type === 'text');
      if (next) get().selectChannel(next.id);
      else set({ activeChannelId: null });
    }
    get().pushToast('Channel deleted', 'success');
  },

  updateGuild: async (guildId, patch) => {
    const res = await api.updateGuild(guildId, patch);
    set((s) => ({ guilds: s.guilds.map((g) => (g.id === guildId ? res.guild : g)) }));
  },

  leaveGuild: async (guildId) => {
    await api.leaveGuild(guildId);
  },

  deleteGuild: async (guildId) => {
    await api.deleteGuild(guildId);
  },

  kickMember: async (guildId, userId) => {
    await api.kickMember(guildId, userId);
    set((s) => ({
      members: { ...s.members, [guildId]: (s.members[guildId] ?? []).filter((m) => m.id !== userId) },
    }));
  },

  setMemberRole: async (guildId, userId, role) => {
    const res = await api.updateMemberRole(guildId, userId, role);
    set((s) => ({
      members: {
        ...s.members,
        [guildId]: (s.members[guildId] ?? []).map((m) => (m.id === userId ? res.member : m)),
      },
    }));
    get().pushToast(role === 'admin' ? 'Admin role granted' : 'Admin role removed', 'success');
  },

  createInvite: async (guildId, options) => {
    return api.createInvite(guildId, options);
  },

  listInvites: async (guildId) => {
    const res = await api.listInvites(guildId);
    return res.invites;
  },

  revokeInvite: async (guildId, code) => {
    await api.revokeInvite(guildId, code);
    get().pushToast('Invite revoked', 'info');
  },

  sendFriendRequest: async (username) => {
    const res = await api.sendFriendRequest(username);
    set((s) => ({
      friends: [...s.friends.filter((f) => f.user.id !== res.friend.user.id), res.friend],
    }));
    get().pushToast(`Friend request sent to ${res.friend.user.displayName}`, 'success');
  },

  acceptFriend: async (userId) => {
    await api.acceptFriend(userId);
    set((s) => ({
      friends: s.friends.map((f) => (f.user.id === userId ? { ...f, state: 'accepted' as const } : f)),
    }));
  },

  cancelFriendRequest: async (userId) => {
    await api.cancelFriendRequest(userId);
    set((s) => ({ friends: s.friends.filter((f) => f.user.id !== userId) }));
  },

  removeFriend: async (userId) => {
    await api.removeFriend(userId);
    set((s) => ({ friends: s.friends.filter((f) => f.user.id !== userId) }));
    get().pushToast('Friend removed', 'info');
  },

  openDm: async (userId) => {
    try {
      const res = await api.createDm([userId]);
      set((s) => ({
        dms: s.dms.some((d) => d.id === res.channel.id) ? s.dms : [...s.dms, res.channel],
        channels: s.channels,
      }));
      get().selectChannel(res.channel.id);
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not open conversation', 'error');
    }
  },

  createGroupDm: async (userIds) => {
    try {
      const res = await api.createDm(userIds);
      set((s) => ({
        dms: s.dms.some((d) => d.id === res.channel.id) ? s.dms : [...s.dms, res.channel],
      }));
      get().selectChannel(res.channel.id);
    } catch (error) {
      get().pushToast(error instanceof Error ? error.message : 'Could not create group', 'error');
    }
  },

  closeDm: async (channelId) => {
    await api.closeDm(channelId);
    set((s) => ({ dms: s.dms.filter((d) => d.id !== channelId) }));
    if (get().activeChannelId === channelId) {
      const next = get().dms[0];
      if (next) get().selectChannel(next.id);
      else set({ activeChannelId: null });
    }
  },

  updateProfile: async (patch) => {
    const res = await api.updateProfile(patch);
    set((s) => ({
      me: res.user,
      presence: { ...s.presence, [res.user.id]: res.user.status },
    }));
  },

  uploadAvatar: async (dataUrl) => {
    const res = await api.uploadAvatar(dataUrl);
    set({ me: res.user });
  },

  removeAvatar: async () => {
    const res = await api.removeAvatar();
    set({ me: res.user });
  },

  setStatus: async (status) => {
    await get().updateProfile({ status });
  },

  openModal: (modal, payload) => set({ modal, modalPayload: payload ?? null }),
  closeModal: () => set({ modal: null, modalPayload: null }),
  openProfile: (userId) => set({ profileUserId: userId }),
  closeProfile: () => set({ profileUserId: null }),
  toggleMemberList: () => set((s) => ({ memberListOpen: !s.memberListOpen })),

  pushToast: (message, kind = 'info') => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4500);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  refreshBadge: () => {
    const { unread } = get();
    let mentions = 0;
    let total = 0;
    for (const info of Object.values(unread)) {
      mentions += info.mentions;
      total += info.count;
    }
    setBadge(mentions);
    document.title = total > 0 ? `(${total}) Nimbus` : 'Nimbus';
  },

  handleEvent: (event) => {
    const { t, d } = event;

    // The voice engine listens for VOICE_* frames (signalling, ringing, …).
    voiceEventSink?.(event);

    switch (t) {
      case 'MESSAGE_CREATE': {
        const message = d as Message;
        const state = get();
        const active =
          state.activeChannelId === message.channelId || state.threadChannelId === message.channelId;
        const own = message.author.id === state.me?.id;
        const mention = !own && Boolean(state.me && (message.mentions ?? []).includes(state.me.id));

        set((s) => {
          const list = s.messages[message.channelId] ?? [];
          const messages = { ...s.messages, [message.channelId]: upsertMessageList(list, message, message.nonce) };
          const unread =
            !own && !active ? addUnread(s.unread, message.channelId, mention) : s.unread;
          return { messages, unread };
        });

        if (!own && !active) {
          const channel = [...state.channels, ...state.dms].find((c) => c.id === message.channelId);
          const level = notificationLevelFor(state, channel);
          const shouldNotify = level === 'all' || (level === 'mentions' && mention);
          if (shouldNotify) {
            notify({
              title: `${message.author.displayName} · ${channelLabel(channel, state.me)}`,
              body: stripMarkdown(message.content).slice(0, 140) ||
                (message.attachments?.length ? 'Sent a picture' : 'Sent a message'),
              channelId: message.channelId,
            });
            flashWindow();
          }
        } else if (active) {
          get().markRead(message.channelId, message.seq);
        }

        get().refreshBadge();
        if (!own && get().view === 'inbox') {
          const at = Date.now();
          if (at - lastInboxLoad > 900) {
            lastInboxLoad = at;
            void get().loadInbox();
          }
        }
        break;
      }

      case 'MESSAGE_UPDATE': {
        const message = d as Message;
        set((s) => {
          const existing = s.pins[message.channelId];
          let pins = s.pins;
          if (existing) {
            const without = existing.filter((m) => m.id !== message.id);
            pins = {
              ...s.pins,
              [message.channelId]: message.pinnedAt ? [message, ...without] : without,
            };
          }
          return {
            messages: {
              ...s.messages,
              [message.channelId]: upsertMessageList(s.messages[message.channelId] ?? [], message),
            },
            pins,
          };
        });
        break;
      }

      case 'MESSAGE_DELETE': {
        const { id, channelId } = d as { id: string; channelId: string };
        set((s) => ({
          messages: {
            ...s.messages,
            [channelId]: (s.messages[channelId] ?? []).map((m) =>
              m.id === id ? { ...m, deletedAt: Date.now(), content: '', attachments: [] } : m,
            ),
          },
        }));
        if (get().view === 'inbox') void get().loadInbox();
        break;
      }

      case 'REACTION_UPDATE': {
        const { messageId, channelId, emoji, userId, action } = d as {
          messageId: string;
          channelId: string;
          emoji: string;
          userId: string;
          action: 'add' | 'remove';
        };
        const me = get().me?.id;
        set((s) => {
          const list = s.messages[channelId];
          if (!list) return {};
          return {
            messages: {
              ...s.messages,
              [channelId]: list.map((message) => {
                if (message.id !== messageId) return message;
                const reactions = message.reactions.map((r) => ({ ...r }));
                const existing = reactions.find((r) => r.emoji === emoji);
                if (action === 'add') {
                  if (existing) {
                    existing.count += 1;
                    if (userId === me) existing.me = true;
                  } else {
                    reactions.push({ emoji, count: 1, me: userId === me });
                  }
                } else if (existing) {
                  existing.count -= 1;
                  if (userId === me) existing.me = false;
                }
                return { ...message, reactions: reactions.filter((r) => r.count > 0) };
              }),
            },
          };
        });
        break;
      }

      case 'TYPING_START': {
        const { channelId, userId, displayName } = d as { channelId: string; userId: string; displayName: string };
        if (userId === get().me?.id) break;
        set((s) => ({
          typing: {
            ...s.typing,
            [channelId]: [
              ...(s.typing[channelId] ?? []).filter((t2) => t2.userId !== userId),
              { userId, displayName, at: Date.now() },
            ],
          },
        }));
        window.setTimeout(() => {
          set((s) => ({
            typing: {
              ...s.typing,
              [channelId]: (s.typing[channelId] ?? []).filter((t2) => t2.userId !== userId),
            },
          }));
        }, 7000);
        break;
      }

      case 'USER_UPDATE': {
        const user = d as PublicUser;
        // Message authors only carry the fields they render, so map explicitly.
        const author = {
          username: user.username,
          displayName: user.displayName,
          avatarColor: user.avatarColor,
          avatarUrl: user.avatarUrl,
        };
        set((s) => {
          const members: Record<string, Member[]> = {};
          for (const [guildId, list] of Object.entries(s.members)) {
            members[guildId] = list.map((m) => (m.id === user.id ? { ...m, ...user } : m));
          }
          const messages: Record<string, Message[]> = {};
          for (const [channelId, list] of Object.entries(s.messages)) {
            messages[channelId] = list.map((m) => {
              if (m.author.id !== user.id && m.pinnedBy?.id !== user.id) return m;
              return {
                ...m,
                author: m.author.id === user.id ? { ...m.author, ...author } : m.author,
                pinnedBy: m.pinnedBy?.id === user.id ? { ...m.pinnedBy, ...author } : m.pinnedBy,
              };
            });
          }
          return {
            me: s.me?.id === user.id ? { ...s.me, ...user } : s.me,
            members,
            friends: s.friends.map((f) => (f.user.id === user.id ? { ...f, user: { ...f.user, ...user } } : f)),
            dms: s.dms.map((dm) =>
              dm.recipients
                ? { ...dm, recipients: dm.recipients.map((r) => (r.id === user.id ? { ...r, ...author } : r)) }
                : dm,
            ),
            messages,
          };
        });
        break;
      }

      case 'PRESENCE_UPDATE': {
        const { userId, status } = d as { userId: string; status: EffectiveStatus };
        set((s) => ({ presence: { ...s.presence, [userId]: status } }));
        break;
      }

      case 'GUILD_CREATE': {
        const payload = d as { guild: Guild; channels: Channel[]; members: Member[] };
        set((s) => {
          const guilds = s.guilds.some((g) => g.id === payload.guild.id)
            ? s.guilds.map((g) => (g.id === payload.guild.id ? payload.guild : g))
            : [...s.guilds, payload.guild];
          const known = new Set(s.channels.map((c) => c.id));
          const channels = [...s.channels, ...payload.channels.filter((c) => !known.has(c.id))];
          return {
            guilds,
            channels,
            members: { ...s.members, [payload.guild.id]: payload.members },
            activeGuildId: s.activeGuildId ?? payload.guild.id,
            view: s.activeGuildId ? s.view : 'guild',
          };
        });
        break;
      }

      case 'GUILD_UPDATE': {
        const guild = d as Guild;
        set((s) => ({ guilds: s.guilds.map((g) => (g.id === guild.id ? guild : g)) }));
        break;
      }

      case 'GUILD_DELETE': {
        const { id } = d as { id: string };
        set((s) => {
          const guilds = s.guilds.filter((g) => g.id !== id);
          const channels = s.channels.filter((c) => c.guildId !== id);
          const members = { ...s.members };
          delete members[id];
          let { activeGuildId, activeChannelId, view } = s;
          if (activeGuildId === id) {
            const nextGuild = guilds[0] ?? null;
            activeGuildId = nextGuild?.id ?? null;
            const nextChannel = nextGuild
              ? channels.find((c) => c.guildId === nextGuild.id && c.type === 'text')
              : undefined;
            activeChannelId = nextChannel?.id ?? null;
            view = nextGuild ? 'guild' : 'friends';
          }
          return { guilds, channels, members, activeGuildId, activeChannelId, view };
        });
        break;
      }

      case 'CHANNEL_CREATE': {
        const channel = d as Channel;
        set((s) =>
          channel.guildId
            ? { channels: s.channels.some((c) => c.id === channel.id) ? s.channels : [...s.channels, channel] }
            : { dms: s.dms.some((c) => c.id === channel.id) ? s.dms : [...s.dms, channel] },
        );
        break;
      }

      case 'CHANNEL_UPDATE': {
        const channel = d as Channel;
        set((s) => ({
          channels: s.channels.map((c) => (c.id === channel.id ? channel : c)),
        }));
        break;
      }

      case 'CHANNEL_DELETE': {
        const { id } = d as { id: string };
        set((s) => {
          const channels = s.channels.filter((c) => c.id !== id);
          if (s.activeChannelId !== id) return { channels };
          const next = channels.find((c) => c.guildId === s.activeGuildId && c.type === 'text');
          return { channels, activeChannelId: next?.id ?? null };
        });
        break;
      }

      case 'MEMBER_JOIN': {
        const { guildId, member } = d as { guildId: string; member: Member };
        set((s) => {
          const list = s.members[guildId] ?? [];
          if (list.some((m) => m.id === member.id)) return {};
          return {
            members: { ...s.members, [guildId]: [...list, member] },
            presence: { ...s.presence, [member.id]: member.status },
          };
        });
        break;
      }

      case 'MEMBER_REMOVE': {
        const { guildId, userId } = d as { guildId: string; userId: string };
        set((s) => ({
          members: { ...s.members, [guildId]: (s.members[guildId] ?? []).filter((m) => m.id !== userId) },
        }));
        break;
      }

      case 'MEMBER_UPDATE': {
        const { guildId, member } = d as { guildId: string; member: Member };
        set((s) => ({
          members: {
            ...s.members,
            [guildId]: (s.members[guildId] ?? []).map((m) => (m.id === member.id ? member : m)),
          },
        }));
        break;
      }

      case 'DM_CREATE': {
        const channel = d as Channel;
        set((s) => ({
          dms: s.dms.some((c) => c.id === channel.id) ? s.dms : [...s.dms, channel],
        }));
        break;
      }

      case 'DM_UPDATE': {
        const channel = d as Channel;
        set((s) => ({ dms: s.dms.map((c) => (c.id === channel.id ? channel : c)) }));
        break;
      }

      case 'DM_DELETE': {
        const { id } = d as { id: string };
        set((s) => ({
          dms: s.dms.filter((c) => c.id !== id),
          activeChannelId: s.activeChannelId === id ? null : s.activeChannelId,
        }));
        break;
      }

      case 'FRIEND_REQUEST':
      case 'FRIEND_ADD': {
        const friend = d as Friend;
        set((s) => ({
          friends: [...s.friends.filter((f) => f.user.id !== friend.user.id), friend],
          presence: { ...s.presence, [friend.user.id]: friend.user.status },
        }));
        if (t === 'FRIEND_REQUEST') get().pushToast(`${friend.user.displayName} sent you a friend request`, 'info');
        break;
      }

      case 'FRIEND_REMOVE': {
        const { userId } = d as { userId: string };
        set((s) => ({ friends: s.friends.filter((f) => f.user.id !== userId) }));
        break;
      }

      case 'THREAD_CREATE': {
        const channel = d as Channel;
        set((s) => ({
          channels: s.channels.some((c) => c.id === channel.id) ? s.channels : [...s.channels, channel],
        }));
        break;
      }

      case 'VOICE_STATE_UPDATE': {
        const { channelId, participants } = d as { channelId: string; participants: VoiceParticipant[] };
        set((s) => {
          const voice = { ...s.voice };
          if (participants.length > 0) voice[channelId] = participants;
          else delete voice[channelId];
          return { voice };
        });
        break;
      }

      case 'VOICE_CLOSED': {
        const { channelId } = d as { channelId: string };
        set((s) => {
          const voice = { ...s.voice };
          delete voice[channelId];
          return { voice };
        });
        break;
      }

      default:
        break;
    }
  },
}));

/* ------------------------------ selectors ------------------------------ */

/** Channel override beats server override; DMs default to everything. */
export function notificationLevelFor(state: Store, channel: Channel | undefined): NotificationLevel {
  if (!channel) return 'mentions';
  const prefs = state.notificationPrefs;
  const channelLevel = (id: string | null | undefined) =>
    id ? prefs.find((p) => p.scope === 'channel' && p.targetId === id)?.level : undefined;

  const direct = channelLevel(channel.id);
  if (direct) return direct;
  if (channel.parentId) {
    const inherited = channelLevel(channel.parentId);
    if (inherited) return inherited;
  }
  if (channel.guildId) {
    const guild = prefs.find((p) => p.scope === 'guild' && p.targetId === channel.guildId)?.level;
    return guild ?? 'mentions';
  }
  return 'all';
}

export const selectActiveChannel = (state: Store): Channel | undefined =>
  state.channels.find((c) => c.id === state.activeChannelId) ??
  state.dms.find((c) => c.id === state.activeChannelId);

export const selectChannelById = (state: Store, id: string): Channel | undefined =>
  state.channels.find((c) => c.id === id) ?? state.dms.find((c) => c.id === id);

export const selectPresence = (state: Store, user: { id: string; status: EffectiveStatus }): EffectiveStatus =>
  state.presence[user.id] ?? user.status;

/** Stable empty array so selectors never return a fresh reference. */
const NO_MEMBERS: Member[] = [];

export const selectMembers = (state: Store, guildId: string | null | undefined): Member[] =>
  (guildId ? state.members[guildId] : undefined) ?? NO_MEMBERS;
