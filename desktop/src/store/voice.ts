import { create } from 'zustand';
import { sendGateway } from '../lib/gateway';
import { flashWindow, notify } from '../lib/desktop';
import {
  applyOutputDevice,
  inputCandidates,
  listAudioDevices,
  storedInputId,
} from '../lib/audio';
import { channelLabel, setVoiceEventSink, useStore } from './store';
import type { GatewayEvent, MessageAuthor, VoiceParticipant } from '../lib/types';

/**
 * The voice engine.
 *
 * Calls are peer-to-peer (mesh): every participant holds one RTCPeerConnection
 * per other participant, so up to VOICE_MAX people can talk without any media
 * server. The Node server only relays signalling frames over the gateway.
 *
 * UI state lives here; the WebRTC objects live in module scope because they are
 * mutable resources, not render data.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/* A TURN server is optional, but it is the difference between "works on my
 * LAN" and "works everywhere". Set these before `npm run dev` / `npm run build`
 * if the people you call are not on the same network. */
const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
if (turnUrl) {
  const urls = turnUrl
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length > 0) {
    ICE_SERVERS.push({
      urls,
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    });
  }
}

const SPEAKING_THRESHOLD = 0.015;
const RING_TIMEOUT_MS = 45_000;
const INCOMING_TIMEOUT_MS = 35_000;
const JOIN_TIMEOUT_MS = 8_000;
const ICE_RECOVERY_MS = 4_000;
/* replaceTrack(null) mutes the remote track instead of ending it, so wait a
 * moment before treating a mute as "stopped sharing" (a resolution change or a
 * brief encoder hiccup must not tear down the stage). */
const SCREEN_MUTE_GRACE_MS = 600;

type Phase = 'idle' | 'connecting' | 'connected';

export interface IncomingCall {
  channelId: string;
  from: MessageAuthor;
  group: boolean;
}

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement | null;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  hasRemoteDescription: boolean;
  /** Candidates that arrived before the remote description was ready. */
  pendingCandidates: RTCIceCandidateInit[];
  /** Serialises offer/answer/candidate handling so they cannot interleave. */
  chain: Promise<void>;
  recoveryTimer: number | null;
  /** The video m-line: screen share is swapped in without renegotiating. */
  videoTransceiver: RTCRtpTransceiver | null;
  videoSender: RTCRtpSender | null;
  /** The remote video track, whether or not they are sharing right now. */
  videoTrack: MediaStreamTrack | null;
  screenStream: MediaStream | null;
  screenMuteTimer: number | null;
  screenCleanup: (() => void) | null;
  /**
   * What the remote peer last told us about their share: `true` sharing,
   * `false` stopped, `null` nothing heard yet (fall back to track state).
   */
  screenWanted: boolean | null;
}

interface VoiceStore {
  channelId: string | null;
  phase: Phase;
  muted: boolean;
  deafened: boolean;
  speaking: Record<string, boolean>;
  incoming: IncomingCall | null;
  /** Channel we are ringing, while waiting for someone to pick up. */
  outgoing: string | null;
  error: string | null;
  /** True while our own screen is being sent. */
  screenSharing: boolean;
  /** Our outgoing screen stream, for the local preview. */
  localScreen: MediaStream | null;
  /** Incoming screen streams, keyed by the user sharing them. */
  remoteScreens: Record<string, MediaStream>;
  /** True while the desktop source picker is open. */
  screenPickerOpen: boolean;
  screenError: string | null;

  join: (channelId: string) => Promise<boolean>;
  leave: () => void;
  call: (channelId: string) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  cancelCall: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /** Swaps the live microphone without dropping the call. */
  switchInput: (deviceId: string | null) => Promise<void>;
  /** Opens the desktop picker, or the browser's own picker outside Electron. */
  beginScreenShare: () => void;
  /** Captures the chosen source and swaps it into every peer. */
  startScreenShare: (sourceId?: string) => Promise<boolean>;
  stopScreenShare: () => void;
  closeScreenPicker: () => void;
  resume: () => void;
  reset: () => void;
  /** The gateway stayed offline: the call cannot survive without signalling. */
  connectionLost: () => void;
}

/* ------------------------------ media state ------------------------------ */

const peers = new Map<string, Peer>();
let localStream: MediaStream | null = null;
let localScreenStream: MediaStream | null = null;
let screenStarting = false;
let localAnalyser: AnalyserNode | null = null;
let localSource: MediaStreamAudioSourceNode | null = null;
let audioContext: AudioContext | null = null;
let speakingFrame: number | null = null;
const levelBuffer = new Float32Array(2048);

/** The microphone stream currently being sent, for meters and diagnostics. */
export function currentLocalStream(): MediaStream | null {
  return localStream;
}

let ringtoneTimer: number | null = null;
let ringtoneContext: AudioContext | null = null;
let incomingTimer: number | null = null;
let outgoingTimer: number | null = null;

let joining = false;
let joinWaiter: ((ok: boolean) => void) | null = null;
/** What the mic was doing before deafen forced it off, so undeafen can restore it. */
let mutedBeforeDeafen = false;

/* -------------------------------- helpers -------------------------------- */

function meId(): string | null {
  return useStore.getState().me?.id ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Verbose logs, visible in devtools or with `localStorage['nimbus.voice.debug'] = '1'`. */
function voiceDebug(...args: unknown[]): void {
  try {
    if (import.meta.env.DEV || localStorage.getItem('nimbus.voice.debug') === '1') {
      console.debug('[voice]', ...args);
    }
  } catch {
    /* logging must never break a call */
  }
}

function voiceWarn(...args: unknown[]): void {
  console.warn('[voice]', ...args);
}

function ensureAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
  return audioContext;
}

function attachAnalyser(stream: MediaStream): { analyser: AnalyserNode; source: MediaStreamAudioSourceNode } | null {
  try {
    const ctx = ensureAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    return { analyser, source };
  } catch (error) {
    voiceDebug('could not attach analyser', describeError(error));
    return null;
  }
}

function readLevel(analyser: AnalyserNode): number {
  analyser.getFloatTimeDomainData(levelBuffer);
  let sum = 0;
  for (let i = 0; i < analyser.fftSize; i += 1) {
    const value = levelBuffer[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / analyser.fftSize);
}

function sameSpeaking(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => b[key] === true);
}

