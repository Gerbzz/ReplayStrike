const api = window.replaystrike;
const $ = (id) => document.getElementById(id);

const STYLE_OPTIONS = [['none', 'Original'], ['cinematic', 'Cinematic'], ['vibrant', 'Vibrant'], ['noir', 'Noir']];
const FORMAT_OPTIONS = [['original', 'Landscape'], ['vertical', 'Vertical crop'], ['vertical-fit', 'Vertical fit'], ['square', 'Square']];
const SLOW_BEFORE = 0.6; // keep in step with src/ffmpeg.js
const SLOW_AFTER = 0.9;

const blankFx = () => ({ style: 'none', format: 'original', moment: null, title: '', fades: false, music: null, gameVol: 1 });

const state = {
  clips: [],
  sources: [],
  view: 'all', // 'all' (recordings) | 'edits' | 'shared' | 'game'
  game: null,
  query: '',
  sort: 'new',
  selected: [], // clip paths, in the order they were picked
  current: null,
  duration: 0,
  trim: [0, 0],
  fx: blankFx(),
  reelFx: blankFx(),
  reelMode: 'reel', // 'reel' (clips as trimmed) | 'montage' (best hype moments)
  montage: { count: 5 },
  hype: { engine: false, model: false, modelMB: 0 },
  analysis: null, // transcript + hype moments of the open clip
  busy: false,
  jobId: null,
  onProgress: null,
};
const cards = new Map(); // clip path -> card element

/* ---------- helpers ---------- */

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
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function dayGroup(ms) {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
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
  setTimeout(() => t.remove(), 4500);
}

