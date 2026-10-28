/**
 * Microphone and speaker selection.
 *
 * Windows exposes the user's configured call device as the pseudo-device
 * `communications`, and the normal system default as `default`. The default
 * input is not always the one that actually captures sound (a disconnected
 * Realtek array can report itself as live but permanently muted), so a voice
 * app should prefer the communications device unless the user picked one.
 */

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export const INPUT_KEY = 'nimbus.voice.input';
export const OUTPUT_KEY = 'nimbus.voice.output';

const COMMUNICATIONS = 'communications';
const DEFAULT = 'default';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage can be unavailable in private contexts */
  }
}

export function storedInputId(): string | null {
  return read(INPUT_KEY);
}

export function storedOutputId(): string | null {
  return read(OUTPUT_KEY);
}

export function setInputDeviceId(deviceId: string | null): void {
  write(INPUT_KEY, deviceId);
}

export function setOutputDeviceId(deviceId: string | null): void {
  write(OUTPUT_KEY, deviceId);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nimbus:audio-output-changed'));
}

export async function listAudioDevices(kind: 'audioinput' | 'audiooutput'): Promise<AudioDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === kind && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label:
        device.label ||
        (kind === 'audioinput' ? `Microphone ${index + 1}` : `Speaker ${index + 1}`),
    }));
}

function unique(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/**
 * The device to try first. An explicit choice always wins; otherwise Windows'
 * communications endpoint, then the system default.
 */
export function preferredInputId(devices: AudioDevice[]): string | undefined {
  const stored = storedInputId();
  if (stored && devices.some((device) => device.deviceId === stored)) return stored;
  if (devices.some((device) => device.deviceId === COMMUNICATIONS)) return COMMUNICATIONS;
  if (devices.some((device) => device.deviceId === DEFAULT)) return DEFAULT;
  return devices[0]?.deviceId;
}

/**
 * Every input worth trying, best first. The caller uses this to skip a device
 * that hands back a permanently muted track when no explicit choice was made.
 */
export function inputCandidates(devices: AudioDevice[]): string[] {
  const stored = storedInputId();
  return unique([
    stored,
    preferredInputId(devices),
    devices.some((device) => device.deviceId === COMMUNICATIONS) ? COMMUNICATIONS : null,
    ...devices
      .filter((device) => device.deviceId !== DEFAULT && device.deviceId !== COMMUNICATIONS)
      .map((device) => device.deviceId),
    devices.some((device) => device.deviceId === DEFAULT) ? DEFAULT : null,
    // Always have a fallback even if enumeration was empty.
    DEFAULT,
  ]);
}

export function preferredOutputId(devices: AudioDevice[]): string | undefined {
  const stored = storedOutputId();
  if (stored && devices.some((device) => device.deviceId === stored)) return stored;
  if (devices.some((device) => device.deviceId === COMMUNICATIONS)) return COMMUNICATIONS;
  if (devices.some((device) => device.deviceId === DEFAULT)) return DEFAULT;
  return devices[0]?.deviceId;
}

type SinkAudio = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };

/**
 * Route a remote audio element to the chosen speaker. Falls back through the
 * available endpoints so unplugging a headset never leaves the call silent.
 */
export async function applyOutputDevice(audio: HTMLAudioElement): Promise<void> {
  const element = audio as SinkAudio;
  if (typeof element.setSinkId !== 'function') return;

  const devices = await listAudioDevices('audiooutput').catch(() => []);
  const candidates = unique([
    storedOutputId(),
    preferredOutputId(devices),
    devices.some((device) => device.deviceId === COMMUNICATIONS) ? COMMUNICATIONS : null,
    devices.some((device) => device.deviceId === DEFAULT) ? DEFAULT : null,
  ]);

  for (const deviceId of candidates) {
    try {
      await element.setSinkId(deviceId);
      return;
    } catch {
      /* try the next endpoint */
    }
  }
}

/** Briefly opens the microphone so device labels become available. */
export async function requestMicrophoneLabels(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    return null;
  }
}
