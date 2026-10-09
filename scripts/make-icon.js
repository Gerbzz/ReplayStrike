// Renders the app icon to build/icon.png. Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff7a3d"/>
      <stop offset="1" stop-color="#ff2e55"/>
    </linearGradient>
  </defs>
  <rect x="24" y="24" width="464" height="464" rx="108" fill="#0b0c10"/>
  <rect x="24" y="24" width="464" height="464" rx="108" fill="none" stroke="url(#g)" stroke-width="14"/>
  <path d="M196 148 L372 256 L196 364 Z" fill="url(#g)"/>
  <path d="M300 96 L232 250 L288 250 L212 416 L224 286 L172 286 Z" fill="#0b0c10" opacity="0.92"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote', out, image.getSize());
  app.quit();
});