function errorText(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const fileUrl = (file) => api.fileUrl(file);
const fxPayload = (fx) => ({ ...fx, music: fx.music ? fx.music.path : null });
const fxActive = (fx) => fx.style !== 'none' || fx.format !== 'original' || fx.moment != null || Boolean(fx.title.trim()) || fx.fades || Boolean(fx.music) || fx.gameVol !== 1;

// Renders a single-choice row of chips bound to fx[key].
function chipGroup(containerId, options, fx, key, onChange) {
  const box = $(containerId);
  const render = () => {
    box.replaceChildren(
      ...options.map(([value, label]) => {
        const b = el('button', 'chip' + (fx()[key] === value ? ' active' : ''), label);
        b.dataset.value = value;
        b.addEventListener('click', () => {
          fx()[key] = value;
          render();
          if (onChange) onChange();
        });
        return b;
      })
    );
  };
  render();
  return render;
}

/* ---------- library ---------- */

function visibleClips() {
  const q = state.query.trim().toLowerCase();
  const inView = {
    all: (c) => !c.mine,
    edits: (c) => c.mine,
    shared: (c) => Boolean(c.upload),
    game: (c) => !c.mine && c.game === state.game,
  }[state.view];
  const list = state.clips.filter((c) => inView(c) && (!q || c.name.toLowerCase().includes(q) || c.game.toLowerCase().includes(q)));
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
  if (clip.mine) thumb.append(el('span', 'badge kind', clip.kind));
}

const VIEW_NAMES = { all: 'All clips', edits: 'My edits', shared: 'Shared links' };
const VIEW_HINTS = {
  edits: 'Nothing here yet. Open a clip and use Save edited copy, Copy for Discord or Send to YouTube, or build a highlight reel. Everything you make shows up here.',
  shared: 'Nothing here yet. Clips you upload to Streamable show up here with their link.',
};

// Plays a muted preview on the card after a short hover.
function attachHoverPreview(card, clip) {
  let timer;
  let preview;
  const stop = () => {
    clearTimeout(timer);
    if (preview) preview.remove();
    preview = null;
  };
  card.addEventListener('mouseenter', () => {
    timer = setTimeout(() => {
      if (!clip.meta || $('player').open) return;
      preview = el('video');
      preview.muted = true;
      preview.loop = true;
      preview.src = `${fileUrl(clip.path)}#t=${Math.floor(clip.meta.duration * 0.3)}`;
      preview.addEventListener('error', stop);
      card.querySelector('.thumb').append(preview);
      preview.play().catch(() => {});
    }, 450);
  });
  card.addEventListener('mouseleave', stop);
  card.addEventListener('click', stop);
}

function toggleSelected(clip) {
  const i = state.selected.indexOf(clip.path);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(clip.path);
  renderSelection();
}

function renderSelection() {
  state.selected = state.selected.filter((p) => state.clips.some((c) => c.path === p));
  for (const [file, card] of cards) {
    const n = state.selected.indexOf(file);
    card.classList.toggle('selected', n >= 0);
    const pick = card.querySelector('.pick');
    pick.textContent = n >= 0 ? String(n + 1) : '';
    pick.setAttribute('aria-pressed', String(n >= 0));
  }
  const count = state.selected.length;
  $('grid').classList.toggle('picking', count > 0);
  $('selbar').hidden = count === 0;
  $('selCount').textContent = `${count} clip${count === 1 ? '' : 's'} selected`;
  $('makeReel').disabled = count < 2;
  $('makeMontage').hidden = !state.hype.engine;
}

function renderGrid() {
  const list = visibleClips();
  const grid = $('grid');
  const grouped = state.sort === 'new' || state.sort === 'old';
  const nodes = [];
  let lastGroup = null;
  cards.clear();
  for (const clip of list) {
    if (grouped) {
      const g = dayGroup(clip.mtime);
      if (g !== lastGroup) nodes.push(el('div', 'group', g));
      lastGroup = g;
    }
    const card = el('div', 'card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const pick = el('button', 'pick');
    pick.setAttribute('aria-label', `Select ${clip.name} for highlight reel`);
    pick.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleSelected(clip);
    });
    const body = el('div', 'card-body');
    const from = clip.mine && clip.game === 'My edits' ? [] : [clip.game];
    const hype = clip.hype ? [`${clip.hype} hype moment${clip.hype === 1 ? '' : 's'}`] : [];
    body.append(el('div', 'card-title', clip.name), el('div', 'card-sub', [...from, fmtDate(clip.mtime), fmtSize(clip.size), ...hype].join(' · ')));
    card.append(pick, el('div', 'thumb'), body);
    fillCard(card, clip);
    card.addEventListener('click', (ev) => (ev.ctrlKey || ev.shiftKey ? toggleSelected(clip) : openPlayer(clip)));
    card.addEventListener('keydown', (ev) => {
      if (ev.target === card && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        if (ev.ctrlKey || ev.shiftKey) toggleSelected(clip);
        else openPlayer(clip);
      }
    });
    attachHoverPreview(card, clip);
    cards.set(clip.path, card);
    nodes.push(card);
  }
  grid.replaceChildren(...nodes);
  const noLibrary = state.clips.length === 0;
  const noResults = !noLibrary && list.length === 0;
  grid.hidden = noLibrary || noResults;
  $('empty').hidden = !noLibrary;
  $('resultsEmpty').hidden = !noResults;
  if (noResults) {
    const searching = Boolean(state.query.trim());
    $('resultsHeading').textContent = searching
      ? 'No matching clips'
      : state.view === 'edits' ? 'No edited clips yet' : state.view === 'shared' ? 'No shared clips yet' : 'No original clips in this view';
    $('resultsText').textContent = searching
      ? `No clips in this view match “${state.query.trim()}”. Try another name or clear the search.`
      : VIEW_HINTS[state.view] || 'There are no clips in this view yet.';
    $('resultsAction').textContent = searching ? 'Clear search' : 'Browse all clips';
  }
  $('heading').textContent = `${state.view === 'game' ? state.game : VIEW_NAMES[state.view]} (${list.length})`;
  renderSelection();
}

function renderSidebar() {
  const recordings = state.clips.filter((c) => !c.mine);
  const counts = new Map();
  for (const c of recordings) counts.set(c.game, (counts.get(c.game) || 0) + 1);
  if (state.view === 'game' && !counts.has(state.game)) state.view = 'all';
  const item = (view, game, label, count) => {
    const b = el('button', 'game' + (state.view === view && (view !== 'game' || state.game === game) ? ' active' : ''));
    b.dataset.view = view;
    b.append(el('span', null, label), el('span', 'count', String(count)));
    b.addEventListener('click', () => {
      state.view = view;
      state.game = game;
      renderSidebar();
      renderGrid();
    });
    return b;
  };
  $('games').replaceChildren(
    item('all', null, VIEW_NAMES.all, recordings.length),
    item('edits', null, VIEW_NAMES.edits, state.clips.length - recordings.length),
    item('shared', null, VIEW_NAMES.shared, state.clips.filter((c) => c.upload).length),
    el('div', 'side-label', 'Games'),
    ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([game, count]) => item('game', game, game, count))
  );
  const found = state.sources.filter((s) => s.exists);
  $('sourcesSummary').textContent = `Watching ${found.length} folder${found.length === 1 ? '' : 's'} for new clips`;
  $('emptyText').textContent = `Checked ${state.sources.length} known locations (NVIDIA, Xbox Game Bar, AMD, Medal, Outplayed, Videos) and found no video files. Record a clip, or point ReplayStrike at the folder your recorder saves to.`;
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
const screen = $('screen');

