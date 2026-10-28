import { useState } from 'react';
import { MessagesSquare, X } from 'lucide-react';
import type { Message } from '../lib/types';
import { useStore } from '../store/store';
import { formatTimestamp } from '../lib/format';
import { Avatar, IconButton } from './ui';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

export function ThreadPanel() {
  const threadId = useStore((s) => s.threadChannelId);
  const channel = useStore((s) => s.channels.find((c) => c.id === s.threadChannelId));
  const parent = useStore((s) => s.channels.find((c) => c.id === channel?.parentId));
  const rootMessage = useStore((s) => {
    if (!channel?.threadRootId || !parent) return undefined;
    return (s.messages[parent.id] ?? []).find((m) => m.id === channel.threadRootId);
  });
  const closeThread = useStore((s) => s.closeThread);
  const selectChannel = useStore((s) => s.selectChannel);
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  if (!threadId || !channel) return null;

  return (
    <aside className="thread-panel" aria-label="Thread">
      <header className="thread-head">
        <div className="thread-head-text">
          <MessagesSquare size={18} />
          <div>
            <h2>{channel.name}</h2>
            {parent && (
              <button className="thread-parent" onClick={() => selectChannel(parent.id)}>
                #{parent.name}
              </button>
            )}
          </div>
        </div>
        <IconButton label="Close thread" onClick={closeThread}>
          <X size={18} />
        </IconButton>
      </header>

      {rootMessage && (
        <div className="thread-root">
          <Avatar name={rootMessage.author.displayName} color={rootMessage.author.avatarColor} src={rootMessage.author.avatarUrl} size={28} />
          <div>
            <div className="thread-root-head">
              <strong>{rootMessage.author.displayName}</strong>
              <span>{formatTimestamp(rootMessage.createdAt)}</span>
            </div>
            <p>
              {rootMessage.content || (rootMessage.attachments?.length ? 'Photo' : '')}
            </p>
          </div>
        </div>
      )}

      <MessageList channelId={channel.id} onReply={setReplyTo} />
      <Composer channelId={channel.id} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
    </aside>
  );
}