function startSpeakingLoop(): void {
  if (speakingFrame !== null) return;
  const tick = () => {
    const next: Record<string, boolean> = {};
    const mine = meId();
    if (mine && localAnalyser && !useVoiceStore.getState().muted) {
      if (readLevel(localAnalyser) > SPEAKING_THRESHOLD) next[mine] = true;
    }
    for (const [userId, peer] of peers) {
      if (peer.analyser && readLevel(peer.analyser) > SPEAKING_THRESHOLD) next[userId] = true;
    }
    if (!sameSpeaking(next, useVoiceStore.getState().speaking)) {
      useVoiceStore.setState({ speaking: next });
    }
    speakingFrame = requestAnimationFrame(tick);
  };
  speakingFrame = requestAnimationFrame(tick);
}

function stopSpeakingLoop(): void {
  if (speakingFrame !== null) cancelAnimationFrame(speakingFrame);
  speakingFrame = null;
}

function isDirectCall(channelId: string): boolean {
  const store = useStore.getState();
  const channel = [...store.channels, ...store.dms].find((candidate) => candidate.id === channelId);
  // DMs and groups have no guild; server voice channels always do.
  return Boolean(channel && !channel.guildId);
}

/* ------------------------------ screen share ----------------------------- */

function screenShareError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Screen sharing was cancelled or denied.';
      case 'NotFoundError':
        return 'That screen or window is no longer available.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Windows could not capture that screen. Try another one.';
      case 'AbortError':
        return 'Screen sharing was cancelled.';
      case 'InvalidStateError':
        return 'Screen sharing is already in progress.';
      default:
        break;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Could not share your screen.';
}

function publishRemoteScreen(userId: string, stream: MediaStream): void {
  const current = useVoiceStore.getState().remoteScreens;
  if (current[userId] === stream) return;
  useVoiceStore.setState({ remoteScreens: { ...current, [userId]: stream } });
}

function unpublishRemoteScreen(userId: string): void {
  const current = useVoiceStore.getState().remoteScreens;
  if (!(userId in current)) return;
  const next = { ...current };
  delete next[userId];
  useVoiceStore.setState({ remoteScreens: next });
}

/** Tells one peer whether we are sharing, so their stage hides immediately. */
function sendScreenState(userId: string, sharing: boolean): void {
  const channelId = useVoiceStore.getState().channelId;
  if (!channelId) return;
  sendGateway({
    t: 'VOICE_SIGNAL',
    d: { channelId, toUserId: userId, kind: 'screen', payload: { sharing } },
  });
}

/**
 * Decides whether the remote stage should be visible.
 *
 * The `screen` signal is authoritative: `replaceTrack(null)` only mutes the
 * remote track, and that mute can take seconds to arrive (or never arrive), so
 * mute alone is a poor "stopped sharing" hint. Track state is still used as a
 * fallback for peers that never sent the signal, and to hide a share whose
 * track has ended.
 */
function applyRemoteScreen(userId: string, peer: Peer): void {
  const track = peer.videoTrack;
  const stream = peer.screenStream;
  if (!track || !stream || track.readyState === 'ended') {
    if (peer.screenMuteTimer !== null) {
      window.clearTimeout(peer.screenMuteTimer);
      peer.screenMuteTimer = null;
    }
    unpublishRemoteScreen(userId);
    return;
  }

  if (peer.screenWanted === false) {
    if (peer.screenMuteTimer !== null) {
      window.clearTimeout(peer.screenMuteTimer);
      peer.screenMuteTimer = null;
    }
    unpublishRemoteScreen(userId);
    return;
  }

  if (peer.screenWanted === true) {
    if (peer.screenMuteTimer !== null) {
      window.clearTimeout(peer.screenMuteTimer);
      peer.screenMuteTimer = null;
    }
    publishRemoteScreen(userId, stream);
    return;
  }

  // No signal yet: infer from the track, with a grace period so a resolution
  // change or a brief encoder hiccup does not tear down the stage.
  if (!track.muted) {
    if (peer.screenMuteTimer !== null) {
      window.clearTimeout(peer.screenMuteTimer);
      peer.screenMuteTimer = null;
    }
    publishRemoteScreen(userId, stream);
    return;
  }
  if (peer.screenMuteTimer !== null) return;
  peer.screenMuteTimer = window.setTimeout(() => {
    peer.screenMuteTimer = null;
    if (peers.get(userId) !== peer) return;
    if (peer.videoTrack === track && peer.screenWanted !== true && !track.muted) return;
    unpublishRemoteScreen(userId);
  }, SCREEN_MUTE_GRACE_MS);
}

/** Starts watching the remote video track that carries their screen share. */
function watchRemoteScreen(userId: string, peer: Peer, track: MediaStreamTrack, stream: MediaStream): void {
  peer.screenCleanup?.();
  peer.videoTrack = track;
  peer.screenStream = stream;

  const sync = () => {
    if (peers.get(userId) !== peer) return;
    applyRemoteScreen(userId, peer);
  };

  track.addEventListener('unmute', sync);
  track.addEventListener('mute', sync);
  track.addEventListener('ended', sync);
  peer.screenCleanup = () => {
    track.removeEventListener('unmute', sync);
    track.removeEventListener('mute', sync);
    track.removeEventListener('ended', sync);
  };

  voiceDebug('remote screen track', {
    userId,
    label: track.label,
    muted: track.muted,
    state: track.readyState,
  });
  sync();
}