function slowWindow() {
  const m = state.fx.moment;
  const [a, b] = state.trim;
  if (m == null || m < a || m > b) return null;
  return [Math.max(a, m - SLOW_BEFORE), Math.min(b, m + SLOW_AFTER)];
}

// Positions the preview overlays over the actual picture inside the letterboxed <video>.
function layoutFrame() {
  const sw = screen.clientWidth;
  const sh = screen.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(sw / vw, sh / vh);
  const w = vw * scale;
  const h = vh * scale;
  const frame = $('frame');
  Object.assign(frame.style, { left: `${(sw - w) / 2}px`, top: `${(sh - h) / 2}px`, width: `${w}px`, height: `${h}px` });

  const fx = state.fx;
  const visible = fx.format === 'vertical' ? Math.min(w, (h * 9) / 16) : fx.format === 'square' ? Math.min(w, h) : w;
  const mask = Math.max(0, (w - visible) / 2);
  $('maskL').style.width = $('maskR').style.width = `${mask}px`;
  $('maskL').style.display = $('maskR').style.display = mask ? '' : 'none';

  const letterbox = fx.style === 'cinematic' && fx.format === 'original';
  const title = $('titlePreview');
  title.textContent = fx.title.trim();
  Object.assign(title.style, {
    left: `${mask + visible * 0.05}px`,
    bottom: `${h * (letterbox ? 0.14 : 0.07)}px`,
    fontSize: `${Math.min(visible, h) / 12}px`,
  });
  screen.dataset.style = fx.style;
  screen.dataset.format = fx.format;
}

function renderTrim() {
  const d = state.duration || 1;
  const [a, b] = state.trim;
  $('trimRange').style.left = `${(a / d) * 100}%`;
  $('trimRange').style.width = `${((b - a) / d) * 100}%`;
  $('trimStart').style.left = `${(a / d) * 100}%`;
  $('trimEnd').style.left = `${(b / d) * 100}%`;
  const whole = a < 0.05 && b > d - 0.05;
  $('trimLabel').textContent = whole ? `Whole clip · ${fmtDur(d)}` : `${fmtDur(a)} to ${fmtDur(b)} · ${fmtDur(b - a)} selected`;
  $('saveEdit').disabled = state.busy || (whole && !fxActive(state.fx));

  const m = state.fx.moment;
  $('trimMoment').hidden = m == null;
  if (m != null) $('trimMoment').style.left = `${(m / d) * 100}%`;
  $('fxMoment').firstChild.textContent = m == null ? 'Slow-mo at playhead ' : `Slow-mo at ${fmtDur(m)} `;
  $('fxMomentClear').hidden = m == null;
}

function renderFx() {
  const fx = state.fx;
  renderStyleChips();
  renderFormatChips();
  $('fxTitle').value = fx.title;
  $('fxFades').checked = fx.fades;
  $('fxMusic').textContent = fx.music ? fx.music.name : 'Add your own track';
  $('fxMusicClear').hidden = !fx.music;
  $('fxVol').value = Math.round(fx.gameVol * 100);
  $('fxVolOut').textContent = `${Math.round(fx.gameVol * 100)}%`;
  video.volume = fx.gameVol;
  layoutFrame();
  renderTrim();
}

let editTimer;
function persistEdit() {
  const clip = state.current;
  if (!clip || !state.duration) return;
  const [a, b] = state.trim;
  const whole = a < 0.05 && b > state.duration - 0.05;
  const edit = { file: clip.path, trim: whole ? null : [a, b], moment: state.fx.moment };
  clip.edit = edit.trim || edit.moment != null ? { trim: edit.trim, moment: edit.moment } : null;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => api.saveEdit(edit), 400);
}

