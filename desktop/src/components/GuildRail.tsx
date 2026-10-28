import { useState, type MouseEvent } from 'react';
import { Inbox as InboxIcon, LogIn, Plus, Settings2 } from 'lucide-react';
import { useStore } from '../store/store';
import { Logo } from './Logo';
import { Avatar, Menu, MenuItem } from './ui';

export function GuildRail() {
  const guilds = useStore((s) => s.guilds);
  const channels = useStore((s) => s.channels);
  const unread = useStore((s) => s.unread);
  const dms = useStore((s) => s.dms);
  const view = useStore((s) => s.view);
  const activeGuildId = useStore((s) => s.activeGuildId);
  const selectGuild = useStore((s) => s.selectGuild);
  const goHome = useStore((s) => s.goHome);
  const openInbox = useStore((s) => s.openInbox);
  const openModal = useStore((s) => s.openModal);

  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

  const openAddMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setAddMenu({ x: rect.right + 10, y: rect.top });
  };

  const guildUnread = (guildId: string) =>
    channels
      .filter((c) => c.guildId === guildId)
      .reduce((sum, c) => sum + (unread[c.id]?.count ?? 0), 0);

  const homeUnread = dms.reduce((sum, d) => sum + (unread[d.id]?.count ?? 0), 0);
  const mentionTotal = Object.values(unread).reduce((sum, info) => sum + info.mentions, 0);

  return (
    <nav className="rail" aria-label="Servers">
      <button
        className={`rail-home ${view === 'friends' ? 'is-active' : ''}`}
        onClick={goHome}
        aria-label="Home"
      >
        <Logo size={48} radius={16} />
        {homeUnread > 0 && <span className="rail-badge">{homeUnread > 99 ? '99+' : homeUnread}</span>}
        <span className="rail-tooltip">Home</span>
        <span className="rail-pill" />
      </button>

      <button
        className={`rail-inbox ${view === 'inbox' ? 'is-active' : ''}`}
        onClick={openInbox}
        aria-label="Inbox"
      >
        <InboxIcon size={22} />
        {mentionTotal > 0 && (
          <span className="rail-badge">{mentionTotal > 99 ? '99+' : mentionTotal}</span>
        )}
        <span className="rail-tooltip">Inbox</span>
        <span className="rail-pill" />
      </button>

      <div className="rail-sep" />

      <div className="rail-guilds">
        {guilds.map((guild) => {
          const active = view === 'guild' && activeGuildId === guild.id;
          const count = guildUnread(guild.id);
          return (
            <button
              key={guild.id}
              className={`rail-guild ${active ? 'is-active' : ''}`}
              onClick={() => selectGuild(guild.id)}
              aria-label={guild.name}
            >
              <Avatar name={guild.name} color={guild.iconColor} size={48} square />
              {count > 0 && !active && <span className="rail-dot" />}
              <span className="rail-tooltip">{guild.name}</span>
              <span className="rail-pill" />
            </button>
          );
        })}

        <button
          className="rail-guild rail-add"
          onClick={openAddMenu}
          aria-label="Add a server"
          aria-haspopup="menu"
        >
          <Plus size={22} />
          <span className="rail-tooltip">Add a server</span>
        </button>
      </div>

      <Menu open={Boolean(addMenu)} onClose={() => setAddMenu(null)} x={addMenu?.x} y={addMenu?.y} width={214}>
        <MenuItem icon={<Plus size={16} />} onClick={() => openModal('create-server')}>
          Create a server
        </MenuItem>
        <MenuItem icon={<LogIn size={16} />} onClick={() => openModal('join-server')}>
          Join a server
        </MenuItem>
      </Menu>

      <div className="rail-spacer" />

      <button
        className="rail-action"
        onClick={() => openModal('settings', 'appearance')}
        aria-label="Settings"
        title="Settings"
      >
        <Settings2 size={19} />
      </button>
    </nav>
  );
}
