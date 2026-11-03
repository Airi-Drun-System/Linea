'use strict';
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

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
function run(cmd, args, onErr) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { windowsHide: true }); } catch { resolve(-1); return; }
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
  if (!exe || (await run(exe, ['--version'])) !== 0) {
    exe = null;
    const rel = await (await net.fetch(REL_API, { headers: UA, signal })).json();
    const assets = (rel && rel.assets) || [];
    const pick = (re) => assets.find((a) => re.test(a.name));
    const gpu = await app.getGPUInfo('basic').catch(() => ({}));
    const nvidia = ((gpu && gpu.gpuDevice) || []).some((d) => d.vendorId === 0x10de);
    // видеокарта NVIDIA: сборка с CUDA (в разы быстрее); иначе — обычная для процессора
    const tries = [nvidia && (pick(/^whisper-bin-win-cuda-12[\d.]*-x64\.zip$/) || pick(/^whisper-cublas-12[\d.]*-bin-x64\.zip$/)), pick(/^whisper-bin-x64\.zip$/)].filter(Boolean);
    for (const a of tries) {
      if (!a.browser_download_url.startsWith(REL_PREFIX)) continue;
      const zip = path.join(dir, a.name);
      await download(a.browser_download_url, zip, (p) => send('bin', p), signal);
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.mkdirSync(binDir, { recursive: true });
      send('unzip', 0);
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await run(tar, ['-xf', zip, '-C', binDir]);
      fs.rmSync(zip, { force: true });
      exe = findFile(binDir, 'whisper-cli.exe');
      if (exe && (await run(exe, ['--version'])) === 0) break;
      exe = null;
    }
    if (!exe) throw new Error('Не получилось поставить распознавание.');
  }
  if (!fs.existsSync(model)) await download(MODEL_URL, model, (p) => send('model', p), signal);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linea-'));
  try {
    const { exe, model } = await ensureWhisper(send, ctrl.signal);
    const input = path.join(tmp, 'in.wav'), base = path.join(tmp, 'out');
    fs.writeFileSync(input, Buffer.from(wav));
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 1)));
    // -dtw даёт точное время каждого слова; -mc 0 не даёт модели зацикливаться на припевах
    const args = ['-m', model, '-f', input, '-l', lang, '-ojf', '-of', base, '-dtw', 'large.v3.turbo', '-nfa', '-sns', '-mc', '0', '-pp', '-t', threads];
    const progress = (line) => { const m = line.match(/progress\s*=\s*(\d+)%/); if (m) send('run', Number(m[1]) / 100); };
    send('run', 0);
    let code = await run(exe, args, progress);
    if (code !== 0 && !ctrl.signal.aborted) { send('cpu', 0); code = await run(exe, [...args, '-ng'], progress); } // видеокарта не завелась — считаем на процессоре
    if (ctrl.signal.aborted) return null;
    if (code !== 0 || !fs.existsSync(base + '.json')) throw new Error('Распознавание не получилось.');
    return fs.readFileSync(base + '.json', 'utf8');
  } catch (err) {
    if (ctrl.signal.aborted) return null;
    throw err;
  } finally {
    job = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
ipcMain.handle('whisper:cancel', () => {
  if (!job) return;
  job.ctrl.abort();
  if (job.proc) job.proc.kill();
});
ipcMain.handle('whisper:ready', () => fs.existsSync(path.join(W_DIR(), MODEL)) && !!findFile(path.join(W_DIR(), 'bin'), 'whisper-cli.exe'));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
