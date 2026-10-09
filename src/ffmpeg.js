const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Bundled binaries live outside the asar archive once packaged.
function unpacked(p) {
  return p ? p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : p;
}

function resolveBin(name) {
  try {
    const p = unpacked(name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path);
    if (p && fs.existsSync(p)) return p;
  } catch {
    // fall through to PATH
  }
  return name;
}

const FFMPEG = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');
const FONT_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');

function run(bin, args, onStdout, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (onStdout) onStdout(s);
      else out += s;
    });
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(' | ') || `${path.basename(bin)} exited ${code}`));
    });
  });
}

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).filter((s) => s.codec_type === 'audio');
  const duration = parseFloat(info.format && info.format.duration) || 0;
  if (!v || !duration) throw new Error('not a playable video');
  const [n, d] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    duration,
    width: v.width,
    height: v.height,
    fps: d ? Math.round(n / d) : 0,
    codec: v.codec_name,
    audioTracks: audio.length,
  };
}

async function thumbnail(file, duration, outFile) {
  const at = Math.min(duration * 0.3, Math.max(0, duration - 0.5));
  await run(FFMPEG, ['-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', outFile]);
}

function uniquePath(dir, base, label) {
  let n = 0;
  let p;
  do {
    p = path.join(dir, `${base} (${label}${n ? ' ' + n : ''}).mp4`);
    n += 1;
  } while (fs.existsSync(p));
  return p;
}

function encodeSettings(targetMB, dur, srcHeight) {
  const totalK = (targetMB * 8192 * 0.94) / dur;
  const audioK = totalK < 600 ? 64 : totalK < 1500 ? 96 : 128;
  const videoK = Math.max(80, Math.floor(totalK - audioK));
  const height = videoK >= 8000 ? srcHeight : videoK >= 3500 ? 1080 : videoK >= 1400 ? 720 : videoK >= 600 ? 480 : 360;
  return { audioK, videoK, height: Math.min(height, srcHeight || height), fps30: videoK < 1400 };
}

/* ---------- effects ---------- */

const STYLES = {
  none: [],
  cinematic: ['eq=contrast=1.08:saturation=1.12:gamma=0.96', 'colorbalance=rs=0.05:bs=-0.05:rh=0.03:bh=-0.04', 'vignette=angle=PI/5'],
  vibrant: ['eq=contrast=1.1:saturation=1.38', 'unsharp=5:5:0.7:5:5:0'],
  noir: ['hue=s=0', 'eq=contrast=1.22:brightness=-0.02', 'vignette=angle=PI/4.5'],
};
const FORMATS = new Set(['original', 'vertical', 'vertical-fit', 'square']);
const SLOW_BEFORE = 0.6;
const SLOW_AFTER = 0.9;