/** Stops the outgoing capture and detaches it from every sender. */
function stopLocalScreenShare(): void {
  const wasSharing = Boolean(localScreenStream) || useVoiceStore.getState().screenSharing;

  if (localScreenStream) {
    for (const track of localScreenStream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    localScreenStream = null;
  }

  for (const [userId, peer] of peers) {
    if (peer.videoSender) {
      void peer.videoSender.replaceTrack(null).catch((error) => {
        voiceDebug('could not detach the screen track', describeError(error));
      });
    }
    // Do not wait for the remote track to mute: tell them right away.
    if (wasSharing) sendScreenState(userId, false);
  }

  if (!wasSharing) return;
  useVoiceStore.setState({ screenSharing: false, localScreen: null, screenError: null });
  voiceDebug('screen share stopped');
}

/* ------------------------------ audio output ----------------------------- */

function playRemoteAudio(audio: HTMLAudioElement): void {
  const attempt = () => {
    void audio
      .play()
      .then(() => voiceDebug('remote audio playing', audio.getAttribute('data-nimbus-voice')))
      .catch((error) => {
        voiceWarn('remote audio was blocked, waiting for a gesture', describeError(error));
        const retry = () => {
          void audio.play().catch(() => {});
          window.removeEventListener('pointerdown', retry);
          window.removeEventListener('keydown', retry);
        };
        window.addEventListener('pointerdown', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
      });
  };

  if (audio.readyState >= 2) {
    attempt();
    return;
  }
  audio.addEventListener('canplay', attempt, { once: true });
  // Some streams never emit canplay in Electron; try anyway shortly after.
  window.setTimeout(attempt, 400);
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => {
      if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {});
    },
    { passive: true },
  );
  window.addEventListener('nimbus:audio-output-changed', () => {
    for (const peer of peers.values()) {
      if (peer.audio) void applyOutputDevice(peer.audio);
    }
  });
}

/* -------------------------------- ringtone -------------------------------- */

function chime(ctx: AudioContext): void {
  const at = ctx.currentTime;
  [880, 660].forEach((frequency, index) => {
    const start = at + index * 0.19;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.07, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.19);
  });
}

function startRingtone(): void {
  stopRingtone();
  try {
    const ctx = ensureAudioContext();
    ringtoneContext = ctx;
    chime(ctx);
    ringtoneTimer = window.setInterval(() => chime(ctx), 2200);
  } catch {
    /* audio output unavailable — the modal still shows the call */
  }
}

function stopRingtone(): void {
  if (ringtoneTimer !== null) window.clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  ringtoneContext = null;
}

function clearTimers(): void {
  if (incomingTimer !== null) window.clearTimeout(incomingTimer);
  if (outgoingTimer !== null) window.clearTimeout(outgoingTimer);
  incomingTimer = null;
  outgoingTimer = null;
}

/* ------------------------------ peer plumbing ----------------------------- */

function scheduleIceRecovery(userId: string, peer: Peer, delay = 0): void {
  if (peer.recoveryTimer !== null) return;
  peer.recoveryTimer = window.setTimeout(() => {
    peer.recoveryTimer = null;
    if (peers.get(userId) !== peer) return;
    const connection = peer.pc.connectionState;
    const ice = peer.pc.iceConnectionState;
    if (connection === 'connected' || ice === 'connected' || ice === 'completed') return;
    if (connection !== 'failed' && ice !== 'failed' && ice !== 'disconnected') return;

    // Perfect negotiation: only the impolite side restarts ICE, so both peers
    // never fire an offer at the same moment.
    const mine = meId();
    if (mine && mine > userId) {
      voiceDebug('restarting ICE', { userId });
      void offerTo(userId, true);
    } else {
      voiceDebug('waiting for remote ICE restart', { userId });
    }
  }, delay);
}

function ensurePeer(userId: string): Peer | null {
  const existing = peers.get(userId);
  if (existing) return existing;
  const mine = meId();
  if (!mine) return null;

  let pc: RTCPeerConnection;
  try {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  } catch (error) {
    voiceWarn('could not create a peer connection', describeError(error));
    return null;
  }

  const peer: Peer = {
    pc,
    audio: null,
    analyser: null,
    source: null,
    // Perfect negotiation: exactly one side yields when offers collide.
    polite: mine < userId,
    makingOffer: false,
    ignoreOffer: false,
    hasRemoteDescription: false,
    pendingCandidates: [],
    chain: Promise.resolve(),
    recoveryTimer: null,
    videoTransceiver: null,
    videoSender: null,
    videoTrack: null,
    screenStream: null,
    screenMuteTimer: null,
    screenCleanup: null,
    screenWanted: null,
  };

  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      pc.addTrack(track, localStream);
      voiceDebug('added local microphone track', {
        userId,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
      });
    }
  } else {
    // Still create the audio section so the peer can send us sound even though
    // we have no microphone.
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (event) => {
    const channelId = useVoiceStore.getState().channelId;
    if (!event.candidate || !channelId) return;
    sendGateway({
      t: 'VOICE_SIGNAL',
      d: { channelId, toUserId: userId, kind: 'candidate', payload: event.candidate.toJSON() },
    });
  };

  pc.ontrack = (event) => {
    if (event.track.kind === 'video') {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      watchRemoteScreen(userId, peer, event.track, stream);
      return;
    }
    if (event.track.kind !== 'audio') return;
    voiceDebug('remote track received', {
      userId,
      label: event.track.label,
      muted: event.track.muted,
      streams: event.streams.length,
    });

    let audio = peer.audio;
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      audio.preload = 'auto';
      audio.setAttribute('data-nimbus-voice', userId);
      audio.style.display = 'none';
      document.body.appendChild(audio);
      peer.audio = audio;
    }

    const stream = event.streams[0] ?? new MediaStream([event.track]);
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.muted = useVoiceStore.getState().deafened;
    audio.volume = 1;
    void applyOutputDevice(audio);
    playRemoteAudio(audio);

    try {
      peer.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    const attached = attachAnalyser(stream);
    if (attached) {
      peer.analyser = attached.analyser;
      peer.source = attached.source;
    }
  };

  pc.onconnectionstatechange = () => {
    voiceDebug('connection state', { userId, state: pc.connectionState });
    if (pc.connectionState === 'failed') scheduleIceRecovery(userId, peer);
    if (pc.connectionState === 'closed') closePeer(userId);
  };

  pc.oniceconnectionstatechange = () => {
    voiceDebug('ICE state', { userId, state: pc.iceConnectionState });
    if (pc.iceConnectionState === 'failed') scheduleIceRecovery(userId, peer);
    if (pc.iceConnectionState === 'disconnected') scheduleIceRecovery(userId, peer, ICE_RECOVERY_MS);
  };

  pc.onsignalingstatechange = () => {
    voiceDebug('signalling state', { userId, state: pc.signalingState });
  };

  peers.set(userId, peer);
  voiceDebug('peer created', { userId, polite: peer.polite, hasMicrophone: Boolean(localStream) });
  return peer;
}

