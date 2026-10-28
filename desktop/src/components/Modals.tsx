import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Check,
  Copy,
  Crown,
  Hash,
  MessageCircle,
  Pin,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Channel, Invite, PublicUser } from '../lib/types';
import { useStore, channelLabel, selectChannelById, selectMembers } from '../store/store';
import { formatMemberSince, formatRelative } from '../lib/format';
import { Avatar, Button, EmptyState, Field, Input, Modal, Spinner, Switch, useCopy } from './ui';
import { SettingsModal } from './SettingsModal';

export function Modals() {
  const modal = useStore((s) => s.modal);
  const payload = useStore((s) => s.modalPayload);
  const profileUserId = useStore((s) => s.profileUserId);

  return (
    <>
      {modal === 'create-server' && <CreateServerModal />}
      {modal === 'join-server' && <JoinServerModal initialCode={payload} />}
      {modal === 'create-channel' && payload && <CreateChannelModal guildId={payload} />}
      {modal === 'invite' && payload && <InviteModal guildId={payload} />}
      {modal === 'channel-settings' && payload && <ChannelSettingsModal channelId={payload} />}
      {modal === 'guild-settings' && payload && <GuildSettingsModal guildId={payload} />}
      {modal === 'group-dm' && <GroupDmModal />}
      {modal === 'pins' && payload && <PinnedModal channelId={payload} />}
      {modal === 'search' && <SearchModal initialChannelId={payload} />}
      {modal === 'settings' && <SettingsModal initialTab={payload} />}
      {profileUserId && <ProfileModal userId={profileUserId} />}
    </>
  );
}

/* ----------------------------- create server ------------------------------ */

function CreateServerModal() {
  const closeModal = useStore((s) => s.closeModal);
  const createGuild = useStore((s) => s.createGuild);
  const pushToast = useStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createGuild(name.trim());
      closeModal();
      pushToast('Server created', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not create server', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create a server"
      subtitle="Your server is where you and your friends hang out. Make yours and start talking."
      onClose={closeModal}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim()} loading={busy}>
            Create server
          </Button>
        </>
      }
    >
      <div className="create-server-preview">
        <Avatar name={name || 'New server'} color="#6d5efc" size={64} square />
        <div>
          <div className="create-server-name">{name || 'Your new server'}</div>
          <div className="create-server-sub">Give it a name you will recognise.</div>
        </div>
      </div>
      <Field label="Server name">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nimbus HQ"
          autoFocus
          maxLength={64}
          onKeyDown={(event) => event.key === 'Enter' && void submit()}
        />
      </Field>
    </Modal>
  );
}

/* ----------------------------- create channel ----------------------------- */

