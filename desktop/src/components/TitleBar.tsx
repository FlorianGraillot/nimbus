import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { closeWindow, isDesktop, minimizeWindow, onWindowState, toggleMaximizeWindow } from '../lib/desktop';
import { useStore } from '../store/store';
import { Logo } from './Logo';

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const gatewayStatus = useStore((s) => s.gatewayStatus);

  useEffect(() => onWindowState((state) => setMaximized(state.maximized)), []);

  if (!isDesktop) return null;

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-brand">
          <Logo size={18} radius={4} />
          <span>Nimbus</span>
        </span>
      </div>

      <div className={`titlebar-status status-text-${gatewayStatus}`} title={`Gateway ${gatewayStatus}`}>
        <span className="titlebar-status-dot" />
        {gatewayStatus === 'online' ? 'Connected' : gatewayStatus === 'connecting' ? 'Connecting…' : 'Offline'}
      </div>

      <div className="window-controls">
        <button className="window-btn" onClick={minimizeWindow} aria-label="Minimize" title="Minimize">
          <Minus size={15} />
        </button>
        <button
          className="window-btn"
          onClick={toggleMaximizeWindow}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Copy size={13} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} />}
        </button>
        <button className="window-btn window-btn-close" onClick={closeWindow} aria-label="Close" title="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
