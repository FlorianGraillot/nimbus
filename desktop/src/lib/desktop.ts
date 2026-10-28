export interface ScreenSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** JPEG data URL preview, or null when the window is not capturable. */
  thumbnail: string | null;
  /** Small app icon data URL for window sources. */
  appIcon: string | null;
}

export interface NimbusBridge {
  isElectron: boolean;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onState: (cb: (state: { maximized: boolean; focused: boolean }) => void) => () => void;
  };
  app: {
    version: () => Promise<string>;
    onOpenChannel: (cb: (channelId: string) => void) => () => void;
    onDeepLink: (cb: (url: string) => void) => () => void;
  };
  screen: {
    sources: () => Promise<ScreenSource[]>;
    /** Chooses the source the next getDisplayMedia() call will capture. */
    select: (sourceId: string) => Promise<boolean>;
    cancel: () => Promise<void>;
  };
  notify: (payload: { title: string; body: string; channelId?: string; silent?: boolean }) => void;
  setBadge: (count: number) => void;
  flash: () => void;
}

declare global {
  interface Window {
    nimbus?: NimbusBridge;
  }
}

export const bridge: NimbusBridge | undefined = typeof window !== 'undefined' ? window.nimbus : undefined;
export const isDesktop = Boolean(bridge?.isElectron);

export function notify(payload: { title: string; body: string; channelId?: string; silent?: boolean }): void {
  if (localStorage.getItem('nimbus.notifications') === 'off') return;
  if (bridge) {
    bridge.notify(payload);
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(payload.title, { body: payload.body });
  } else if (Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

export function setBadge(count: number): void {
  bridge?.setBadge(count);
}

export function flashWindow(): void {
  if (localStorage.getItem('nimbus.flash') === 'off') return;
  bridge?.flash();
}

export function minimizeWindow(): void {
  bridge?.window.minimize();
}

export function toggleMaximizeWindow(): void {
  bridge?.window.maximize();
}

export function closeWindow(): void {
  bridge?.window.close();
}

export function onWindowState(cb: (state: { maximized: boolean; focused: boolean }) => void): () => void {
  return bridge?.window.onState(cb) ?? (() => {});
}