/**
 * Makes sure this peer has a video m-line that is negotiated as sendrecv, so a
 * share can start or stop with replaceTrack() and no SDP round-trip.
 *
 * The offerer creates the transceiver before createOffer(). The answerer does
 * NOT create one up front: Chrome would ignore an unassociated transceiver
 * whose sender has no track and create a second, recvonly one from the offer.
 * Instead, after setRemoteDescription() we adopt the transceiver Chrome made
 * and flip it to sendrecv before createAnswer().
 */
function ensureVideoTransceiver(peer: Peer): RTCRtpTransceiver | null {
  if (peer.videoTransceiver && peer.videoTransceiver.currentDirection !== 'stopped') {
    peer.videoSender = peer.videoTransceiver.sender;
    return peer.videoTransceiver;
  }

  const existing = peer.pc
    .getTransceivers()
    .find(
      (transceiver) =>
        transceiver.currentDirection !== 'stopped' && transceiver.receiver.track?.kind === 'video',
    );

  if (existing) {
    // A transceiver created by a remote offer defaults to recvonly. Change it
    // before the answer is generated, or we would only ever receive.
    if (existing.direction === 'recvonly') existing.direction = 'sendrecv';
    peer.videoTransceiver = existing;
    peer.videoSender = existing.sender;
  } else {
    try {
      const transceiver = peer.pc.addTransceiver('video', { direction: 'sendrecv' });
      peer.videoTransceiver = transceiver;
      peer.videoSender = transceiver.sender;
    } catch (error) {
      voiceWarn('could not create the video transceiver', describeError(error));
      return null;
    }
  }

  if (localScreenStream && peer.videoTransceiver) {
    const track = localScreenStream.getVideoTracks()[0];
    if (track) {
      void peer.videoTransceiver.sender.replaceTrack(track).catch((error) => {
        voiceWarn('could not attach the screen track to a new peer', describeError(error));
      });
    }
  }

  return peer.videoTransceiver;
}

async function flushCandidates(peer: Peer): Promise<void> {
  if (peer.pendingCandidates.length === 0) return;
  const queued = peer.pendingCandidates.splice(0);
  for (const candidate of queued) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error) {
      voiceDebug('queued candidate rejected', describeError(error));
    }
  }
  voiceDebug('queued candidates flushed', queued.length);
}

async function offerTo(userId: string, iceRestart = false): Promise<void> {
  const channelId = useVoiceStore.getState().channelId;
  if (!channelId) return;
  const peer = ensurePeer(userId);
  if (!peer || peer.pc.signalingState === 'closed') return;

  ensureVideoTransceiver(peer);

  try {
    peer.makingOffer = true;
    const offer = await peer.pc.createOffer({ iceRestart });
    await peer.pc.setLocalDescription(offer);
    sendGateway({
      t: 'VOICE_SIGNAL',
      d: {
        channelId,
        toUserId: userId,
        kind: 'offer',
        payload: { type: offer.type, sdp: offer.sdp },
      },
    });
    voiceDebug('offer sent', { userId, iceRestart });
    // A peer joining while we share needs the state frame too: their m-line is
    // negotiated as sendrecv, but the stage is driven by this signal.
    if (localScreenStream) sendScreenState(userId, true);
  } catch (error) {
    voiceWarn('could not send an offer', describeError(error));
  } finally {
    peer.makingOffer = false;
  }
}

async function processSignal(peer: Peer, data: any): Promise<void> {
  if (peer.pc.signalingState === 'closed') return;

  if (data.kind === 'offer' || data.kind === 'answer') {
    const description = data.payload as RTCSessionDescriptionInit | undefined;
    if (!description || (description.type !== 'offer' && description.type !== 'answer')) return;

    const collision =
      description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) {
      voiceDebug('ignored a colliding offer', { from: data.fromUserId });
      return;
    }

    try {
      if (collision && peer.polite) {
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }
      await peer.pc.setRemoteDescription(description);
      peer.hasRemoteDescription = true;
      if (description.type === 'answer') peer.ignoreOffer = false;
      // The incoming offer already created the video transceiver; adopt it and
      // make the answer sendrecv before it is generated.
      if (description.type === 'offer') ensureVideoTransceiver(peer);
      await flushCandidates(peer);

      if (description.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        sendGateway({
          t: 'VOICE_SIGNAL',
          d: {
            channelId: useVoiceStore.getState().channelId,
            toUserId: data.fromUserId,
            kind: 'answer',
            payload: { type: answer.type, sdp: answer.sdp },
          },
        });
        voiceDebug('answer sent', { to: data.fromUserId });
        if (localScreenStream) sendScreenState(String(data.fromUserId), true);
      }
    } catch (error) {
      voiceWarn('negotiation failed', { from: data.fromUserId, error: describeError(error) });
    }
    return;
  }

  if (data.kind === 'screen') {
    // Explicit share state: authoritative, and independent of SDP.
    const sharing = Boolean((data.payload as { sharing?: unknown } | undefined)?.sharing);
    peer.screenWanted = sharing;
    const userId = String(data.fromUserId ?? '');
    if (userId) applyRemoteScreen(userId, peer);
    return;
  }

  if (data.kind === 'candidate' && data.payload) {
    if (peer.ignoreOffer) return;
    if (!peer.hasRemoteDescription) {
      peer.pendingCandidates.push(data.payload as RTCIceCandidateInit);
      voiceDebug('candidate queued until the remote description arrives', {
        from: data.fromUserId,
        queued: peer.pendingCandidates.length,
      });
      return;
    }
    try {
      await peer.pc.addIceCandidate(data.payload as RTCIceCandidateInit);
    } catch (error) {
      voiceDebug('candidate rejected', { from: data.fromUserId, error: describeError(error) });
    }
  }
}

/**
 * Signals are handled one at a time per peer. Without this, an ICE candidate
 * could run `addIceCandidate` while an offer is still awaiting
 * `setRemoteDescription`, and the candidate would be lost forever.
 */
