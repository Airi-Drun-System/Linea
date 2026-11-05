'use strict';
const { app, BrowserWindow, ipcMain, net, globalShortcut, screen, Tray, Menu, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createConnection } = require('net');

// музыка играет и в свёрнутом окне без задержек
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// YouTube и Google встречают «Electron» в подписи браузера проверкой «вы не бот» и не пускают войти — представляемся обычным Chrome
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|linea)\/\S+/gi, '');

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
  // ссылки из плеера (логотип YouTube, «Открыть на SoundCloud») и вход в Last.fm — в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    // «Войти» из плеера YouTube — в окне самой Linea: вход должен остаться в её куках, иначе плеер так и будет просить войти
    if (/^https:\/\/accounts\.google\.com\/|^https:\/\/(www\.)?youtube\.com\/(signin|ServiceLogin)/.test(url)) openBrowse(url);
    else if (/^https:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be|soundcloud\.com|last\.fm|t\.me|github\.com|donationalerts\.com)\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // портативная Linea запускается из временной папки, которая удаляется после выхода; чтобы значок,
  // закреплённый на панели задач, не ломался, говорим Windows запускать сам портативный .exe
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform === 'win32' && portable) {
    try { win.setAppDetails({ appId: 'com.vegasdev.linea', relaunchCommand: `"${portable}"`, relaunchDisplayName: 'Linea', appIconPath: portable, appIconIndex: 0 }); } catch (e) { logLine('ярлык на панели задач:', String(e)); }
  }
  // крестик прячет в трей (музыка играет дальше); совсем выйти — через значок в трее
  win.on('close', (e) => {
    if (quitting || !prefs.tray) return;
    e.preventDefault();
    win.hide();
    if (!prefs.trayTold && tray) { tray.displayBalloon({ title: 'Linea играет в трее', content: 'Чтобы выйти совсем: правый клик по значку → «Выйти из Linea».' }); prefs.trayTold = true; win.webContents.send('keys:step', 'trayTold'); }
  });
  win.on('closed', () => { win = null; app.quit(); }); // окно закрылось — закрываем и оверлей, фоновых процессов не остаётся
}

