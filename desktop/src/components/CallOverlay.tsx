import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
} from 'lucide-react';
import { selectActiveChannel, useStore } from '../store/store';
import { useVoiceStore, voiceChannelLabel } from '../store/voice';
import { Avatar, Button } from './ui';
import { ScreenSharePicker, ScreenShareStage } from './ScreenShare';

/** Seconds → m:ss, or h:mm:ss once a call passes an hour. */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Two pieces of voice UI that float above the app: the incoming-call card and
 * the call bar. Both are portalled so they survive view changes.
 */
export function CallOverlay() {
  return (
    <>
      <IncomingCall />
      <CallBar />
      <ScreenShareStage />
      <ScreenSharePicker />
    </>
  );
}

/* ----------------------------- incoming call ----------------------------- */

function IncomingCall() {
  const incoming = useVoiceStore((s) => s.incoming);
  const accept = useVoiceStore((s) => s.accept);
  const decline = useVoiceStore((s) => s.decline);

  if (!incoming) return null;

  return createPortal(
    <div className="call-incoming-backdrop">
      <div className="call-incoming" role="dialog" aria-modal="true" aria-label="Incoming voice call">
        <div className="call-incoming-avatar">
          <Avatar
            name={incoming.from.displayName}
            color={incoming.from.avatarColor}
            src={incoming.from.avatarUrl}
            size={76}
          />
          <span className="call-incoming-pulse" />
        </div>
        <h2>{incoming.from.displayName}</h2>
        <p>{incoming.group ? 'Incoming group call' : 'Incoming voice call'}</p>
        <div className="call-incoming-actions">
          <Button variant="danger" onClick={decline}>
            <PhoneOff size={17} />
            Decline
          </Button>
          <Button variant="success" onClick={() => void accept()}>
            <Phone size={17} />
            Accept
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------- call bar ------------------------------- */

function CallBar() {
  const channelId = useVoiceStore((s) => s.channelId);
  const phase = useVoiceStore((s) => s.phase);
  const muted = useVoiceStore((s) => s.muted);
  const deafened = useVoiceStore((s) => s.deafened);
  const outgoing = useVoiceStore((s) => s.outgoing);
  const speaking = useVoiceStore((s) => s.speaking);
  const screenSharing = useVoiceStore((s) => s.screenSharing);
  const leave = useVoiceStore((s) => s.leave);
  const cancelCall = useVoiceStore((s) => s.cancelCall);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const beginScreenShare = useVoiceStore((s) => s.beginScreenShare);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);

  const participants = useStore((s) => (channelId ? s.voice[channelId] : undefined)) ?? [];
  const me = useStore((s) => s.me);
  const activeChannel = useStore(selectActiveChannel);

  const [seconds, setSeconds] = useState(0);

  const connected = phase === 'connected';
  // A voice channel already has its own room UI; only show the floating bar
  // when the call lives somewhere else (a DM, or a channel you navigated away
  // from).
  const hideForRoom = connected && activeChannel?.type === 'voice' && activeChannel.id === channelId;

  useEffect(() => {
    if (!connected) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [connected, channelId]);

  if (!channelId || hideForRoom) return null;

  const others = participants.filter((person) => person.userId !== me?.id);
  const label = voiceChannelLabel(channelId);
  const ringing = Boolean(outgoing);

  const status = ringing
    ? others.length > 0
      ? 'Connected'
      : 'Ringing…'
    : phase === 'connecting'
      ? 'Connecting…'
      : connected
        ? `${others.length + 1} in call · ${formatDuration(seconds)}`
        : 'Not connected';

  return createPortal(
    <div className={`call-bar ${ringing ? 'is-ringing' : ''}`}>
      <div className="call-bar-main">
        <span className={`call-bar-dot ${connected ? 'is-live' : ''}`} />
        <div className="call-bar-text">
          <span className="call-bar-title">{label}</span>
          <span className="call-bar-status">{status}</span>
        </div>
      </div>

      {others.length > 0 && (
        <div className="call-bar-people">
          {others.slice(0, 4).map((person) => (
            <span
              key={person.userId}
              className={`call-bar-person ${speaking[person.userId] ? 'is-speaking' : ''}`}
              title={person.displayName}
            >
              <Avatar name={person.displayName} color={person.avatarColor} src={person.avatarUrl} size={24} />
            </span>
          ))}
          {others.length > 4 && <span className="call-bar-more">+{others.length - 4}</span>}
        </div>
      )}

      <div className="call-bar-actions">
        {ringing && others.length === 0 ? (
          <Button variant="danger" size="sm" onClick={cancelCall}>
            <PhoneOff size={15} />
            Cancel
          </Button>
        ) : (
          <>
            <button
              className={`call-bar-btn ${muted ? 'is-off' : ''}`}
              onClick={toggleMute}
              disabled={deafened}
              title={deafened ? 'Undeafen to unmute' : muted ? 'Unmute' : 'Mute'}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {muted ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
            <button
              className={`call-bar-btn ${deafened ? 'is-off' : ''}`}
              onClick={toggleDeafen}
              title={deafened ? 'Undeafen' : 'Deafen'}
              aria-label={deafened ? 'Undeafen' : 'Deafen'}
            >
              {deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
            </button>
            <button
              className={`call-bar-btn ${screenSharing ? 'is-sharing' : ''}`}
              onClick={screenSharing ? stopScreenShare : beginScreenShare}
              disabled={!connected}
              title={screenSharing ? 'Stop sharing your screen' : 'Share your screen'}
              aria-label={screenSharing ? 'Stop sharing your screen' : 'Share your screen'}
            >
              {screenSharing ? <ScreenShareOff size={17} /> : <ScreenShare size={17} />}
            </button>
            <button className="call-bar-btn is-hangup" onClick={leave} title="Leave call" aria-label="Leave call">
              <PhoneOff size={17} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
