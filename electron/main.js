// Electron main process: window, menu, app:// protocol and native file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const fsSync = require('fs');
const os = require('os');
const dgram = require('dgram');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');

// Serve the UI from app://local/ so ES modules and fetch() of fonts work.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win;
let splash;
const SPLASH_MS = 3000;

// Frameless "Holmes" splash shown while the editor loads in the background.
function createSplash() {
  splash = new BrowserWindow({
    width: 520,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.loadURL('app://local/splash.html');
  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => (splash = null));
}

function createWindow() {
  const shownAt = Date.now();
  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#15171b',
    title: 'LaserCutX',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://local/index.html');
  // show the editor once it has loaded and the splash has had its moment
  win.once('ready-to-show', () => {
    setTimeout(() => {
      win.show();
      if (splash) splash.close();
    }, Math.max(0, SPLASH_MS - (Date.now() - shownAt)));
  });
  // open external links in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { type: 'separator' },
        { label: 'Export for laser…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { label: 'Bulk export (×6 on one sheet)…', accelerator: 'CmdOrCtrl+Shift+E', click: send('bulk') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo of the design itself is handled by the app; these keep
        // native text-field editing working.
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- the computer user's name (for the welcome screen) ----------
// Full name where the OS has one (macOS "Phoenix Holmes"), else the login name.
function userDisplayName() {
  let name = '';
  try {
    if (process.platform === 'darwin') name = execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 1500 }).trim();
    else if (process.platform === 'linux') name = (execFileSync('getent', ['passwd', os.userInfo().username], { encoding: 'utf8', timeout: 1500 }).split(':')[4] || '').split(',')[0].trim();
  } catch {
    /* fall back to the login name */
  }
  if (!name) {
    try {
      name = os.userInfo().username || '';
    } catch {
      name = process.env.USERNAME || process.env.USER || '';
    }
  }
  return name.trim();
}
const cachedUserName = userDisplayName();
ipcMain.on('user-name', (e) => (e.returnValue = cachedUserName));

// ---------- Ruida controllers over Ethernet (UDP) ----------
// Packets are prepared (swizzled + checksummed) by the page; this side only
// sends them and waits for the controller's one-byte acknowledgement.
const RUIDA_PORT = 50200;
const RUIDA_REPLY_PORT = 40200;

function ruidaSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.once('error', (err) =>
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? 'Port 40200 is busy – close LightBurn or RDWorks and try again.'
            : `Network error: ${err.message}`
        )
      )
    );
    sock.bind(RUIDA_REPLY_PORT, () => resolve(sock));
  });
}

// Sends one packet and resolves with the reply byte (still swizzled).
function sendAndWait(sock, host, pkt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.removeListener('message', onMsg);
      reject(new Error('timeout'));
    }, timeoutMs);
    const onMsg = (msg) => {
      clearTimeout(timer);
      sock.removeListener('message', onMsg);
      resolve(msg[0]);
    };
    sock.on('message', onMsg);
    sock.send(Buffer.from(pkt), RUIDA_PORT, host, (err) => {
      if (err) {
        clearTimeout(timer);
        sock.removeListener('message', onMsg);
        reject(err);
      }
    });
  });
}

let ruidaBusy = false;
let ruidaCancel = false;

// packets: Uint8Array[]; ack: the swizzled ACK byte to expect.
ipcMain.handle('ruida-udp-send', async (e, { host, packets, ack }) => {
  if (ruidaBusy) return { ok: false, error: 'A job is already being sent.' };
  ruidaBusy = true;
  ruidaCancel = false;
  let sock;
  try {
    sock = await ruidaSocket();
    for (let i = 0; i < packets.length; i++) {
      if (ruidaCancel) return { ok: false, error: 'Cancelled' };
      let tries = 0;
      for (;;) {
        let reply;
        try {
          reply = await sendAndWait(sock, host, packets[i], i === 0 ? 3000 : 4000);
        } catch (err) {
          if (err.message !== 'timeout') throw err;
          reply = null;
        }
        if (reply === ack) break;
        if (++tries >= 4) {
          throw new Error(
            reply === null
              ? `No answer from the laser at ${host}. Check the IP address, the network cable, and that the laser is switched on.`
              : `The laser rejected packet ${i + 1} (reply 0x${reply.toString(16)}).`
          );
        }
      }
      e.sender.send('ruida-progress', (i + 1) / packets.length);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    ruidaBusy = false;
    if (sock) sock.close();
  }
});

ipcMain.handle('ruida-udp-cancel', () => {
  ruidaCancel = true;
  return true;
});

// Quick "is it there?" check: one small packet, any reply counts.
ipcMain.handle('ruida-udp-ping', async (_e, { host, packet }) => {
  if (ruidaBusy) return { ok: false, error: 'Busy sending a job.' };
  let sock;
  try {
    sock = await ruidaSocket();
    const reply = await sendAndWait(sock, host, packet, 2000);
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, error: err.message === 'timeout' ? `No answer from ${host}.` : err.message };
  } finally {
    if (sock) sock.close();
  }
});

// ---------- secrets (Claude API key), encrypted by the OS keychain ----------
const secretFile = (name) => path.join(app.getPath('userData'), `${name.replace(/[^a-z0-9-]/gi, '')}.secret`);
ipcMain.handle('secret-get', (_e, name) => {
  try {
    const buf = fsSync.readFileSync(secretFile(name));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
});
ipcMain.handle('secret-set', (_e, name, value) => {
  const file = secretFile(name);
  if (!value) {
    fsSync.rmSync(file, { force: true });
    return true;
  }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  fsSync.writeFileSync(file, data, { mode: 0o600 });
  return true;
});

ipcMain.handle('save-file', async (_e, { name, data, filter }) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: filter ? [{ name: filter.name, extensions: filter.extensions }] : [],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

ipcMain.handle('save-files', async (_e, { files }) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the exported files',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  const written = [];
  for (const f of files) {
    const p = path.join(dir, path.basename(f.name));
    await fs.writeFile(p, Buffer.from(f.data));
    written.push(p);
  }
  return written;
});

// USB serial (GRBL lasers): let the page use Web Serial and pick the port
// with a simple native chooser.
function setupSerial() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');
  ses.on('select-serial-port', async (event, portList, _wc, callback) => {
    event.preventDefault();
    if (!portList.length) {
      await dialog.showMessageBox(win, { type: 'warning', message: 'No laser found', detail: 'Plug the laser in with USB, switch it on, and try again. On Windows you may need the CH340 driver.' });
      return callback('');
    }
    const labels = portList.map((p) => `${p.displayName || p.portName}${p.portName && p.displayName ? ` (${p.portName})` : ''}`);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: 'Choose your laser',
      detail: 'Select the USB port your laser is connected to.',
      buttons: [...labels, 'Cancel'],
      cancelId: labels.length,
    });
    callback(response < portList.length ? portList[response].portId : '');
  });
}

app.whenReady().then(() => {
  setupSerial();
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(SRC, decodeURIComponent(pathname)));
    if (!file.startsWith(SRC)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  buildMenu();
  createSplash();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
