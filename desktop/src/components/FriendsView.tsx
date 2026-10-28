import { useEffect, useState } from 'react';
import { Check, MessageCircle, Search, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { api } from '../lib/api';
import type { EffectiveStatus, PublicUser } from '../lib/types';
import { useStore } from '../store/store';
import { Avatar, Button, EmptyState, IconButton, Input } from './ui';

type Tab = 'online' | 'all' | 'pending' | 'add';

const TABS: { id: Tab; label: string }[] = [
  { id: 'online', label: 'Online' },
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'add', label: 'Add friend' },
];

const STATUS_TEXT: Record<EffectiveStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
};

export function FriendsView() {
  const friends = useStore((s) => s.friends);
  const presence = useStore((s) => s.presence);
  const openDm = useStore((s) => s.openDm);
  const openProfile = useStore((s) => s.openProfile);
  const acceptFriend = useStore((s) => s.acceptFriend);
  const cancelFriendRequest = useStore((s) => s.cancelFriendRequest);
  const removeFriend = useStore((s) => s.removeFriend);
  const sendFriendRequest = useStore((s) => s.sendFriendRequest);
  const openModal = useStore((s) => s.openModal);

  const [tab, setTab] = useState<Tab>('online');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PublicUser[]>([]);

  const pending = friends.filter((f) => f.state !== 'accepted');
  const accepted = friends.filter((f) => f.state === 'accepted');
  const statusOf = (id: string, fallback: EffectiveStatus): EffectiveStatus => presence[id] ?? fallback;

  useEffect(() => {
    if (tab !== 'add') return;
    const query = username.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.searchUsers(query);
        if (!cancelled) setResults(res.users);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [username, tab]);

  async function addFriend(value: string) {
    setBusy(true);
    try {
      await sendFriendRequest(value);
      setUsername('');
      setResults([]);
    } catch (error) {
      useStore.getState().pushToast(error instanceof Error ? error.message : 'Could not send request', 'error');
    } finally {
      setBusy(false);
    }
  }

  const visible = tab === 'online' ? accepted.filter((f) => statusOf(f.user.id, f.user.status) !== 'offline') : accepted;

  return (
    <div className="friends">
      <header className="friends-head">
        <div className="friends-title">
          <Users size={22} />
          <h1>Friends</h1>
          <span className="friends-tabs-sep" />
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`friends-tab ${tab === item.id ? 'is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.id === 'pending' && pending.length > 0 && <span className="tab-badge">{pending.length}</span>}
            </button>
          ))}
        </div>
        <IconButton label="New group DM" onClick={() => openModal('group-dm')}>
          <UserPlus size={19} />
        </IconButton>
      </header>

      <div className="friends-body">
        {tab === 'add' ? (
          <div className="add-friend">
            <h2>Add friend</h2>
            <p>You can add friends with their Nimbus username.</p>
            <div className="add-friend-row">
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Enter a username"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && username.trim()) void addFriend(username.trim());
                }}
                autoFocus
              />
              <Button onClick={() => void addFriend(username.trim())} disabled={!username.trim()} loading={busy}>
                Send friend request
              </Button>
            </div>

            {results.length > 0 && (
              <div className="search-results">
                <div className="search-results-head">Results</div>
                {results.map((user) => (
                  <div key={user.id} className="friend-row">
                    <Avatar
                      name={user.displayName}
                      color={user.avatarColor}
                      src={user.avatarUrl}
                      size={38}
                      status={statusOf(user.id, user.status)}
                    />
                    <div className="friend-row-text">
                      <span className="friend-row-name">{user.displayName}</span>
                      <span className="friend-row-sub">@{user.username}</span>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => void addFriend(user.username)}>
                      Add friend
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tab === 'pending' ? (
          <>
            {pending.length === 0 && (
              <EmptyState icon={<Check size={34} />} title="No pending requests">
                When someone adds you, their request will show up here.
              </EmptyState>
            )}
            {pending.filter((f) => f.state === 'incoming').length > 0 && (
              <>
                <div className="friends-section-label">Incoming — {pending.filter((f) => f.state === 'incoming').length}</div>
                {pending
                  .filter((f) => f.state === 'incoming')
                  .map((friend) => (
                    <div key={friend.user.id} className="friend-row">
                      <Avatar
                        name={friend.user.displayName}
                        color={friend.user.avatarColor}
                        src={friend.user.avatarUrl}
                        size={38}
                        status={statusOf(friend.user.id, friend.user.status)}
                      />
                      <div className="friend-row-text">
                        <span className="friend-row-name">{friend.user.displayName}</span>
                        <span className="friend-row-sub">Incoming friend request</span>
                      </div>
                      <div className="friend-row-actions">
                        <button
                          className="round-action is-accept"
                          title="Accept"
                          onClick={() => void acceptFriend(friend.user.id)}
                        >
                          <Check size={18} />
                        </button>
                        <button
                          className="round-action is-deny"
                          title="Ignore"
                          onClick={() => void cancelFriendRequest(friend.user.id)}
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
              </>
            )}
            {pending.filter((f) => f.state === 'outgoing').length > 0 && (
              <>
                <div className="friends-section-label">Outgoing — {pending.filter((f) => f.state === 'outgoing').length}</div>
                {pending
                  .filter((f) => f.state === 'outgoing')
                  .map((friend) => (
                    <div key={friend.user.id} className="friend-row">
                      <Avatar
                        name={friend.user.displayName}
                        color={friend.user.avatarColor}
                        src={friend.user.avatarUrl}
                        size={38}
                        status={statusOf(friend.user.id, friend.user.status)}
                      />
                      <div className="friend-row-text">
                        <span className="friend-row-name">{friend.user.displayName}</span>
                        <span className="friend-row-sub">Outgoing friend request</span>
                      </div>
                      <div className="friend-row-actions">
                        <button
                          className="round-action is-deny"
                          title="Cancel request"
                          onClick={() => void cancelFriendRequest(friend.user.id)}
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
              </>
            )}
          </>
        ) : (
          <>
            {visible.length === 0 && (
              <EmptyState
                icon={<Search size={34} />}
                title={tab === 'online' ? 'No one is around' : 'No friends yet'}
              >
                {tab === 'online'
                  ? 'Your friends are all offline right now. Try the All tab.'
                  : 'Add a friend by username to start a conversation.'}
              </EmptyState>
            )}
            {visible.map((friend) => {
              const status = statusOf(friend.user.id, friend.user.status);
              return (
                <div key={friend.user.id} className="friend-row">
                  <Avatar name={friend.user.displayName} color={friend.user.avatarColor} src={friend.user.avatarUrl} size={38} status={status} />
                  <div className="friend-row-text" onClick={() => openProfile(friend.user.id)}>
                    <span className="friend-row-name">{friend.user.displayName}</span>
                    <span className="friend-row-sub">{friend.user.customStatus || STATUS_TEXT[status]}</span>
                  </div>
                  <div className="friend-row-actions">
                    <button
                      className="round-action"
                      title="Message"
                      onClick={() => void openDm(friend.user.id)}
                    >
                      <MessageCircle size={18} />
                    </button>
                    <button
                      className="round-action is-deny"
                      title="Remove friend"
                      onClick={() => {
                        if (window.confirm(`Remove ${friend.user.displayName} from your friends?`)) {
                          void removeFriend(friend.user.id);
                        }
                      }}
                    >
                      <UserMinus size={18} />
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