// drawtext text is embedded in the filter graph, so only keep characters
// that need no escaping there.
function cleanTitle(t) {
  return String(t || '').replace(/[^\p{L}\p{N} \-_.!?#@&+]/gu, '').trim().slice(0, 60);
}

function normalizeFx(fx) {
  fx = fx || {};
  const gameVol = Number.isFinite(fx.gameVol) ? Math.max(0, Math.min(1, fx.gameVol)) : 1;
  return {
    style: STYLES[fx.style] ? fx.style : 'none',
    format: FORMATS.has(fx.format) ? fx.format : 'original',
    moment: Number.isFinite(fx.moment) ? fx.moment : null,
    title: cleanTitle(fx.title),
    fades: Boolean(fx.fades),
    music: fx.music || null,
    gameVol,
    uniform: Boolean(fx.uniform), // fixed size + frame rate so reel segments can be joined
  };
}

function hasFx(fx) {
  const f = normalizeFx(fx);
  return f.style !== 'none' || f.format !== 'original' || f.moment != null || Boolean(f.title) || f.fades || Boolean(f.music) || f.gameVol !== 1 || f.uniform;
}

function fontFile() {
  return ['segoeuib.ttf', 'arialbd.ttf', 'arial.ttf'].find((f) => fs.existsSync(path.join(FONT_DIR, f))) || null;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// The half-speed window around the marked moment, relative to the selection.
function slowWindow(moment, start, dur) {
  if (moment == null) return null;
  const m = moment - start;
  if (m < 0 || m > dur) return null;
  const a = Math.max(0, m - SLOW_BEFORE);
  const b = Math.min(dur, m + SLOW_AFTER);
  return b - a > 0.2 ? [a, b] : null;
}

function buildGraph({ meta, dur, outDur, slow, fx, limitH, fps, font }) {
  const g = [];
  const n = meta.audioTracks;
  const t = (x) => x.toFixed(3);

  // Audio base: silence if the clip has none, otherwise every track mixed
  // (recorders often put the mic on its own track).
  if (n === 0) g.push(`anullsrc=r=48000:cl=stereo,atrim=end=${t(dur)}[a0]`);
  else {
    const ins = Array.from({ length: n }, (_, i) => `[0:a:${i}]`).join('');
    g.push(`${ins}${n > 1 ? `amix=inputs=${n}:normalize=0,` : ''}aresample=48000,aformat=channel_layouts=stereo[a0]`);
  }
  let v = '[0:v:0]';
  let a = '[a0]';

  if (slow) {
    const segs = [];
    if (slow[0] > 0.05) segs.push([0, slow[0], 1]);
    segs.push([slow[0], slow[1], 0.5]);
    if (slow[1] < dur - 0.05) segs.push([slow[1], dur, 1]);
    const k = segs.length;
    g.push(`${v}split=${k}${segs.map((_, i) => `[sv${i}]`).join('')}`);
    g.push(`${a}asplit=${k}${segs.map((_, i) => `[sa${i}]`).join('')}`);
    segs.forEach(([s, e, speed], i) => {
      g.push(`[sv${i}]trim=start=${t(s)}:end=${t(e)},setpts=${1 / speed}*(PTS-STARTPTS)[tv${i}]`);
      g.push(`[sa${i}]atrim=start=${t(s)}:end=${t(e)},asetpts=PTS-STARTPTS${speed !== 1 ? `,atempo=${speed}` : ''}[ta${i}]`);
    });
    g.push(`${segs.map((_, i) => `[tv${i}][ta${i}]`).join('')}concat=n=${k}:v=1:a=1[cv][ca]`);
    v = '[cv]';
    a = '[ca]';
  }

  // Geometry
  const short = fx.uniform ? 1080 : even(Math.min(1080, limitH, meta.height));
  let outW;
  let outH;
  if (fx.format === 'vertical') {
    outW = short;
    outH = even((short * 16) / 9);
    g.push(`${v}crop='min(iw,ih*9/16)':ih,scale=${outW}:${outH}[geo]`);
  } else if (fx.format === 'vertical-fit') {
    outW = short;
    outH = even((short * 16) / 9);
    g.push(`${v}split=2[bg0][fg0]`);
    g.push(`[bg0]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=20:4[bg1]`);
    g.push(`[fg0]scale=${outW}:-2[fg1]`);
    g.push(`[bg1][fg1]overlay=(W-w)/2:(H-h)/2[geo]`);
  } else if (fx.format === 'square') {
    outW = outH = short;
    g.push(`${v}crop='min(iw,ih)':'min(iw,ih)',scale=${outW}:${outH}[geo]`);
  } else if (fx.uniform) {
    outW = 1920;
    outH = 1080;
    g.push(`${v}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[geo]`);
  } else {
    outH = even(Math.min(meta.height, limitH));
    outW = even((outH * meta.width) / meta.height);
    g.push(`${v}scale=${outW}:${outH}[geo]`);
  }

  const chain = ['setsar=1', `fps=${fps}`, ...STYLES[fx.style]];
  const letterbox = fx.style === 'cinematic' && fx.format === 'original';
  if (letterbox) {
    chain.push('drawbox=x=0:y=0:w=iw:h=ih*0.11:color=black:t=fill', 'drawbox=x=0:y=ih*0.89:w=iw:h=ih*0.11:color=black:t=fill');
  }
  if (fx.title && font) {
    const size = Math.round(Math.min(outW, outH) / 12);
    const y = Math.round(outH * (letterbox ? 0.86 : 0.93));
    chain.push(
      `drawtext=fontfile=${font}:text='${fx.title}':fontcolor=white:fontsize=${size}:x=${Math.round(outW * 0.05)}:y=${y}-text_h` +
        `:shadowcolor=black@0.65:shadowx=3:shadowy=3:alpha='if(lt(t,0.3),t/0.3,if(lt(t,2.6),1,if(lt(t,3.1),(3.1-t)/0.5,0)))'`
    );
  }
  const fades = fx.fades && outDur > 1.5;
  if (fades) chain.push('fade=t=in:st=0:d=0.35', `fade=t=out:st=${t(outDur - 0.45)}:d=0.45`);
  chain.push('format=yuv420p');
  g.push(`[geo]${chain.join(',')}[vout]`);

  if (fx.gameVol !== 1) {
    g.push(`${a}volume=${fx.gameVol}[ag]`);
    a = '[ag]';
  }
  if (fx.music) {
    g.push('[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.8[mu]');
    g.push(`${a}[mu]amix=inputs=2:duration=first:normalize=0[am]`);
    a = '[am]';
  }
  const achain = fades ? ['afade=t=in:st=0:d=0.35', `afade=t=out:st=${t(outDur - 0.45)}:d=0.45`] : ['anull'];
  g.push(`${a}${achain.join(',')}[aout]`);
  return g.join(';');
}

// Cuts [start, end] out of `src`, optionally applying effects (`fx`).
// With no effects it stream-copies when the result already fits `targetMB`
// (or no target is given); otherwise it re-encodes, to the target size if
// one is set.
async function exportClip({ src, start, end, targetMB, outDir, label, meta, srcSize, fx: rawFx, outName }, onProgress = () => {}) {
  const fx = normalizeFx(rawFx);
  const dur = Math.max(0.1, end - start);
  fs.mkdirSync(outDir, { recursive: true });
  const out = outName ? path.join(outDir, outName) : uniquePath(outDir, path.basename(src, path.extname(src)), label);
  const estCopyMB = ((srcSize / meta.duration) * dur) / 1048576;

  if (!hasFx(fx) && (!targetMB || estCopyMB <= targetMB * 0.97)) {
    const multi = meta.audioTracks > 1;
    const args = ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src];
    if (multi) {
      const ins = Array.from({ length: meta.audioTracks }, (_, i) => `[0:a:${i}]`).join('');
      args.push('-filter_complex', `${ins}amix=inputs=${meta.audioTracks}:normalize=0[a]`, '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a?', '-c', 'copy');
    }
    args.push('-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', out);
    await run(FFMPEG, args, (chunk) => {
      const m = /out_time_(?:us|ms)=(\d+)/.exec(chunk);
      if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / dur));
    });
    return { path: out, size: fs.statSync(out).size, reencoded: false, duration: dur };
  }

  const slow = slowWindow(fx.moment, start, dur);
  const outDur = dur + (slow ? slow[1] - slow[0] : 0);
  const s = targetMB ? encodeSettings(targetMB, outDur, meta.height) : null;
  const fps = fx.uniform ? 60 : Math.min(s && s.fps30 ? 30 : 60, meta.fps || 60);
  const font = fx.title ? fontFile() : null;
  const graph = buildGraph({ meta, dur, outDur, slow, fx, limitH: s ? s.height : meta.height, fps, font });

  const build = (videoK) => {
    const args = ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src];
    if (fx.music) args.push('-stream_loop', '-1', '-i', fx.music);
    args.push('-filter_complex', graph, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
    if (videoK) args.push('-b:v', `${videoK}k`, '-maxrate', `${videoK}k`, '-bufsize', `${videoK * 2}k`);
    else args.push('-crf', '18');
    args.push('-c:a', 'aac', '-b:a', `${s ? s.audioK : 192}k`, '-ac', '2', '-ar', '48000', '-t', outDur.toFixed(3), '-movflags', '+faststart', '-y', out);
    return args;
  };
  const progress = (chunk) => {
    const m = /out_time_(?:us|ms)=(\d+)/.exec(chunk);
    if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / outDur));
  };
  // drawtext resolves the font relative to the working directory, which
  // avoids escaping a Windows path inside the filter graph.
  const cwd = font ? FONT_DIR : undefined;
  await run(FFMPEG, build(s && s.videoK), progress, cwd);

  // Rate control can overshoot on short clips: one corrective pass.
  if (s) {
    const size = fs.statSync(out).size;
    if (size > targetMB * 1048576) {
      onProgress(0);
      await run(FFMPEG, build(Math.max(60, Math.floor(s.videoK * ((targetMB * 1048576) / size) * 0.93))), progress, cwd);
    }
  }
  return { path: out, size: fs.statSync(out).size, reencoded: true, duration: outDur };
}

