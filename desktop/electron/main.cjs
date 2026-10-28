const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Notification,
  Menu,
  session,
  desktopCapturer,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = process.env.NIMBUS_DEV === '1';
const DEV_URL = process.env.NIMBUS_DEV_URL || 'http://127.0.0.1:5173';
const APP_ID = 'chat.nimbus.desktop';

app.setAppUserModelId(APP_ID);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {string | null} */
let pendingDeepLink = null;

/*
 * Screen sharing.
 *
 * `DesktopCapturerSource` objects cannot cross the context bridge, so the main
 * process keeps the real objects and hands the renderer only serialisable
 * metadata. When the renderer calls getDisplayMedia(), the handler below hands
 * Chromium the source the user picked in our own picker.
 */
/** @type {Map<string, Electron.DesktopCapturerSource>} */
const screenSources = new Map();
/** @type {Electron.DesktopCapturerSource | null} */
let pendingScreenSource = null;
/** @type {NodeJS.Timeout | null} */
let pendingScreenTimer = null;

function clearPendingScreenSource() {
  pendingScreenSource = null;
  if (pendingScreenTimer !== null) clearTimeout(pendingScreenTimer);
  pendingScreenTimer = null;
}

function isTrustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

function extractDeepLink(argv) {
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith('nimbus://')) ?? null;
}

function sendDeepLink(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:deeplink', url);
  } else {
    pendingDeepLink = url;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#1e1f22',
    title: 'Nimbus',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (pendingDeepLink) {
      sendDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  const emitState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused(),
    });
  };

  mainWindow.on('maximize', emitState);
  mainWindow.on('unmaximize', emitState);
  mainWindow.on('focus', emitState);
  mainWindow.on('blur', emitState);
  mainWindow.on('enter-full-screen', emitState);
  mainWindow.on('leave-full-screen', emitState);
  mainWindow.on('closed', () => {
    mainWindow = null;
    screenSources.clear();
    clearPendingScreenSource();
  });

  mainWindow.webContents.on('did-finish-load', emitState);

  // F12 / Ctrl+Shift+I opens devtools even though the app menu is removed.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isDevTools =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (isDevTools) {
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

Menu.setApplicationMenu(null);

/*
 * `--profile=<name>` gives this process its own userData directory, so a second
 * account can run next to the first one. The single-instance lock is scoped to
 * userData, which is exactly what we want here.
 */
const profileArg = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith('--profile='));
const profileName = profileArg ? profileArg.slice('--profile='.length).replace(/[^a-zA-Z0-9_-]/g, '') : '';
if (profileName) {
  app.setPath('userData', path.join(app.getPath('appData'), `nimbus-${profileName}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const link = extractDeepLink(argv);
    if (link) sendDeepLink(link);
  });

  app.whenReady().then(() => {
    // Deep links: nimbus://invite/<code>
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('nimbus', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('nimbus');
    }
    pendingDeepLink = extractDeepLink(process.argv);

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(
        permission === 'notifications' ||
          permission === 'clipboard-sanitized-write' ||
          // Voice calls need the microphone. Screen sharing is video-only and
          // goes through our own picker below. Nothing else (camera,
          // geolocation, …) is ever granted.
          permission === 'media' ||
          permission === 'audioCapture' ||
          permission === 'display-capture',
      );
    });

    // Electron asks for `media` for both audio and video, so narrow it down:
    // only microphone requests reach getUserMedia, and a camera request is
    // rejected before the OS prompt appears.
    session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      if (permission === 'notifications' || permission === 'clipboard-sanitized-write') return true;
      // `media` covers both microphone and camera; only audio is allowed.
      if (permission === 'media') return details?.mediaType !== 'video';
      if (permission === 'audioCapture') return true;
      if (permission === 'display-capture') return true;
      return false;
    });

    /*
     * Our own picker is the only way a screen source is chosen. If no source
     * was selected (or the selection went stale), deny instead of letting
     * Chromium fall back to an arbitrary screen.
     */
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      const source = pendingScreenSource;
      clearPendingScreenSource();
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source });
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  sendDeepLink(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------- IPC ---------------------------------- */

ipcMain.on('window:minimize', () => mainWindow?.minimize());

ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.on('notify', (_event, payload) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: String(payload?.title ?? 'Nimbus'),
    body: String(payload?.body ?? ''),
    silent: Boolean(payload?.silent),
  });
  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (payload?.channelId) mainWindow.webContents.send('app:open-channel', payload.channelId);
  });
  notification.show();
});

ipcMain.on('badge', (_event, count) => {
  try {
    app.setBadgeCount(Math.max(0, Number(count) || 0));
  } catch {
    /* not supported on this platform */
  }
});

ipcMain.on('flash', () => mainWindow?.flashFrame(true));

/* ------------------------------ screen share --------------------------- */

ipcMain.handle('screen:sources', async (event) => {
  if (!isTrustedSender(event)) return [];
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  screenSources.clear();
  const ordered = [...sources].sort((a, b) => {
    const screenA = a.id.startsWith('screen:') ? 0 : 1;
    const screenB = b.id.startsWith('screen:') ? 0 : 1;
    if (screenA !== screenB) return screenA - screenB;
    return a.name.localeCompare(b.name);
  });

  return ordered.map((source) => {
    screenSources.set(source.id, source);
    return {
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
      appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    };
  });
});

ipcMain.handle('screen:select', (event, sourceId) => {
  if (!isTrustedSender(event)) return false;
  const source = screenSources.get(String(sourceId));
  if (!source) return false;
  clearPendingScreenSource();
  pendingScreenSource = source;
  // A picker that is abandoned must not leave a usable source behind.
  pendingScreenTimer = setTimeout(clearPendingScreenSource, 20_000);
  return true;
});

ipcMain.handle('screen:cancel', (event) => {
  if (!isTrustedSender(event)) return;
  clearPendingScreenSource();
});

/* --------------------------- navigation guards ------------------------- */

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
});
