// Electron main process: window, menu, app:// protocol and native file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

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

app.whenReady().then(() => {
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
