import { useState, type MouseEvent } from 'react';
import {
  Bell,
  BellOff,
  ChevronDown,
  CircleUser,
  Hash,
  Inbox as InboxIcon,
  Link2,
  LogOut,
  Mail,
  MicOff,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { channelLabel, notificationLevelFor, selectMembers, useStore } from '../store/store';
import { useVoiceStore } from '../store/voice';
import type { Channel, EffectiveStatus, UserStatus } from '../lib/types';
import { Avatar, IconButton, Menu, MenuItem, MenuSeparator, StatusDot } from './ui';

/* --------------------------------- sidebar -------------------------------- */

export function Sidebar() {
  const view = useStore((s) => s.view);
  return (
    <aside className="sidebar">
      {view === 'guild' ? <GuildSidebar /> : <HomeSidebar />}
      <UserPanel />
    </aside>
  );
}

/* ------------------------------- home / DMs ------------------------------- */

function HomeSidebar() {
  const dms = useStore((s) => s.dms);
  const me = useStore((s) => s.me);
  const friends = useStore((s) => s.friends);
  const unread = useStore((s) => s.unread);
  const presence = useStore((s) => s.presence);
  const view = useStore((s) => s.view);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const selectChannel = useStore((s) => s.selectChannel);
  const openFriends = useStore((s) => s.openFriends);
  const openInbox = useStore((s) => s.openInbox);
  const openModal = useStore((s) => s.openModal);
  const closeDm = useStore((s) => s.closeDm);
  const drafts = useStore((s) => s.drafts);

  const pending = friends.filter((f) => f.state === 'incoming').length;
  const mentions = Object.values(unread).reduce((sum, info) => sum + info.mentions, 0);

  return (
    <>
      <div className="sidebar-head">
        <button className="sidebar-search" onClick={() => openModal('search')}>
          <span>Find or start a conversation</span>
        </button>
      </div>

      <div className="sidebar-scroll">
        <button className={`nav-row ${view === 'inbox' ? 'is-active' : ''}`} onClick={openInbox}>
          <InboxIcon size={18} />
          <span>Inbox</span>
          {mentions > 0 && <span className="nav-badge">{mentions > 99 ? '99+' : mentions}</span>}
        </button>

        <button
          className={`nav-row ${view === 'friends' && !activeChannelId ? 'is-active' : ''}`}
          onClick={openFriends}
        >
          <Users size={18} />
          <span>Friends</span>
          {pending > 0 && <span className="nav-badge">{pending}</span>}
        </button>

        <div className="sidebar-section-head">
          <span>Direct messages</span>
          <IconButton label="Create group DM" onClick={() => openModal('group-dm')}>
            <Plus size={16} />
          </IconButton>
        </div>

        <div className="dm-list">
          {dms.length === 0 && <p className="sidebar-empty">No conversations yet. Add a friend to start one.</p>}
          {dms.map((dm) => {
            const other = dm.recipients?.find((r) => r.id !== me?.id) ?? dm.recipients?.[0];
            const status = (other ? presence[other.id] : undefined) ?? 'offline';
            const info = unread[dm.id];
            return (
              <div
                key={dm.id}
                className={`dm-row ${activeChannelId === dm.id ? 'is-active' : ''}`}
                onClick={() => selectChannel(dm.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && selectChannel(dm.id)}
              >
                <Avatar
                  name={channelLabel(dm, me)}
                  color={other?.avatarColor ?? '#6d5efc'}
                  src={other?.avatarUrl}
                  size={32}
                  status={dm.type === 'group' ? undefined : status}
                />
                <span className="dm-name">{channelLabel(dm, me)}</span>
                {drafts[dm.id] && <span className="draft-dot" title="Draft" />}
                {info?.count > 0 && <span className="unread-badge">{info.count > 99 ? '99+' : info.count}</span>}
                <button
                  className="dm-close"
                  aria-label="Close conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeDm(dm.id);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ------------------------------ guild sidebar ----------------------------- */

function GuildSidebar() {
  const guilds = useStore((s) => s.guilds);
  const activeGuildId = useStore((s) => s.activeGuildId);
  const channels = useStore((s) => s.channels);
  const me = useStore((s) => s.me);
  const members = useStore((s) => selectMembers(s, activeGuildId));
  const unread = useStore((s) => s.unread);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const selectChannel = useStore((s) => s.selectChannel);
  const openModal = useStore((s) => s.openModal);
  const leaveGuild = useStore((s) => s.leaveGuild);
  const deleteGuild = useStore((s) => s.deleteGuild);
  const deleteChannel = useStore((s) => s.deleteChannel);
  const pushToast = useStore((s) => s.pushToast);
  const drafts = useStore((s) => s.drafts);
  const markUnread = useStore((s) => s.markUnread);
  const setNotificationLevel = useStore((s) => s.setNotificationLevel);
  useStore((s) => s.notificationPrefs);
  const voiceStates = useStore((s) => s.voice);
  const myVoiceChannel = useVoiceStore((s) => s.channelId);
  const voicePhase = useVoiceStore((s) => s.phase);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; channel: Channel } | null>(null);

  const guild = guilds.find((g) => g.id === activeGuildId);
  const textChannels = channels
    .filter((c) => c.guildId === activeGuildId && c.type === 'text')
    .sort((a, b) => a.position - b.position);
  const voiceChannels = channels
    .filter((c) => c.guildId === activeGuildId && c.type === 'voice')
    .sort((a, b) => a.position - b.position);
  const isOwner = guild?.ownerId === me?.id;
  const isAdmin = members.some((m) => m.id === me?.id && m.role === 'admin');
  const canManage = isOwner || isAdmin;
  const contextMuted = context ? notificationLevelFor(useStore.getState(), context.channel) === 'none' : false;

  if (!guild) {
    return (
      <div className="sidebar-scroll">
        <p className="sidebar-empty">Select a server to get started.</p>
      </div>
    );
  }

  const openMenu = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 6 });
  };

  return (
    <>
      <button className="guild-head" onClick={openMenu}>
        <span>{guild.name}</span>
        <ChevronDown size={16} />
      </button>

      <Menu open={Boolean(menu)} onClose={() => setMenu(null)} x={menu?.x} y={menu?.y} width={224}>
        <MenuItem icon={<UserPlus size={16} />} onClick={() => openModal('invite', guild.id)}>
          Invite people
        </MenuItem>
        {canManage && (
          <MenuItem icon={<Plus size={16} />} onClick={() => openModal('create-channel', guild.id)}>
            Create channel
          </MenuItem>
        )}
        <MenuItem icon={<Settings size={16} />} onClick={() => openModal('guild-settings', guild.id)}>
          Server settings
        </MenuItem>
        <MenuSeparator />
        {isOwner ? (
          <MenuItem
            danger
            icon={<Trash2 size={16} />}
            onClick={() => {
              if (window.confirm(`Delete “${guild.name}”? This cannot be undone.`)) {
                void deleteGuild(guild.id)
                  .then(() => pushToast('Server deleted', 'success'))
                  .catch((error) => pushToast(error instanceof Error ? error.message : 'Could not delete server', 'error'));
              }
            }}
          >
            Delete server
          </MenuItem>
        ) : (
          <MenuItem
            danger
            icon={<LogOut size={16} />}
            onClick={() => {
              if (window.confirm(`Leave “${guild.name}”?`)) void leaveGuild(guild.id);
            }}
          >
            Leave server
          </MenuItem>
        )}
      </Menu>

      <div className="sidebar-scroll">
        <div className="sidebar-section-head">
          <span>Text channels</span>
          {canManage && (
            <IconButton label="Create channel" onClick={() => openModal('create-channel', guild.id)}>
              <Plus size={16} />
            </IconButton>
          )}
        </div>

        <div className="channel-list">
          {textChannels.map((channel) => {
            const info = unread[channel.id];
            const active = activeChannelId === channel.id;
            const unreadCount = active ? 0 : (info?.count ?? 0);
            return (
              <button
                key={channel.id}
                className={`channel-row ${active ? 'is-active' : ''} ${unreadCount > 0 ? 'is-unread' : ''}`}
                onClick={() => selectChannel(channel.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContext({ x: event.clientX, y: event.clientY, channel });
                }}
              >
                <Hash size={18} />
                <span className="channel-name">{channel.name}</span>
                {drafts[channel.id] && <span className="draft-dot" title="Draft" />}
                {unreadCount > 0 && (
                  <span className={`unread-badge ${info?.mentions ? 'is-mention' : ''}`}>
                    {info?.mentions ? info.mentions : unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
            );
          })}
          {textChannels.length === 0 && <p className="sidebar-empty">No channels yet.</p>}
        </div>

        <div className="sidebar-section-head">
          <span>Voice channels</span>
          {canManage && (
            <IconButton label="Create voice channel" onClick={() => openModal('create-channel', guild.id)}>
              <Plus size={16} />
            </IconButton>
          )}
        </div>

        <div className="channel-list">
          {voiceChannels.map((channel) => {
            const people = voiceStates[channel.id] ?? [];
            const active = activeChannelId === channel.id;
            const joined = myVoiceChannel === channel.id && voicePhase !== 'idle';
            return (
              <div key={channel.id} className="voice-channel-group">
                <button
                  className={`channel-row voice-channel-row ${active ? 'is-active' : ''} ${joined ? 'is-joined' : ''}`}
                  onClick={() => {
                    selectChannel(channel.id);
                    // Discord-style: clicking an empty room drops you in. If a
                    // call is already running elsewhere we only open the room,
                    // so nobody is hung up on by accident.
                    if (useVoiceStore.getState().phase === 'idle') {
                      void useVoiceStore.getState().join(channel.id);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContext({ x: event.clientX, y: event.clientY, channel });
                  }}
                >
                  <Volume2 size={18} />
                  <span className="channel-name">{channel.name}</span>
                  {people.length > 0 && <span className="voice-count">{people.length}</span>}
                </button>

                {people.length > 0 && (
                  <div className="voice-people">
                    {people.map((person) => (
                      <div key={person.userId} className="voice-person">
                        <Avatar
                          name={person.displayName}
                          color={person.avatarColor}
                          src={person.avatarUrl}
                          size={18}
                        />
                        <span className="voice-person-name">{person.displayName}</span>
                        {person.muted && <MicOff size={12} className="voice-person-mute" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {voiceChannels.length === 0 && <p className="sidebar-empty">No voice channels yet.</p>}
        </div>
      </div>

      <Menu open={Boolean(context)} onClose={() => setContext(null)} x={context?.x} y={context?.y} width={210}>
        {context?.channel.type === 'voice' && (
          <MenuItem
            icon={<Volume2 size={16} />}
            onClick={() => {
              if (!context) return;
              const state = useVoiceStore.getState();
              if (state.channelId === context.channel.id) state.leave();
              else void state.join(context.channel.id);
            }}
          >
            {myVoiceChannel === context?.channel.id ? 'Leave call' : 'Join voice'}
          </MenuItem>
        )}
        {canManage && (
          <MenuItem
            icon={<Pencil size={16} />}
            onClick={() => context && openModal('channel-settings', context.channel.id)}
          >
            Edit channel
          </MenuItem>
        )}
        <MenuItem
          icon={<Link2 size={16} />}
          onClick={() => {
            if (!context) return;
            void navigator.clipboard?.writeText(`nimbus://channel/${context.channel.id}`).catch(() => {});
            pushToast('Channel link copied', 'success');
          }}
        >
          Copy link
        </MenuItem>
        {context?.channel.type !== 'voice' && (
          <MenuItem
            icon={<Mail size={16} />}
            onClick={() => {
              if (!context) return;
              void markUnread(context.channel.id);
            }}
          >
            Mark as unread
          </MenuItem>
        )}
        <MenuItem
          icon={contextMuted ? <Bell size={16} /> : <BellOff size={16} />}
          onClick={() => {
            if (!context) return;
            void setNotificationLevel('channel', context.channel.id, contextMuted ? null : 'none');
          }}
        >
          {contextMuted ? 'Unmute channel' : 'Mute channel'}
        </MenuItem>
        {canManage && (
          <>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              onClick={() => {
                if (context && window.confirm(`Delete ${context.channel.type === 'voice' ? '' : '#'}${context.channel.name}?`)) {
                  void deleteChannel(context.channel.id).catch((error) =>
                    pushToast(error instanceof Error ? error.message : 'Could not delete channel', 'error'),
                  );
                }
              }}
            >
              Delete channel
            </MenuItem>
          </>
        )}
      </Menu>
    </>
  );
}

/* -------------------------------- user panel ------------------------------ */

const STATUS_OPTIONS: { value: UserStatus; label: string; status: EffectiveStatus }[] = [
  { value: 'online', label: 'Online', status: 'online' },
  { value: 'idle', label: 'Idle', status: 'idle' },
  { value: 'dnd', label: 'Do Not Disturb', status: 'dnd' },
  { value: 'invisible', label: 'Invisible', status: 'offline' },
];

function UserPanel() {
  const me = useStore((s) => s.me);
  const presence = useStore((s) => s.presence);
  const setStatus = useStore((s) => s.setStatus);
  const openModal = useStore((s) => s.openModal);
  const logout = useStore((s) => s.logout);

  const [menu, setMenu] = useState<{ x: number; bottom: number } | null>(null);
  if (!me) return null;

  const status: EffectiveStatus = presence[me.id] ?? me.status;

  return (
    <div className="user-panel">
      <button
        className="user-panel-main"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, bottom: window.innerHeight - rect.top + 8 });
        }}
      >
        <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={32} status={status} />
        <span className="user-panel-text">
          <span className="user-panel-name">{me.displayName}</span>
          <span className="user-panel-sub">{me.customStatus || (status === 'offline' ? 'Offline' : me.username)}</span>
        </span>
      </button>

      <div className="user-panel-actions">
        <IconButton label="Settings" onClick={() => openModal('settings', 'account')}>
          <Settings size={17} />
        </IconButton>
      </div>

      <Menu
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        x={menu?.x}
        bottom={menu?.bottom}
        width={252}
      >
        <div className="menu-header">
          <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={38} status={status} />
          <div>
            <div className="menu-header-name">{me.displayName}</div>
            <div className="menu-header-sub">@{me.username}</div>
          </div>
        </div>
        <MenuSeparator />
        {STATUS_OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            onClick={() => void setStatus(option.value)}
            icon={<StatusDot status={option.status} size={10} />}
            hint={option.value === me.status ? 'Current' : undefined}
          >
            {option.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Pencil size={16} />} onClick={() => openModal('settings', 'profile')}>
          Edit profile
        </MenuItem>
        <MenuItem icon={<CircleUser size={16} />} onClick={() => openModal('settings', 'account')}>
          My account
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger icon={<LogOut size={16} />} onClick={() => void logout()}>
          Sign out
        </MenuItem>
      </Menu>
    </div>
  );
}
