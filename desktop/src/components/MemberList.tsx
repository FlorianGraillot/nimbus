import { Crown, Shield } from 'lucide-react';
import type { EffectiveStatus, Member } from '../lib/types';
import { useStore } from '../store/store';
import { Avatar, StatusDot } from './ui';

const EMPTY: Member[] = [];

const GROUPS: { status: EffectiveStatus; label: string }[] = [
  { status: 'online', label: 'Online' },
  { status: 'idle', label: 'Idle' },
  { status: 'dnd', label: 'Do Not Disturb' },
  { status: 'offline', label: 'Offline' },
];

export function MemberList() {
  const guildId = useStore((s) => s.activeGuildId);
  const members = useStore((s) => (guildId ? s.members[guildId] : undefined) ?? EMPTY);
  const presence = useStore((s) => s.presence);
  const openProfile = useStore((s) => s.openProfile);

  const statusOf = (member: Member): EffectiveStatus => presence[member.id] ?? member.status;
  const onlineCount = members.filter((m) => statusOf(m) !== 'offline').length;

  return (
    <aside className="members" aria-label="Members">
      <div className="members-head">Members — {onlineCount}</div>
      <div className="members-scroll">
        {GROUPS.map((group) => {
          const list = members.filter((m) => statusOf(m) === group.status);
          if (list.length === 0) return null;
          return (
            <div key={group.status} className="member-group">
              <div className="member-group-head">
                {group.label} — {list.length}
              </div>
              {list.map((member) => (
                <button
                  key={member.id}
                  className={`member-row ${group.status === 'offline' ? 'is-offline' : ''}`}
                  onClick={() => openProfile(member.id)}
                >
                  <Avatar
                    name={member.nickname || member.displayName}
                    color={member.avatarColor}
                    src={member.avatarUrl}
                    size={32}
                    status={group.status}
                  />
                  <span className="member-text">
                    <span className="member-name">
                      {member.nickname || member.displayName}
                      {member.isOwner && <Crown size={13} className="member-crown" />}
                      {member.role === 'admin' && (
                        <Shield
                          size={13}
                          className="member-shield"
                          fill="currentColor"
                          strokeWidth={1.5}
                          aria-label="Admin"
                        />
                      )}
                    </span>
                    {member.customStatus && <span className="member-sub">{member.customStatus}</span>}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
        {members.length === 0 && <p className="sidebar-empty">No members yet.</p>}
      </div>
      <div className="members-footer">
        <StatusDot status="online" size={8} /> Live presence enabled
      </div>
    </aside>
  );
}
