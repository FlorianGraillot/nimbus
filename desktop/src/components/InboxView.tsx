import { useEffect } from 'react';
import { AtSign, CheckCheck, Hash, Inbox as InboxIcon, MessageSquare, RefreshCw } from 'lucide-react';
import type { Channel, Inbox, InboxMention } from '../lib/types';
import { formatRelative, formatTimestamp } from '../lib/format';
import { MessageContent } from '../lib/markdown';
import { channelLabel, useStore } from '../store/store';
import { Avatar, Button, IconButton } from './ui';

const EMPTY_INBOX: Inbox = { mentions: [], unread: [] };

export function InboxView() {
  const inbox = useStore((s) => s.inbox);
  const loading = useStore((s) => s.inboxLoading);
  const me = useStore((s) => s.me);
  const channels = useStore((s) => s.channels);
  const dms = useStore((s) => s.dms);
  const guilds = useStore((s) => s.guilds);
  const loadInbox = useStore((s) => s.loadInbox);
  const markInboxRead = useStore((s) => s.markInboxRead);
  const openMessage = useStore((s) => s.openMessage);
  const selectChannel = useStore((s) => s.selectChannel);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  const data = inbox ?? EMPTY_INBOX;
  const channelOf = (id: string): Channel | undefined =>
    channels.find((c) => c.id === id) ?? dms.find((c) => c.id === id);
  const guildName = (id: string | null) => guilds.find((g) => g.id === id)?.name ?? null;
  const empty = data.mentions.length === 0 && data.unread.length === 0;

  const mentionLocation = (mention: InboxMention) => {
    const channel = channelOf(mention.channelId);
    const parent = channel?.type === 'thread' && channel.parentId ? channelOf(channel.parentId) : channel;
    return [guildName(mention.guildId), parent ? channelLabel(parent, me) : null, channel?.type === 'thread' ? 'thread' : null]
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <div className="inbox">
      <header className="friends-head inbox-head">
        <div className="friends-title">
          <InboxIcon size={20} />
          <h1>Inbox</h1>
          {data.mentions.length > 0 && (
            <span className="inbox-pill">{data.mentions.length} new</span>
          )}
        </div>
        <IconButton label="Refresh inbox" onClick={() => void loadInbox()} disabled={loading}>
          <RefreshCw size={18} className={loading ? 'spin' : ''} />
        </IconButton>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void markInboxRead()}
          disabled={empty || loading}
        >
          <CheckCheck size={15} />
          Mark all read
        </Button>
      </header>

      <div className="inbox-body">
        {empty && !loading && (
          <div className="inbox-empty">
            <div className="inbox-empty-icon">
              <InboxIcon size={38} />
            </div>
            <h2>You&apos;re all caught up</h2>
            <p>Mentions and unread channels land here, newest first.</p>
          </div>
        )}

        {data.mentions.length > 0 && (
          <section className="inbox-section">
            <div className="inbox-section-head">
              <AtSign size={14} />
              <span>Mentions</span>
              <span className="inbox-count">{data.mentions.length}</span>
            </div>

            {data.mentions.map((mention) => (
              <button
                key={mention.id}
                className="inbox-row inbox-mention"
                onClick={() => void openMessage(mention)}
              >
                <Avatar
                  name={mention.author.displayName}
                  color={mention.author.avatarColor}
                  src={mention.author.avatarUrl}
                  size={38}
                />
                <div className="inbox-row-main">
                  <div className="inbox-row-top">
                    <span className="inbox-row-author">{mention.author.displayName}</span>
                    <span className="inbox-row-where">{mentionLocation(mention)}</span>
                    <time
                      className="inbox-row-time"
                      title={formatTimestamp(mention.createdAt)}
                    >
                      {formatRelative(mention.createdAt)}
                    </time>
                  </div>
                  <div className="inbox-snippet">
                    {mention.content ? (
                      <MessageContent content={mention.content} />
                    ) : mention.hasAttachments ? (
                      <span className="inbox-photo">Photo</span>
                    ) : null}
                  </div>
                </div>
              </button>
            ))}
          </section>
        )}

        {data.unread.length > 0 && (
          <section className="inbox-section">
            <div className="inbox-section-head">
              <MessageSquare size={14} />
              <span>Unread channels</span>
              <span className="inbox-count">{data.unread.length}</span>
            </div>

            {data.unread.map((entry) => {
              const channel = channelOf(entry.channelId);
              if (!channel) return null;
              const isDm = channel.type === 'dm' || channel.type === 'group';
              const label = channelLabel(channel, me);
              const other = channel.recipients?.find((r) => r.id !== me?.id);
              const where = guildName(channel.guildId);

              return (
                <button
                  key={entry.channelId}
                  className="inbox-row inbox-unread"
                  onClick={() => selectChannel(channel.id)}
                >
                  {isDm ? (
                    <Avatar name={label} color={other?.avatarColor ?? '#6d5efc'} src={other?.avatarUrl} size={38} />
                  ) : (
                    <span className="inbox-hash">
                      <Hash size={18} />
                    </span>
                  )}

                  <div className="inbox-row-main">
                    <div className="inbox-row-top">
                      <span className="inbox-row-author">{label}</span>
                      {where && <span className="inbox-row-where">{where}</span>}
                      {entry.last && (
                        <time
                          className="inbox-row-time"
                          title={formatTimestamp(entry.last.createdAt)}
                        >
                          {formatRelative(entry.last.createdAt)}
                        </time>
                      )}
                    </div>
                    {entry.last && (
                      <div className="inbox-snippet inbox-preview">
                        <span className="inbox-preview-author">{entry.last.author.displayName}</span>
                        <span className="inbox-preview-text">
                          {entry.last.content || (entry.last.hasAttachments ? 'Photo' : '')}
                        </span>
                      </div>
                    )}
                  </div>

                  <span className={`unread-badge ${entry.mentions > 0 ? 'is-mention' : ''}`}>
                    {entry.count > 99 ? '99+' : entry.count}
                  </span>
                </button>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
