const { app, BrowserWindow, ipcMain, dialog, shell, protocol, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const { Store } = require('./store');
const { detectSources } = require('./detect');
const { Library } = require('./library');
const { exportClip, makeReel, hasFx } = require('./ffmpeg');
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
const pickedMusic = new Set(); // audio files the user chose through the picker

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg' };
const REEL_DEFAULT_SECONDS = 15; // untrimmed clips contribute their final seconds, where the action usually is

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
  return path.join(app.getPath('videos'), 'ReplayStrike');
}

function tempDir() {
  return path.join(app.getPath('temp'), 'ReplayStrike');
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
  const edits = config.get('edits');
  return {
    sources,
    clips: clips.map((c) => {
      const id = c.path.toLowerCase();
      return { ...c, upload: uploads[id] || null, edit: edits[id] || null };
    }),
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
      ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:REPLAYSTRIKE_FILE'],
      { windowsHide: true, env: { ...process.env, REPLAYSTRIKE_FILE: file } },
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

// Effects arrive from the renderer; music must be a file the user picked.
function cleanFx(fx) {
  if (!fx) return null;
  return { ...fx, uniform: false, music: pickedMusic.has(fx.music) ? fx.music : null };
}

function isWhole(clip, start, end) {
  return start < 0.05 && end > clip.meta.duration - 0.05;
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

  ipcMain.handle('music:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a music track',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    pickedMusic.add(r.filePaths[0]);
    return { path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
  });

  ipcMain.handle('settings:get', () => ({
    email: config.get('streamableEmail') || '',
    hasPassword: Boolean(getPassword()),
    canSavePassword: safeStorage.isEncryptionAvailable(),
    exportDir: exportDir(),
    limitMB: streamable.LIMIT_MB,
    limitSeconds: streamable.LIMIT_SECONDS,
    reelSeconds: REEL_DEFAULT_SECONDS,
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

  // Remembers each clip's trim and slow-mo moment between sessions.
  ipcMain.handle('edit:save', (_e, { file, trim, moment }) => {
    const edits = { ...config.get('edits') };
    const id = String(file).toLowerCase();
    if (trim || moment != null) edits[id] = { trim: trim || null, moment: moment == null ? null : moment };
    else delete edits[id];
    config.set('edits', edits);
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

  // Renders the selection (trim + effects, optionally to a size limit) into
  // the exports folder and copies the file to the clipboard ready to paste.
  ipcMain.handle('export:run', async (_e, { jobId, file, start, end, targetMB, fx }) => {
    const clip = clipFor(file);
    const clean = cleanFx(fx);
    const stage = targetMB || hasFx(clean) ? 'Rendering' : 'Trimming';
    const out = await exportClip(
      { src: clip.path, start, end, targetMB, outDir: exportDir(), label: targetMB ? `${targetMB}MB` : 'edit', meta: clip.meta, srcSize: clip.size, fx: clean },
      (pct) => send('job:progress', { jobId, stage, pct })
    );
    servable.add(out.path);
    await copyFileToClipboard(out.path).catch(() => {});
    return out;
  });

  ipcMain.handle('upload:streamable', async (_e, { jobId, file, start, end, fx }) => {
    const clip = clipFor(file);
    const clean = cleanFx(fx);
    const email = config.get('streamableEmail');
    const password = getPassword();
    if (!email || !password) throw new Error('NEEDS_LOGIN');
    if (end - start > streamable.LIMIT_SECONDS) {
      throw new Error(`Streamable's free plan allows ${streamable.LIMIT_SECONDS / 60} minutes per video. Trim the clip first.`);
    }

    const fitsAsIs =
      isWhole(clip, start, end) && !hasFx(clean) && clip.size <= streamable.LIMIT_MB * 1048576 && clip.meta.audioTracks <= 1 && /\.mp4$/i.test(clip.path);
    let upFile = clip.path;
    let temp = null;
    if (!fitsAsIs) {
      const out = await exportClip(
        { src: clip.path, start, end, targetMB: streamable.LIMIT_MB, outDir: tempDir(), label: 'upload', meta: clip.meta, srcSize: clip.size, fx: clean },
        (pct) => send('job:progress', { jobId, stage: 'Rendering', pct })
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
  ipcMain.handle('upload:youtube', async (_e, { jobId, file, start, end, fx }) => {
    const clip = clipFor(file);
    const clean = cleanFx(fx);
    let target = clip.path;
    if (!isWhole(clip, start, end) || hasFx(clean) || clip.meta.audioTracks > 1) {
      const out = await exportClip(
        { src: clip.path, start, end, targetMB: 0, outDir: exportDir(), label: 'youtube', meta: clip.meta, srcSize: clip.size, fx: clean },
        (pct) => send('job:progress', { jobId, stage: 'Rendering', pct })
      );
      servable.add(out.path);
      target = out.path;
    }
    await copyFileToClipboard(target).catch(() => {});
    shell.showItemInFolder(target);
    await shell.openExternal('https://www.youtube.com/upload');
    return { path: target };
  });

  // Joins several clips into one highlight reel. Each clip contributes its
  // saved trim, or its last few seconds if it has never been trimmed.
  ipcMain.handle('reel:run', async (_e, { jobId, files, fx }) => {
    if (!Array.isArray(files) || files.length < 2) throw new Error('Pick at least two clips for a reel.');
    const edits = config.get('edits');
    const segments = files.map((file) => {
      const clip = clipFor(file);
      const edit = edits[clip.path.toLowerCase()] || {};
      const d = clip.meta.duration;
      const [start, end] = edit.trim || [Math.max(0, d - REEL_DEFAULT_SECONDS), d];
      return { src: clip.path, start, end, meta: clip.meta, srcSize: clip.size, moment: edit.moment == null ? null : edit.moment };
    });
    const out = await makeReel(
      { segments, fx: cleanFx(fx), outDir: exportDir(), tmpDir: path.join(tempDir(), `reel-${Date.now()}`) },
      (pct) => send('job:progress', { jobId, stage: 'Building reel', pct })
    );
    servable.add(out.path);
    return out;
  });
}

function createWindow() {
  const icon = path.join(__dirname, '..', 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0c10',
    title: 'ReplayStrike',
    icon: fs.existsSync(icon) ? icon : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0c10', symbolColor: '#e9ebf1', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // REPLAYSTRIKE_SMOKE=<dir> captures screenshots of the main screens, then quits.
  const smoke = process.env.REPLAYSTRIKE_SMOKE;
  if (smoke) {
    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const js = (code) => win.webContents.executeJavaScript(code);
      const shot = async (name) => fs.writeFileSync(path.join(smoke, name), (await win.webContents.capturePage()).toPNG());
      await wait(Number(process.env.REPLAYSTRIKE_SMOKE_WAIT) || 9000);
      await shot('library.png');
      await js("document.querySelectorAll('.pick').forEach((p, i) => i < 3 && p.click())");
      await wait(400);
      await shot('selection.png');
      await js("document.getElementById('makeReel').click()");
      await wait(500);
      await shot('reel.png');
      await js("document.getElementById('reel').close(); document.getElementById('clearSel').click(); document.querySelector('.card').click()");
      await wait(3000);
      await shot('player.png');
      await js(
        "document.querySelector('#styleChips [data-value=cinematic]').click(); document.getElementById('fxTitle').value='Clutch round'; document.getElementById('fxTitle').dispatchEvent(new Event('input')); document.getElementById('video').currentTime = 1; document.getElementById('fxMoment').click()"
      );
      await wait(1200);
      await shot('player-cinematic.png');
      await js("document.querySelector('#formatChips [data-value=vertical]').click()");
      await wait(600);
      await shot('player-vertical.png');
      const state = await js(
        "JSON.stringify({cards: document.querySelectorAll('.card').length, thumbs: document.querySelectorAll('.card img').length, video: (()=>{const v=document.querySelector('#video');return v?{ready:v.readyState,dur:v.duration,err:v.error&&v.error.message}:null})()})"
      );
      console.log('SMOKE ' + state);
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = new Store(userData, 'config.json', { folders: [], uploads: {}, edits: {}, streamableEmail: '', streamablePass: '' });
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
