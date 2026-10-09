const { app, BrowserWindow, ipcMain, dialog, shell, protocol, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const { Store } = require('./store');
const { detectSources } = require('./detect');
const { Library } = require('./library');
const { exportClip } = require('./ffmpeg');
const streamable = require('./streamable');

protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win;
let config;
let library;
let watchers = [];
let sessionPassword = null; // used when the OS can't encrypt the saved one
const servable = new Set(); // exported files the player may also read

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg' };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Serves clips and thumbnails to the renderer with byte-range support so the
// <video> element can seek. Only files the library knows about are readable.
function serveFile(file, range) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return new Response('not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), end);
    } else {
      start = Math.max(0, stat.size - Number(m[2]));
    }
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    status = 206;
  }
  const headers = { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  if (stat.size === 0) return new Response(null, { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
}

function registerProtocol(thumbDir) {
  protocol.handle('clip', (req) => {
    const url = new URL(req.url);
    if (url.hostname === 'thumb') {
      return serveFile(path.join(thumbDir, path.basename(decodeURIComponent(url.pathname))), null);
    }
    if (url.hostname === 'file') {
      const file = url.searchParams.get('p') || '';
      if (!library.has(file) && !servable.has(file)) return new Response('forbidden', { status: 403 });
      return serveFile(file, req.headers.get('range'));
    }
    return new Response('not found', { status: 404 });
  });
}

function exportDir() {
  return path.join(app.getPath('videos'), 'ClipDeck Exports');
}

function watch(sources) {
  for (const w of watchers) w.close();
  watchers = [];
  let timer;
  for (const s of sources.filter((x) => x.exists)) {
    try {
      const w = fs.watch(s.path, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => send('library:changed'), 2500);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // folder can't be watched; manual rescan still works
    }
  }
}

async function scan() {
  const sources = await detectSources(app.getPath('videos'), config.get('folders'));
  const clips = await library.scan(sources);
  watch(sources);
  const uploads = config.get('uploads');
  return {
    sources,
    clips: clips.map((c) => ({ ...c, upload: uploads[c.path.toLowerCase()] || null })),
  };
}

function getPassword() {
  if (sessionPassword) return sessionPassword;
  const enc = config.get('streamablePass');
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

// Puts the file itself on the clipboard so it can be pasted into Discord,
// a browser upload dialog, Explorer, etc.
function copyFileToClipboard(file) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:CLIPDECK_FILE'],
      { windowsHide: true, env: { ...process.env, CLIPDECK_FILE: file } },
      (err) => (err ? reject(new Error('Could not copy the file to the clipboard.')) : resolve())
    );
  });
}

function clipFor(file) {
  const clip = library.get(file);
  if (!clip) throw new Error('That clip is no longer in the library. Rescan and try again.');
  if (!clip.meta) throw new Error('Still reading this clip. Try again in a moment.');
  return clip;
}