function handleSignal(data: any): void {
  const channelId = useVoiceStore.getState().channelId;
  if (!channelId || data.channelId !== channelId) return;
  const fromUserId = String(data.fromUserId ?? '');
  if (!fromUserId) return;
  const peer = ensurePeer(fromUserId);
  if (!peer) return;

  peer.chain = peer.chain
    .then(() => processSignal(peer, data))
    .catch((error) => voiceWarn('signal failed', describeError(error)));
}

function closePeer(userId: string): void {
  const peer = peers.get(userId);
  if (!peer) return;
  peers.delete(userId);

  if (peer.recoveryTimer !== null) window.clearTimeout(peer.recoveryTimer);
  peer.pendingCandidates.length = 0;
  try {
    peer.pc.close();
  } catch {
    /* already closed */
  }
  if (peer.audio) {
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
  try {
    peer.source?.disconnect();
  } catch {
    /* already disconnected */
  }

  if (peer.screenMuteTimer !== null) window.clearTimeout(peer.screenMuteTimer);
  peer.screenMuteTimer = null;
  peer.screenCleanup?.();
  peer.screenCleanup = null;
  peer.videoTrack = null;
  peer.videoTransceiver = null;
  peer.videoSender = null;
  peer.screenStream = null;
  unpublishRemoteScreen(userId);

  voiceDebug('peer closed', { userId });
}

function teardownMedia(): void {
  // Stop the capture before the connections go away, so replaceTrack(null)
  // still reaches every sender.
  stopLocalScreenShare();
  for (const userId of [...peers.keys()]) closePeer(userId);
  stopSpeakingLoop();

  try {
    localSource?.disconnect();
  } catch {
    /* already disconnected */
  }
  localSource = null;
  localAnalyser = null;

  if (localStream) {
    for (const track of localStream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
  }
  localStream = null;
  mutedBeforeDeafen = false;

  // Belt and braces: never leave a remote audio element behind.
  document.querySelectorAll('audio[data-nimbus-voice]').forEach((element) => {
    const audio = element as HTMLAudioElement;
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  });

  useVoiceStore.setState({ remoteScreens: {}, screenPickerOpen: false });
}

/** Idempotent: every termination path funnels through here. */
function endCall(options: { sendLeave?: boolean; toast?: string; error?: string | null } = {}): void {
  const state = useVoiceStore.getState();
  if (options.sendLeave && state.channelId) {
    sendGateway({ t: 'VOICE_LEAVE', d: { channelId: state.channelId } });
  }

  teardownMedia();
  clearTimers();
  stopRingtone();

  if (joinWaiter) joinWaiter(false);

  useVoiceStore.setState({
    channelId: null,
    phase: 'idle',
    muted: false,
    deafened: false,
    speaking: {},
    outgoing: null,
    error: options.error ?? null,
    screenSharing: false,
    localScreen: null,
    remoteScreens: {},
    screenPickerOpen: false,
    screenError: null,
  });

  if (options.toast) useStore.getState().pushToast(options.toast, 'info');
  voiceDebug('call ended', { sendLeave: Boolean(options.sendLeave), toast: options.toast });
}

/* -------------------------------- capture -------------------------------- */

interface CaptureResult {
  stream: MediaStream | null;
  error: unknown;
  label: string | null;
  /** True when an explicitly selected device failed and we used another one. */
  fallback: boolean;
}

function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      // `ideal` silently falls back to the system default, which is exactly the
      // dead device we are trying to avoid. `exact` either gives us the device
      // we asked for or fails loudly, and the caller then tries the next one.
      deviceId: { exact: deviceId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };
}

/**
 * Some endpoints (notably Bluetooth headsets) report `muted: true` for a moment
 * while the audio link wakes up. Give them a chance before skipping them.
 */
async function waitForLiveTrack(track: MediaStreamTrack, timeout = 1500): Promise<boolean> {
  if (!track.muted) return true;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(120);
    if (track.readyState !== 'live') return false;
    if (!track.muted) return true;
  }
  return !track.muted;
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone permission denied — you joined muted. Allow it in Windows Settings → Privacy → Microphone.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone found — you joined muted.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Your microphone is busy or unavailable — you joined muted.';
      case 'OverconstrainedError':
        return 'That microphone is unavailable — you joined muted.';
      default:
        break;
    }
  }
  if (error instanceof Error && error.message.toLowerCase().includes('muted')) {
    return 'Your microphone is muted by Windows — pick another device in Settings → Voice.';
  }
  return 'Microphone unavailable — you joined muted.';
}

async function captureMicrophone(): Promise<CaptureResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: null, error: new Error('Microphone access is unavailable'), label: null, fallback: false };
  }

  const devices = await listAudioDevices('audioinput').catch(() => []);
  const explicit = storedInputId();
  const candidates = inputCandidates(devices);
  let lastError: unknown = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const deviceId = candidates[index]!;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((candidate) => candidate.stop());
        continue;
      }

      // Some Windows endpoints (disconnected mic arrays, for example) hand
      // back a live but permanently muted track. If the user has not chosen a
      // device explicitly, move on instead of joining a silent call.
      if (!explicit && candidates.length > 1) {
        const usable = await waitForLiveTrack(track);
        if (!usable) {
          voiceDebug('microphone is muted, trying the next device', {
            deviceId,
            label: track.label,
          });
          stream.getTracks().forEach((candidate) => candidate.stop());
          lastError = new Error(`Microphone "${track.label || deviceId}" is muted`);
          continue;
        }
      }

      const fallback = Boolean(explicit) && deviceId !== explicit;
      voiceDebug('microphone captured', {
        deviceId,
        label: track.label,
        muted: track.muted,
        settings: track.getSettings(),
        fallback,
      });
      return { stream, error: null, label: track.label || deviceId, fallback };
    } catch (error) {
      lastError = error;
      voiceDebug('microphone candidate failed', { deviceId, error: describeError(error) });
    }
  }

  return { stream: null, error: lastError, label: null, fallback: false };
}

