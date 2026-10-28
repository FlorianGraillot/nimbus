export type EffectiveStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type ChannelType = 'text' | 'voice' | 'thread' | 'dm' | 'group';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  /** Relative path to the picture, or null when the user has none. */
  avatarUrl: string | null;
  bio: string;
  status: EffectiveStatus;
  customStatus: string;
  createdAt: number;
}

export interface MessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
}

export interface ReplyRef {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  /** True when the replied-to message is a picture with no text. */
  hasAttachments?: boolean;
}

export interface Attachment {
  id: string;
  /** Signed, server-relative path for the image. */
  url: string;
  mime: string;
  width: number;
  height: number;
  size: number;
}

export interface Message {
  seq: number;
  id: string;
  channelId: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  system: boolean;
  author: MessageAuthor;
  replyTo: ReplyRef | null;
  reactions: Reaction[];
  attachments: Attachment[];
  threadId: string | null;
  /** Ids of the users this message @mentions. */
  mentions: string[];
  pinnedAt: number | null;
  pinnedBy: MessageAuthor | null;
  nonce?: string;
}

export interface Channel {
  id: string;
  guildId: string | null;
  name: string;
  type: ChannelType;
  topic: string;
  position: number;
  parentId: string | null;
  threadRootId: string | null;
  createdAt: number;
  /** False when the server set this channel to text only for members. */
  allowAttachments: boolean;
  recipients?: MessageAuthor[];
}

export interface Guild {
  id: string;
  name: string;
  iconColor: string;
  ownerId: string;
  createdAt: number;
}

export type GuildRole = 'owner' | 'admin' | 'member';

export interface Member extends PublicUser {
  nickname: string;
  joinedAt: number;
  isOwner: boolean;
  /** owner comes from guilds.ownerId; admin can manage channels. */
  role: GuildRole;
}

export interface Friend {
  user: PublicUser;
  state: 'accepted' | 'incoming' | 'outgoing';
  since: number;
}

export interface Unread {
  count: number;
  mentions: number;
}

export interface InboxMention {
  id: string;
  seq: number;
  channelId: string;
  content: string;
  createdAt: number;
  author: MessageAuthor;
  guildId: string | null;
  guildName: string | null;
  /** True when the message is a picture with no text of its own. */
  hasAttachments: boolean;
}

export interface InboxChannel {
  channelId: string;
  count: number;
  mentions: number;
  last: {
    id: string;
    seq: number;
    content: string;
    createdAt: number;
    author: MessageAuthor;
    hasAttachments: boolean;
  } | null;
}

export interface Inbox {
  mentions: InboxMention[];
  unread: InboxChannel[];
}

export type NotificationLevel = 'all' | 'mentions' | 'none';

export interface NotificationPref {
  scope: 'channel' | 'guild';
  targetId: string;
  level: NotificationLevel;
}

export interface Invite {
  code: string;
  guildId: string;
  url: string;
  createdAt: number;
  createdBy: MessageAuthor | null;
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  active: boolean;
}

export interface SearchResult {
  messages: Message[];
  operators: {
    text: string;
    from: string | null;
    in: string | null;
    before: number | null;
    after: number | null;
  };
}

export interface TypingUser {
  userId: string;
  displayName: string;
  at: number;
}

/** Somebody currently connected to a voice session. */
export interface VoiceParticipant {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  muted: boolean;
  deafened: boolean;
  joinedAt: number;
}

export interface Bootstrap {
  user: PublicUser;
  guilds: Guild[];
  channels: Channel[];
  members: Record<string, Member[]>;
  dms: Channel[];
  friends: Friend[];
  reads: Record<string, number>;
  unread: Record<string, Unread>;
  notificationPrefs: NotificationPref[];
  blocked: string[];
  /** Live voice sessions the viewer can see, keyed by channel id. */
  voice: Record<string, VoiceParticipant[]>;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GatewayEvent {
  t: string;
  d: any;
}

export type ModalKind =
  | null
  | 'create-server'
  | 'join-server'
  | 'create-channel'
  | 'invite'
  | 'settings'
  | 'search'
  | 'profile'
  | 'channel-settings'
  | 'guild-settings'
  | 'group-dm'
  | 'pins';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
}
