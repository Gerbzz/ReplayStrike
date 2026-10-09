const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function regQuery(key, value) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith(value));
      if (!line) return resolve(null);
      const m = line.trim().match(/^\S+\s+(REG_\w+)\s+(.*)$/);
      resolve(m ? { type: m[1], data: m[2].trim() } : null);
    });
  });
}

// GeForce Experience / NVIDIA App store the recording folder as UTF-16 bytes.
async function nvidiaPath() {
  const r = await regQuery('HKCU\\Software\\NVIDIA Corporation\\Global\\ShadowPlay\\NVSPCAPS', 'DefaultPathW');
  if (!r || r.type !== 'REG_BINARY' || !/^[0-9a-f]+$/i.test(r.data)) return null;
  const p = Buffer.from(r.data, 'hex').toString('utf16le').replace(/\0/g, '').trim();
  return p || null;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Returns every place we know to look, whether or not it exists on this PC,
// so the UI can show what was checked. Order matters: a clip is credited to
// the first source that contains it, so specific folders come before Videos.
async function detectSources(videosDir, userFolders = []) {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [];
  const add = (label, p, kind = 'auto') => p && candidates.push({ label, path: path.normalize(p), kind });

  for (const p of userFolders) add(path.basename(p) || p, p, 'user');

  add('NVIDIA', await nvidiaPath());
  add('NVIDIA', path.join(videosDir, 'NVIDIA'));
  add('NVIDIA Highlights', path.join(local, 'Temp', 'Highlights'));
  add('Xbox Game Bar', path.join(videosDir, 'Captures'));
  add('AMD ReLive', path.join(videosDir, 'Radeon ReLive'));
  add('Medal', path.join(videosDir, 'Medal'));
  add('Medal', path.join(home, 'Medal'));
  add('Outplayed', path.join(videosDir, 'Overwolf', 'Outplayed'));
  add('Outplayed', path.join(videosDir, 'Outplayed'));
  add('Videos', videosDir);

  const seen = new Set();
  const sources = [];
  for (const c of candidates) {
    const key = c.path.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ ...c, exists: isDir(c.path), count: 0 });
  }
  return sources;
}

module.exports = { detectSources };