async function startSession(channelId: string): Promise<boolean> {
  teardownMedia();
  useVoiceStore.setState({ phase: 'connecting', channelId, error: null, speaking: {} });

  const capture = await captureMicrophone();
  localStream = capture.stream;
  const mic = Boolean(localStream);
  const capturedTrack = localStream?.getAudioTracks()[0] ?? null;
  // A last-resort device can still be permanently muted; say so instead of
  // pretending the microphone is live.
  const deviceMuted = Boolean(capturedTrack?.muted);
  const muted = !mic || deviceMuted || useVoiceStore.getState().muted || useVoiceStore.getState().deafened;
  useVoiceStore.setState({ muted, deafened: useVoiceStore.getState().deafened });

  if (mic && localStream) {
    ensureAudioContext();
    const attached = attachAnalyser(localStream);
    if (attached) {
      localAnalyser = attached.analyser;
      localSource = attached.source;
    }
    const track = capturedTrack;
    if (track) {
      track.enabled = !muted;
      track.addEventListener('mute', () => {
        if (!useVoiceStore.getState().channelId) return;
        voiceWarn('microphone track muted by the operating system');
        useStore.getState().pushToast('Microphone disconnected — check Settings → Voice', 'error');
      });
    }
    if (deviceMuted) {
      useStore
        .getState()
        .pushToast('Your microphone is muted by Windows — pick another device in Settings → Voice.', 'error');
    }
    if (capture.fallback) {
      useStore.getState().pushToast(`Using ${capture.label} instead of the selected microphone`, 'info');
    }
  } else {
    voiceWarn('joining without a microphone', describeError(capture.error));
    useStore.getState().pushToast(microphoneError(capture.error), 'error');
  }

  // Remote speaking rings should work even when we have no microphone.
  startSpeakingLoop();

  if (
    !sendGateway({
      t: 'VOICE_JOIN',
      d: { channelId, muted: useVoiceStore.getState().muted, deafened: useVoiceStore.getState().deafened },
    })
  ) {
    teardownMedia();
    useVoiceStore.setState({ phase: 'idle', channelId: null, error: 'Not connected to Nimbus' });
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (joinWaiter === finish) joinWaiter = null;
      resolve(ok);
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      const state = useVoiceStore.getState();
      // The server never confirmed the join. Release the microphone instead of
      // leaving the app stuck on "Connecting…" with a hot track.
      if (state.channelId === channelId && state.phase !== 'connected') {
        endCall({ sendLeave: false, error: 'Could not join the call', toast: 'Could not join the call' });
      }
      finish(false);
    }, JOIN_TIMEOUT_MS);
    joinWaiter = finish;
  });
}

/* --------------------------------- store --------------------------------- */

