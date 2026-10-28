import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EMOJI_CATEGORIES } from '../lib/emoji';

export function EmojiPicker({
  onPick,
  onClose,
  style,
  className = '',
  closeOnPick = false,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  style?: CSSProperties;
  className?: string;
  closeOnPick?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const category = EMOJI_CATEGORIES[tab];

  return (
    <div className={`emoji-picker ${className}`} style={style} ref={ref} role="dialog" aria-label="Emoji picker">
      <div className="emoji-tabs">
        {EMOJI_CATEGORIES.map((c, index) => (
          <button
            key={c.name}
            className={`emoji-tab ${index === tab ? 'is-active' : ''}`}
            onClick={() => setTab(index)}
            title={c.name}
            aria-label={c.name}
            type="button"
          >
            {c.icon}
          </button>
        ))}
      </div>
      <div className="emoji-grid-wrap">
        <div className="emoji-category-label">{category.name}</div>
        <div className="emoji-grid">
          {category.emojis.map((emoji, index) => (
            <button
              key={`${emoji}-${index}`}
              className="emoji-cell"
              type="button"
              onClick={() => {
                onPick(emoji);
                if (closeOnPick) onClose();
              }}
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
