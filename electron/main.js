// Electron main process: window, menu, app:// protocol and native file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const fsSync = require('fs');

const SRC = path.join(__dirname, '..', 'src');

// Serve the UI from app://local/ so ES modules and fetch() of fonts work.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win;

function createWindow() {
  win = new BrowserWindow({
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
