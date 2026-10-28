import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import type { EffectiveStatus } from '../lib/types';
import { assetUrl } from '../lib/api';
import { initials } from '../lib/format';
import { useStore } from '../store/store';

/* --------------------------------- colour -------------------------------- */

export function shade(hex: string, percent = -24): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full || '6d5efc', 16);
  const r = Math.min(255, Math.max(0, ((num >> 16) & 255) + Math.round((255 * percent) / 100)));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + Math.round((255 * percent) / 100)));
  const b = Math.min(255, Math.max(0, (num & 255) + Math.round((255 * percent) / 100)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function gradientFor(color: string): string {
  return `linear-gradient(135deg, ${color}, ${shade(color, -34)})`;
}

/* --------------------------------- avatar -------------------------------- */

export function Avatar({
  name,
  color,
  src,
  size = 40,
  status,
  className = '',
  square = false,
}: {
  name: string;
  color: string;
  /** Server-relative picture path; falls back to initials when absent or broken. */
  src?: string | null;
  size?: number;
  status?: EffectiveStatus;
  className?: string;
  square?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const url = assetUrl(src);

  useEffect(() => {
    setBroken(false);
  }, [url]);

  return (
    <div
      className={`avatar ${square ? 'avatar-square' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        background: gradientFor(color),
        fontSize: Math.max(10, Math.round(size * 0.36)),
        borderRadius: square ? Math.round(size * 0.3) : '50%',
      }}
      title={name}
    >
      {url && !broken ? (
        <img className="avatar-img" src={url} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span>{initials(name)}</span>
      )}
      {status && <StatusDot status={status} size={Math.min(20, Math.max(10, Math.round(size * 0.3)))} />}
    </div>
  );
}

const STATUS_LABEL: Record<EffectiveStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
};

export function StatusDot({
  status,
  size = 10,
  className = '',
}: {
  status: EffectiveStatus;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`status-dot status-${status} ${className}`}
      style={{ width: size, height: size }}
      title={STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
    />
  );
}

/* -------------------------------- controls ------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  full?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  full = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${full ? 'btn-full' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 size={16} className="spin" />}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  active,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      title={label}
      aria-label={label}
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />;
}

/* ---------------------------------- modal -------------------------------- */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 440,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal ${className}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-head-text">
            {title && <h2>{title}</h2>}
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------- menus -------------------------------- */

export function Menu({
  open,
  onClose,
  children,
  x,
  y,
  bottom,
  align = 'left',
  width,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  x?: number;
  y?: number;
  bottom?: number;
  align?: 'left' | 'right';
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose]);

  if (!open) return null;

  const style: CSSProperties = {
    ...(x !== undefined ? { left: x } : {}),
    ...(y !== undefined ? { top: y } : {}),
    ...(bottom !== undefined ? { bottom } : {}),
    ...(width ? { width } : {}),
    ...(align === 'right' && x !== undefined ? { transform: 'translateX(-100%)' } : {}),
  };

  return createPortal(
    <div className="menu" style={style} ref={ref} role="menu" onClick={onClose}>
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  icon,
  hint,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item ${danger ? 'is-danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <span className="menu-item-icon">{icon}</span>}
      <span className="menu-item-label">{children}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

/* --------------------------------- toasts -------------------------------- */

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-icon">
            {toast.kind === 'success' ? <Check size={16} /> : toast.kind === 'error' ? <X size={16} /> : 'i'}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ------------------------------- empty state ------------------------------ */

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <div className="empty-state-text">{children}</div>}
    </div>
  );
}

/* -------------------------------- copy hook ------------------------------- */

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  return [copied, copy];
}
