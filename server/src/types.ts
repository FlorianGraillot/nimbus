export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type EffectiveStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type GuildRole = 'owner' | 'admin' | 'member';

export interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_color: string;
  bio: string;
  status: PresenceStatus;
  custom_status: string;
  simulated_presence: number;
  created_at: number;
  /** `data:image/...;base64,...` or null. */
  avatar_data: string | null;
  /** Changes on every upload so clients can bust their image cache. */
  avatar_updated_at: number | null;
}

export interface GuildRow {
  id: string;
  name: string;
  icon_color: string;
  owner_id: string;
  created_at: number;
}

export interface ChannelRow {
  id: string;
  guild_id: string | null;
  name: string;
  type: 'text' | 'voice' | 'thread' | 'dm' | 'group';
  topic: string;
  position: number;
  parent_id: string | null;
  thread_root_id: string | null;
  created_by: string | null;
  created_at: number;
  /** 1 = members may attach pictures, 0 = text only (owner/admin bypass). */
  allow_attachments: number;
}

export interface MessageRow {
  seq: number;
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  system: number;
  pinned_at: number | null;
  pinned_by: string | null;
}

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

export interface ReactionSummary {
  emoji: string;
  count: number;
  me: boolean;
}

export interface MessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  uploader_id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  data: string;
  created_at: number;
}

export interface AttachmentDTO {
  id: string;
  /** Signed, cacheable path for the image. */
  url: string;
  mime: string;
  width: number;
  height: number;
  size: number;
}

export interface MessageDTO {
  seq: number;
  id: string;
  channelId: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  system: boolean;
  author: MessageAuthor;
  replyTo: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    /** True when the replied-to message is a picture with no text. */
    hasAttachments: boolean;
  } | null;
  reactions: ReactionSummary[];
  attachments: AttachmentDTO[];
  threadId: string | null;
  /** Ids of the users this message @mentions. */
  mentions: string[];
  pinnedAt: number | null;
  pinnedBy: MessageAuthor | null;
}

export interface ChannelDTO {
  id: string;
  guildId: string | null;
  name: string;
  type: ChannelRow['type'];
  topic: string;
  position: number;
  parentId: string | null;
  threadRootId: string | null;
  createdAt: number;
  /** False when the server set this channel to text only for members. */
  allowAttachments: boolean;
  /** Only for dm/group channels. */
  recipients?: MessageAuthor[];
}

export interface GuildDTO {
  id: string;
  name: string;
  iconColor: string;
  ownerId: string;
  createdAt: number;
}

export interface MemberDTO extends PublicUser {
  nickname: string;
  joinedAt: number;
  isOwner: boolean;
  /** owner | admin | member — owner is derived from guilds.owner_id. */
  role: GuildRole;
}

export interface FriendDTO {
  user: PublicUser;
  /** accepted | incoming | outgoing */
  state: 'accepted' | 'incoming' | 'outgoing';
  since: number;
}

export interface InboxMentionDTO {
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

export interface InboxChannelDTO {
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

export interface InboxDTO {
  mentions: InboxMentionDTO[];
  unread: InboxChannelDTO[];
}

export type NotificationLevel = 'all' | 'mentions' | 'none';

export interface NotificationPrefDTO {
  scope: 'channel' | 'guild';
  targetId: string;
  level: NotificationLevel;
}

/**
 * Somebody currently connected to a voice session. Voice state is ephemeral:
 * it lives in memory and disappears when the last gateway connection closes.
 */
export interface VoiceParticipantDTO {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  muted: boolean;
  deafened: boolean;
  joinedAt: number;
}

export interface InviteRow {
  code: string;
  guild_id: string;
  created_by: string;
  created_at: number;
  uses: number;
  max_uses: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface InviteDTO {
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
