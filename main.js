'use strict';
const { app, BrowserWindow, ipcMain, net, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

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


// ==================== распознавание слов: whisper.cpp прямо на компьютере ====================
// программа ставится с GitHub whisper.cpp, модель — с Hugging Face; оба качаются один раз
const W_DIR = () => path.join(app.getPath('userData'), 'whisper');
const MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`;
const REL_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const REL_PREFIX = 'https://github.com/ggml-org/whisper.cpp/releases/download/';
let job = null; // { ctrl, proc }

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}
// whisper.cpp и tar читают пути в кодировке Windows и ломаются на русских буквах (папка пользователя «ЧЕЛ»),
// поэтому запускаем их из рабочей папки и даём только короткие латинские пути
function run(cmd, args, onErr, cwd) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, cwd }); } catch { resolve(-1); return; }
    if (job) job.proc = p;
    let buf = '';
    p.stderr.on('data', (d) => { if (!onErr) return; buf += d; const ls = buf.split(/\r?\n/); buf = ls.pop(); ls.forEach(onErr); });
    p.stdout.on('data', () => {});
    p.on('error', () => resolve(-1));
    p.on('close', (code) => resolve(code));
  });
}
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
async function ensureWhisper(send, signal) {
  const dir = W_DIR(), binDir = path.join(dir, 'bin'), model = path.join(dir, MODEL);
  fs.mkdirSync(dir, { recursive: true });
  let exe = findFile(binDir, 'whisper-cli.exe');
  if (!exe || (await run(exe, ['-h'])) !== 0) {
    exe = null;
    logLine('whisper: ставлю, exe был', exe);
    const rel = await (await net.fetch(REL_API, { headers: UA, signal })).json();
    const assets = (rel && rel.assets) || [];
    const pick = (re) => assets.find((a) => re.test(a.name));
    const gpu = await app.getGPUInfo('basic').catch(() => ({}));
    const nvidia = ((gpu && gpu.gpuDevice) || []).some((d) => d.vendorId === 0x10de);
    // видеокарта NVIDIA: сборка с CUDA (в разы быстрее); иначе — обычная для процессора
    logLine('whisper: релиз', rel && rel.tag_name, 'файлы', assets.map((a) => a.name), 'nvidia', nvidia);
    const tries = [nvidia && (pick(/^whisper-bin-win-cuda-12[\d.]*-x64\.zip$/) || pick(/^whisper-cublas-12[\d.]*-bin-x64\.zip$/)), pick(/^whisper-bin-x64\.zip$/)].filter(Boolean);
    for (const a of tries) {
      if (!a.browser_download_url.startsWith(REL_PREFIX)) continue;
      const zip = path.join(dir, a.name);
      await download(a.browser_download_url, zip, (p) => send('bin', p), signal);
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.mkdirSync(binDir, { recursive: true });
      send('unzip', 0);
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const tc = await run(tar, ['-xf', a.name, '-C', 'bin'], null, dir);
      fs.rmSync(zip, { force: true });
      exe = findFile(binDir, 'whisper-cli.exe');
      const hc = exe ? await run(exe, ['-h']) : null;
      logLine('whisper: скачал', a.name, 'tar', tc, 'exe', exe, '-h', hc);
      if (hc === 0) break;
      exe = null;
    }
    if (!exe) throw new Error('Не получилось поставить распознавание.');
  }
  if (!fs.existsSync(model)) { logLine('whisper: качаю модель'); await download(MODEL_URL, model, (p) => send('model', p), signal); logLine('whisper: модель скачана', fs.statSync(model).size); }
  return { exe, model };
}
ipcMain.handle('whisper:run', async (e, q) => {
  if (job) throw new Error('Уже распознаю другую песню.');
  const wav = q && q.wav;
  if (!(wav instanceof ArrayBuffer) || wav.byteLength < 44 || wav.byteLength > 300e6) throw new Error('Не тот звук.');
  const lang = /^(auto|[a-z]{2})$/.test(q.lang) ? q.lang : 'auto';
  const ctrl = new AbortController();
  job = { ctrl, proc: null };
  const send = (stage, p) => { if (!e.sender.isDestroyed()) e.sender.send('whisper:progress', { stage, p }); };
  const tmp = path.join(W_DIR(), 'job');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const { exe } = await ensureWhisper(send, ctrl.signal);
    const base = path.join(tmp, 'out');
    fs.writeFileSync(path.join(tmp, 'in.wav'), Buffer.from(wav));
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 1)));
    // -dtw даёт точное время каждого слова; -mc 0 не даёт модели зацикливаться на припевах
    const args = ['-m', MODEL, '-f', 'job/in.wav', '-l', lang, '-ojf', '-of', 'job/out', '-dtw', 'large.v3.turbo', '-nfa', '-sns', '-mc', '0', '-pp', '-t', threads];
    const tail = []; // последние строки whisper — показать, если он упадёт
    const progress = (line) => { const m = line.match(/progress\s*=\s*(\d+)%/); if (m) send('run', Number(m[1]) / 100); else if (line.trim()) { tail.push(line.trim()); if (tail.length > 4) tail.shift(); } };
    send('run', 0);
    let code = await run(exe, args, progress, W_DIR());
    logLine('whisper: код', code, tail);
    if (code !== 0 && !ctrl.signal.aborted) { send('cpu', 0); code = await run(exe, [...args, '-ng'], progress, W_DIR()); } // видеокарта не завелась — считаем на процессоре
    if (ctrl.signal.aborted) return null;
    logLine('whisper: итог', code, fs.existsSync(base + '.json'), tail);
    if (code !== 0 || !fs.existsSync(base + '.json')) throw new Error('Распознавание не получилось (код ' + code + '). ' + tail.slice(-2).join(' | ').slice(0, 300));
    return fs.readFileSync(base + '.json', 'utf8');
  } catch (err) {
    logLine('whisper: ошибка', String((err && err.stack) || err));
    if (ctrl.signal.aborted) return null;
    throw err;
  } finally {
    job = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
ipcMain.on('log', (_e, m) => logLine('окно:', String(m).slice(0, 2000)));
ipcMain.handle('whisper:cancel', () => {
  if (!job) return;
  job.ctrl.abort();
  if (job.proc) job.proc.kill();
});
ipcMain.handle('whisper:ready', () => fs.existsSync(path.join(W_DIR(), MODEL)) && !!findFile(path.join(W_DIR(), 'bin'), 'whisper-cli.exe'));

// ==================== стрелки везде, как в Soundpad ====================
// Пока включено, ← и → принадлежат Linea во всех программах: переключают песни, даже если окно свёрнуто
ipcMain.handle('keys:global', (_e, on) => {
  globalShortcut.unregister('Left');
  globalShortcut.unregister('Right');
  if (!on) return true;
  const send = (d) => () => { if (win && !win.isDestroyed()) win.webContents.send('keys:step', d); };
  const ok = globalShortcut.register('Left', send(-1)) && globalShortcut.register('Right', send(1));
  if (!ok) { globalShortcut.unregister('Left'); globalShortcut.unregister('Right'); }
  return ok;
});

// ==================== слова поверх игр ====================
// прозрачное окно поверх всех окон; клики проходят сквозь него в игру
let overlay = null;
const OV_FILE = () => path.join(app.getPath('userData'), 'overlay.json');
function ovBounds() {
  try { const b = JSON.parse(fs.readFileSync(OV_FILE(), 'utf8')); if (screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.x < d.bounds.x + d.bounds.width && b.y >= d.bounds.y - 50 && b.y < d.bounds.y + d.bounds.height)) return b; } catch { /* первый запуск */ }
  const wa = screen.getPrimaryDisplay().workArea;
  return { width: 960, height: 170, x: Math.round(wa.x + (wa.width - 960) / 2), y: wa.y + wa.height - 210 };
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

app.whenReady().then(() => { logLine('Linea запущен', app.getVersion(), process.platform, os.release()); createWindow(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