export const useVoiceStore = create<VoiceStore>()((set, get) => ({
  channelId: null,
  phase: 'idle',
  muted: false,
  deafened: false,
  speaking: {},
  incoming: null,
  outgoing: null,
  error: null,
  screenSharing: false,
  localScreen: null,
  remoteScreens: {},
  screenPickerOpen: false,
  screenError: null,

  join: async (channelId) => {
    if (joining) return false;
    joining = true;
    try {
      const current = get();
      if (current.channelId === channelId && current.phase === 'connected') return true;

      if (current.channelId && current.channelId !== channelId) {
        sendGateway({ t: 'VOICE_LEAVE', d: { channelId: current.channelId } });
        set({ channelId: null, phase: 'idle', speaking: {}, outgoing: null });
      }

      return await startSession(channelId);
    } finally {
      joining = false;
    }
  },

  leave: () => {
    endCall({ sendLeave: true });
  },

  call: async (channelId) => {
    const state = get();
    if (state.channelId === channelId && state.phase === 'connected') return;
    if (state.phase !== 'idle') return;

    set({ outgoing: channelId, error: null });
    const joined = await get().join(channelId);
    if (!joined) {
      set({ outgoing: null });
      return;
    }

    if (!sendGateway({ t: 'VOICE_RING', d: { channelId } })) {
      endCall({ sendLeave: true, toast: 'Not connected to Nimbus' });
      return;
    }

    if (outgoingTimer !== null) window.clearTimeout(outgoingTimer);
    outgoingTimer = window.setTimeout(() => {
      const participants = useStore.getState().voice[channelId] ?? [];
      const others = participants.filter((person) => person.userId !== meId());
      if (get().outgoing === channelId && others.length === 0) {
        useStore.getState().pushToast('No answer', 'info');
        endCall({ sendLeave: true });
      }
    }, RING_TIMEOUT_MS);
  },

  accept: async () => {
    const incoming = get().incoming;
    if (!incoming) return;
    stopRingtone();
    clearTimers();
    set({ incoming: null });
    await get().join(incoming.channelId);
  },

  decline: () => {
    const incoming = get().incoming;
    if (!incoming) return;
    sendGateway({ t: 'VOICE_DECLINE', d: { channelId: incoming.channelId } });
    stopRingtone();
    clearTimers();
    set({ incoming: null });
  },

  cancelCall: () => {
    const outgoing = get().outgoing;
    if (outgoing) sendGateway({ t: 'VOICE_CANCEL', d: { channelId: outgoing } });
    endCall({ sendLeave: true });
  },

  toggleMute: () => {
    // Deafen implies mute; you have to undeafen first, like Discord.
    if (get().deafened) return;
    const muted = !get().muted;
    set({ muted });
    if (localStream) {
      for (const track of localStream.getAudioTracks()) track.enabled = !muted;
    }
    sendGateway({ t: 'VOICE_STATE', d: { muted, deafened: get().deafened } });
    voiceDebug('microphone mute', muted);
  },

  toggleDeafen: () => {
    const deafened = !get().deafened;
    let muted: boolean;
    if (deafened) {
      mutedBeforeDeafen = get().muted;
      muted = true;
    } else {
      // Undeafening restores whatever the microphone was doing before.
      muted = mutedBeforeDeafen;
    }
    set({ deafened, muted });
    for (const peer of peers.values()) {
      if (peer.audio) peer.audio.muted = deafened;
    }
    if (localStream) {
      for (const track of localStream.getAudioTracks()) track.enabled = !muted;
    }
    sendGateway({ t: 'VOICE_STATE', d: { muted, deafened } });
    voiceDebug('deafen', { deafened, muted });
  },

  /**
   * Replace the outgoing microphone while a call is running. The new track is
   * swapped into every existing sender, so nobody has to leave and rejoin.
   */
  switchInput: async (deviceId) => {
    const state = get();
    if (!state.channelId || state.phase !== 'connected') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      useStore.getState().pushToast('Microphone access is unavailable', 'error');
      return;
    }

    const hadMicrophone = Boolean(localStream);
    const shouldMute = state.deafened ? true : hadMicrophone ? state.muted : false;
    const devices = await listAudioDevices('audioinput').catch(() => []);
    const chosen = deviceId && devices.some((device) => device.deviceId === deviceId) ? deviceId : null;
    const candidates = chosen ? [chosen] : inputCandidates(devices);

    let next: MediaStream | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(micConstraints(candidate));
        const track = stream.getAudioTracks()[0];
        if (!track) {
          stream.getTracks().forEach((item) => item.stop());
          continue;
        }
        // Same muted-endpoint guard as the initial capture.
        if (!chosen && candidate !== candidates[candidates.length - 1]) {
          const usable = await waitForLiveTrack(track);
          if (!usable) {
            stream.getTracks().forEach((item) => item.stop());
            lastError = new Error(`Microphone "${track.label || candidate}" is muted`);
            continue;
          }
        }
        next = stream;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!next) {
      useStore.getState().pushToast(microphoneError(lastError), 'error');
      return;
    }

    const track = next.getAudioTracks()[0]!;
    track.enabled = !shouldMute;

    let renegotiate = false;
    for (const [userId, peer] of peers) {
      const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'audio');
      try {
        if (sender) {
          await sender.replaceTrack(track);
        } else {
          // We joined without a microphone, so this peer has no send track yet.
          peer.pc.addTrack(track, next);
          renegotiate = true;
        }
      } catch (error) {
        voiceWarn('could not swap the microphone track', { userId, error: describeError(error) });
        renegotiate = true;
      }
    }
    if (renegotiate) {
      for (const userId of peers.keys()) void offerTo(userId);
    }

    const previous = localStream;
    localStream = next;
    try {
      localSource?.disconnect();
    } catch {
      /* already disconnected */
    }
    localSource = null;
    localAnalyser = null;
    const attached = attachAnalyser(next);
    if (attached) {
      localAnalyser = attached.analyser;
      localSource = attached.source;
    }
    if (previous) {
      for (const item of previous.getTracks()) {
        try {
          item.stop();
        } catch {
          /* already stopped */
        }
      }
    }

    useVoiceStore.setState({ muted: shouldMute, error: null });
    sendGateway({ t: 'VOICE_STATE', d: { muted: shouldMute, deafened: state.deafened } });
    useStore.getState().pushToast(`Microphone: ${track.label || 'selected device'}`, 'info');
    voiceDebug('microphone switched', {
      label: track.label,
      muted: track.muted,
      renegotiate,
    });
  },

  beginScreenShare: () => {
    const state = get();
    if (!state.channelId || state.phase !== 'connected' || localScreenStream) return;
    set({ screenError: null });
    // Electron needs our picker because it owns the capturer; a browser has
    // its own source chooser inside getDisplayMedia().
    if (window.nimbus?.screen) {
      set({ screenPickerOpen: true });
      return;
    }
    void get().startScreenShare();
  },

  startScreenShare: async (sourceId) => {
    const state = get();
    if (!state.channelId || state.phase !== 'connected') return false;
    if (localScreenStream) return true;
    if (screenStarting) return false;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      const message = 'Screen sharing is not available in this build.';
      set({ screenError: message });
      useStore.getState().pushToast(message, 'error');
      return false;
    }

    screenStarting = true;
    set({ screenError: null });
    try {
      const desktop = window.nimbus?.screen;
      if (desktop) {
        if (!sourceId) throw new Error('Pick a screen or window to share.');
        const chosen = await desktop.select(sourceId);
        if (!chosen) throw new Error('That screen or window is no longer available.');
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        throw new Error('That source did not provide a video track.');
      }
      try {
        // Text and UI stay sharp when the encoder has to trade resolution.
        track.contentHint = 'detail';
      } catch {
        /* older Chromium */
      }

      localScreenStream = stream;
      for (const [userId, peer] of peers) {
        try {
          const transceiver = ensureVideoTransceiver(peer);
          if (!transceiver) continue;
          await transceiver.sender.replaceTrack(track);
          // A peer that joined before this client had a video m-line still
          // needs one negotiated. Our own clients always negotiate it up front.
          if (!transceiver.mid) void offerTo(userId);
          sendScreenState(userId, true);
        } catch (error) {
          voiceWarn('could not attach the screen track', { userId, error: describeError(error) });
        }
      }

      // Windows' own "Stop sharing" control ends the track directly.
      track.addEventListener(
        'ended',
        () => {
          if (localScreenStream !== stream) return;
          voiceDebug('screen capture ended by the operating system');
          stopLocalScreenShare();
        },
        { once: true },
      );

      set({ screenSharing: true, localScreen: stream, screenPickerOpen: false, screenError: null });
      voiceDebug('screen share started', {
        label: track.label,
        peers: peers.size,
        settings: track.getSettings(),
      });
      return true;
    } catch (error) {
      const message = screenShareError(error);
      set({ screenError: message });
      useStore.getState().pushToast(message, 'error');
      voiceWarn('could not start screen sharing', describeError(error));
      void window.nimbus?.screen?.cancel();
      return false;
    } finally {
      screenStarting = false;
    }
  },

  stopScreenShare: () => {
    stopLocalScreenShare();
  },

  closeScreenPicker: () => {
    void window.nimbus?.screen?.cancel();
    set({ screenPickerOpen: false, screenError: null });
  },

  resume: () => {
    const { channelId, phase, outgoing } = get();
    if (!channelId || phase !== 'connected') return;

    // If a direct call lost its only other participant while we were offline,
    // rejoining would leave us talking to an empty conversation.
    if (!outgoing && isDirectCall(channelId)) {
      const participants = useStore.getState().voice[channelId] ?? [];
      const others = participants.filter((person) => person.userId !== meId());
      if (others.length === 0) {
        endCall({ sendLeave: false, toast: 'Call ended while you were offline.' });
        return;
      }
    }

    teardownMedia();
    void startSession(channelId);
  },

  reset: () => {
    endCall({ sendLeave: true });
    useVoiceStore.setState({ incoming: null, error: null });
  },

  connectionLost: () => {
    const state = get();
    if (!state.channelId && !state.incoming && !state.outgoing) return;
    endCall({
      sendLeave: false,
      toast: state.channelId ? 'Call ended — the connection to Nimbus was lost.' : undefined,
    });
    useVoiceStore.setState({ incoming: null });
  },
}));