function setTrim(edge, t) {
  const d = state.duration;
  const gap = Math.min(1, d / 2);
  if (edge === 0) state.trim[0] = Math.max(0, Math.min(t, state.trim[1] - gap));
  else state.trim[1] = Math.min(d, Math.max(t, state.trim[0] + gap));
  renderTrim();
  persistEdit();
}

function setDuration(d) {
  if (!d || !isFinite(d) || Math.abs(d - state.duration) < 0.01) return;
  state.duration = d;
  const saved = state.current && state.current.edit && state.current.edit.trim;
  state.trim = saved && saved[1] <= d + 0.1 ? [saved[0], Math.min(saved[1], d)] : [0, d];
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
  for (const id of ['upStreamable', 'discord', 'upYouTube', 'copyFile', 'trash', 'discordSize', 'hypeFind']) $(id).disabled = busy;
  renderTrim();
}

function openPlayer(clip) {
  state.current = clip;
  state.duration = 0;
  state.trim = [0, 0];
  state.fx = blankFx();
  if (clip.edit && clip.edit.moment != null) state.fx.moment = clip.edit.moment;
  $('clipTitle').textContent = clip.name;
  const m = clip.meta;
  $('clipMeta').textContent = [clip.game, fmtDate(clip.mtime), m && `${m.width}×${m.height}${m.fps ? ` ${m.fps}fps` : ''}`, fmtSize(clip.size)].filter(Boolean).join(' · ');
  $('videoNote').hidden = true;
  showLink(clip.upload);
  setStatus(null);
  setBusy(false);
  if (m) setDuration(m.duration);
  video.src = fileUrl(clip.path);
  $('player').showModal();
  renderFx();
  state.analysis = null;
  renderHype();
  api.getAnalysis(clip.path).then((found) => {
    if (found && state.current === clip) {
      state.analysis = found;
      renderHype();
    }
  });
  video.play().catch(() => {});
}

function closePlayer() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.current = null;
  if ($('player').open) $('player').close();
}

video.addEventListener('loadedmetadata', () => {
  setDuration(video.duration);
  layoutFrame();
  if (state.trim[0] > 0.05) video.currentTime = state.trim[0];
});
video.addEventListener('timeupdate', () => {
  const d = state.duration || 1;
  const t = video.currentTime;
  $('trimHead').style.left = `${(t / d) * 100}%`;
  const [a, b] = state.trim;
  // loop the selection while previewing a trim
  if (b < d - 0.05 && t >= b && !video.paused) video.currentTime = a;
  const slow = slowWindow();
  const inSlow = Boolean(slow && t >= slow[0] && t < slow[1]);
  video.playbackRate = inSlow ? 0.5 : 1;
  $('slowBadge').hidden = !inSlow;
});
video.addEventListener('error', () => {
  if (!state.current) return;
  const codec = state.current.meta && state.current.meta.codec;
  $('videoNote').textContent = `This clip${codec ? ` (${codec})` : ''} can't be previewed here, but editing and sharing still work.`;
  $('videoNote').hidden = false;
});
new ResizeObserver(layoutFrame).observe(screen);

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
  if (dragEdge == null) video.currentTime = timeAt(ev);
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

function setMoment(t) {
  state.fx.moment = t;
  renderTrim();
  persistEdit();
}

$('setStart').addEventListener('click', () => setTrim(0, video.currentTime));
$('setEnd').addEventListener('click', () => setTrim(1, video.currentTime));
$('trimReset').addEventListener('click', () => {
  state.trim = [0, state.duration];
  renderTrim();
  persistEdit();
});

$('player').addEventListener('keydown', (ev) => {
  if (ev.target.matches('select, input')) return;
  const k = ev.key.toLowerCase();
  if (k === 'i') setTrim(0, video.currentTime);
  else if (k === 'o') setTrim(1, video.currentTime);
  else if (k === 'm') setMoment(video.currentTime);
  else if (ev.key === 'ArrowLeft' && ev.target !== video) video.currentTime -= 5;
  else if (ev.key === 'ArrowRight' && ev.target !== video) video.currentTime += 5;
});
$('player').addEventListener('close', closePlayer);
$('player').addEventListener('cancel', (ev) => state.busy && ev.preventDefault());
$('closePlayer').addEventListener('click', () => !state.busy && closePlayer());