function registerIpc() {
  ipcMain.handle('library:scan', () => scan());

  ipcMain.handle('folders:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add a clips folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return false;
    const folders = config.get('folders');
    if (!folders.some((f) => f.toLowerCase() === r.filePaths[0].toLowerCase())) {
      config.set('folders', [...folders, r.filePaths[0]]);
    }
    return true;
  });

  ipcMain.handle('folders:remove', (_e, folder) => {
    config.set('folders', config.get('folders').filter((f) => path.normalize(f).toLowerCase() !== String(folder).toLowerCase()));
    return true;
  });

  ipcMain.handle('settings:get', () => ({
    email: config.get('streamableEmail') || '',
    hasPassword: Boolean(getPassword()),
    canSavePassword: safeStorage.isEncryptionAvailable(),
    exportDir: exportDir(),
    limitMB: streamable.LIMIT_MB,
    limitSeconds: streamable.LIMIT_SECONDS,
  }));

  ipcMain.handle('settings:set', (_e, { email, password }) => {
    config.set('streamableEmail', String(email || '').trim());
    if (password) {
      if (safeStorage.isEncryptionAvailable()) {
        config.set('streamablePass', safeStorage.encryptString(password).toString('base64'));
        sessionPassword = null;
      } else {
        sessionPassword = password;
      }
    }
    return true;
  });

  ipcMain.handle('settings:forget', () => {
    config.set('streamableEmail', '');
    config.set('streamablePass', '');
    sessionPassword = null;
    return true;
  });

  ipcMain.handle('clip:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('clip:copyFile', (_e, file) => copyFileToClipboard(clipFor(file).path));
  ipcMain.handle('clip:trash', async (_e, file) => {
    await shell.trashItem(clipFor(file).path);
    return true;
  });
  ipcMain.handle('text:copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('link:open', (_e, url) => {
    if (/^https:\/\/(streamable\.com|www\.youtube\.com|youtu\.be)\//.test(url)) return shell.openExternal(url);
    return false;
  });

  // Trim and/or compress into the exports folder, then copy the file to the
  // clipboard ready to paste.
  ipcMain.handle('export:run', async (_e, { jobId, file, start, end, targetMB }) => {
    const clip = clipFor(file);
    const progress = (pct) => send('job:progress', { jobId, stage: targetMB ? 'Compressing' : 'Trimming', pct });
    const out = await exportClip(
      { src: clip.path, start, end, targetMB, outDir: exportDir(), label: targetMB ? `${targetMB}MB` : 'trim', meta: clip.meta, srcSize: clip.size },
      progress
    );
    servable.add(out.path);
    await copyFileToClipboard(out.path).catch(() => {});
    return out;
  });

  ipcMain.handle('upload:streamable', async (_e, { jobId, file, start, end }) => {
    const clip = clipFor(file);
    const email = config.get('streamableEmail');
    const password = getPassword();
    if (!email || !password) throw new Error('NEEDS_LOGIN');
    const dur = end - start;
    if (dur > streamable.LIMIT_SECONDS) {
      throw new Error(`Streamable's free plan allows ${streamable.LIMIT_SECONDS / 60} minutes per video. Trim the clip first.`);
    }

    const whole = start < 0.05 && end > clip.meta.duration - 0.05;
    const fitsAsIs = whole && clip.size <= streamable.LIMIT_MB * 1048576 && clip.meta.audioTracks <= 1 && /\.mp4$/i.test(clip.path);
    let upFile = clip.path;
    let temp = null;
    if (!fitsAsIs) {
      const out = await exportClip(
        { src: clip.path, start, end, targetMB: streamable.LIMIT_MB, outDir: path.join(app.getPath('temp'), 'ClipDeck'), label: 'upload', meta: clip.meta, srcSize: clip.size },
        (pct) => send('job:progress', { jobId, stage: 'Preparing', pct })
      );
      upFile = temp = out.path;
    }
    try {
      const res = await streamable.upload({ file: upFile, email, password, title: clip.name }, (pct) =>
        send('job:progress', { jobId, stage: 'Uploading', pct })
      );
      const upload = { url: res.url, at: Date.now() };
      config.set('uploads', { ...config.get('uploads'), [clip.path.toLowerCase()]: upload });
      clipboard.writeText(res.url);
      return upload;
    } finally {
      if (temp) fs.rm(temp, { force: true }, () => {});
    }
  });

  // YouTube forces API uploads from unaudited apps to private, so we hand
  // off instead: prepare the file, put it on the clipboard, open the uploader.
  ipcMain.handle('upload:youtube', async (_e, { jobId, file, start, end }) => {
    const clip = clipFor(file);
    const whole = start < 0.05 && end > clip.meta.duration - 0.05;
    let target = clip.path;
    if (!whole || clip.meta.audioTracks > 1) {
      const out = await exportClip(
        { src: clip.path, start, end, targetMB: 0, outDir: exportDir(), label: 'youtube', meta: clip.meta, srcSize: clip.size },
        (pct) => send('job:progress', { jobId, stage: 'Preparing', pct })
      );
      servable.add(out.path);
      target = out.path;
    }
    await copyFileToClipboard(target).catch(() => {});
    shell.showItemInFolder(target);
    await shell.openExternal('https://www.youtube.com/upload');
    return { path: target };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0d11',
    autoHideMenuBar: true,
    title: 'ClipDeck',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // CLIPDECK_SMOKE=<dir> captures screenshots of the library and player, then quits.
  const smoke = process.env.CLIPDECK_SMOKE;
  if (smoke) {
    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const shot = async (name) => fs.writeFileSync(path.join(smoke, name), (await win.webContents.capturePage()).toPNG());
      await wait(Number(process.env.CLIPDECK_SMOKE_WAIT) || 9000);
      await shot('library.png');
      await win.webContents.executeJavaScript("document.querySelector('.card') && document.querySelector('.card').click()");
      await wait(3000);
      await shot('player.png');
      const state = await win.webContents.executeJavaScript(
        "JSON.stringify({cards: document.querySelectorAll('.card').length, thumbs: document.querySelectorAll('.card img').length, video: (()=>{const v=document.querySelector('video');return v?{ready:v.readyState,dur:v.duration,err:v.error&&v.error.message}:null})()})"
      );
      console.log('SMOKE ' + state);
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = new Store(userData, 'config.json', { folders: [], uploads: {}, streamableEmail: '', streamablePass: '' });
  const metaStore = new Store(userData, 'meta.json', {});
  const thumbDir = path.join(userData, 'thumbs');
  library = new Library({ thumbDir, metaStore, onUpdate: (u) => send('clip:update', u) });
  registerProtocol(thumbDir);
  registerIpc();
  createWindow();
  app.on('before-quit', () => {
    config.flush();
    metaStore.flush();
  });
});

app.on('window-all-closed', () => app.quit());
