const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p));

test('approved ReplayStrike original remains unchanged', () => {
  assert.equal(crypto.createHash('sha256').update(read('build/icon.png')).digest('hex'),
    'bbb1658dd75a7295da48e28faa6d874f51089eb997bed399d8a826e912afee6d');
});

test('renderer uses the exact approved artwork instead of the placeholder play triangle', () => {
  assert.deepEqual(read('renderer/replaystrike-logo.png'), read('build/icon.png'));
  assert.match(read('renderer/index.html').toString(), /<img class="brand-mark" src="replaystrike-logo.png" alt=""/);
  assert.match(read('renderer/app.css').toString(), /\.brand-mark\s*\{[^}]*object-fit:\s*contain/);
});

test('README displays the approved original, with existing package icon paths retained', () => {
  assert.match(read('README.md').toString(), /<img src="build\/icon.png" alt="ReplayStrike logo"/);
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  for (const icon of config.bundle.icon) assert.ok(read('src-tauri/' + icon).length > 0);
});