/* ---------- hype moments ---------- */

function seekTo(t) {
  video.currentTime = Math.max(0, t);
  video.play().catch(() => {});
}

function renderHype() {
  const a = state.analysis;
  const d = state.duration || (state.current && state.current.meta && state.current.meta.duration) || 1;
  $('hypeHint').textContent = !state.hype.engine
    ? 'Not available in this build.'
    : a
      ? a.moments.length
        ? 'Best first. Click one to watch it.'
        : 'No standout moments found in this clip.'
      : state.hype.model
        ? 'Listens to the clip and marks its most exciting moments.'
        : `Listens to the clip and marks its most exciting moments. First use downloads a ${state.hype.modelMB} MB speech model; after that everything runs on this PC.`;
  $('hypeFind').hidden = Boolean(a) || !state.hype.engine;
  $('hypeAuto').hidden = !(a && a.moments.length);
  $('hypeList').replaceChildren(
    ...(a ? a.moments : []).map((m) => {
      const b = el('button', 'hype');
      b.append(el('time', null, fmtDur(m.t)), el('span', null, m.spoken ? `“${m.reason}”` : m.reason));
      b.title = m.reason;
      b.addEventListener('click', () => seekTo(m.t - 3));
      return b;
    })
  );
  $('trimHype').replaceChildren(
    ...(a ? a.moments : []).map((m) => {
      const tick = el('i');
      tick.style.left = `${(m.t / d) * 100}%`;
      return tick;
    })
  );
  $('transcript').hidden = !(a && a.lines.length);
  $('transcriptLines').replaceChildren(
    ...(a ? a.lines : []).map((line) => {
      const b = el('button');
      b.append(el('time', null, fmtDur(line.from)), el('span', null, line.text));
      b.addEventListener('click', () => seekTo(line.from));
      return b;
    })
  );
}

$('hypeFind').addEventListener('click', () =>
  runJob(
    'Listening…',
    async (job, clip) => {
      const found = await api.analyze({ jobId: job.jobId, file: job.file });
      state.hype.model = true;
      clip.hype = found.moments.length;
      if (state.current === clip) {
        state.analysis = found;
        renderHype();
      }
      return found;
    },
    (found) => (found.moments.length ? `Found ${found.moments.length} hype moment${found.moments.length === 1 ? '' : 's'}.` : 'No standout moments found in this clip.')
  )
);

// Trims around the best moment and puts the slow-mo on it.
$('hypeAuto').addEventListener('click', () => {
  const best = state.analysis && state.analysis.moments[0];
  if (!best || !state.duration) return;
  state.trim = [Math.max(0, best.t - 8), Math.min(state.duration, best.t + 4)];
  setMoment(best.t);
  seekTo(state.trim[0]);
  toast('Trimmed to the best moment with slow-mo on it. Share it or keep tweaking.');
});

/* ---------- effects controls ---------- */

const onFxChange = () => {
  layoutFrame();
  renderTrim();
};
const renderStyleChips = chipGroup('styleChips', STYLE_OPTIONS, () => state.fx, 'style', onFxChange);
const renderFormatChips = chipGroup('formatChips', FORMAT_OPTIONS, () => state.fx, 'format', onFxChange);

$('fxMoment').addEventListener('click', () => setMoment(video.currentTime));
$('fxMomentClear').addEventListener('click', () => setMoment(null));
$('fxTitle').addEventListener('input', (ev) => {
  state.fx.title = ev.target.value;
  onFxChange();
});
$('fxFades').addEventListener('change', (ev) => {
  state.fx.fades = ev.target.checked;
  onFxChange();
});
$('fxVol').addEventListener('input', (ev) => {
  state.fx.gameVol = Number(ev.target.value) / 100;
  $('fxVolOut').textContent = `${ev.target.value}%`;
  video.volume = state.fx.gameVol;
  renderTrim();
});
$('fxMusic').addEventListener('click', async () => {
  const track = await api.pickMusic();
  if (!track) return;
  state.fx.music = track;
  if (state.fx.gameVol === 1) state.fx.gameVol = 0.5; // let the track be heard
  renderFx();
});
$('fxMusicClear').addEventListener('click', () => {
  state.fx.music = null;
  renderFx();
});
$('fxReset').addEventListener('click', () => {
  state.fx = blankFx();
  renderFx();
  persistEdit();
});

