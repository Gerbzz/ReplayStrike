const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { probe, thumbnail } = require('./ffmpeg');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi']);
const MAX_DEPTH = 4;

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

async function walk(dir, depth, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(p, depth + 1, out);
    } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = await fsp.stat(p);
        out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {
        // file vanished mid-scan
      }
    }
  }
}

class Library {
  constructor({ thumbDir, metaStore, onUpdate }) {
    this.thumbDir = thumbDir;
    this.metaStore = metaStore;
    this.onUpdate = onUpdate;
    this.clips = new Map(); // lowercased path -> clip
    this.queue = [];
    this.active = 0;
    fs.mkdirSync(thumbDir, { recursive: true });
  }

  has(file) {
    return this.clips.has(String(file).toLowerCase());
  }

  get(file) {
    return this.clips.get(String(file).toLowerCase());
  }

  async scan(sources) {
    const clips = new Map();
    for (const source of sources) {
      source.count = 0;
      if (!source.exists) continue;
      const files = [];
      await walk(source.path, 0, files);
      for (const f of files) {
        const id = f.path.toLowerCase();
        if (clips.has(id)) continue;
        source.count += 1;
        // Recorders file clips as <root>\<Game>\<clip>.mp4
        const rel = path.relative(source.path, f.path).split(path.sep);
        const key = sha(`${f.path}|${f.size}|${f.mtime}`);
        const meta = this.metaStore.get(key) || null;
        const thumbFile = path.join(this.thumbDir, key + '.jpg');
        clips.set(id, {
          ...f,
          key,
          name: path.basename(f.path, path.extname(f.path)),
          source: source.label,
          game: rel.length > 1 ? rel[0] : source.label,
          meta,
          thumb: meta && fs.existsSync(thumbFile) ? `clip://thumb/${key}.jpg` : null,
        });
      }
    }
    this.clips = clips;
    this.queue = [...clips.values()].filter((c) => !c.meta || !c.thumb).sort((a, b) => b.mtime - a.mtime);
    this.pump();
    return [...clips.values()];
  }

  pump() {
    while (this.active < 2 && this.queue.length) {
      const clip = this.queue.shift();
      this.active += 1;
      this.process(clip)
        .catch(() => {
          // unreadable or still being written; a later rescan retries it
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  async process(clip) {
    if (!clip.meta) {
      clip.meta = await probe(clip.path);
      this.metaStore.set(clip.key, clip.meta);
    }
    if (!clip.thumb) {
      await thumbnail(clip.path, clip.meta.duration, path.join(this.thumbDir, clip.key + '.jpg'));
      clip.thumb = `clip://thumb/${clip.key}.jpg`;
    }
    this.onUpdate({ path: clip.path, meta: clip.meta, thumb: clip.thumb });
  }
}

module.exports = { Library };