// Renders each segment to matching 60fps files, then joins them without a
// second video encode. Music, if any, is laid over the whole reel.
async function makeReel({ segments, fx: rawFx, outDir, tmpDir }, onProgress = () => {}) {
  const fx = normalizeFx(rawFx);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  try {
    let total = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const segFx = { style: fx.style, format: fx.format, fades: true, title: i === 0 ? fx.title : '', moment: segments[i].moment, uniform: true };
      const r = await exportClip({ ...segments[i], targetMB: 0, outDir: tmpDir, outName: `seg${i}.mp4`, fx: segFx }, (p) =>
        onProgress(((i + p) / segments.length) * 0.94)
      );
      total += r.duration;
    }
    fs.writeFileSync(path.join(tmpDir, 'list.txt'), segments.map((_, i) => `file 'seg${i}.mp4'`).join('\n'));
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} - ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    const out = uniquePath(outDir, `Highlight Reel ${stamp}`, `${segments.length} clips`);
    const args = ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt'];
    if (fx.music) {
      args.push(
        '-stream_loop', '-1', '-i', fx.music,
        '-filter_complex',
        `[0:a]volume=${fx.gameVol}[g];[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.8[m];[g][m]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1[a]`,
        '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3)
      );
    } else {
      args.push('-c', 'copy');
    }
    args.push('-movflags', '+faststart', '-y', out);
    await run(FFMPEG, args, null, tmpDir);
    onProgress(1);
    return { path: out, size: fs.statSync(out).size, duration: total };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { probe, thumbnail, exportClip, makeReel, hasFx, FFMPEG, FFPROBE };