// слова с таймингами: бесплатная база lrclib.net, без ключей
const UA = { 'User-Agent': 'Linea/0.1 (https://github.com/Airi-Drun-System/Linea)' };
async function getJson(url) {
  const r = await net.fetch(url, { headers: UA });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`lrclib ответил ${r.status}`);
  return r.json();
}
const { lrclibFind } = require('./src/lib.js');
ipcMain.handle('lyrics:find', (_e, q) => lrclibFind(getJson, q));


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
  showWin();
  win.webContents.send('keys:step', 'already');
});
if (process.platform === 'win32') app.setAppUserModelId('com.vegasdev.linea');
app.whenReady().then(() => { logLine('Linea запущен', app.getVersion(), process.platform, os.release()); lockPerms(); createWindow(); makeTray(); setupUpdates(); });
// ==================== значок в трее ====================
let tray = null, quitting = false;
const prefs = { icon: 'grey', tray: true, trayTold: false };
const iconPath = (n) => path.join(__dirname, 'src', 'icons', `${/^[a-z]+$/.test(n) ? n : 'grey'}.png`);
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function quitAll() { quitting = true; app.quit(); }
function makeTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(iconPath(prefs.icon)).resize({ width: 32, height: 32 }));
  tray.setToolTip('Linea');
  const send = (v) => () => { if (win) win.webContents.send('keys:step', v); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Linea', click: showWin },
    { type: 'separator' },
    { label: 'Играть', click: send('play') },
    { label: 'Пауза', click: send('pause') },
    { label: 'Следующая', click: send(1) },
    { label: 'Предыдущая', click: send(-1) },
    { type: 'separator' },
    { label: 'Выйти из Linea', click: quitAll },
  ]));
  tray.on('click', showWin);
}
// плеер сообщает выбор иконки и поведение крестика
ipcMain.on('app:prefs', (_e, q) => {
  if (!q) return;
  if (typeof q.tray === 'boolean') prefs.tray = q.tray;
  if (typeof q.trayTold === 'boolean') prefs.trayTold = q.trayTold;
  if (typeof q.icon === 'string' && /^[a-z]+$/.test(q.icon)) {
    prefs.icon = q.icon;
    const img = nativeImage.createFromPath(iconPath(q.icon));
    if (win && !img.isEmpty()) win.setIcon(img);
    if (tray && !img.isEmpty()) tray.setImage(img.resize({ width: 32, height: 32 }));
  }
});
// ==================== Discord: «Слушает» в профиле ====================
// Discord на компьютере принимает статус через локальный канал discord-ipc-0…9: кадр — код и длина (по 4 байта) и JSON.
// Протокол короткий, поэтому без сторонних библиотек
let dc = null, dcId = '', dcBad = '', dcAct = null, dcBusy = false, dcLast = 0, dcT = null, dcRetry = null;
function dcFrame(op, data) {
  const b = Buffer.from(JSON.stringify(data)), h = Buffer.alloc(8);
  h.writeInt32LE(op, 0); h.writeInt32LE(b.length, 4);
  return Buffer.concat([h, b]);
}
function dcOpen(i = 0) {
  if (dc || dcBusy || !dcId || !dcAct || dcId === dcBad) return;
  dcBusy = true;
  const id = dcId, dir = process.platform === 'win32' ? '\\\\?\\pipe\\' : `${process.env.XDG_RUNTIME_DIR || os.tmpdir()}/`;
  const s = createConnection(dir + 'discord-ipc-' + i);
  let buf = Buffer.alloc(0), ready = false, bad = false;
  s.on('connect', () => s.write(dcFrame(0, { v: 1, client_id: id })));
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
      const op = buf.readInt32LE(0), n = buf.readInt32LE(4);
      let m = null;
      try { m = JSON.parse(buf.subarray(8, 8 + n)); } catch { /* битый кадр пропускаем */ }
      buf = buf.subarray(8 + n);
      if (op === 3) s.write(dcFrame(4, m)); // пинг
      else if (op === 2) { bad = true; dcBad = id; logLine('Discord не принял ID приложения:', m && m.message); }
      else if (m && m.evt === 'READY') { ready = true; dcBusy = false; if (id !== dcId) s.destroy(); else { dc = s; dcSend(); } }
      else if (m && m.evt === 'ERROR') logLine('Discord:', m.data && m.data.message);
    }
  });
  s.on('error', () => {}); // Discord не запущен — тихо попробуем позже
  s.on('close', () => {
    if (dc === s) dc = null;
    if (!ready) dcBusy = false;
    if (!ready && !bad && i < 9) { dcOpen(i + 1); return; }
    clearTimeout(dcRetry);
    if (!bad) dcRetry = setTimeout(dcOpen, ready ? 5000 : 20000);
  });
}
function dcSend() {
  if (!dc) { dcOpen(); return; }
  const wait = dcLast + 4000 - Date.now(); // Discord принимает не больше 5 обновлений за 20 секунд
  if (wait > 0) { if (!dcT) dcT = setTimeout(() => { dcT = null; dcSend(); }, wait); return; }
  dcLast = Date.now();
  dc.write(dcFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: dcAct || undefined }, nonce: String(dcLast) }));
}
// пустой ID — выключено; на паузе статус убираем
ipcMain.on('discord:set', (_e, id, act) => {
  id = /^\d{15,22}$/.test(id) ? id : '';
  if (id !== dcId) { dcId = id; if (dc) dc.destroy(); dc = null; }
  dcAct = id && act && typeof act === 'object' ? act : null;
  if (dc || dcAct) dcSend();
});
// ==================== песни из интернета: SoundCloud и YouTube ====================
// их официальные плееры живут в «мостике» — маленькой странице с localhost:
// YouTube не встраивается в страницы с file:// (ошибка 153), а с localhost работает как на любом сайте
const BRIDGE = { 'player.html': 'text/html; charset=utf-8', 'player.js': 'text/javascript; charset=utf-8' };
let bridgePort = null;
ipcMain.handle('net:port', () => bridgePort || (bridgePort = new Promise((res, rej) => {
  const srv = require('http').createServer((req, rsp) => {
    const name = (req.url || '').split('?')[0].replace(/^\//, '');
    if (!BRIDGE[name]) { rsp.writeHead(404); rsp.end(); return; }
    fs.readFile(path.join(__dirname, 'src', 'bridge', name), (err, buf) => {
      if (err) { rsp.writeHead(500); rsp.end(); return; }
      rsp.writeHead(200, { 'Content-Type': BRIDGE[name], 'Cache-Control': 'no-store' });
      rsp.end(buf);
    });
  });
  srv.on('error', (e) => { bridgePort = null; logLine('мостик:', String(e)); rej(e); });
  srv.listen(0, '127.0.0.1', () => res(srv.address().port));
})));
// название и обложка по ссылке: официальный oEmbed, без ключей
const OEMBED = { yt: 'https://www.youtube.com/oembed?format=json&url=', sc: 'https://soundcloud.com/oembed?format=json&url=' };
ipcMain.handle('net:oembed', async (_e, kind, url) => {
  if (!OEMBED[kind] || !/^https:\/\//.test(String(url))) return null;
  try { const r = await net.fetch(OEMBED[kind] + encodeURIComponent(url), { headers: UA }); return r.ok ? await r.json() : null; } catch { return null; }
});
const getBytes = async (url, max, okType) => {
  const r = await net.fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (okType && !okType.test(type) && !okType.test(url)) throw new Error('По ссылке не песня');
  if (Number(r.headers.get('content-length')) > max) throw new Error('Файл слишком большой');
  const buf = await r.arrayBuffer();
  if (buf.byteLength > max) throw new Error('Файл слишком большой');
  return { buf, type, url: r.url };
};
// обложки только с серверов SoundCloud и YouTube
ipcMain.handle('net:img', async (_e, url) => {
  if (!/^https:\/\/([a-z0-9-]+\.sndcdn\.com|i\.ytimg\.com)\//.test(String(url))) return null;
  try { return (await getBytes(url, 5e6, /^image\//)).buf; } catch { return null; }
});
// прямая ссылка на mp3 и т.п. — скачиваем как обычный файл
ipcMain.handle('net:file', async (_e, url) => {
  if (!/^https?:\/\//.test(String(url))) throw new Error('Это не ссылка');
  const f = await getBytes(url, 400e6, /^(audio|video)\/|\.(mp3|ogg|wav|flac|m4a|opus|aac|mp4|webm)(\?|$)/i);
  return { buf: f.buf, type: f.type, name: decodeURIComponent(new URL(f.url).pathname.split('/').pop() || 'song.mp3') };
});
// короткие ссылки on.soundcloud.com ведут редиректом на настоящую
ipcMain.handle('net:final', async (_e, url) => {
  if (!/^https:\/\/on\.soundcloud\.com\//.test(String(url))) return url;
  try { const r = await net.fetch(url, { headers: UA }); return r.url; } catch { return url; }
});
// поиск прямо в Linea: сайт SoundCloud или YouTube в своём окне и кнопка «В Linea»
const SITES = { sc: 'https://soundcloud.com/discover', yt: 'https://www.youtube.com/' };
let browse = null;
// в окне сайтов можно уйти по ссылкам куда угодно, а Electron без своих правил молча разрешает любому сайту микрофон,
// камеру, геолокацию и запуск программ по ссылкам вида ms-…: или steam://. Плееру и сайтам нужны только полный экран и копирование ссылки
const PERMS = new Set(['fullscreen', 'clipboard-sanitized-write', 'mediaKeySystem']); // mediaKeySystem — защищённое видео в плеере YouTube
function lockPerms() {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(PERMS.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => PERMS.has(perm));
}
ipcMain.on('browse:open', (_e, site) => { if (SITES[site]) openBrowse(SITES[site]); });
// окно сайтов — в той же сессии, что и плеер: вход в YouTube или SoundCloud здесь работает и для песен в Linea
function openBrowse(url) {
  if (!browse) {
    browse = new BrowserWindow({
      width: 1100, height: 780, title: 'Найти песню', icon: iconPath(prefs.icon), autoHideMenuBar: true, backgroundColor: '#09090D',
      webPreferences: { preload: path.join(__dirname, 'preload-browse.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // сайты не пускают «Electron», представляемся обычным Chrome
    browse.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) browse.loadURL(url); return { action: 'deny' }; });
    browse.on('closed', () => { browse = null; if (win) win.webContents.send('browse:closed'); });
  }
  browse.loadURL(url);
  browse.show(); browse.focus();
}
ipcMain.on('browse:add', (e, url) => {
  if (!browse || e.sender !== browse.webContents || !win) return;
  win.webContents.send('net:add', String(url).slice(0, 2000));
});

// ==================== обновления по воздуху ====================
// установленная Linea сама проверяет релизы на GitHub, тихо качает новую версию и предлагает перезапуститься
let updReady = null;
function setupUpdates() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return; // портативную обновлять некуда
  let au;
  try { ({ autoUpdater: au } = require('electron-updater')); } catch (e) { logLine('обновления:', String(e)); return; }
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true; // если не нажал «Обновить», поставится при выходе
  au.on('update-downloaded', (i) => { updReady = i.version; logLine('обновление скачано', i.version); if (win) win.webContents.send('upd:ready', i.version); });
  au.on('error', (e) => logLine('обновления: ошибка', String((e && e.message) || e)));
  const check = () => au.checkForUpdates().catch((e) => logLine('обновления: не проверилось', String(e)));
  setTimeout(check, 5000);
  setInterval(check, 2 * 60 * 60 * 1000);
  ipcMain.handle('upd:check', () => check().then(() => true));
  ipcMain.on('upd:install', () => { quitting = true; au.quitAndInstall(true, true); });
}
ipcMain.handle('upd:state', () => ({ version: app.getVersion(), ready: updReady, can: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE }));
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