/* ---------- share actions ---------- */

async function runJob(startText, fn, doneText) {
  if (state.busy || !state.current) return;
  const clip = state.current;
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.jobId = jobId;
  state.onProgress = (stage, pct) => setStatus('run', `${stage}… ${Math.round(pct * 100)}%`, pct);
  setBusy(true);
  setStatus('run', startText, 0);
  try {
    const [start, end] = state.trim;
    const result = await fn({ jobId, file: clip.path, start, end, fx: fxPayload(state.fx) }, clip);
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
  if (jobId === state.jobId && state.onProgress) state.onProgress(stage, pct);
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
    'Rendering…',
    (job) => api.exportClip({ ...job, targetMB }),
    (out) => `${fmtSize(out.size)} file copied. Press Ctrl+V in Discord to attach it. It's also saved in My edits.`
  );
});

$('upYouTube').addEventListener('click', () =>
  runJob('Preparing…', api.uploadYouTube, () => 'YouTube upload opened in your browser. Drag the highlighted file from the folder window onto the page.')
);

$('saveEdit').addEventListener('click', () =>
  runJob(
    'Rendering…',
    (job) => api.exportClip({ ...job, targetMB: 0 }),
    (out) => `Saved a ${fmtSize(out.size)} copy to My edits and copied the file.`
  )
);

$('copyFile').addEventListener('click', async () => {
  try {
    await api.copyFile(state.current.path);
    toast('Original file copied. Paste it anywhere.');
  } catch (err) {
    setStatus('error', errorText(err));
  }
});

$('reveal').addEventListener('click', () => api.reveal(state.current.path));

