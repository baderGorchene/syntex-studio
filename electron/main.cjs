/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS entry for Electron's main process */
// Electron shell for the Windows desktop app: runs the Next standalone server on loopback
// in an Electron utility process and shows it in a locked-down window. Build it with scripts/desktop-prepare.mjs.
const { app, BrowserWindow, dialog, session, shell, utilityProcess } = require('electron');
const net = require('node:net');
const path = require('node:path');

const DEEP_LINK = /^synthex:\/\/connect\/?\?token=(sxd_[A-Za-z0-9_-]+)\/?$/;
const READY_TIMEOUT_MS = 30_000;
// Windows env lookups ignore case, so HTTPS_PROXY also picks up https_proxy.
const CHILD_ENV_KEYS = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];

let win = null;
let child = null;
let base = null; // http://127.0.0.1:<port> once the server answers
let pendingToken = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A dev checkout doesn't claim synthex:// (it would point the OS at node_modules/electron); the installed app does.
  if (app.isPackaged) app.setAsDefaultProtocolClient('synthex');
  app.on('second-instance', (_event, argv) => {
    handleDeepLink(argv.find((a) => a.startsWith('synthex://')));
    focusWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    if (child) child.kill();
  });
  process.on('exit', () => child && child.kill());
  handleDeepLink(process.argv.find((a) => a.startsWith('synthex://'))); // Windows passes the URL in argv on first launch
  app.whenReady().then(start).catch((err) => fatal(`Synthex Studio could not start.\n\n${err.message}`));
}

function cloudUrl() {
  if (process.env.SYNTHEX_CLOUD_URL) return process.env.SYNTHEX_CLOUD_URL;
  return require('./config.json').cloudUrl || '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function start() {
  const port = await freePort();
  const standalone = app.isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.join(__dirname, '..', '.next', 'standalone');
  const userData = app.getPath('userData');

  // Allowlist, not a denylist: nothing from the launching shell (Clerk, Neon, AI keys) reaches the server.
  const env = {};
  for (const key of CHILD_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1', // the desktop host check accepts 127.0.0.1/localhost on PORT only
    SYNTHEX_DESKTOP: '1',
    SYNTHEX_DATA_DIR: userData,
    SYNTHEX_UPLOAD_DIR: path.join(userData, 'uploads'),
    SYNTHEX_CLOUD_URL: cloudUrl(),
  });

  // A utility process is owned by Electron, so it dies with the app even on a hard crash.
  child = utilityProcess.fork(path.join(standalone, 'server.js'), [], {
    cwd: standalone,
    env,
    stdio: 'inherit',
    serviceName: 'Synthex Studio server',
  });
  child.on('exit', (code) => {
    child = null;
    if (!quitting) fatal(`The Synthex Studio server stopped unexpectedly (exit code ${code}).`);
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  base = url;
  console.log(`Synthex Studio server ready on ${url}`);

  // Deny every permission except clipboard writes, which the app's Copy buttons need (no clipboard reads).
  const allowed = (permission) => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Synthex Studio',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: 'deny' };
  });
  const stayOnOrigin = (event, target) => {
    if (sameOrigin(target)) return;
    event.preventDefault();
    openExternal(target);
  };
  win.webContents.on('will-navigate', stayOnOrigin);
  win.webContents.on('will-redirect', stayOnOrigin);
  win.on('closed', () => { win = null; });
  // A link that launched the app is posted before the page loads, so its first sync status already shows it.
  if (pendingToken) {
    const token = pendingToken;
    pendingToken = null;
    await connect(token);
  }
  await win.loadURL(`${base}/app`);
}

async function waitForServer(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/ai/status`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('The local server did not start within 30 seconds.');
}

function sameOrigin(target) {
  try {
    return new URL(target).origin === base;
  } catch {
    return false;
  }
}

function openExternal(target) {
  try {
    const { protocol } = new URL(target);
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(target);
  } catch {
    // not a URL: ignore
  }
}

// Only `synthex://connect?token=sxd_...` is accepted. Never log the URL or the token.
function handleDeepLink(url) {
  const match = url ? DEEP_LINK.exec(url) : null;
  if (!match) return;
  if (!base || !win) {
    pendingToken = match[1]; // picked up once the window is open
    return;
  }
  connect(match[1]);
}

// The server holds the token until the user confirms the account in the window (R19), which it asks on focus.
async function connect(token) {
  try {
    const res = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'connect', token }),
    });
    if (!res.ok) {
      dialog.showErrorBox('Synthex Studio', 'This desktop could not be connected. Open the connect link from the web app again.');
    }
  } catch {
    dialog.showErrorBox('Synthex Studio', 'This desktop could not be connected. Open the connect link from the web app again.');
  }
  focusWindow();
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function fatal(message) {
  if (quitting) return;
  quitting = true;
  dialog.showErrorBox('Synthex Studio', message);
  if (child) child.kill();
  app.quit();
}
