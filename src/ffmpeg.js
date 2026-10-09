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

function run(bin, args, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
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

// Cuts [start, end] out of `src`. Stream-copies when the result already fits
// `targetMB` (or no target is given); otherwise re-encodes to hit the size.
// Clips with a separate mic track get their audio mixed down so every player
// (Discord, browsers, Streamable) plays both.
async function exportClip({ src, start, end, targetMB, outDir, label, meta, srcSize }, onProgress = () => {}) {
  const dur = Math.max(0.1, end - start);
  const base = path.basename(src, path.extname(src));
  fs.mkdirSync(outDir, { recursive: true });
  const out = uniquePath(outDir, base, label);
  const estCopyMB = ((srcSize / meta.duration) * dur) / 1048576;
  const copyVideo = !targetMB || estCopyMB <= targetMB * 0.97;
  const multiAudio = meta.audioTracks > 1;

  const progress = (chunk) => {
    const m = /out_time_(?:us|ms)=(\d+)/.exec(chunk);
    if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / dur));
  };

  const build = (videoK, s) => {
    const args = ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src];
    if (multiAudio) {
      const ins = Array.from({ length: meta.audioTracks }, (_, i) => `[0:a:${i}]`).join('');
      args.push('-filter_complex', `${ins}amix=inputs=${meta.audioTracks}:normalize=0[a]`, '-map', '0:v:0', '-map', '[a]');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a?');
    }
    if (copyVideo) {
      args.push('-c:v', 'copy');
      if (multiAudio) args.push('-c:a', 'aac', '-b:a', '160k');
      else args.push('-c:a', 'copy');
      args.push('-avoid_negative_ts', 'make_zero');
    } else {
      const vf = [`scale=-2:'min(ih,${s.height})'`];
      if (s.fps30 && meta.fps > 30) vf.push('fps=30');
      args.push(
        '-vf', vf.join(','),
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-b:v', `${videoK}k`, '-maxrate', `${videoK}k`, '-bufsize', `${videoK * 2}k`,
        '-c:a', 'aac', '-b:a', `${s.audioK}k`, '-ac', '2'
      );
    }
    args.push('-movflags', '+faststart', '-y', out);
    return args;
  };

  const s = copyVideo ? null : encodeSettings(targetMB, dur, meta.height);
  await run(FFMPEG, build(s && s.videoK, s), progress);

  // Rate control can overshoot on short clips: one corrective pass.
  if (!copyVideo) {
    const size = fs.statSync(out).size;
    if (size > targetMB * 1048576) {
      const videoK = Math.max(60, Math.floor(s.videoK * ((targetMB * 1048576) / size) * 0.93));
      onProgress(0);
      await run(FFMPEG, build(videoK, s), progress);
    }
  }
  return { path: out, size: fs.statSync(out).size, reencoded: !copyVideo };
}

module.exports = { probe, thumbnail, exportClip, FFMPEG, FFPROBE };