/* ------------------------------- gateway --------------------------------- */

function onVoiceEvent(event: GatewayEvent): void {
  const data = (event.d ?? {}) as any;
  const state = useVoiceStore.getState();

  switch (event.t) {
    case 'VOICE_JOINED': {
      if (data.channelId !== state.channelId) return;
      useVoiceStore.setState({ phase: 'connected', error: null });
      if (joinWaiter) joinWaiter(true);

      const mine = meId();
      const participants = (data.participants ?? []) as VoiceParticipant[];
      const others = participants.filter((participant) => participant.userId !== mine);

      // We accepted a call that ended before our join landed.
      if (isDirectCall(data.channelId) && others.length === 0 && state.outgoing !== data.channelId) {
        endCall({ sendLeave: true, toast: 'Call ended — the other person left.' });
        return;
      }

      for (const participant of others) {
        if (!peers.has(participant.userId)) void offerTo(participant.userId);
      }

      if (state.outgoing === data.channelId && others.length > 0) {
        if (outgoingTimer !== null) window.clearTimeout(outgoingTimer);
        outgoingTimer = null;
        useVoiceStore.setState({ outgoing: null });
      }
      break;
    }

    case 'VOICE_STATE_UPDATE': {
      if (data.channelId !== state.channelId) return;
      const participants = (data.participants ?? []) as VoiceParticipant[];
      const ids = new Set(participants.map((person) => person.userId));
      for (const userId of [...peers.keys()]) {
        if (!ids.has(userId)) closePeer(userId);
      }

      const mine = meId();
      const others = participants.filter((person) => person.userId !== mine);

      if (mine && !ids.has(mine)) {
        // The server ended our session (kicked, channel deleted, …).
        endCall({ sendLeave: false });
        break;
      }

      // A direct/group call has nothing to stay in alone. This is the client
      // half of the server rule; it also catches a lost VOICE_CLOSED frame.
      if (isDirectCall(data.channelId) && others.length === 0) {
        if (state.outgoing !== data.channelId) {
          endCall({ sendLeave: true, toast: 'Call ended — the other person left.' });
        }
        break;
      }

      if (state.outgoing === data.channelId && others.length > 0) {
        if (outgoingTimer !== null) window.clearTimeout(outgoingTimer);
        outgoingTimer = null;
        useVoiceStore.setState({ outgoing: null });
      }
      break;
    }

    case 'VOICE_SIGNAL':
      handleSignal(data);
      break;

    case 'VOICE_RING': {
      const from = data.from as MessageAuthor | undefined;
      if (!from || typeof data.channelId !== 'string') return;
      if (state.phase !== 'idle' || state.incoming) {
        // Busy: politely decline without showing anything.
        sendGateway({ t: 'VOICE_DECLINE', d: { channelId: data.channelId } });
        return;
      }
      useVoiceStore.setState({
        incoming: { channelId: data.channelId, from, group: Boolean(data.group) },
      });
      startRingtone();
      if (incomingTimer !== null) window.clearTimeout(incomingTimer);
      incomingTimer = window.setTimeout(() => useVoiceStore.getState().decline(), INCOMING_TIMEOUT_MS);

      notify({
        title: `Incoming call from ${from.displayName}`,
        body: data.group ? 'Group voice call' : 'Voice call',
        channelId: data.channelId,
        silent: true,
      });
      flashWindow();
      break;
    }

    case 'VOICE_DECLINE': {
      if (state.outgoing !== data.channelId) return;
      endCall({ sendLeave: true, toast: 'Call declined' });
      break;
    }

    case 'VOICE_CANCEL': {
      const incoming = state.incoming;
      if (!incoming || incoming.channelId !== data.channelId) return;
      if (data.fromUserId && incoming.from.id !== data.fromUserId) return;
      stopRingtone();
      clearTimers();
      useVoiceStore.setState({ incoming: null });
      break;
    }

    case 'VOICE_RING_END': {
      const incoming = state.incoming;
      if (!incoming || incoming.channelId !== data.channelId) return;
      if (data.userId && incoming.from.id !== data.userId) return;
      stopRingtone();
      clearTimers();
      useVoiceStore.setState({ incoming: null });
      break;
    }

    case 'VOICE_ERROR': {
      const message = String(data.message ?? 'Voice is unavailable right now');
      useStore.getState().pushToast(message, 'error');
      const stage = String(data.stage ?? '');
      if (stage === 'VOICE_JOIN' && state.channelId === data.channelId) {
        endCall({ sendLeave: false, error: message });
      } else if (stage === 'VOICE_RING' && state.outgoing === data.channelId) {
        endCall({ sendLeave: true });
      }
      break;
    }

    case 'VOICE_CLOSED': {
      const channelId = typeof data.channelId === 'string' ? data.channelId : null;
      if (!channelId) return;

      const incoming = state.incoming;
      if (incoming && incoming.channelId === channelId) {
        stopRingtone();
        clearTimers();
        useVoiceStore.setState({ incoming: null });
      }

      if (state.channelId !== channelId) return;
      const reason = typeof data.reason === 'string' ? data.reason : '';
      endCall({
        sendLeave: false,
        toast: reason === 'peer-left' ? 'Call ended — the other person left.' : undefined,
      });
      break;
    }

    case 'VOICE_LEFT': {
      if (data.channelId !== state.channelId) return;
      endCall({ sendLeave: false });
      break;
    }

    default:
      break;
  }
}

setVoiceEventSink((event) => {
  if (event.t.startsWith('VOICE_')) onVoiceEvent(event);
});

/** Label for the floating call bar (falls back to "Voice call"). */
export function voiceChannelLabel(channelId: string | null): string {
  if (!channelId) return 'Voice call';
  const store = useStore.getState();
  const channel = [...store.channels, ...store.dms].find((candidate) => candidate.id === channelId);
  return channel ? channelLabel(channel, store.me) : 'Voice call';
}