$('trash').addEventListener('click', async () => {
  const clip = state.current;
  if (!(await api.confirm(`Move "${clip.name}" to the Recycle Bin?`, 'Move to Recycle Bin'))) return;
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

/* ---------- highlight reel ---------- */

const renderReelStyle = chipGroup('reelStyleChips', STYLE_OPTIONS, () => state.reelFx, 'style');
const renderReelFormat = chipGroup('reelFormatChips', FORMAT_OPTIONS, () => state.reelFx, 'format');

function setReelStatus(kind, text, pct) {
  const s = $('reelStatus');
  s.hidden = !kind;
  s.className = 'status' + (kind && kind !== 'run' ? ' ' + kind : '');
  $('reelStatusText').textContent = text || '';
  if (pct != null) $('reelBarFill').style.width = `${Math.round(pct * 100)}%`;
}

function renderReelMusic() {
  const fx = state.reelFx;
  $('reelMusic').textContent = fx.music ? fx.music.name : 'Add your own track';
  $('reelMusicClear').hidden = !fx.music;
  $('reelVol').value = Math.round(fx.gameVol * 100);
  $('reelVolOut').textContent = `${Math.round(fx.gameVol * 100)}%`;
}

const renderReelCount = chipGroup('reelCountChips', [[3, '3'], [5, '5'], [8, '8'], [12, '12']], () => state.montage, 'count');

async function openReelDialog(mode) {
  state.reelMode = mode;
  const montage = mode === 'montage';
  const s = await api.getSettings();
  const picked = state.selected.map((p) => state.clips.find((c) => c.path === p)).filter(Boolean);
  $('reelHeading').textContent = montage ? 'Auto montage' : 'Highlight reel';
  $('reelGo').textContent = montage ? 'Build montage' : 'Build reel';
  $('reelCountField').hidden = !montage;
  if (montage) {
    const todo = picked.filter((c) => c.hype == null).length;
    $('reelNote').textContent =
      `ReplayStrike listens to each clip, picks the most exciting moments across all of them and cuts about 9 seconds around each, in the order they happened. The biggest moment gets slow-mo.` +
      (todo ? ` ${todo} clip${todo === 1 ? ' needs' : 's need'} analysing first, roughly 5 seconds per minute of footage.` : '') +
      (state.hype.model ? '' : ` First use downloads a ${state.hype.modelMB} MB speech model.`);
    $('reelList').replaceChildren(
      ...picked.map((c) => el('li', null, `${c.name} · ${c.hype == null ? 'not analysed yet' : `${c.hype} hype moment${c.hype === 1 ? '' : 's'}`}`))
    );
    renderReelCount();
  } else {
    $('reelNote').textContent = `Clips play in the order you picked them. Each one uses the trim and slow-mo you set on it; untrimmed clips use their last ${s.reelSeconds} seconds.`;
    $('reelList').replaceChildren(
      ...picked.map((c) => {
        const trim = c.edit && c.edit.trim;
        const len = trim ? trim[1] - trim[0] : Math.min(s.reelSeconds, (c.meta && c.meta.duration) || s.reelSeconds);
        return el('li', null, `${c.name} · ${fmtDur(len)}${trim ? ' (your trim)' : ''}`);
      })
    );
  }
  renderReelStyle();
  renderReelFormat();
  $('reelTitle').value = state.reelFx.title;
  renderReelMusic();
  setReelStatus(null);
  $('reelGo').disabled = false;
  $('reel').showModal();
}

$('makeReel').addEventListener('click', () => openReelDialog('reel'));
$('makeMontage').addEventListener('click', () => openReelDialog('montage'));

$('reelTitle').addEventListener('input', (ev) => (state.reelFx.title = ev.target.value));
$('reelVol').addEventListener('input', (ev) => {
  state.reelFx.gameVol = Number(ev.target.value) / 100;
  $('reelVolOut').textContent = `${ev.target.value}%`;
});
$('reelMusic').addEventListener('click', async () => {
  const track = await api.pickMusic();
  if (!track) return;
  state.reelFx.music = track;
  if (state.reelFx.gameVol === 1) state.reelFx.gameVol = 0.5;
  renderReelMusic();
});
$('reelMusicClear').addEventListener('click', () => {
  state.reelFx.music = null;
  renderReelMusic();
});
$('closeReel').addEventListener('click', () => !state.busy && $('reel').close());
$('reel').addEventListener('cancel', (ev) => state.busy && ev.preventDefault());
$('clearSel').addEventListener('click', () => {
  state.selected = [];
  renderSelection();
});

$('reelGo').addEventListener('click', async () => {
  if (state.busy) return;
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.jobId = jobId;
  state.busy = true;
  state.onProgress = (stage, pct) => setReelStatus('run', `${stage}… ${Math.round(pct * 100)}%`, pct);
  $('reelGo').disabled = true;
  const montage = state.reelMode === 'montage';
  setReelStatus('run', montage ? 'Listening…' : 'Building reel…', 0);
  try {
    const job = { jobId, files: state.selected, fx: fxPayload(state.reelFx) };
    const out = montage ? await api.makeMontage({ ...job, count: state.montage.count }) : await api.makeReel(job);
    if (montage) state.hype.model = true;
    state.selected = [];
    $('reel').close();
    await rescan();
    toast(`${montage ? 'Montage' : 'Highlight reel'} ready: ${fmtDur(out.duration)}, ${fmtSize(out.size)}.`);
    state.view = 'edits';
    renderSidebar();
    renderGrid();
    const made = state.clips.find((c) => c.path === out.path);
    if (made) openPlayer(made);
  } catch (err) {
    setReelStatus('error', errorText(err));
    $('reelGo').disabled = false;
  } finally {
    state.jobId = null;
    state.busy = false;
  }
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
  $('exportNote').textContent = `Edited clips and highlight reels are saved to ${s.exportDir}`;
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

$('winMin').addEventListener('click', () => api.minimize());
$('winMax').addEventListener('click', () => api.toggleMaximize());
$('winClose').addEventListener('click', () => api.close());
document.querySelector('.toolbar').addEventListener('dblclick', (ev) => {
  if (ev.target.hasAttribute('data-tauri-drag-region')) api.toggleMaximize();
});

$('search').addEventListener('input', (ev) => {
  state.query = ev.target.value;
  renderGrid();
});
$('search').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !state.query) return;
  ev.preventDefault();
  state.query = '';
  $('search').value = '';
  renderGrid();
});
$('resultsAction').addEventListener('click', () => {
  if (state.query.trim()) {
    state.query = '';
    $('search').value = '';
    renderGrid();
    $('search').focus();
    return;
  }
  state.view = 'all';
  state.game = null;
  renderSidebar();
  renderGrid();
  $('games').querySelector('[data-view="all"]').focus();
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

api.hypeStatus().then((status) => {
  state.hype = status;
  renderSelection();
});
rescan();
