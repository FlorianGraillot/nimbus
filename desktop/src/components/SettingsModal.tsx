import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Bell,
  Camera,
  Check,
  Loader2,
  LogOut,
  Mic,
  Palette,
  Shield,
  Sparkles,
  User,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { API_BASE } from '../lib/api';
import {
  listAudioDevices,
  preferredInputId,
  preferredOutputId,
  requestMicrophoneLabels,
  setInputDeviceId,
  setOutputDeviceId,
  storedInputId,
  storedOutputId,
  type AudioDevice,
} from '../lib/audio';
import { fileToAvatarDataUrl } from '../lib/avatar';
import { applyDensity, applyTheme, getDensity, getTheme, type Theme } from '../lib/theme';
import { useStore } from '../store/store';
import { currentLocalStream, useVoiceStore } from '../store/voice';
import type { UserStatus } from '../lib/types';
import { Avatar, Button, Field, Input, Switch } from './ui';

const AVATAR_COLORS = ['#6d5efc', '#f47fff', '#00a8fc', '#23a55a', '#f0b232', '#f23f43', '#eb459e', '#9b59b6'];

type Tab = 'account' | 'profile' | 'appearance' | 'notifications' | 'voice' | 'advanced';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'account', label: 'My account', icon: <User size={17} /> },
  { id: 'profile', label: 'Profile', icon: <Sparkles size={17} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={17} /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell size={17} /> },
  { id: 'voice', label: 'Voice', icon: <Mic size={17} /> },
  { id: 'advanced', label: 'Advanced', icon: <Shield size={17} /> },
];

function useStored(key: string, initial: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initial);
  return [
    value,
    (next: string) => {
      localStorage.setItem(key, next);
      setValue(next);
    },
  ];
}

