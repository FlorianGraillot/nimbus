import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Hash,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Trash2,
  X,
} from 'lucide-react';
import type { Attachment, Channel, Message } from '../lib/types';
import { assetUrl } from '../lib/api';
import { MessageContent } from '../lib/markdown';
import { formatClock, formatTimestamp, sameDay, truncate } from '../lib/format';
import { channelLabel, selectChannelById, selectMembers, useStore } from '../store/store';
import { QUICK_REACTIONS } from '../lib/emoji';
import { Avatar, Menu, MenuItem, MenuSeparator } from './ui';

const NO_MESSAGES: Message[] = [];

/* ------------------------------- message list ----------------------------- */

export function MessageList({ channelId, onReply }: { channelId: string; onReply: (message: Message) => void }) {
  const messages = useStore((s) => s.messages[channelId] ?? NO_MESSAGES);
  const hasMore = useStore((s) => s.hasMore[channelId]);
  const loading = useStore((s) => s.loadingChannels[channelId]);
  const loadOlder = useStore((s) => s.loadOlder);
  const channel = useStore((s) => selectChannelById(s, channelId));
  const highlightId = useStore((s) => s.highlightMessageId);
  const setHighlight = useStore((s) => s.setHighlight);
  const newMarker = useStore((s) => s.unreadMarkers[channelId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const highlightPending = useRef(Boolean(highlightId));
  const [showJump, setShowJump] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);

  const lastId = messages[messages.length - 1]?.id;

  useEffect(() => {
    highlightPending.current = Boolean(highlightId);
  }, [highlightId]);

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    atBottom.current = true;
    setShowJump(false);
    // An inbox jump owns the scroll position; don't yank it to the bottom.
    if (highlightPending.current) return;
    requestAnimationFrame(() => scrollToBottom());
  }, [channelId]);

  useEffect(() => {
    if (atBottom.current && !highlightPending.current) requestAnimationFrame(() => scrollToBottom());
  }, [lastId]);

  useEffect(() => {
    if (!highlightId) return;
    const node = document.getElementById(`msg-${highlightId}`);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(highlightId);
    const timer = window.setTimeout(() => setFlashId(null), 2600);
    setHighlight(null);
    return () => window.clearTimeout(timer);
  }, [highlightId, messages, setHighlight]);

  async function handleLoadOlder() {
    const el = scrollRef.current;
    if (!el) return;
    const previousHeight = el.scrollHeight;
    const previousTop = el.scrollTop;
    await loadOlder(channelId);
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight - previousHeight + previousTop;
    });
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = near;
    setShowJump(!near);
    if (el.scrollTop < 140 && hasMore !== false && !loading) void handleLoadOlder();
  }

  if (!channel) return null;

  return (
    <div className="chat-scroll-wrap">
      <div className="chat-body" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-fill">
          {hasMore && (
            <div className="load-more">
              <button onClick={() => void handleLoadOlder()} disabled={loading}>
                {loading ? 'Loading…' : 'Load older messages'}
              </button>
            </div>
          )}

          <ChannelIntro channel={channel} />

          {messages.length === 0 && (
            <div className="chat-empty">
              <MessagesSquare size={26} />
              <p>
                {channel.type === 'thread'
                  ? 'No replies yet — start the thread.'
                  : channel.type === 'dm' || channel.type === 'group'
                    ? 'No messages yet — say hello.'
                    : `No messages in #${channel.name} yet.`}
              </p>
            </div>
          )}

          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
            const grouped =
              !newDay &&
              Boolean(previous) &&
              previous.author.id === message.author.id &&
              message.createdAt - previous.createdAt < 5 * 60 * 1000 &&
              !message.replyTo &&
              !message.system;
            const newDivider =
              newMarker !== undefined && message.seq > newMarker && (!previous || previous.seq <= newMarker);

            return (
              <div key={message.id}>
                {newDivider && <NewMessagesDivider />}
                {newDay && <DateDivider ts={message.createdAt} />}
                <MessageRow
                  message={message}
                  grouped={grouped}
                  channel={channel}
                  flash={flashId === message.id}
                  onReply={onReply}
                />
              </div>
            );
          })}

          <div ref={bottomRef} className="chat-bottom-spacer" />
        </div>
      </div>

      {showJump && (
        <button
          className="jump-bottom"
          onClick={() => {
            scrollToBottom(true);
            atBottom.current = true;
            setShowJump(false);
          }}
        >
          <ArrowDown size={16} /> Jump to present
        </button>
      )}
    </div>
  );
}

