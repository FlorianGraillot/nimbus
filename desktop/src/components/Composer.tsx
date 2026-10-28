import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Ban, ImageOff, ImagePlus, Loader2, Send, Smile, X } from 'lucide-react';
import type { Attachment, Channel, Message, Member } from '../lib/types';
import { MAX_ATTACHMENTS, prepareAttachment, type PreparedAttachment } from '../lib/attachments';
import { channelLabel, selectChannelById, useStore } from '../store/store';
import { truncate } from '../lib/format';
import { EmojiPicker } from './EmojiPicker';

const EMPTY_MEMBERS: Member[] = [];

interface Suggestion {
  id: string;
  label: string;
  sub?: string;
  insert: string;
  color?: string;
}

export function Composer({
  channelId,
  replyTo,
  onClearReply,
}: {
  channelId: string;
  replyTo: Message | null;
  onClearReply: () => void;
}) {
  const me = useStore((s) => s.me);
  const channel = useStore((s) => selectChannelById(s, channelId));
  const members = useStore((s) => (channel?.guildId ? s.members[channel.guildId] : undefined) ?? EMPTY_MEMBERS);
  const guild = useStore((s) => (channel?.guildId ? s.guilds.find((g) => g.id === channel.guildId) : undefined));
  const friends = useStore((s) => s.friends);
  const channels = useStore((s) => s.channels);
  const sendMessage = useStore((s) => s.sendMessage);
  const uploadAttachment = useStore((s) => s.uploadAttachment);
  const startTyping = useStore((s) => s.startTyping);
  const setDraft = useStore((s) => s.setDraft);
  const blocked = useStore((s) => s.blocked);
  const pushToast = useStore((s) => s.pushToast);

  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [suggest, setSuggest] = useState<{ kind: 'user' | 'channel'; query: string; start: number } | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [pending, setPending] = useState<PreparedAttachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragging, setDragging] = useState(false);

  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(useStore.getState().drafts[channelId] ?? '');
    setSuggest(null);
  }, [channelId]);

  // A draft is text only, so pictures do not follow you between channels.
  useEffect(() => {
    setPending([]);
  }, [channelId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    ref.current?.focus();
  }, [channelId, replyTo?.id]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (!suggest) return [];
    const q = suggest.query.toLowerCase();
    if (suggest.kind === 'channel') {
      return channels
        .filter((c) => c.guildId === channel?.guildId && c.type === 'text')
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ id: c.id, label: `#${c.name}`, insert: `#${c.name} ` }));
    }
    const pool: { id: string; username: string; displayName: string; avatarColor: string }[] =
      channel?.guildId && members.length > 0
        ? members
        : [
            ...(channel?.recipients ?? []),
            ...friends.filter((f) => f.state === 'accepted').map((f) => f.user),
          ];
    const seen = new Set<string>();
    return pool
      .filter((u) => {
        if (u.id === me?.id || seen.has(u.id)) return false;
        seen.add(u.id);
        return (
          u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
        );
      })
      .slice(0, 8)
      .map((u) => ({
        id: u.id,
        label: u.displayName,
        sub: `@${u.username}`,
        insert: `@${u.username} `,
        color: u.avatarColor,
      }));
  }, [suggest, channels, channel, members, friends, me?.id]);

  useEffect(() => {
    setSuggestIndex(0);
  }, [suggest?.query, suggest?.kind]);

  function detectSuggest(text: string, caret: number) {
    const before = text.slice(0, caret);
    const userMatch = /(^|\s)@([\w.-]{0,32})$/.exec(before);
    if (userMatch) {
      setSuggest({ kind: 'user', query: userMatch[2], start: userMatch.index + userMatch[1].length });
      return;
    }
    const channelMatch = /(^|\s)#([\w-]{0,32})$/.exec(before);
    if (channelMatch) {
      setSuggest({ kind: 'channel', query: channelMatch[2], start: channelMatch.index + channelMatch[1].length });
      return;
    }
    setSuggest(null);
  }

  function applySuggestion(item: Suggestion) {
    const el = ref.current;
    if (!el || !suggest) return;
    const caret = el.selectionStart;
    const next = value.slice(0, suggest.start) + item.insert + value.slice(caret);
    setValue(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const position = suggest.start + item.insert.length;
      el.focus();
      el.setSelectionRange(position, position);
    });
  }

  const isDirect = channel?.type === 'dm' || channel?.type === 'group';
  const blockedRecipient = Boolean(
    isDirect && (channel?.recipients ?? []).some((r) => r.id !== me?.id && blocked.includes(r.id)),
  );
  // Owners and admins set the picture policy and keep the ability to attach.
  const canManage = !channel?.guildId
    ? true
    : guild?.ownerId === me?.id || members.some((m) => m.id === me?.id && m.role === 'admin');
  const canAttach = !channel?.guildId || channel.allowAttachments !== false || canManage;

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    if (!canAttach) {
      pushToast('Pictures are turned off in this channel', 'error');
      return;
    }
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      pushToast('Only pictures can be sent', 'error');
      return;
    }

    const room = MAX_ATTACHMENTS - pending.length;
    if (room <= 0) {
      pushToast(`You can attach up to ${MAX_ATTACHMENTS} pictures`, 'error');
      return;
    }
    if (images.length > room) pushToast(`You can attach up to ${MAX_ATTACHMENTS} pictures`, 'error');
    const chosen = images.slice(0, room);

    setPreparing((n) => n + chosen.length);
    const prepared = await Promise.all(
      chosen.map(async (file) => {
        try {
          return await prepareAttachment(file);
        } catch (error) {
          pushToast(error instanceof Error ? error.message : 'Could not use that picture', 'error');
          return null;
        } finally {
          setPreparing((n) => Math.max(0, n - 1));
        }
      }),
    );

    setPending((current) =>
      [...current, ...prepared.filter((item): item is PreparedAttachment => Boolean(item))].slice(0, MAX_ATTACHMENTS),
    );
  }

  function removeAttachment(index: number) {
    setPending((current) => current.filter((_, i) => i !== index));
  }

  async function submit() {
    const text = value.trim();
    if ((!text && pending.length === 0) || sending || preparing > 0) return;
    setSending(true);
    try {
      // Upload first, then claim the uploads when creating the message.
      let uploaded: Attachment[] = [];
      if (pending.length > 0) {
        uploaded = await Promise.all(
          pending.map((item) =>
            uploadAttachment({ dataUrl: item.dataUrl, width: item.width, height: item.height }),
          ),
        );
      }
      const ok = await sendMessage(channelId, text, replyTo?.id ?? null, uploaded);
      if (ok) {
        setValue('');
        setDraft(channelId, '');
        setPending([]);
        onClearReply();
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not send those pictures', 'error');
    } finally {
      setSending(false);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest && suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSuggestIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applySuggestion(suggestions[suggestIndex]);
        return;
      }
      if (event.key === 'Escape') {
        setSuggest(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
    if (event.key === 'Escape' && replyTo) {
      onClearReply();
    }
  }

  if (!channel) return null;

  const placeholder = blockedRecipient
    ? 'Unblock this user to send messages'
    : isDirect
      ? `Message ${channelLabel(channel, me)}`
      : `Message #${channel.name}`;

  const canSend = Boolean(value.trim() || pending.length > 0);

  return (
    <div
      className="composer-wrap"
      onDragOver={(event) => {
        if (!canAttach || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {blockedRecipient && (
        <div className="composer-blocked-note">
          <Ban size={15} /> You blocked this user. Unblock them from their profile to send messages.
        </div>
      )}
      {!blockedRecipient && channel.guildId && channel.allowAttachments === false && (
        <div className="composer-note">
          <ImageOff size={14} />
          {canManage
            ? 'Pictures are off for members in this channel.'
            : 'Pictures are turned off in this channel — text only.'}
        </div>
      )}
      {dragging && (
        <div className="composer-drop">
          <ImagePlus size={20} /> Drop pictures to attach
        </div>
      )}
      {suggest && suggestions.length > 0 && (
        <div className="autocomplete">
          <div className="autocomplete-head">{suggest.kind === 'user' ? 'Members' : 'Channels'}</div>
          {suggestions.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`autocomplete-row ${index === suggestIndex ? 'is-active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                applySuggestion(item);
              }}
            >
              {item.color ? (
                <span className="autocomplete-dot" style={{ background: item.color }} />
              ) : (
                <span className="autocomplete-hash">#</span>
              )}
              <span className="autocomplete-label">{item.label}</span>
              {item.sub && <span className="autocomplete-sub">{item.sub}</span>}
            </button>
          ))}
        </div>
      )}

      <div className={`composer ${replyTo ? 'has-reply' : ''} ${pending.length > 0 ? 'has-attachments' : ''}`}>
        {replyTo && (
          <div className="composer-reply">
            <span>
              Replying to <strong>{replyTo.author.displayName}</strong>
              <span className="composer-reply-text">
                {truncate(replyTo.content, 90) || (replyTo.attachments?.length ? 'Photo' : 'original message')}
              </span>
            </span>
            <button onClick={onClearReply} aria-label="Cancel reply">
              <X size={14} />
            </button>
          </div>
        )}

        {pending.length > 0 && (
          <div className="composer-attachments">
            {pending.map((item, index) => (
              <div key={`${item.name}-${index}`} className="composer-attachment">
                <img src={item.previewUrl} alt={item.name} />
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => removeAttachment(index)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove picture"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {preparing > 0 && (
              <div className="composer-attachment is-loading">
                <Loader2 size={18} className="spin" />
              </div>
            )}
          </div>
        )}

        <div className="composer-row">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={blockedRecipient}
            onChange={(event) => {
              setValue(event.target.value);
              setDraft(channelId, event.target.value);
              detectSuggest(event.target.value, event.target.selectionStart);
              if (event.target.value) startTyping(channelId);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => detectSuggest(value, event.currentTarget.selectionStart)}
            onClick={(event) => detectSuggest(value, event.currentTarget.selectionStart)}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
              );
              if (images.length > 0) {
                event.preventDefault();
                void addFiles(images);
              }
            }}
            onBlur={() => window.setTimeout(() => setSuggest(null), 120)}
            maxLength={4000}
          />

          <div className="composer-actions">
            <button
              type="button"
              className="composer-icon"
              onClick={() => fileRef.current?.click()}
              disabled={!canAttach || blockedRecipient || preparing > 0 || pending.length >= MAX_ATTACHMENTS}
              aria-label="Attach pictures"
              title={canAttach ? 'Attach pictures' : 'Pictures are turned off in this channel'}
            >
              {preparing > 0 ? <Loader2 size={19} className="spin" /> : <ImagePlus size={20} />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void addFiles(files);
              }}
            />
            <button
              type="button"
              className="composer-icon"
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Emoji"
              title="Emoji"
            >
              <Smile size={20} />
            </button>
            <button
              type="button"
              className="composer-send"
              onClick={() => void submit()}
              disabled={!canSend || sending || preparing > 0 || blockedRecipient}
              aria-label="Send message"
              title="Send message"
            >
              {sending ? <Loader2 size={16} className="spin" /> : <Send size={17} />}
            </button>
          </div>
        </div>

        {value.length > 3600 && <div className="composer-count">{value.length}/4000</div>}
      </div>

      {emojiOpen && (
        <EmojiPicker
          onPick={(emoji) => {
            const el = ref.current;
            const caret = el?.selectionStart ?? value.length;
            setValue(value.slice(0, caret) + emoji + value.slice(caret));
            requestAnimationFrame(() => {
              el?.focus();
              el?.setSelectionRange(caret + emoji.length, caret + emoji.length);
            });
          }}
          onClose={() => setEmojiOpen(false)}
          style={{ position: 'absolute', right: 16, bottom: 68 }}
        />
      )}
    </div>
  );
}