export function SettingsModal({ initialTab }: { initialTab: string | null }) {
  const closeModal = useStore((s) => s.closeModal);
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || 'account');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeModal]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeModal();
      }}
    >
      <div className="settings-modal" role="dialog" aria-modal="true">
        <aside className="settings-nav">
          <div className="settings-nav-title">User settings</div>
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item ${tab === item.id ? 'is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <div className="settings-nav-divider" />
          <SignOutButton />
        </aside>

        <section className="settings-content">
          <button className="settings-close" onClick={closeModal} aria-label="Close settings">
            <X size={20} />
          </button>
          <div className="settings-inner">
            {tab === 'account' && <AccountPanel onEditProfile={() => setTab('profile')} />}
            {tab === 'profile' && <ProfilePanel />}
            {tab === 'appearance' && <AppearancePanel />}
            {tab === 'notifications' && <NotificationsPanel />}
            {tab === 'voice' && <VoicePanel />}
            {tab === 'advanced' && <AdvancedPanel />}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

function SignOutButton() {
  const logout = useStore((s) => s.logout);
  return (
    <button className="settings-nav-item is-danger" onClick={() => void logout()}>
      <LogOut size={17} />
      Sign out
    </button>
  );
}

/* -------------------------------- account --------------------------------- */

function AccountPanel({ onEditProfile }: { onEditProfile: () => void }) {
  const me = useStore((s) => s.me);
  const setStatus = useStore((s) => s.setStatus);
  const logout = useStore((s) => s.logout);
  if (!me) return null;

  const options: { value: UserStatus; label: string; color: string }[] = [
    { value: 'online', label: 'Online', color: 'var(--green)' },
    { value: 'idle', label: 'Idle', color: 'var(--yellow)' },
    { value: 'dnd', label: 'Do Not Disturb', color: 'var(--red)' },
    { value: 'invisible', label: 'Invisible', color: 'var(--text-subtle)' },
  ];

  return (
    <div className="settings-panel">
      <h2>My account</h2>
      <div className="account-card">
        <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={72} status={me.status} />
        <div className="account-card-text">
          <div className="account-name">{me.displayName}</div>
          <div className="account-username">@{me.username}</div>
        </div>
        <Button variant="secondary" size="sm" onClick={onEditProfile}>
          Edit profile
        </Button>
      </div>

      <div className="settings-section">
        <h3>Presence</h3>
        <p className="settings-help">Choose how you appear to other people in Nimbus.</p>
        <div className="status-grid">
          {options.map((option) => (
            <button
              key={option.value}
              className={`status-option ${me.status === option.value ? 'is-active' : ''}`}
              onClick={() => void setStatus(option.value)}
            >
              <span className="status-option-dot" style={{ background: option.color }} />
              {option.label}
              {me.status === option.value && <Check size={14} />}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h3>Sign out</h3>
        <p className="settings-help">Signing out removes this device's session. Your messages stay on the server.</p>
        <Button variant="danger" size="sm" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- profile --------------------------------- */

function ProfilePanel() {
  const me = useStore((s) => s.me);
  const updateProfile = useStore((s) => s.updateProfile);
  const uploadAvatar = useStore((s) => s.uploadAvatar);
  const removeAvatar = useStore((s) => s.removeAvatar);
  const pushToast = useStore((s) => s.pushToast);

  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [customStatus, setCustomStatus] = useState(me?.customStatus ?? '');
  const [color, setColor] = useState(me?.avatarColor ?? '#6d5efc');
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!me) return null;

  async function pickAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setAvatarBusy(true);
    try {
      // Centre-cropped and resized in the renderer, then stored on the server.
      const dataUrl = await fileToAvatarDataUrl(file);
      await uploadAvatar(dataUrl);
      pushToast('Profile picture updated', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not use that picture', 'error');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function clearAvatar() {
    setAvatarBusy(true);
    try {
      await removeAvatar();
      pushToast('Profile picture removed', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not remove that picture', 'error');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await updateProfile({
        displayName: displayName.trim() || me!.displayName,
        bio,
        customStatus,
        avatarColor: color,
      });
      pushToast('Profile updated', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Could not update profile', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <h2>Profile</h2>
      <p className="settings-help">This is how you appear across Nimbus.</p>

      <div className="profile-edit-preview">
        <div className="avatar-edit">
          <Avatar name={displayName || me.username} color={color} src={me.avatarUrl} size={72} status={me.status} />
          <button
            type="button"
            className="avatar-edit-btn"
            title="Change profile picture"
            aria-label="Change profile picture"
            onClick={() => fileInput.current?.click()}
            disabled={avatarBusy}
          >
            {avatarBusy ? <Loader2 size={13} className="spin" /> : <Camera size={13} />}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(event) => void pickAvatar(event)}
          />
        </div>
        <div>
          <div className="account-name">{displayName || me.displayName}</div>
          <div className="account-username">@{me.username}</div>
          <div className="avatar-hint">
            {me.avatarUrl ? (
              <>
                Square crop, applied instantly.{' '}
                <button type="button" className="link-btn" onClick={() => void clearAvatar()} disabled={avatarBusy}>
                  Remove picture
                </button>
              </>
            ) : (
              'PNG, JPEG, WebP or GIF — cropped to a square automatically.'
            )}
          </div>
        </div>
      </div>

      <Field label="Display name">
        <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={32} />
      </Field>

      <Field label="Custom status" hint="Shown next to your name">
        <Input
          value={customStatus}
          onChange={(event) => setCustomStatus(event.target.value)}
          placeholder="Building something cool"
          maxLength={128}
        />
      </Field>

      <Field label="About me" hint={`${bio.length}/190`}>
        <textarea
          className="input textarea"
          value={bio}
          onChange={(event) => setBio(event.target.value.slice(0, 190))}
          rows={4}
          placeholder="Tell people a little about yourself"
        />
      </Field>

      <Field label="Avatar color" hint="Used when you have no picture">
        <div className="color-row">
          {AVATAR_COLORS.map((option) => (
            <button
              key={option}
              className={`color-swatch ${color === option ? 'is-active' : ''}`}
              style={{ background: option }}
              onClick={() => setColor(option)}
              aria-label={option}
            />
          ))}
        </div>
      </Field>

      <Button onClick={() => void save()} loading={busy}>
        Save changes
      </Button>
    </div>
  );
}

/* ------------------------------- appearance ------------------------------- */

function AppearancePanel() {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [density, setDensity] = useState(getDensity());

  return (
    <div className="settings-panel">
      <h2>Appearance</h2>
      <p className="settings-help">Make Nimbus feel like yours.</p>

      <div className="settings-section">
        <h3>Theme</h3>
        <div className="theme-grid">
          {(['dark', 'light'] as Theme[]).map((option) => (
            <button
              key={option}
              className={`theme-card theme-${option} ${theme === option ? 'is-active' : ''}`}
              onClick={() => {
                setTheme(option);
                applyTheme(option);
              }}
            >
              <span className="theme-preview">
                <span className="theme-preview-rail" />
                <span className="theme-preview-side" />
                <span className="theme-preview-main" />
              </span>
              <span className="theme-label">
                {option === 'dark' ? 'Dark' : 'Light'}
                {theme === option && <Check size={14} />}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <h3>Message spacing</h3>
        <div className="density-row">
          <button
            className={`density-option ${density === 'cozy' ? 'is-active' : ''}`}
            onClick={() => {
              setDensity('cozy');
              applyDensity('cozy');
            }}
          >
            Cozy
          </button>
          <button
            className={`density-option ${density === 'compact' ? 'is-active' : ''}`}
            onClick={() => {
              setDensity('compact');
              applyDensity('compact');
            }}
          >
            Compact
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ notifications ----------------------------- */

function NotificationsPanel() {
  const [notifications, setNotifications] = useStored('nimbus.notifications', 'on');
  const [flash, setFlash] = useStored('nimbus.flash', 'on');

  return (
    <div className="settings-panel">
      <h2>Notifications</h2>
      <p className="settings-help">Control when Nimbus gets your attention.</p>

      <div className="toggle-row">
        <div>
          <div className="toggle-title">Desktop notifications</div>
          <div className="toggle-sub">Show a native notification for mentions and direct messages.</div>
        </div>
        <Switch checked={notifications === 'on'} onChange={(value) => setNotifications(value ? 'on' : 'off')} label="Desktop notifications" />
      </div>

      <div className="toggle-row">
        <div>
          <div className="toggle-title">Flash the taskbar</div>
          <div className="toggle-sub">Flash the window when you are mentioned while Nimbus is in the background.</div>
        </div>
        <Switch checked={flash === 'on'} onChange={(value) => setFlash(value ? 'on' : 'off')} label="Flash taskbar" />
      </div>

      <div className="settings-note">
        <Bell size={15} /> Notifications appear only for mentions and direct messages, never for every message.
      </div>
    </div>
  );
}

/* ---------------------------------- voice --------------------------------- */

const AUTOMATIC = 'auto';

function deviceLabel(device: AudioDevice): string {
  return device.label.replace(/\s+\([0-9a-f]{64}\)$/i, '');
}

function micErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access was denied. Allow it in Windows Settings → Privacy → Microphone.';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No microphone is available.';
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return 'That microphone is in use by another application.';
    }
    if (error.name === 'OverconstrainedError') {
      return 'That microphone is no longer connected.';
    }
  }
  return 'Could not open that microphone.';
}

function VoicePanel() {
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [inputId, setInputId] = useState<string | null>(storedInputId());
  const [outputId, setOutputId] = useState<string | null>(storedOutputId());
  const [unlocking, setUnlocking] = useState(false);
  const inCall = useVoiceStore((s) => Boolean(s.channelId));
  const switchInput = useVoiceStore((s) => s.switchInput);

  const refresh = useCallback(async () => {
    const [nextInputs, nextOutputs] = await Promise.all([
      listAudioDevices('audioinput'),
      listAudioDevices('audiooutput'),
    ]);
    setInputs(nextInputs);
    setOutputs(nextOutputs);
  }, []);

  useEffect(() => {
    void refresh();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const onChange = () => void refresh();
    media.addEventListener('devicechange', onChange);
    return () => media.removeEventListener('devicechange', onChange);
  }, [refresh]);

  // Chromium hides device names until the page has held a microphone once.
  const labelsHidden = inputs.length > 0 && inputs.every((device) => /^Microphone \d+$/.test(device.label));

  async function unlockLabels() {
    setUnlocking(true);
    try {
      const stream = await requestMicrophoneLabels();
      stream?.getTracks().forEach((track) => track.stop());
      await refresh();
    } finally {
      setUnlocking(false);
    }
  }

  function chooseInput(value: string) {
    const next = value === AUTOMATIC ? null : value;
    setInputDeviceId(next);
    setInputId(next);
    // Swap the live track when we are already in a call, so the change is
    // audible immediately instead of on the next call.
    if (inCall) void switchInput(next);
  }

  function chooseOutput(value: string) {
    const next = value === AUTOMATIC ? null : value;
    setOutputDeviceId(next);
    setOutputId(next);
  }

  const automaticInput = preferredInputId(inputs);
  const automaticOutput = preferredOutputId(outputs);

  return (
    <div className="settings-panel">
      <h2>Voice</h2>
      <p className="settings-help">Pick the devices Nimbus uses for calls, and check that your microphone hears you.</p>

      <div className="settings-section">
        <h3>Input device</h3>
        <p className="settings-help">
          Automatic prefers the Windows communications device, then the system default.
        </p>
        <select className="input" value={inputId ?? AUTOMATIC} onChange={(event) => chooseInput(event.target.value)}>
          <option value={AUTOMATIC}>
            Automatic{automaticInput ? ` — ${deviceLabel(inputs.find((d) => d.deviceId === automaticInput) ?? inputs[0]!)}` : ''}
          </option>
          {inputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {deviceLabel(device)}
            </option>
          ))}
        </select>
        {labelsHidden && (
          <p className="voice-device-hint">
            Device names are hidden until Nimbus can use a microphone.{' '}
            <button type="button" className="link-btn" onClick={() => void unlockLabels()} disabled={unlocking}>
              {unlocking ? 'Checking…' : 'Show device names'}
            </button>
          </p>
        )}

        <MicMeter inputId={inputId} />
      </div>

      <div className="settings-section">
        <h3>Output device</h3>
        <p className="settings-help">Where other people's voices come out. Headphones avoid echo.</p>
        <select className="input" value={outputId ?? AUTOMATIC} onChange={(event) => chooseOutput(event.target.value)}>
          <option value={AUTOMATIC}>
            Automatic{automaticOutput ? ` — ${deviceLabel(outputs.find((d) => d.deviceId === automaticOutput) ?? outputs[0]!)}` : ''}
          </option>
          {outputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {deviceLabel(device)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-note">
        <Volume2 size={15} />
        {inCall
          ? 'You are in a call — changes here apply straight away.'
          : 'Nimbus asks for the microphone only when you join or test it. Nothing is recorded.'}
      </div>
    </div>
  );
}

/**
 * Live level meter for the chosen microphone. While a call is running it taps
 * the stream that is actually being sent instead of opening a second capture,
 * because many devices (especially Bluetooth) cannot be opened twice.
 */
function MicMeter({ inputId }: { inputId: string | null }) {
  const channelId = useVoiceStore((s) => s.channelId);
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<'starting' | 'ok' | 'muted' | 'error'>('starting');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let owned = false;
    let context: AudioContext | null = null;
    let timer = 0;
    let analyser: AnalyserNode | null = null;

    const start = async () => {
      setStatus('starting');
      setDetail(null);
      setLevel(0);

      const live = currentLocalStream();
      if (live && live.getAudioTracks().length > 0) {
        stream = live;
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: inputId
              ? { deviceId: { exact: inputId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
              : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
          owned = true;
        } catch (error) {
          if (cancelled) return;
          setStatus('error');
          setDetail(micErrorMessage(error));
          return;
        }
      }
      if (cancelled) {
        // The panel closed while the device was opening.
        if (owned) stream?.getTracks().forEach((track) => track.stop());
        return;
      }

      const track = stream.getAudioTracks()[0];
      if (!track) {
        setStatus('error');
        setDetail('That device did not provide a microphone track.');
        return;
      }

      try {
        context = new AudioContext();
        if (context.state === 'suspended') void context.resume().catch(() => {});
        const source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setDetail(micErrorMessage(error));
        return;
      }

      const buffer = new Float32Array(analyser.fftSize);
      let loudest = 0;

      const sample = () => {
        if (cancelled || !analyser) return;
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        let peak = 0;
        for (const value of buffer) {
          sum += value * value;
          peak = Math.max(peak, Math.abs(value));
        }
        loudest = Math.max(loudest, peak);
        setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 14));
        setStatus(track.muted ? 'muted' : 'ok');
      };
      // A timer, not requestAnimationFrame: a background or occluded window
      // stops painting frames, but the meter still needs to move.
      sample();
      timer = window.setInterval(sample, 60);

      window.setTimeout(() => {
        if (cancelled) return;
        if (track.muted) {
          setDetail('Windows reports this microphone as muted. Pick another device, or enable it in Windows sound settings.');
        } else if (loudest < 0.002) {
          setDetail('No sound detected yet — speak, or try another microphone.');
        } else {
          setDetail(null);
        }
      }, 2800);
    };

    void start();

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      if (owned) stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
    };
  }, [inputId, channelId]);

  return (
    <div className="voice-mic-test">
      <div className="voice-mic-label">
        <Mic size={14} />
        <span>Microphone test</span>
        <span className={`voice-mic-state is-${status}`}>
          {status === 'starting'
            ? 'Starting…'
            : status === 'ok'
              ? level > 0.02
                ? 'Hearing you'
                : 'Listening'
              : status === 'muted'
                ? 'Muted'
                : 'Unavailable'}
        </span>
      </div>
      <div className="voice-mic-meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(2))}>
        <span className="voice-mic-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      {detail && <p className="voice-mic-warning">{detail}</p>}
    </div>
  );
}

/* -------------------------------- advanced -------------------------------- */

function AdvancedPanel() {
  const gatewayStatus = useStore((s) => s.gatewayStatus);
  const me = useStore((s) => s.me);
  const versions = (window as any).nimbus?.versions;

  return (
    <div className="settings-panel">
      <h2>Advanced</h2>
      <p className="settings-help">Connection details for this installation.</p>

      <div className="info-row">
        <span>API server</span>
        <code>{API_BASE}</code>
      </div>
      <div className="info-row">
        <span>Gateway</span>
        <code className={`gateway-${gatewayStatus}`}>
          <Wifi size={13} /> {gatewayStatus}
        </code>
      </div>
      <div className="info-row">
        <span>Signed in as</span>
        <code>{me ? `@${me.username}` : '—'}</code>
      </div>
      <div className="info-row">
        <span>App version</span>
        <code>0.1.0</code>
      </div>
      {versions && (
        <>
          <div className="info-row">
            <span>Electron</span>
            <code>{versions.electron}</code>
          </div>
          <div className="info-row">
            <span>Chromium</span>
            <code>{versions.chrome}</code>
          </div>
        </>
      )}

      <div className="settings-note">
        <Shield size={15} /> Everything runs locally. Messages are stored in a SQLite file inside the server folder.
      </div>
    </div>
  );
}