/* --------------------------------- pieces --------------------------------- */

function ChannelIntro({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me);
  const label = channelLabel(channel, me);
  const isDm = channel.type === 'dm' || channel.type === 'group';
  return (
    <div className="channel-intro">
      <div className="channel-intro-icon">
        {isDm ? <Avatar name={label} color={channel.recipients?.[0]?.avatarColor ?? '#6d5efc'} src={channel.recipients?.[0]?.avatarUrl} size={64} /> : <Hash size={40} />}
      </div>
      <h2>{isDm ? label : `Welcome to #${channel.name}`}</h2>
      <p>
        {channel.topic ||
          (isDm
            ? `This is the beginning of your conversation with ${label}.`
            : `This is the start of the #${channel.name} channel.`)}
      </p>
    </div>
  );
}

function DateDivider({ ts }: { ts: number }) {
  return (
    <div className="date-divider">
      <span>{formatTimestamp(ts).replace(' at ', ' · ')}</span>
    </div>
  );
}

function NewMessagesDivider() {
  return (
    <div className="new-messages-divider">
      <span>New messages</span>
    </div>
  );
}

/* ------------------------------- pictures --------------------------------- */

function MessageAttachments({ attachments, onOpen }: { attachments: Attachment[]; onOpen: (index: number) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className={`message-attachments count-${Math.min(attachments.length, 4)}`}>
      {attachments.map((attachment, index) => {
        const url = assetUrl(attachment.url);
        if (!url) return null;
        return (
          <button
            key={attachment.id}
            type="button"
            className="message-attachment"
            onClick={() => onOpen(index)}
            title="Open picture"
            aria-label="Open picture"
          >
            <img src={url} alt="" loading="lazy" width={attachment.width} height={attachment.height} />
          </button>
        );
      })}
    </div>
  );
}

