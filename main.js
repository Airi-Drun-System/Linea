'use strict';
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');

// музыка играет и в свёрнутом окне без задержек
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#09090D',
    title: 'Linea',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// слова с таймингами: бесплатная база lrclib.net, без ключей
const UA = { 'User-Agent': 'Linea/0.1 (https://github.com/Airi-Drun-System/Linea)' };
async function getJson(url) {
  const r = await net.fetch(url, { headers: UA });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`lrclib ответил ${r.status}`);
  return r.json();
}
ipcMain.handle('lyrics:find', async (_e, q) => {
  const title = String((q && q.title) || '').slice(0, 200).trim();
  const artist = String((q && q.artist) || '').slice(0, 200).trim();
  const duration = Math.round(Number(q && q.duration) || 0);
  if (!title) return null;
  try {
    let plain = null;
    if (artist) {
      const exact = await getJson(`https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}${duration ? `&duration=${duration}` : ''}`);
      if (exact && exact.syncedLyrics) return { synced: exact.syncedLyrics };
      plain = (exact && exact.plainLyrics) || null;
    }
    const list = (await getJson(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}`)) || [];
    // только песни близкой длины, самая близкая первой
    const near = (x) => !duration || Math.abs((x.duration || 0) - duration) <= 8;
    const byDur = (a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration);
    const synced = list.filter((x) => x.syncedLyrics && near(x)).sort(byDur)[0];
    if (synced) return { synced: synced.syncedLyrics };
    // текст без таймингов тоже пригодится: его можно разметить пробелом в плеере
    if (!plain) { const p = list.filter((x) => x.plainLyrics && near(x)).sort(byDur)[0]; plain = p ? p.plainLyrics : null; }
    return plain ? { plain } : null;
  } catch { return null; }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
