import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Maximize2,
  Minimize2,
  Monitor,
  ScreenShare,
  ScreenShareOff,
} from 'lucide-react';
import { useStore } from '../store/store';
import { useVoiceStore } from '../store/voice';
import type { ScreenSource } from '../lib/desktop';
import { Modal, Spinner } from './ui';

/**
 * Screen sharing is video-only: system audio would mean a second audio m-line
 * and a renegotiation, which is exactly what the mesh tries to avoid. The
 * floating stage shows every share in the call, including your own preview.
 */

/* ------------------------------- video tile ------------------------------ */

function ScreenVideo({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

/* --------------------------------- stage --------------------------------- */

export function ScreenShareStage() {
  const channelId = useVoiceStore((s) => s.channelId);
  const localScreen = useVoiceStore((s) => s.localScreen);
  const remoteScreens = useVoiceStore((s) => s.remoteScreens);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);
  const participants = useStore((s) => (channelId ? s.voice[channelId] : undefined)) ?? [];
  const me = useStore((s) => s.me);

  const [minimized, setMinimized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const nameFor = (userId: string) =>
    participants.find((person) => person.userId === userId)?.displayName ?? 'Someone';

  const tiles = [
    ...(localScreen
      ? [
          {
            key: 'local',
            name: `${me?.displayName ?? 'You'} (you)`,
            stream: localScreen,
            local: true,
          },
        ]
      : []),
    ...Object.entries(remoteScreens).map(([userId, stream]) => ({
      key: userId,
      name: nameFor(userId),
      stream,
      local: false,
    })),
  ];

  if (tiles.length === 0) return null;

  const summary =
    tiles.length === 1
      ? tiles[0].local
        ? 'You are sharing your screen'
        : `${tiles[0].name} is sharing`
      : `${tiles.length} people are sharing`;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void stageRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  if (minimized) {
    return createPortal(
      <div className="screen-stage is-minimized">
        <div className="screen-stage-mini">
          <ScreenShare size={15} />
          <span>{summary}</span>
        </div>
        <div className="screen-stage-actions">
          {localScreen && (
            <button
              className="screen-stage-btn is-stop"
              onClick={stopScreenShare}
              title="Stop sharing your screen"
              aria-label="Stop sharing your screen"
            >
              <ScreenShareOff size={15} />
            </button>
          )}
          <button
            className="screen-stage-btn"
            onClick={() => setMinimized(false)}
            title="Show shared screens"
            aria-label="Show shared screens"
          >
            <Maximize2 size={15} />
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className={`screen-stage ${fullscreen ? 'is-fullscreen' : ''}`} ref={stageRef}>
      <div className="screen-stage-head">
        <div className="screen-stage-title">
          <ScreenShare size={15} />
          <span>{summary}</span>
        </div>
        <div className="screen-stage-actions">
          {localScreen && (
            <button className="screen-stage-btn is-stop" onClick={stopScreenShare} title="Stop sharing">
              <ScreenShareOff size={15} />
              <span>Stop</span>
            </button>
          )}
          <button
            className="screen-stage-btn"
            onClick={() => setMinimized(true)}
            title="Minimize"
            aria-label="Minimize shared screens"
          >
            <Minimize2 size={15} />
          </button>
          <button
            className="screen-stage-btn"
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>

      <div className={`screen-stage-body ${tiles.length === 1 ? 'is-single' : ''}`}>
        {tiles.map((tile) => (
          <div key={tile.key} className={`screen-tile ${tile.local ? 'is-local' : ''}`}>
            <ScreenVideo stream={tile.stream} muted={tile.local} />
            <span className="screen-tile-label">
              <Monitor size={12} />
              {tile.name}
            </span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------- picker -------------------------------- */

export function ScreenSharePicker() {
  const open = useVoiceStore((s) => s.screenPickerOpen);
  const close = useVoiceStore((s) => s.closeScreenPicker);
  const start = useVoiceStore((s) => s.startScreenShare);
  const error = useVoiceStore((s) => s.screenError);

  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSources(null);
    setLoadError(null);

    const screen = window.nimbus?.screen;
    if (!screen) {
      setLoadError('Screen sharing is only available in the desktop app.');
      return;
    }
    void screen
      .sources()
      .then((list) => {
        if (!cancelled) setSources(list);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : 'Could not list your screens.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  async function choose(source: ScreenSource) {
    setBusyId(source.id);
    const ok = await start(source.id);
    setBusyId(null);
    if (ok) close();
  }

  return (
    <Modal
      title="Share your screen"
      subtitle="Pick a screen or a window. It stays on this call until you stop it."
      onClose={close}
      width={720}
      className="screen-picker"
    >
      {loadError && <div className="form-error">{loadError}</div>}
      {!sources && !loadError && (
        <div className="invite-loading">
          <Spinner /> Looking for screens…
        </div>
      )}
      {sources && sources.length === 0 && (
        <div className="screen-picker-empty">No screens or windows were found.</div>
      )}
      {sources && sources.length > 0 && (
        <div className="screen-source-grid">
          {sources.map((source) => (
            <button
              key={source.id}
              type="button"
              className="screen-source"
              onClick={() => void choose(source)}
              disabled={busyId !== null}
            >
              <span className="screen-source-thumb">
                {source.thumbnail ? (
                  <img src={source.thumbnail} alt="" draggable={false} />
                ) : (
                  <Monitor size={30} />
                )}
                {busyId === source.id && (
                  <span className="screen-source-busy">
                    <Spinner size={18} />
                  </span>
                )}
              </span>
              <span className="screen-source-name" title={source.name}>
                {source.appIcon ? (
                  <img className="screen-source-icon" src={source.appIcon} alt="" draggable={false} />
                ) : source.kind === 'screen' ? (
                  <Monitor size={13} />
                ) : null}
                <span>{source.name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <p className="screen-picker-hint">
        Only video is shared — system audio stays on your machine. Your microphone keeps working as
        usual.
      </p>
    </Modal>
  );
}
