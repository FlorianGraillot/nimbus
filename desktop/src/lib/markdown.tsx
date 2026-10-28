import { Fragment, type ReactNode } from 'react';

interface RenderOptions {
  onChannel?: (name: string) => void;
  onMention?: (username: string) => void;
  onInvite?: (code: string) => void;
  knownUsernames?: Set<string>;
  highlight?: string;
}

const INLINE =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|`[^`\n]+`|nimbus:\/\/invite\/[A-Za-z0-9_-]+|https?:\/\/[^\s<>]+|@[a-zA-Z0-9._-]{2,32}|#[a-zA-Z0-9_-]{1,64})/g;

function renderInline(text: string, keyPrefix: string, options: RenderOptions): ReactNode[] {
  const pieces = text.split(INLINE);
  const nodes: ReactNode[] = [];

  pieces.forEach((piece, index) => {
    if (!piece) return;
    const key = `${keyPrefix}-${index}`;

    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
      nodes.push(<strong key={key}>{piece.slice(2, -2)}</strong>);
      return;
    }
    if (piece.startsWith('__') && piece.endsWith('__') && piece.length > 4) {
      nodes.push(<u key={key}>{piece.slice(2, -2)}</u>);
      return;
    }
    if (piece.startsWith('~~') && piece.endsWith('~~') && piece.length > 4) {
      nodes.push(<s key={key}>{piece.slice(2, -2)}</s>);
      return;
    }
    if (piece.startsWith('*') && piece.endsWith('*') && piece.length > 2) {
      nodes.push(<em key={key}>{piece.slice(1, -1)}</em>);
      return;
    }
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
      nodes.push(
        <code className="md-inline-code" key={key}>
          {piece.slice(1, -1)}
        </code>,
      );
      return;
    }
    if (piece.startsWith('nimbus://invite/')) {
      const code = piece.slice('nimbus://invite/'.length);
      nodes.push(
        <a
          key={key}
          className="md-link md-invite-link"
          href={piece}
          onClick={(event) => {
            event.preventDefault();
            if (options.onInvite) options.onInvite(code);
            else window.dispatchEvent(new CustomEvent('nimbus:join-invite', { detail: code }));
          }}
        >
          {piece}
        </a>,
      );
      return;
    }
    if (/^https?:\/\//.test(piece)) {
      const href = piece.replace(/[.,;:!?)]+$/, '');
      const trailing = piece.slice(href.length);
      nodes.push(
        <Fragment key={key}>
          <a className="md-link" href={href} target="_blank" rel="noreferrer noopener">
            {href}
          </a>
          {trailing}
        </Fragment>,
      );
      return;
    }
    if (piece.startsWith('@') && piece.length > 1) {
      const known = options.knownUsernames?.has(piece.slice(1).toLowerCase()) ?? true;
      nodes.push(
        <span
          key={key}
          className={known ? 'md-mention' : 'md-mention md-mention-plain'}
          onClick={() => options.onMention?.(piece.slice(1))}
          role={options.onMention ? 'button' : undefined}
        >
          {piece}
        </span>,
      );
      return;
    }
    if (piece.startsWith('#') && piece.length > 1) {
      nodes.push(
        <span
          key={key}
          className="md-channel"
          onClick={() => options.onChannel?.(piece.slice(1))}
          role={options.onChannel ? 'button' : undefined}
        >
          {piece}
        </span>,
      );
      return;
    }
    nodes.push(<Fragment key={key}>{piece}</Fragment>);
  });

  return nodes;
}

function renderTextBlock(text: string, keyPrefix: string, options: RenderOptions): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    if (index > 0) nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    if (line.startsWith('> ')) {
      nodes.push(
        <span className="md-quote" key={`${keyPrefix}-q-${index}`}>
          {renderInline(line.slice(2), `${keyPrefix}-q-${index}`, options)}
        </span>,
      );
      return;
    }
    if (line.startsWith('-# ')) {
      nodes.push(
        <span className="md-subtext" key={`${keyPrefix}-s-${index}`}>
          {renderInline(line.slice(3), `${keyPrefix}-s-${index}`, options)}
        </span>,
      );
      return;
    }
    nodes.push(...renderInline(line, `${keyPrefix}-l-${index}`, options));
  });

  return nodes;
}

export function MessageContent({ content, options = {} }: { content: string; options?: RenderOptions }) {
  const nodes: ReactNode[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let block = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(content))) {
    if (match.index > lastIndex) {
      nodes.push(...renderTextBlock(content.slice(lastIndex, match.index), `t${block}`, options));
    }
    nodes.push(
      <pre className="md-code" key={`code-${block}`}>
        <code>{match[2].replace(/\n$/, '')}</code>
      </pre>,
    );
    lastIndex = match.index + match[0].length;
    block += 1;
  }

  if (lastIndex < content.length) {
    nodes.push(...renderTextBlock(content.slice(lastIndex), `t${block}`, options));
  }

  return <>{nodes}</>;
}
