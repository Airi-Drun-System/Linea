'use strict';
const { app, BrowserWindow, ipcMain, net, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// музыка играет и в свёрнутом окне без задержек
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
// журнал для разбора проблем: рядом с портативным .exe (или в папке данных программы)
function logLine(...a) {
  try {
    const dir = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('userData');
    fs.appendFileSync(path.join(dir, 'Linea-log.txt'), `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  } catch { /* журнал не обязателен */ }
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#09090D',
    title: 'Linea',
    frame: false, // своя шапка вместо системной полоски с заголовком
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
    // поиск по названию оригинала (для мешапа): текст подойдёт и от трека другой длины
    if (!plain) { const p = list.filter((x) => x.plainLyrics && (q.loose || near(x))).sort(byDur)[0]; plain = p ? p.plainLyrics : null; }
    return plain ? { plain } : null;
  } catch { return null; }
});


// ==================== скачивание больших файлов (модель для минуса) ====================
async function download(url, dest, onProgress, signal) {
  const r = await net.fetch(url, { headers: UA, signal });
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}. Проверь интернет или включи VPN.`);
  const total = Number(r.headers.get('content-length')) || 0;
  const part = dest + '.part';
  const out = fs.createWriteStream(part);
  let got = 0, last = 0;
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (total && Date.now() - last > 200) { last = Date.now(); onProgress(got / total); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (e) { out.destroy(); fs.rmSync(part, { force: true }); throw e; }
  if (total && got !== total) { fs.rmSync(part, { force: true }); throw new Error('Файл скачался не целиком, попробуй ещё раз.'); }
  fs.renameSync(part, dest);
}
ipcMain.on('log', (_e, m) => logLine('окно:', String(m).slice(0, 2000)));

// ==================== стрелки везде, как в Soundpad ====================
// Пока включено, ← и → принадлежат Linea во всех программах: переключают песни, даже если окно свёрнуто
const KEYS = { Left: -1, Right: 1, PageDown: 'play', PageUp: 'pause' }; // PgDn — играть, PgUp — стоп
let keysOn = false;
// занятые клавиши (например, их держит ещё открытая старая Linea) пробуем забрать снова, пока не получится
function grabKeys() {
  let ok = true;
  for (const [k, v] of Object.entries(KEYS)) {
    if (globalShortcut.isRegistered(k)) continue;
    const got = globalShortcut.register(k, () => { if (win && !win.isDestroyed()) win.webContents.send('keys:step', v); });
    if (!got) ok = false;
  }
  return ok;
}
setInterval(() => { if (keysOn) grabKeys(); }, 3000);
ipcMain.handle('keys:global', (_e, on) => {
  keysOn = !!on;
  if (!on) { for (const k of Object.keys(KEYS)) globalShortcut.unregister(k); return true; }
  const ok = grabKeys();
  logLine('клавиши везде:', ok ? 'все заняты Linea' : 'часть занята другой программой');
  return ok;
});

// кнопки окна в своей шапке
ipcMain.on('win:act', (_e, a) => {
  if (!win || win.isDestroyed()) return;
  if (a === 'min') win.minimize();
  else if (a === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (a === 'close') win.close();
});

// ==================== слова поверх игр ====================
// прозрачное окно поверх всех окон; клики проходят сквозь него в игру
let overlay = null;
const OV_FILE = () => path.join(app.getPath('userData'), 'overlay.json');
function ovBounds() {
  const W = 760, H = 96; // компактная плашка: место сохраняем, размер всегда этот
  try {
    const b = JSON.parse(fs.readFileSync(OV_FILE(), 'utf8'));
    const x = Math.round(b.x + ((b.width || W) - W) / 2), y = Math.round(b.y + ((b.height || H) - H) / 2);
    if (screen.getAllDisplays().some((d) => x >= d.bounds.x - 50 && x < d.bounds.x + d.bounds.width && y >= d.bounds.y - 50 && y < d.bounds.y + d.bounds.height)) return { width: W, height: H, x, y };
  } catch { /* первый запуск */ }
  const wa = screen.getPrimaryDisplay().workArea;
  return { width: W, height: H, x: Math.round(wa.x + (wa.width - W) / 2), y: wa.y + wa.height - H - 40 };
}
function openOverlay() {
  if (overlay && !overlay.isDestroyed()) return;
  overlay = new BrowserWindow({
    ...ovBounds(), frame: false, transparent: true, resizable: false, movable: true, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('moved', () => { try { fs.writeFileSync(OV_FILE(), JSON.stringify(overlay.getBounds())); } catch { /* не страшно */ } });
  overlay.on('closed', () => { overlay = null; });
}
ipcMain.handle('overlay:set', (_e, q) => {
  if (!q || !q.on) { if (overlay) overlay.close(); return; }
  openOverlay();
  // режим «подвинуть»: окно ловит мышь, его можно тащить; потом снова сквозное
  const move = !!q.move;
  overlay.setIgnoreMouseEvents(!move);
  overlay.setFocusable(move);
  overlay.webContents.send('overlay:move', move);
});
ipcMain.on('overlay:state', (_e, st) => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:state', st); });

// ==================== отделение голоса (модель HTDemucs, качается один раз) ====================
const { Worker } = require('worker_threads');
const SEP_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const SEP_FILE = () => path.join(app.getPath('userData'), 'demucs', 'htdemucs_embedded.onnx');
let sepJob = null;
ipcMain.handle('sep:run', async (e, q) => {
  if (sepJob) throw new Error('Уже отделяю голос у другой песни.');
  const { left, right } = q || {};
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length || left.length > 44100 * 60 * 20) throw new Error('Не тот звук.');
  const send = (stage, p) => { if (!e.sender.isDestroyed()) e.sender.send('sep:progress', { stage, p }); };
  sepJob = { worker: null, ctrl: new AbortController() };
  try {
    const f = SEP_FILE();
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      await download(SEP_URL, f, (p) => send('model', p), sepJob.ctrl.signal);
    }
    send('run', 0);
    // поток лежит рядом с распакованным onnxruntime, а не внутри app.asar
    const script = path.join(__dirname, 'sep', 'worker.js').replace('app.asar', 'app.asar.unpacked');
    return await new Promise((res, rej) => {
      const w = new Worker(script, { workerData: { model: f, left, right } });
      sepJob.worker = w;
      w.on('message', (m) => {
        if (m.p != null) send('run', m.p);
        else if (m.gpu != null) { logLine('минус: видеокарта', m.gpu); if (m.gpu === false && process.platform === 'win32') send('cpu', 0); }
        else if (m.done) res(m.out);
        else if (m.err) rej(new Error('Не получилось отделить голос: ' + m.err));
      });
      w.on('error', rej);
      w.on('exit', () => res(null)); // если ответ уже пришёл, это ничего не меняет; иначе — отменили
    });
  } catch (err) {
    logLine('минус: ошибка', String((err && err.stack) || err));
    if (sepJob && sepJob.ctrl.signal.aborted) return null;
    throw err;
  } finally {
    sepJob = null;
  }
});
ipcMain.handle('sep:cancel', () => { if (!sepJob) return; sepJob.ctrl.abort(); if (sepJob.worker) sepJob.worker.terminate(); });
ipcMain.handle('sep:ready', () => fs.existsSync(SEP_FILE()));

// только одна Linea за раз: две копии делят одну базу песен, и вторая её не видит —
// поэтому при втором запуске просто показываем уже открытое окно
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  win.webContents.send('keys:step', 'already');
});
app.whenReady().then(() => { logLine('Linea запущен', app.getVersion(), process.platform, os.release()); createWindow(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