function CreateChannelModal({ guildId }: { guildId: string }) {
  const closeModal = useStore((s) => s.closeModal);
  const createChannel = useStore((s) => s.createChannel);
  const pushToast = useStore((s) => s.pushToast);
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [busy, setBusy] = useState(false);

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  async function submit() {
    if (!slug) return;
    setBusy(true);
    try {
      await createChannel(guildId, slug, type);
      closeModal();
      pushToast(type === 'voice' ? `Voice channel “${slug}” created` : `#${slug} created`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not create channel', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create a channel"
      subtitle="Text channels are for messages. Voice channels are rooms you drop into to talk."
      onClose={closeModal}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!slug} loading={busy}>
            Create channel
          </Button>
        </>
      }
    >
      <div className="channel-type-picker">
        <button
          type="button"
          className={`channel-type-option ${type === 'text' ? 'is-active' : ''}`}
          onClick={() => setType('text')}
        >
          <Hash size={18} />
          <span>
            <strong>Text</strong>
            <small>Send messages, pictures and threads</small>
          </span>
        </button>
        <button
          type="button"
          className={`channel-type-option ${type === 'voice' ? 'is-active' : ''}`}
          onClick={() => setType('voice')}
        >
          <Volume2 size={18} />
          <span>
            <strong>Voice</strong>
            <small>Hop in and talk, up to five people</small>
          </span>
        </button>
      </div>

      <div className="create-server-preview">
        <span className="create-channel-hash">{type === 'voice' ? <Volume2 size={18} /> : '#'}</span>
        <div>
          <div className="create-server-name">{slug || (type === 'voice' ? 'new-voice-room' : 'new-channel')}</div>
          <div className="create-server-sub">
            {type === 'voice'
              ? 'People see who is inside before they join.'
              : 'Lowercase letters, numbers and dashes work best.'}
          </div>
        </div>
      </div>
      <Field label="Channel name">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={type === 'voice' ? 'lounge' : 'project-updates'}
          autoFocus
          maxLength={64}
          onKeyDown={(event) => event.key === 'Enter' && void submit()}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------ join server ------------------------------- */

function parseInviteCode(input: string): string {
  const value = input.trim();
  const match = value.match(/invite\/([A-Za-z0-9_-]+)/) ?? value.match(/^([A-Za-z0-9_-]{4,32})$/);
  return match ? match[1] : value;
}

function JoinServerModal({ initialCode }: { initialCode?: string | null }) {
  const closeModal = useStore((s) => s.closeModal);
  const joinInvite = useStore((s) => s.joinInvite);
  const pushToast = useStore((s) => s.pushToast);
  const [value, setValue] = useState(initialCode ?? '');
  const [preview, setPreview] = useState<{ name: string; iconColor: string; memberCount: number; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup(input = value) {
    const code = parseInviteCode(input);
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.previewInvite(code);
      setPreview({ ...res.guild, code: res.code });
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : 'That invite is not valid');
    } finally {
      setBusy(false);
    }
  }

  /* Deep links and message invite cards arrive with the code already in hand. */
  useEffect(() => {
    if (initialCode) void lookup(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function join() {
    if (!preview) return;
    setBusy(true);
    try {
      await joinInvite(preview.code);
      closeModal();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not join server', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Join a server"
      subtitle="Paste an invite link or code below."
      onClose={closeModal}
      width={460}
      footer={
        preview ? (
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Back
            </Button>
            <Button onClick={() => void join()} loading={busy}>
              Join server
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={closeModal}>
              Cancel
            </Button>
            <Button onClick={() => void lookup()} disabled={!value.trim()} loading={busy}>
              Look up invite
            </Button>
          </>
        )
      }
    >
      {preview ? (
        <div className="invite-preview">
          <Avatar name={preview.name} color={preview.iconColor} size={64} square />
          <div>
            <div className="invite-preview-name">{preview.name}</div>
            <div className="invite-preview-sub">{preview.memberCount} members</div>
          </div>
        </div>
      ) : (
        <>
          <Field label="Invite link or code" hint="Try NIMBUS01">
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="nimbus://invite/NIMBUS01"
              autoFocus
              onKeyDown={(event) => event.key === 'Enter' && void lookup()}
            />
          </Field>
          {error && <div className="form-error">{error}</div>}
        </>
      )}
    </Modal>
  );
}

/* -------------------------------- invite ---------------------------------- */

function InviteModal({ guildId }: { guildId: string }) {
  const closeModal = useStore((s) => s.closeModal);
  const createInvite = useStore((s) => s.createInvite);
  const listInvites = useStore((s) => s.listInvites);
  const revokeInvite = useStore((s) => s.revokeInvite);
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const me = useStore((s) => s.me);
  const members = useStore((s) => s.members[guildId]);
  const pushToast = useStore((s) => s.pushToast);

  const [invite, setInvite] = useState<Invite | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [expiry, setExpiry] = useState('never');
  const [maxUses, setMaxUses] = useState('unlimited');
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  const [copiedCode, copyCode] = useCopy();

  const canManage = guild?.ownerId === me?.id || members?.some((m) => m.id === me?.id && m.role === 'admin');

  async function refresh() {
    if (!canManage) return;
    try {
      setInvites(await listInvites(guildId));
    } catch {
      /* list is a convenience — creation still works */
    }
  }

  async function generate() {
    setBusy(true);
    try {
      const value = await createInvite(guildId, {
        maxUses: maxUses === 'unlimited' ? null : Number(maxUses),
        expiresInMinutes: expiry === 'never' ? null : Number(expiry),
      });
      setInvite(value);
      await refresh();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not create an invite', 'error');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void createInvite(guildId)
      .then((value) => {
        if (!cancelled) setInvite(value);
      })
      .catch(() => {});
    void refresh();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  const link = invite?.url ?? (invite ? `nimbus://invite/${invite.code}` : '');

  return (
    <Modal
      title={`Invite people to ${guild?.name ?? 'your server'}`}
      subtitle="Share this link or code — your friend can paste it under Join a server."
      onClose={closeModal}
      width={500}
      footer={
        <Button onClick={closeModal} variant="secondary">
          Done
        </Button>
      }
    >
      {invite ? (
        <>
          <div className="invite-link-box">
            <code>{link}</code>
            <button className="invite-copy" onClick={() => copy(link)} aria-label="Copy invite link">
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <div className="invite-code-hint">
            <span>
              Invite code: <strong>{invite.code}</strong>
            </span>
            <button
              className="invite-code-copy"
              onClick={() => copyCode(invite.code)}
              aria-label="Copy invite code"
              title="Copy invite code"
            >
              {copiedCode ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </>
      ) : (
        <div className="invite-loading">
          <Spinner /> Generating an invite…
        </div>
      )}

      <div className="invite-options">
        <label>
          <span>Expire after</span>
          <select className="input" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
            <option value="never">Never</option>
            <option value="60">1 hour</option>
            <option value="1440">1 day</option>
            <option value="10080">7 days</option>
            <option value="43200">30 days</option>
          </select>
        </label>
        <label>
          <span>Max uses</span>
          <select className="input" value={maxUses} onChange={(event) => setMaxUses(event.target.value)}>
            <option value="unlimited">Unlimited</option>
            <option value="1">1 use</option>
            <option value="5">5 uses</option>
            <option value="10">10 uses</option>
            <option value="25">25 uses</option>
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={() => void generate()} loading={busy}>
          New invite
        </Button>
      </div>

      <p className="invite-help">
        Send the link or the code — your friend opens <strong>Join a server</strong> and pastes either one.
      </p>

      {canManage && (
        <>
          <div className="settings-section-label">Existing invites</div>
          <div className="invite-list">
            {invites.length === 0 && <p className="sidebar-empty">No invites yet.</p>}
            {invites.map((row) => (
              <div key={row.code} className={`invite-row ${row.active ? '' : 'is-inactive'}`}>
                <code>{row.code}</code>
                <span className="invite-row-uses">
                  {row.uses}
                  {row.maxUses ? `/${row.maxUses}` : ''} uses
                </span>
                <span className="invite-row-expiry">
                  {row.revokedAt
                    ? 'Revoked'
                    : row.expiresAt
                      ? `Expires ${new Date(row.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                      : 'Never expires'}
                </span>
                {row.active ? (
                  <button
                    className="invite-revoke"
                    onClick={() => {
                      if (window.confirm(`Revoke invite ${row.code}?`)) {
                        void revokeInvite(guildId, row.code).then(refresh).catch(() => {});
                      }
                    }}
                  >
                    Revoke
                  </button>
                ) : (
                  <span className="invite-dead">Inactive</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ----------------------------- pinned messages ---------------------------- */

function PinnedModal({ channelId }: { channelId: string }) {
  const closeModal = useStore((s) => s.closeModal);
  const channel = useStore((s) => selectChannelById(s, channelId));
  const me = useStore((s) => s.me);
  const members = useStore((s) => selectMembers(s, channel?.guildId));
  const pins = useStore((s) => s.pins[channelId]);
  const loading = useStore((s) => s.pinsLoading[channelId]);
  const loadPins = useStore((s) => s.loadPins);
  const jumpToMessage = useStore((s) => s.jumpToMessage);

  useEffect(() => {
    void loadPins(channelId);
  }, [channelId, loadPins]);

  // Same rule as the message menu: server owners/admins curate pins.
  const canPin = !channel?.guildId || members.some((m) => m.id === me?.id && m.role !== 'member');

  return (
    <Modal
      title="Pinned messages"
      subtitle={channel ? channelLabel(channel, useStore.getState().me) : 'This channel'}
      onClose={closeModal}
      width={560}
    >
      {!pins && loading && (
        <div className="invite-loading">
          <Spinner /> Loading pins…
        </div>
      )}
      {pins && pins.length === 0 && (
        <EmptyState icon={<Pin size={30} />} title="Nothing pinned yet">
          {canPin ? (
            <>
              Open a message’s menu and choose <strong>Pin message</strong> to keep it here.
            </>
          ) : (
            <>
              Only the server owner and admins can pin messages, so nothing has been pinned here yet.
            </>
          )}
        </EmptyState>
      )}
      <div className="pin-list">
        {(pins ?? []).map((pin) => (
          <button
            key={pin.id}
            className="pin-row"
            onClick={() => {
              void jumpToMessage(pin.channelId, pin.id, pin.seq);
              closeModal();
            }}
          >
            <Avatar name={pin.author.displayName} color={pin.author.avatarColor} src={pin.author.avatarUrl} size={32} />
            <span className="pin-main">
              <span className="pin-head">
                <strong>{pin.author.displayName}</strong>
                <span className="pin-time">{formatRelative(pin.createdAt)}</span>
              </span>
              <span className="pin-text">
                {pin.content || (pin.attachments?.length ? 'Photo' : 'Message unavailable')}
              </span>
              <span className="pin-meta">
                <Pin size={11} />
                {pin.pinnedBy ? `Pinned by ${pin.pinnedBy.displayName}` : 'Pinned'}
                {pin.pinnedAt ? ` · ${formatRelative(pin.pinnedAt)}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------------------- channel settings ---------------------------- */

function ChannelSettingsModal({ channelId }: { channelId: string }) {
  const closeModal = useStore((s) => s.closeModal);
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId));
  const updateChannel = useStore((s) => s.updateChannel);
  const deleteChannel = useStore((s) => s.deleteChannel);
  const pushToast = useStore((s) => s.pushToast);

  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [allowAttachments, setAllowAttachments] = useState(channel?.allowAttachments ?? true);
  const [busy, setBusy] = useState(false);

  if (!channel) return null;
  const isVoice = channel.type === 'voice';

  async function save() {
    setBusy(true);
    try {
      await updateChannel(channel!.id, {
        name: name.trim() || channel!.name,
        topic,
        ...(isVoice ? {} : { allowAttachments }),
      });
      closeModal();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not update channel', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`${isVoice ? '' : '#'}${channel.name}`}
      subtitle={isVoice ? 'Voice channel settings' : 'Channel settings'}
      onClose={closeModal}
      width={480}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              if (window.confirm(`Delete ${isVoice ? '' : '#'}${channel.name}?`)) {
                void deleteChannel(channel.id).then(closeModal).catch(() => {});
              }
            }}
          >
            Delete channel
          </Button>
          <div className="spacer" />
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save changes
          </Button>
        </>
      }
    >
      <Field label="Channel name">
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
      </Field>
      <Field label="Topic" hint="Shown in the channel header">
        <textarea
          className="input textarea"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          rows={3}
          maxLength={1024}
          placeholder={isVoice ? 'Who is this room for?' : 'What is this channel about?'}
        />
      </Field>

      {isVoice ? (
        <div className="toggle-row">
          <div>
            <div className="toggle-title">Voice room</div>
            <div className="toggle-sub">
              Members join straight from the sidebar. Up to five people can talk at once, and nobody needs
              a microphone to listen in.
            </div>
          </div>
          <Volume2 size={20} className="toggle-icon" />
        </div>
      ) : (
        <div className="toggle-row">
          <div>
            <div className="toggle-title">Let members send pictures</div>
            <div className="toggle-sub">
              When off, members can only send text. Owners and admins can still post pictures.
            </div>
          </div>
          <Switch
            checked={allowAttachments}
            onChange={setAllowAttachments}
            label="Let members send pictures"
          />
        </div>
      )}
    </Modal>
  );
}

/* ----------------------------- guild settings ----------------------------- */

const COLORS = ['#6d5efc', '#3fa9ff', '#23a55a', '#f0b232', '#f23f43', '#eb459e', '#9b59b6', '#f47fff'];

function GuildSettingsModal({ guildId }: { guildId: string }) {
  const closeModal = useStore((s) => s.closeModal);
  const guild = useStore((s) => s.guilds.find((g) => g.id === guildId));
  const updateGuild = useStore((s) => s.updateGuild);
  const deleteGuild = useStore((s) => s.deleteGuild);
  const leaveGuild = useStore((s) => s.leaveGuild);
  const members = useStore((s) => selectMembers(s, guildId));
  const me = useStore((s) => s.me);
  const kickMember = useStore((s) => s.kickMember);
  const setMemberRole = useStore((s) => s.setMemberRole);
  const pushToast = useStore((s) => s.pushToast);

  const [name, setName] = useState(guild?.name ?? '');
  const [color, setColor] = useState(guild?.iconColor ?? '#6d5efc');
  const [busy, setBusy] = useState(false);

  if (!guild) return null;
  const isOwner = guild.ownerId === me?.id;
  const myRole = members.find((member) => member.id === me?.id)?.role;
  const canManage = isOwner || myRole === 'admin';

  async function save() {
    setBusy(true);
    try {
      await updateGuild(guild!.id, { name: name.trim() || guild!.name, iconColor: color });
      closeModal();
      pushToast('Server updated', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not update server', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={guild.name}
      subtitle="Server settings"
      onClose={closeModal}
      width={560}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              if (isOwner) {
                if (window.confirm(`Delete “${guild.name}”? This cannot be undone.`)) {
                  void deleteGuild(guild.id).then(closeModal).catch(() => {});
                }
              } else if (window.confirm(`Leave “${guild.name}”?`)) {
                void leaveGuild(guild.id).then(closeModal).catch(() => {});
              }
            }}
          >
            {isOwner ? 'Delete server' : 'Leave server'}
          </Button>
          <div className="spacer" />
          <Button variant="ghost" onClick={closeModal}>
            {isOwner ? 'Cancel' : 'Close'}
          </Button>
          {isOwner && (
            <Button onClick={() => void save()} loading={busy}>
              Save changes
            </Button>
          )}
        </>
      }
    >
      <div className="guild-settings-top">
        <Avatar name={name || guild.name} color={color} size={64} square />
        <Field label="Server name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={64}
            disabled={!isOwner}
          />
        </Field>
      </div>

      <Field label="Server color">
        <div className="color-row">
          {COLORS.map((option) => (
            <button
              key={option}
              className={`color-swatch ${color === option ? 'is-active' : ''}`}
              style={{ background: option }}
              onClick={() => setColor(option)}
              disabled={!isOwner}
              aria-label={option}
            />
          ))}
        </div>
      </Field>
      {!isOwner && (
        <p className="settings-hint">
          {canManage
            ? 'You are an admin here — you can manage channels, but only the owner can change server settings.'
            : 'Only the server owner can change these settings.'}
        </p>
      )}

      <div className="settings-section-label">Members — {members.length}</div>
      <div className="member-manage-list">
        {members.map((member) => (
          <div key={member.id} className="member-manage-row">
            <Avatar
              name={member.displayName}
              color={member.avatarColor}
              src={member.avatarUrl}
              size={30}
              status={member.status}
            />
            <span className="member-manage-name">
              {member.displayName}
              {member.isOwner && <Crown size={13} />}
            </span>
            <span className="member-manage-sub">@{member.username}</span>
            <span className={`role-tag role-${member.role}`}>
              {member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member'}
            </span>
            {isOwner && !member.isOwner && (
              <>
                <button
                  className="member-role-btn"
                  onClick={() =>
                    void setMemberRole(guild.id, member.id, member.role === 'admin' ? 'member' : 'admin').catch(
                      (error) =>
                        pushToast(error instanceof Error ? error.message : 'Could not change role', 'error'),
                    )
                  }
                  aria-label={
                    member.role === 'admin'
                      ? `Remove admin from ${member.displayName}`
                      : `Make ${member.displayName} an admin`
                  }
                  title={member.role === 'admin' ? 'Remove admin' : 'Make admin'}
                >
                  {member.role === 'admin' ? <ShieldOff size={15} /> : <Shield size={15} />}
                </button>
                <button
                  className="member-kick"
                  onClick={() => {
                    if (window.confirm(`Remove ${member.displayName} from the server?`)) {
                      void kickMember(guild.id, member.id);
                    }
                  }}
                  aria-label={`Kick ${member.displayName}`}
                >
                  <UserMinus size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* -------------------------------- group DM -------------------------------- */

function GroupDmModal() {
  const closeModal = useStore((s) => s.closeModal);
  const allFriends = useStore((s) => s.friends);
  const friends = useMemo(() => allFriends.filter((f) => f.state === 'accepted'), [allFriends]);
  const createGroupDm = useStore((s) => s.createGroupDm);
  const pushToast = useStore((s) => s.pushToast);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await createGroupDm(selected);
      closeModal();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not create group', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create a group DM"
      subtitle="Pick the people you want in the conversation."
      onClose={closeModal}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={selected.length < 1} loading={busy}>
            Create group
          </Button>
        </>
      }
    >
      {friends.length === 0 && (
        <EmptyState icon={<Users size={30} />} title="No friends yet">
          Add a friend first, then start a group.
        </EmptyState>
      )}
      <div className="picker-list">
        {friends.map((friend) => {
          const checked = selected.includes(friend.user.id);
          return (
            <button
              key={friend.user.id}
              className={`picker-row ${checked ? 'is-checked' : ''}`}
              onClick={() =>
                setSelected((current) =>
                  checked ? current.filter((id) => id !== friend.user.id) : [...current, friend.user.id],
                )
              }
            >
              <Avatar name={friend.user.displayName} color={friend.user.avatarColor} src={friend.user.avatarUrl} size={32} />
              <span className="picker-name">{friend.user.displayName}</span>
              <span className="picker-sub">@{friend.user.username}</span>
              <span className="picker-check">{checked && <Check size={15} />}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/* --------------------------------- search --------------------------------- */

function SearchModal({ initialChannelId }: { initialChannelId: string | null }) {
  const closeModal = useStore((s) => s.closeModal);
  const jumpToMessage = useStore((s) => s.jumpToMessage);
  const channels = useStore((s) => s.channels);
  const dms = useStore((s) => s.dms);
  const activeGuildId = useStore((s) => s.activeGuildId);
  const me = useStore((s) => s.me);

  const initialChannel = channels.find((c) => c.id === initialChannelId) ?? dms.find((c) => c.id === initialChannelId);
  const [scope, setScope] = useState<'channel' | 'server' | 'all'>(
    initialChannel?.guildId ? 'channel' : 'all',
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.search>>['messages']>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  const channelById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of [...channels, ...dms]) map.set(channel.id, channel);
    return map;
  }, [channels, dms]);

  async function run() {
    const q = query.trim();
    if (q.length < 2 && !/\b(from|in|before|after):/i.test(q)) return;
    setBusy(true);
    setSearched(true);
    try {
      const res = await api.search(q, {
        channelId: scope === 'channel' ? initialChannelId ?? undefined : undefined,
        guildId: scope === 'server' ? activeGuildId ?? undefined : undefined,
      });
      setResults(res.messages);
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Search" onClose={closeModal} width={620}>
      <div className="search-bar">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void run()}
          placeholder="Search messages…  try from:aria in:design before:2026-01-01"
        />
        <Button
          size="sm"
          onClick={() => void run()}
          disabled={query.trim().length < 2 && !/\b(from|in|before|after):/i.test(query)}
          loading={busy}
        >
          Search
        </Button>
      </div>

      <div className="search-operator-hint">
        Operators: <code>from:username</code> <code>in:channel</code> <code>before:YYYY-MM-DD</code>{' '}
        <code>after:YYYY-MM-DD</code>
      </div>

      <div className="search-scopes">
        {initialChannelId && (
          <button className={scope === 'channel' ? 'is-active' : ''} onClick={() => setScope('channel')}>
            <Hash size={13} /> This channel
          </button>
        )}
        <button className={scope === 'server' ? 'is-active' : ''} onClick={() => setScope('server')}>
          This server
        </button>
        <button className={scope === 'all' ? 'is-active' : ''} onClick={() => setScope('all')}>
          Everywhere
        </button>
      </div>

      <div className="search-results-list">
        {!searched && <div className="search-hint">Search across every message you can see.</div>}
        {searched && !busy && results.length === 0 && (
          <div className="search-hint">No messages matched “{query.trim()}”.</div>
        )}
        {results.map((message) => {
          const channel = channelById.get(message.channelId);
          return (
            <button
              key={message.id}
              className="search-result"
              onClick={() => {
                void jumpToMessage(message.channelId, message.id, message.seq);
                closeModal();
              }}
            >
              <Avatar
                name={message.author.displayName}
                color={message.author.avatarColor}
                src={message.author.avatarUrl}
                size={30}
              />
              <span className="search-result-main">
                <span className="search-result-head">
                  <strong>{message.author.displayName}</strong>
                  <span className="search-result-channel">
                    {channel && (channel.type === 'dm' || channel.type === 'group')
                      ? 'Direct message'
                      : channelLabel(channel, me)}
                  </span>
                  <span className="search-result-time">{formatRelative(message.createdAt)}</span>
                </span>
                <span className="search-result-text">
                  {message.content || (message.attachments?.length ? 'Photo' : '')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/* -------------------------------- profile --------------------------------- */

function ProfileModal({ userId }: { userId: string }) {
  const closeProfile = useStore((s) => s.closeProfile);
  const me = useStore((s) => s.me);
  const friends = useStore((s) => s.friends);
  const members = useStore((s) => s.members);
  const dms = useStore((s) => s.dms);
  const presence = useStore((s) => s.presence);
  const openDm = useStore((s) => s.openDm);
  const sendFriendRequest = useStore((s) => s.sendFriendRequest);
  const removeFriend = useStore((s) => s.removeFriend);
  const blocked = useStore((s) => s.blocked);
  const blockUser = useStore((s) => s.blockUser);
  const unblockUser = useStore((s) => s.unblockUser);
  const pushToast = useStore((s) => s.pushToast);

  const [fetched, setFetched] = useState<PublicUser | null>(null);
  const [busy, setBusy] = useState(false);

  const known: PublicUser | undefined = useMemo(() => {
    if (me?.id === userId) return me;
    for (const list of Object.values(members)) {
      const found = list.find((m) => m.id === userId);
      if (found) return found;
    }
    const friend = friends.find((f) => f.user.id === userId);
    if (friend) return friend.user;
    for (const dm of dms) {
      const recipient = dm.recipients?.find((r) => r.id === userId);
      if (recipient) {
        return {
          ...recipient,
          bio: '',
          customStatus: '',
          status: presence[recipient.id] ?? 'offline',
          createdAt: 0,
        };
      }
    }
    return undefined;
  }, [userId, me, members, friends, dms, presence]);

  useEffect(() => {
    if (known) return;
    let cancelled = false;
    void api
      .getUser(userId)
      .then((res) => {
        if (!cancelled) setFetched(res.user);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, known]);

  const user = known ?? fetched;
  if (!user) {
    return (
      <Modal title="Profile" onClose={closeProfile} width={420}>
        <div className="invite-loading">
          <Spinner /> Loading profile…
        </div>
      </Modal>
    );
  }

  const friend = friends.find((f) => f.user.id === userId);
  const sharedServers = Object.entries(members).filter(([, list]) => list.some((m) => m.id === userId)).length;
  const isBlocked = blocked.includes(userId);

  return (
    <Modal onClose={closeProfile} width={420} className="profile-modal">
      <div className="profile-banner" style={{ background: `linear-gradient(120deg, ${user.avatarColor}, #1e1f22)` }} />
      <div className="profile-body">
        <div className="profile-avatar-wrap">
          <Avatar
            name={user.displayName}
            color={user.avatarColor}
            src={user.avatarUrl}
            size={80}
            status={presence[user.id] ?? user.status}
          />
        </div>
        <div className="profile-card">
          <h2>{user.displayName}</h2>
          <div className="profile-username">@{user.username}</div>
          {user.customStatus && <div className="profile-custom">{user.customStatus}</div>}

          <div className="profile-divider" />

          {user.bio && (
            <>
              <div className="profile-label">About me</div>
              <p className="profile-bio">{user.bio}</p>
            </>
          )}

          <div className="profile-label">Member since</div>
          <p className="profile-meta">{user.createdAt ? formatMemberSince(user.createdAt) : 'Recently'}</p>

          {sharedServers > 0 && (
            <>
              <div className="profile-label">Servers in common</div>
              <p className="profile-meta">{sharedServers}</p>
            </>
          )}

          <div className="profile-actions">
            {user.id !== me?.id && !isBlocked && (
              <Button
                onClick={() => {
                  void openDm(user.id);
                  closeProfile();
                }}
                full
              >
                <MessageCircle size={16} /> Message
              </Button>
            )}
            {user.id !== me?.id && !friend && !isBlocked && (
              <Button
                variant="secondary"
                full
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await sendFriendRequest(user.username);
                  } catch (error) {
                    pushToast(error instanceof Error ? error.message : 'Could not add friend', 'error');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <UserPlus size={16} /> Add friend
              </Button>
            )}
            {friend?.state === 'accepted' && (
              <Button
                variant="danger"
                full
                onClick={() => {
                  void removeFriend(user.id);
                  closeProfile();
                }}
              >
                <Trash2 size={16} /> Remove friend
              </Button>
            )}
            {user.id !== me?.id && (
              <Button
                variant={isBlocked ? 'secondary' : 'danger'}
                full
                onClick={() => {
                  if (isBlocked) void unblockUser(user.id);
                  else void blockUser(user.id);
                }}
              >
                <Ban size={16} /> {isBlocked ? 'Unblock user' : 'Block user'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