function ImageLightbox({
  attachments,
  start,
  onClose,
}: {
  attachments: Attachment[];
  start: number;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(start);

  useEffect(() => {
    setCurrent(start);
  }, [start]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') setCurrent((i) => (i + 1) % attachments.length);
      else if (event.key === 'ArrowLeft') setCurrent((i) => (i - 1 + attachments.length) % attachments.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachments.length, onClose]);

  const attachment = attachments[current];
  const url = assetUrl(attachment?.url);
  if (!url) return null;

  const step = (delta: number) => setCurrent((i) => (i + delta + attachments.length) % attachments.length);

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close picture">
        <X size={20} />
      </button>
      {attachments.length > 1 && (
        <>
          <button
            className="lightbox-nav is-prev"
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
            aria-label="Previous picture"
          >
            <ChevronLeft size={24} />
          </button>
          <button
            className="lightbox-nav is-next"
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
            aria-label="Next picture"
          >
            <ChevronRight size={24} />
          </button>
          <div className="lightbox-count">
            {current + 1} / {attachments.length}
          </div>
        </>
      )}
      <img src={url} alt="" onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

/* -------------------------------- message --------------------------------- */

function MessageRow({
  message,
  grouped,
  channel,
  flash,
  onReply,
}: {
  message: Message;
  grouped: boolean;
  channel: Channel;
  flash: boolean;
  onReply: (message: Message) => void;
}) {
  const me = useStore((s) => s.me);
  const guild = useStore((s) => s.guilds.find((g) => g.id === channel.guildId));
  const members = useStore((s) => selectMembers(s, channel.guildId));
  const toggleReaction = useStore((s) => s.toggleReaction);
  const editMessage = useStore((s) => s.editMessage);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const createThread = useStore((s) => s.createThread);
  const openThread = useStore((s) => s.openThread);
  const togglePin = useStore((s) => s.togglePin);
  const selectChannel = useStore((s) => s.selectChannel);
  const openProfile = useStore((s) => s.openProfile);
  const pushToast = useStore((s) => s.pushToast);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [quickOpen, setQuickOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);

  const isMine = message.author.id === me?.id;
  const canManage = isMine || guild?.ownerId === me?.id;
  // Server channels: owner/admins only. DMs have no roles, so everyone there.
  const canPin = channel.guildId
    ? guild?.ownerId === me?.id || members.some((m) => m.id === me?.id && m.role === 'admin')
    : true;
  const deleted = Boolean(message.deletedAt);

  const knownUsernames = useMemo(
    () => new Set(members.map((m) => m.username.toLowerCase())),
    [members],
  );

  useEffect(() => {
    if (!quickOpen) return;
    const close = () => setQuickOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [quickOpen]);

  function startEdit() {
    setDraft(message.content);
    setEditing(true);
  }

  async function saveEdit() {
    const value = draft.trim();
    if (!value || value === message.content) {
      setEditing(false);
      return;
    }
    await editMessage(message.id, message.channelId, value);
    setEditing(false);
  }

  function copyText() {
    void navigator.clipboard?.writeText(message.content).catch(() => {});
    pushToast('Message copied', 'success');
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={`message ${grouped ? 'is-grouped' : ''} ${deleted ? 'is-deleted' : ''} ${flash ? 'is-flash' : ''}`}
    >
      {!grouped ? (
        <button className="message-avatar" onClick={() => openProfile(message.author.id)} aria-label={message.author.displayName}>
          <Avatar name={message.author.displayName} color={message.author.avatarColor} src={message.author.avatarUrl} size={40} />
        </button>
      ) : (
        <span className="message-gutter-time">{formatClock(message.createdAt)}</span>
      )}

      <div className="message-main">
        {message.replyTo && (
          <div className="reply-line">
            <Reply size={12} />
            <span className="reply-line-author">{message.replyTo.authorName}</span>
            <span className="reply-line-text">
              {truncate(message.replyTo.content, 140) ||
                (message.replyTo.hasAttachments ? 'Photo' : 'original message')}
            </span>
          </div>
        )}

        {!grouped && (
          <div className="message-head">
            <button
              className="message-author"
              style={{ color: message.author.avatarColor }}
              onClick={() => openProfile(message.author.id)}
            >
              {message.author.displayName}
            </button>
            <span className="message-time">{formatTimestamp(message.createdAt)}</span>
          </div>
        )}

        {deleted ? (
          <div className="message-deleted">This message was deleted</div>
        ) : editing ? (
          <div className="message-edit">
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void saveEdit();
                }
                if (event.key === 'Escape') setEditing(false);
              }}
              rows={Math.min(8, draft.split('\n').length + 1)}
            />
            <div className="message-edit-actions">
              <button className="text-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="text-btn primary" onClick={() => void saveEdit()}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.content && (
              <div className="message-text">
                <MessageContent
                  content={message.content}
                  options={{
                    knownUsernames,
                    onMention: (username) => {
                      const target = members.find((m) => m.username.toLowerCase() === username.toLowerCase());
                      if (target) openProfile(target.id);
                    },
                    onChannel: (name) => {
                      const target = useStore
                        .getState()
                        .channels.find((c) => c.guildId === channel.guildId && c.name.toLowerCase() === name.toLowerCase());
                      if (target) selectChannel(target.id);
                    },
                    onInvite: (code) => useStore.getState().openModal('join-server', code),
                  }}
                />
                {message.editedAt && <span className="message-edited">(edited)</span>}
              </div>
            )}
            <MessageAttachments attachments={message.attachments ?? []} onOpen={setViewer} />
          </>
        )}

        {!deleted && message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                className={`reaction ${reaction.me ? 'is-me' : ''}`}
                onClick={() => void toggleReaction(message.id, message.channelId, reaction.emoji, reaction.me)}
                title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
              >
                <span>{reaction.emoji}</span>
                <span className="reaction-count">{reaction.count}</span>
              </button>
            ))}
            <button
              className="reaction reaction-add"
              onClick={() => setQuickOpen(true)}
              aria-label="Add reaction"
              title="Add reaction"
            >
              <SmilePlus size={14} />
            </button>
          </div>
        )}

        {!deleted && message.threadId && (
          <button className="thread-chip" onClick={() => openThread(message.threadId!)}>
            <MessagesSquare size={14} />
            View thread
          </button>
        )}

        {!deleted && message.pinnedAt && (
          <div className="pinned-chip" title={message.pinnedBy ? `Pinned by ${message.pinnedBy.displayName}` : 'Pinned message'}>
            <Pin size={12} />
            Pinned{message.pinnedBy ? ` by ${message.pinnedBy.displayName}` : ''}
          </div>
        )}
      </div>

      {!deleted && !editing && (
        <div className="msg-actions">
          <button onClick={() => setQuickOpen(true)} title="Add reaction" aria-label="Add reaction">
            <SmilePlus size={16} />
          </button>
          <button onClick={() => onReply(message)} title="Reply" aria-label="Reply">
            <Reply size={16} />
          </button>
          <button
            onClick={() => void createThread(message.id, message.channelId)}
            title="Create thread"
            aria-label="Create thread"
          >
            <MessagesSquare size={16} />
          </button>
          {isMine && (
            <button onClick={startEdit} title="Edit" aria-label="Edit">
              <Pencil size={16} />
            </button>
          )}
          {canManage && (
            <button
              onClick={() => void deleteMessage(message.id, message.channelId)}
              title="Delete"
              aria-label="Delete"
              className="danger-hover"
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 190, y: rect.bottom + 4 });
            }}
            title="More"
            aria-label="More"
          >
            <MoreHorizontal size={16} />
          </button>

          {quickOpen && (
            <div className="quick-reactions" onMouseDown={(event) => event.stopPropagation()}>
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    void toggleReaction(
                      message.id,
                      message.channelId,
                      emoji,
                      message.reactions.some((r) => r.emoji === emoji && r.me),
                    );
                    setQuickOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Menu open={Boolean(menu)} onClose={() => setMenu(null)} x={menu?.x} y={menu?.y} width={190}>
        <MenuItem icon={<Copy size={15} />} onClick={copyText}>
          Copy text
        </MenuItem>
        <MenuItem
          icon={<Reply size={15} />}
          onClick={() => {
            onReply(message);
            setMenu(null);
          }}
        >
          Reply
        </MenuItem>
        <MenuItem
          icon={<MessagesSquare size={15} />}
          onClick={() => {
            void createThread(message.id, message.channelId);
            setMenu(null);
          }}
        >
          Create thread
        </MenuItem>
        {canPin && (
          <MenuItem
            icon={message.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}
            onClick={() => {
              void togglePin(message.id, message.channelId, Boolean(message.pinnedAt));
              setMenu(null);
            }}
          >
            {message.pinnedAt ? 'Unpin message' : 'Pin message'}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Copy size={15} />}
          onClick={() => {
            void navigator.clipboard?.writeText(`nimbus://message/${message.id}`).catch(() => {});
            pushToast('Message link copied', 'success');
            setMenu(null);
          }}
        >
          Copy link
        </MenuItem>
        {canManage && (
          <>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2 size={15} />}
              onClick={() => {
                void deleteMessage(message.id, message.channelId);
                setMenu(null);
              }}
            >
              Delete message
            </MenuItem>
          </>
        )}
      </Menu>

      {viewer !== null && (message.attachments?.length ?? 0) > 0 && (
        <ImageLightbox
          attachments={message.attachments ?? []}
          start={Math.min(viewer, (message.attachments?.length ?? 1) - 1)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
