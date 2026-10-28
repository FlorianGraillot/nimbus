import { useEffect, useState, type MouseEvent } from 'react';
import { Bell, BellOff, Check, Hash, Mail, MessagesSquare, Phone, Pin, Search, Users } from 'lucide-react';
import { api } from '../lib/api';
import type { Channel, Message, NotificationLevel, TypingUser } from '../lib/types';
import { channelLabel, selectActiveChannel, useStore } from '../store/store';
import { useVoiceStore } from '../store/voice';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { Avatar, IconButton, Menu, MenuItem, MenuSeparator } from './ui';

const NO_TYPING: TypingUser[] = [];

const NOTIFICATION_LEVELS: { value: NotificationLevel; label: string }[] = [
  { value: 'all', label: 'All messages' },
  { value: 'mentions', label: 'Only @mentions' },
  { value: 'none', label: 'Nothing' },
];

export function ChatView() {
  const channel = useStore(selectActiveChannel);
  const me = useStore((s) => s.me);
  const presence = useStore((s) => s.presence);
  const memberListOpen = useStore((s) => s.memberListOpen);
  const toggleMemberList = useStore((s) => s.toggleMemberList);
  const openModal = useStore((s) => s.openModal);
  const openThread = useStore((s) => s.openThread);
  const threadChannelId = useStore((s) => s.threadChannelId);

  const channelId = channel?.id;
  const typing = useStore((s) => (channelId ? s.typing[channelId] : undefined) ?? NO_TYPING);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [threadsMenu, setThreadsMenu] = useState<{ x: number; y: number } | null>(null);
  const [notifyMenu, setNotifyMenu] = useState<{ x: number; y: number } | null>(null);
  const [threads, setThreads] = useState<Channel[]>([]);
  const setNotificationLevel = useStore((s) => s.setNotificationLevel);
  const markUnread = useStore((s) => s.markUnread);
  const notificationPrefs = useStore((s) => s.notificationPrefs);

  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const voicePhase = useVoiceStore((s) => s.phase);
  const startCall = useVoiceStore((s) => s.call);

  useEffect(() => {
    setReplyTo(null);
  }, [channelId]);

  if (!channel) {
    return (
      <div className="chat">
        <div className="chat-placeholder">
          <div className="chat-placeholder-icon">
            <MessagesSquare size={44} />
          </div>
          <h2>No channel selected</h2>
          <p>Pick a channel from the sidebar to start reading.</p>
        </div>
      </div>
    );
  }

  const isDm = channel.type === 'dm' || channel.type === 'group';
  const other = channel.recipients?.find((r) => r.id !== me?.id);
  const otherStatus = other ? presence[other.id] ?? 'offline' : undefined;
  const label = channelLabel(channel, me);

  const channelPref = notificationPrefs.find((p) => p.scope === 'channel' && p.targetId === channel.id)?.level;
  const parentPref = channel.parentId
    ? notificationPrefs.find((p) => p.scope === 'channel' && p.targetId === channel.parentId)?.level
    : undefined;
  const guildPref = channel.guildId
    ? notificationPrefs.find((p) => p.scope === 'guild' && p.targetId === channel.guildId)?.level
    : undefined;
  const channelLevel: NotificationLevel = channelPref ?? parentPref ?? guildPref ?? (channel.guildId ? 'mentions' : 'all');
  const guildLevel: NotificationLevel = guildPref ?? 'mentions';

  async function openThreadList(event: MouseEvent<HTMLButtonElement>) {
    if (!channel) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setThreadsMenu({ x: rect.right - 260, y: rect.bottom + 6 });
    try {
      const res = await api.fetchThreads(channel.id);
      setThreads(res.threads);
    } catch {
      setThreads([]);
    }
  }

  return (
    <div className={`chat ${threadChannelId ? 'with-thread' : ''}`}>
      <header className="chat-head">
        <div className="chat-head-main">
          {isDm ? (
            <Avatar
              name={label}
              color={other?.avatarColor ?? '#6d5efc'}
              src={other?.avatarUrl}
              size={26}
              status={channel.type === 'dm' ? otherStatus : undefined}
            />
          ) : (
            <Hash size={22} />
          )}
          <h1>{isDm ? label : channel.name}</h1>
          {channel.topic && (
            <>
              <span className="chat-head-divider" />
              <p className="chat-topic" title={channel.topic}>
                {channel.topic}
              </p>
            </>
          )}
          {isDm && channel.type === 'dm' && otherStatus && (
            <>
              <span className="chat-head-divider" />
              <p className="chat-topic">{otherStatus === 'offline' ? 'Offline' : otherStatus === 'dnd' ? 'Do Not Disturb' : otherStatus === 'idle' ? 'Idle' : 'Online'}</p>
            </>
          )}
          {channel.type === 'group' && (
            <>
              <span className="chat-head-divider" />
              <p className="chat-topic">{channel.recipients?.length ?? 0} members</p>
            </>
          )}
        </div>

        <div className="chat-head-actions">
          {isDm && (
            <IconButton
              label={
                voiceChannelId === channel.id
                  ? 'Call in progress'
                  : voicePhase !== 'idle'
                    ? 'You are already in a call'
                    : channel.type === 'group'
                      ? 'Start group call'
                      : 'Start voice call'
              }
              active={voiceChannelId === channel.id}
              disabled={voicePhase !== 'idle' && voiceChannelId !== channel.id}
              onClick={() => void startCall(channel.id)}
            >
              <Phone size={20} />
            </IconButton>
          )}
          <IconButton label="Pinned messages" onClick={() => openModal('pins', channel.id)}>
            <Pin size={20} />
          </IconButton>
          <IconButton
            label="Notification settings"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setNotifyMenu({ x: rect.right - 240, y: rect.bottom + 6 });
            }}
          >
            {channelLevel === 'none' ? <BellOff size={20} /> : <Bell size={20} />}
          </IconButton>
          {!isDm && (
            <IconButton label="Threads" onClick={(event) => void openThreadList(event)}>
              <MessagesSquare size={20} />
            </IconButton>
          )}
          <IconButton label="Search" onClick={() => openModal('search', channel.id)}>
            <Search size={20} />
          </IconButton>
          {!isDm && (
            <IconButton label="Toggle member list" active={memberListOpen} onClick={toggleMemberList}>
              <Users size={20} />
            </IconButton>
          )}
          {isDm && other && (
            <IconButton label="Profile" onClick={() => useStore.getState().openProfile(other.id)}>
              <Users size={20} />
            </IconButton>
          )}
        </div>
      </header>

      <MessageList channelId={channel.id} onReply={setReplyTo} />

      <div className="typing-bar">
        {typing.length > 0 && (
          <span>
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
            <strong>{typing.map((t) => t.displayName).join(', ')}</strong>
            {typing.length > 1 ? ' are typing…' : ' is typing…'}
          </span>
        )}
      </div>

      <Composer channelId={channel.id} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />

      <Menu open={Boolean(threadsMenu)} onClose={() => setThreadsMenu(null)} x={threadsMenu?.x} y={threadsMenu?.y} width={260}>
        <div className="menu-label">Active threads</div>
        {threads.length === 0 && <div className="menu-empty">No threads in this channel yet.</div>}
        {threads.map((thread) => (
          <MenuItem key={thread.id} icon={<MessagesSquare size={15} />} onClick={() => openThread(thread.id)}>
            {thread.name}
          </MenuItem>
        ))}
      </Menu>

      <Menu open={Boolean(notifyMenu)} onClose={() => setNotifyMenu(null)} x={notifyMenu?.x} y={notifyMenu?.y} width={240}>
        <div className="menu-label">Channel notifications</div>
        {NOTIFICATION_LEVELS.map((level) => (
          <MenuItem
            key={level.value}
            icon={channelLevel === level.value ? <Check size={15} /> : <Bell size={15} />}
            hint={channelLevel === level.value ? 'Current' : undefined}
            onClick={() => void setNotificationLevel('channel', channel.id, level.value)}
          >
            {level.label}
          </MenuItem>
        ))}
        {channel.guildId && (
          <>
            <MenuSeparator />
            <div className="menu-label">Server notifications</div>
            {NOTIFICATION_LEVELS.map((level) => (
              <MenuItem
                key={`guild-${level.value}`}
                icon={guildLevel === level.value ? <Check size={15} /> : <Bell size={15} />}
                hint={guildLevel === level.value ? 'Current' : undefined}
                onClick={() => void setNotificationLevel('guild', channel.guildId!, level.value)}
              >
                {level.label}
              </MenuItem>
            ))}
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={<Mail size={15} />} onClick={() => void markUnread(channel.id)}>
          Mark as unread
        </MenuItem>
      </Menu>
    </div>
  );
}
