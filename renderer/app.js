const api = window.clipdeck;
const $ = (id) => document.getElementById(id);

const state = {
  clips: [],
  sources: [],
  game: null,
  query: '',
  sort: 'new',
  current: null,
  duration: 0,
  trim: [0, 0],
  busy: false,
  jobId: null,
};
const cards = new Map(); // clip path -> card element

/* ---------- formatting ---------- */

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtSize(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toast(message) {
  const t = el('div', 'toast', message);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

function errorText(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/* ---------- library ---------- */

function visibleClips() {
  const q = state.query.toLowerCase();
  const list = state.clips.filter(
    (c) => (!state.game || c.game === state.game) && (!q || c.name.toLowerCase().includes(q) || c.game.toLowerCase().includes(q))
  );
  const by = {
    new: (a, b) => b.mtime - a.mtime,
    old: (a, b) => a.mtime - b.mtime,
    big: (a, b) => b.size - a.size,
    long: (a, b) => ((b.meta && b.meta.duration) || 0) - ((a.meta && a.meta.duration) || 0),
  };
  return list.sort(by[state.sort]);
}

function fillCard(card, clip) {
  const thumb = card.querySelector('.thumb');
  thumb.replaceChildren();
  if (clip.thumb) {
    const img = el('img');
    img.src = clip.thumb;
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  }
  if (clip.meta) thumb.append(el('span', 'badge dur', fmtDur(clip.meta.duration)));
  if (clip.upload) thumb.append(el('span', 'badge shared', 'Shared'));
}

function renderGrid() {
  const list = visibleClips();
  const grid = $('grid');
  cards.clear();
  grid.replaceChildren(
    ...list.map((clip) => {
      const card = el('button', 'card');
      card.append(el('div', 'thumb'));
      const body = el('div', 'card-body');
      body.append(el('div', 'card-title', clip.name), el('div', 'card-sub', `${clip.game} · ${fmtDate(clip.mtime)} · ${fmtSize(clip.size)}`));
      card.append(body);
      fillCard(card, clip);
      card.addEventListener('click', () => openPlayer(clip));
      cards.set(clip.path, card);
      return card;
    })
  );
  const none = state.clips.length === 0;
  grid.hidden = none;
  $('empty').hidden = !none;
  $('heading').textContent = `${state.game || 'All clips'} (${list.length})`;
}

function renderSidebar() {
  const counts = new Map();
  for (const c of state.clips) counts.set(c.game, (counts.get(c.game) || 0) + 1);
  if (state.game && !counts.has(state.game)) state.game = null;
  const entries = [[null, state.clips.length], ...[...counts.entries()].sort((a, b) => b[1] - a[1])];
  $('games').replaceChildren(
    ...entries.map(([game, count]) => {
      const b = el('button', 'game' + (game === state.game ? ' active' : ''));
      b.append(el('span', null, game || 'All clips'), el('span', 'count', String(count)));
      b.addEventListener('click', () => {
        state.game = game;
        renderSidebar();
        renderGrid();
      });
      return b;
    })
  );
  const found = state.sources.filter((s) => s.exists);
  $('sourcesSummary').textContent = `Watching ${found.length} folder${found.length === 1 ? '' : 's'}`;
  $('emptyText').textContent = `Checked ${state.sources.length} known locations (NVIDIA, Xbox Game Bar, AMD, Medal, Outplayed, Videos) and found no video files. Record a clip, or point ClipDeck at the folder your recorder saves to.`;
}

function renderSources() {
  $('sourceList').replaceChildren(
    ...state.sources.map((s) => {
      const li = el('li');
      const info = el('div');
      info.append(el('div', null, `${s.label}${s.exists ? ` · ${s.count} clip${s.count === 1 ? '' : 's'}` : ' · not found on this PC'}`), el('div', 'source-path', s.path));
      li.append(el('span', 'dot' + (s.exists ? ' on' : '')), info);
      if (s.kind === 'user') {
        const rm = el('button', 'btn ghost small', 'Remove');
        rm.addEventListener('click', async () => {
          await api.removeFolder(s.path);
          await rescan();
        });
        li.append(rm);
      } else {
        li.append(el('span'));
      }
      return li;
    })
  );
}

async function rescan() {
  const result = await api.scan();
  state.clips = result.clips;
  state.sources = result.sources;
  if (state.current) state.current = state.clips.find((c) => c.path === state.current.path) || state.current;
  renderSidebar();
  renderGrid();
  renderSources();
}

/* ---------- player ---------- */

const video = $('video');

function renderTrim() {
  const d = state.duration || 1;
  const [a, b] = state.trim;
  $('trimRange').style.left = `${(a / d) * 100}%`;
  $('trimRange').style.width = `${((b - a) / d) * 100}%`;
  $('trimStart').style.left = `${(a / d) * 100}%`;
  $('trimEnd').style.left = `${(b / d) * 100}%`;
  const whole = a < 0.05 && b > d - 0.05;
  $('trimLabel').textContent = whole ? `Whole clip · ${fmtDur(d)}` : `${fmtDur(a)} to ${fmtDur(b)} · ${fmtDur(b - a)} selected`;
  $('saveTrim').disabled = state.busy || whole;
}

function setTrim(edge, t) {
  const d = state.duration;
  const gap = Math.min(1, d / 2);
  if (edge === 0) state.trim[0] = Math.max(0, Math.min(t, state.trim[1] - gap));
  else state.trim[1] = Math.min(d, Math.max(t, state.trim[0] + gap));
  renderTrim();
}

function setDuration(d) {
  if (!d || !isFinite(d) || Math.abs(d - state.duration) < 0.01) return;
  state.duration = d;
  state.trim = [0, d];
  renderTrim();
}

function showLink(upload) {
  $('linkRow').hidden = !upload;
  if (upload) $('linkUrl').textContent = upload.url;
}

function setStatus(kind, text, pct) {
  const s = $('status');
  s.hidden = !kind;
  s.className = 'status' + (kind && kind !== 'run' ? ' ' + kind : '');
  $('statusText').textContent = text || '';
  if (pct != null) $('barFill').style.width = `${Math.round(pct * 100)}%`;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['upStreamable', 'discord', 'upYouTube', 'saveTrim', 'copyFile', 'trash', 'discordSize']) $(id).disabled = busy;
  renderTrim();
}

function openPlayer(clip) {
  state.current = clip;
  state.duration = 0;
  state.trim = [0, 0];
  $('clipTitle').textContent = clip.name;
  const m = clip.meta;
  $('clipMeta').textContent = [clip.game, fmtDate(clip.mtime), m && `${m.width}×${m.height}${m.fps ? ` ${m.fps}fps` : ''}`, fmtSize(clip.size)].filter(Boolean).join(' · ');
  $('videoNote').hidden = true;
  showLink(clip.upload);
  setStatus(null);
  setBusy(false);
  if (m) setDuration(m.duration);
  video.src = `clip://file/?p=${encodeURIComponent(clip.path)}`;
  $('player').showModal();
  video.play().catch(() => {});
}

function closePlayer() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.current = null;
  if ($('player').open) $('player').close();
}

video.addEventListener('loadedmetadata', () => setDuration(video.duration));
video.addEventListener('timeupdate', () => {
  const d = state.duration || 1;
  $('trimHead').style.left = `${(video.currentTime / d) * 100}%`;
  const [a, b] = state.trim;
  // loop the selection while previewing a trim
  if (b < d - 0.05 && video.currentTime >= b && !video.paused) video.currentTime = a;
});
video.addEventListener('error', () => {
  if (!state.current) return;
  const codec = state.current.meta && state.current.meta.codec;
  $('videoNote').textContent = `This clip${codec ? ` (${codec})` : ''} can't be previewed here, but trimming and sharing still work.`;
  $('videoNote').hidden = false;
});

// Trim bar: drag a handle to move it, click the track to seek.
const trimBar = $('trim');
let dragEdge = null;
const timeAt = (ev) => {
  const r = trimBar.getBoundingClientRect();
  return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * state.duration;
};
trimBar.addEventListener('pointerdown', (ev) => {
  if (!state.duration) return;
  trimBar.setPointerCapture(ev.pointerId);
  dragEdge = ev.target.dataset.edge != null ? Number(ev.target.dataset.edge) : null;
  const t = timeAt(ev);
  if (dragEdge == null) video.currentTime = t;
});
trimBar.addEventListener('pointermove', (ev) => {
  if (!trimBar.hasPointerCapture(ev.pointerId)) return;
  const t = timeAt(ev);
  if (dragEdge == null) video.currentTime = t;
  else {
    setTrim(dragEdge, t);
    video.currentTime = state.trim[dragEdge];
  }
});
trimBar.addEventListener('pointerup', () => (dragEdge = null));

$('setStart').addEventListener('click', () => setTrim(0, video.currentTime));
$('setEnd').addEventListener('click', () => setTrim(1, video.currentTime));
$('trimReset').addEventListener('click', () => {
  state.trim = [0, state.duration];
  renderTrim();
});

$('player').addEventListener('keydown', (ev) => {
  if (ev.target.matches('select, input')) return;
  if (ev.key === 'i' || ev.key === 'I') setTrim(0, video.currentTime);
  else if (ev.key === 'o' || ev.key === 'O') setTrim(1, video.currentTime);
  else if (ev.key === 'ArrowLeft' && ev.target !== video) video.currentTime -= 5;
  else if (ev.key === 'ArrowRight' && ev.target !== video) video.currentTime += 5;
});
$('player').addEventListener('close', closePlayer);
$('player').addEventListener('cancel', (ev) => state.busy && ev.preventDefault());
$('closePlayer').addEventListener('click', () => !state.busy && closePlayer());

/* ---------- share actions ---------- */

async function runJob(startText, fn, doneText) {
  if (state.busy || !state.current) return;
  const clip = state.current;
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.jobId = jobId;
  setBusy(true);
  setStatus('run', startText, 0);
  try {
    const [start, end] = state.trim;
    const result = await fn({ jobId, file: clip.path, start, end }, clip);
    const text = doneText(result);
    setStatus('done', text);
    toast(text);
  } catch (err) {
    const msg = errorText(err);
    if (msg === 'NEEDS_LOGIN') {
      setStatus(null);
      openSettings('Sign in to Streamable once to upload. A free account works.');
    } else {
      setStatus('error', msg);
    }
  } finally {
    state.jobId = null;
    setBusy(false);
  }
}

api.onJobProgress(({ jobId, stage, pct }) => {
  if (jobId === state.jobId) setStatus('run', `${stage}… ${Math.round(pct * 100)}%`, pct);
});

$('upStreamable').addEventListener('click', () =>
  runJob(
    'Preparing…',
    async (job, clip) => {
      const upload = await api.uploadStreamable(job);
      clip.upload = upload;
      showLink(upload);
      const card = cards.get(clip.path);
      if (card) fillCard(card, clip);
      return upload;
    },
    () => 'Link copied. Paste it in Discord and it plays right in the chat.'
  )
);

$('discord').addEventListener('click', () => {
  const targetMB = Number($('discordSize').value);
  runJob(
    'Compressing…',
    (job) => api.exportClip({ ...job, targetMB }),
    (out) => `${fmtSize(out.size)} file copied. Press Ctrl+V in Discord to attach it.`
  );
});

$('upYouTube').addEventListener('click', () =>
  runJob('Preparing…', api.uploadYouTube, () => 'YouTube upload opened in your browser. Drag the highlighted file from the folder window onto the page.')
);

$('saveTrim').addEventListener('click', () =>
  runJob(
    'Trimming…',
    (job) => api.exportClip({ ...job, targetMB: 0 }),
    (out) => `Saved ${fmtSize(out.size)} trimmed copy to ClipDeck Exports and copied the file.`
  )
);

$('copyFile').addEventListener('click', async () => {
  try {
    await api.copyFile(state.current.path);
    toast('File copied. Paste it anywhere.');
  } catch (err) {
    setStatus('error', errorText(err));
  }
});

$('reveal').addEventListener('click', () => api.reveal(state.current.path));

$('trash').addEventListener('click', async () => {
  const clip = state.current;
  if (!confirm(`Move "${clip.name}" to the Recycle Bin?`)) return;
  try {
    closePlayer();
    await api.trash(clip.path);
    toast('Moved to the Recycle Bin.');
    await rescan();
  } catch (err) {
    toast(errorText(err));
  }
});

$('linkCopy').addEventListener('click', async () => {
  await api.copyText($('linkUrl').textContent);
  toast('Link copied.');
});
$('linkUrl').addEventListener('click', (ev) => {
  ev.preventDefault();
  api.openLink($('linkUrl').textContent);
});

/* ---------- settings ---------- */

async function openSettings(notice) {
  const s = await api.getSettings();
  $('stEmail').value = s.email;
  $('stPass').value = '';
  $('stPass').placeholder = s.hasPassword ? 'Saved. Leave blank to keep it' : '';
  $('streamableNote').textContent =
    `Free accounts: up to ${s.limitMB} MB and ${s.limitSeconds / 60} minutes per video, and Streamable deletes free videos after about 90 days. ` +
    `Longer or larger selections are compressed to fit before upload. ` +
    (s.canSavePassword ? 'Your password is stored encrypted by Windows on this PC only.' : 'This PC cannot encrypt saved passwords, so it is kept only until you close the app.');
  $('exportNote').textContent = `Trimmed and compressed copies are saved to ${s.exportDir}`;
  $('loginNotice').hidden = !notice;
  $('loginNotice').textContent = notice || '';
  renderSources();
  if (!$('settings').open) $('settings').showModal();
}

$('openSettings').addEventListener('click', () => openSettings());
$('closeSettings').addEventListener('click', () => $('settings').close());
$('saveLogin').addEventListener('click', async () => {
  await api.setSettings({ email: $('stEmail').value, password: $('stPass').value });
  toast('Streamable login saved.');
  $('settings').close();
});
$('forgetLogin').addEventListener('click', async () => {
  await api.forgetLogin();
  toast('Streamable login removed.');
  openSettings();
});

async function addFolder() {
  if (await api.addFolder()) await rescan();
}
$('addFolder').addEventListener('click', addFolder);
$('emptyAdd').addEventListener('click', addFolder);

/* ---------- toolbar + live updates ---------- */

$('search').addEventListener('input', (ev) => {
  state.query = ev.target.value;
  renderGrid();
});
$('sort').addEventListener('change', (ev) => {
  state.sort = ev.target.value;
  renderGrid();
});
$('rescan').addEventListener('click', async () => {
  await rescan();
  toast(`Found ${state.clips.length} clip${state.clips.length === 1 ? '' : 's'}.`);
});

api.onClipUpdate(({ path, meta, thumb }) => {
  const clip = state.clips.find((c) => c.path === path);
  if (!clip) return;
  clip.meta = meta;
  clip.thumb = thumb;
  const card = cards.get(path);
  if (card) fillCard(card, clip);
});

api.onLibraryChanged(() => rescan());

rescan();
