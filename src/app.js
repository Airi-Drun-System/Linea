'use strict';
const $ = (id) => document.getElementById(id);

// ---------- хранилище: всё в try/catch, без него плеер тоже работает ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const settings = Object.assign({ volume: 0.8 }, store.get('ln.settings', {}));
const saveSettings = () => store.set('ln.settings', settings);

// песни лежат в IndexedDB вместе с файлом: библиотека переживает перезапуск
const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('linea', 2);
      r.onupgradeneeded = () => { for (const n of ['songs', 'bgs']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  const api = (store) => ({
    all: () => tx(store, 'readonly', (s) => s.getAll()).catch(() => []),
    put: (v) => tx(store, 'readwrite', (s) => s.put(v)).catch(() => {}),
    del: (id) => tx(store, 'readwrite', (s) => s.delete(id)).catch(() => {}),
  });
  return Object.assign(api('songs'), { bgs: api('bgs') });
})();

// ---------- теги mp3: название, исполнитель и обложка из ID3 ----------
async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out;
    const ver = head[3];
    const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
    const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const size = syncsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if (ver < 3) return out; // ID3v2.2 почти не встречается
    let p = 0;
    if (head[5] & 0x40) p = ver === 4 ? syncsafe(buf, 0) : be32(buf, 0) + 4;
    const text = (b) => {
      const enc = b[0], body = b.subarray(1);
      const dec = new TextDecoder(enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1');
      return dec.decode(body).replace(/\0+$/g, '').split('\0')[0].trim();
    };
    while (p + 10 < buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsz = ver === 4 ? syncsafe(buf, p + 4) : be32(buf, p + 4);
      const start = p + 10, data = buf.subarray(start, start + fsz);
      if (id === 'TIT2') out.title = text(data);
      else if (id === 'TPE1') out.artist = text(data);
      else if (id === 'APIC' && !out.cover) {
        const enc = data[0];
        let q = 1, mime = '';
        while (q < data.length && data[q]) mime += String.fromCharCode(data[q++]);
        q += 2; // ноль и тип картинки
        if (enc === 1 || enc === 2) { while (q + 1 < data.length && (data[q] || data[q + 1])) q += 2; q += 2; } else { while (q < data.length && data[q]) q++; q++; }
        out.cover = new Blob([data.slice(q)], { type: /\//.test(mime) ? mime : 'image/jpeg' });
      }
      p = start + fsz;
    }
  } catch { /* битые теги — просто без них */ }
  return out;
}

// ---------- цвета песни: из обложки, как в музыкальных плеерах ----------
function hsl(h, s, l) { return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`; }
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return '#' + f(0) + f(8) + f(4);
}
function paletteFromHues(h1, h2) {
  // четыре цвета связок: два главных из обложки и два соседних по кругу
  const hs = [h1, h2, (h1 + 150) % 360, (h2 + 200) % 360];
  return hs.map((h) => hslToHex(h, 88, 64));
}
function paletteOf(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 32, 32);
    const d = x.getImageData(0, 0, 32, 32).data, bins = new Array(18).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
      if (sat < 0.25 || mx < 0.2) continue;
      let h = 0;
      if (mx !== mn) h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
      bins[Math.floor(((h * 60 + 360) % 360) / 20)] += sat * mx;
    }
    const order = bins.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    if (order[0][0] < 1) return null; // почти серая обложка
    const h1 = order[0][1] * 20 + 10;
    const second = order.find(([v, i]) => v > 0 && Math.min(Math.abs(i * 20 + 10 - h1), 360 - Math.abs(i * 20 + 10 - h1)) >= 50);
    return paletteFromHues(h1, second ? second[1] * 20 + 10 : (h1 + 60) % 360);
  } catch { return null; }
}
const paletteOfId = (id) => { const h = hashStr(id); return paletteFromHues(h % 360, (h % 360 + 70 + (h >> 9) % 80) % 360); };

// обложка для песни без картинки: своя генеративная картинка из колец-нот в цветах песни
function makeArt(song) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d'), pal = song.pal, R = rng(hashStr(song.id));
  x.fillStyle = '#101018'; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 3; i++) {
    const gr = x.createRadialGradient(R() * 512, R() * 512, 0, R() * 512, R() * 512, 300 + R() * 200);
    gr.addColorStop(0, pal[i] + 'cc'); gr.addColorStop(1, pal[i] + '00');
    x.fillStyle = gr; x.fillRect(0, 0, 512, 512);
  }
  for (let i = 0; i < 9; i++) {
    const cx = R() * 512, cy = R() * 512, r = 24 + R() * 70;
    x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = r * 0.14;
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = pal[i % 4]; x.lineWidth = 3;
    x.beginPath(); x.arc(cx, cy, r * (1.4 + R()), 0, Math.PI * 2); x.stroke();
  }
  x.font = '900 120px "Dela Gothic One", "Arial Black", sans-serif';
  x.fillStyle = 'rgba(255,255,255,0.92)';
  x.textBaseline = 'alphabetic';
  x.fillText((song.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase(), 30, 480);
  return c.toDataURL('image/jpeg', 0.85);
}

// картинка песни: из тегов, своя или сгенерированная; цвета берутся из неё
function songImage(song) {
  if (song.imgPromise) return song.imgPromise;
  song.imgPromise = new Promise((resolve) => {
    const blob = song.customBg || song.cover;
    if (!song.pal) song.pal = paletteOfId(song.id);
    const url = blob ? URL.createObjectURL(blob) : makeArt(song);
    const img = new Image();
    img.onload = () => { const p = blob ? paletteOf(img) : null; if (p) song.pal = p; song.img = img; song.imgUrl = url; resolve(img); };
    img.onerror = () => { song.imgUrl = makeArt(song); const i2 = new Image(); i2.onload = () => { song.img = i2; resolve(i2); }; i2.src = song.imgUrl; };
    img.src = url;
  });
  return song.imgPromise;
}


// ==================== библиотека ====================
const songs = [];
let cur = null; // песня, которая играет
let query = '';
const decks = [new Audio(), new Audio()];
let audio = decks[0]; // та, что играет сейчас
const deckUrl = new Map(), deckGain = new Map();
decks.forEach((d) => { d.volume = settings.volume; d.preservesPitch = false; });
function setSrc(el, blob) {
  const old = deckUrl.get(el);
  if (old) URL.revokeObjectURL(old);
  const u = URL.createObjectURL(blob);
  deckUrl.set(el, u);
  el.src = u;
}
// минус (без голоса), если он уже сделан и включён
const srcOf = (s) => (settings.karaoke && s.inst ? s.inst : s.blob);

const saveSong = (song) => { const { img, imgUrl, imgPromise, bgUrl, vox, ...rec } = song; DB.put(rec); };
const lyricsOf = (s) => (s && s.lyrics && s.lyrics.length ? s.lyrics : null);

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function showLoading(title, text, p) {
  $('loading').hidden = false;
  $('loadTitle').textContent = title;
  $('loadText').textContent = text;
  $('loadBar').style.width = Math.round((p || 0) * 100) + '%';
}
function fileDuration(file) {
  return new Promise((res) => {
    const a = new Audio(), url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); res(v); };
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration * 1000 : 0);
    a.onerror = () => done(-1);
    a.src = url;
  });
}
async function addFiles(list) {
  let added = 0, first = null;
  for (const [k, file] of list.entries()) {
    const id = 'f' + hashStr(`${file.name}|${file.size}|${file.lastModified}`).toString(36);
    if (songs.some((s) => s.id === id)) continue;
    showLoading('Добавляю песни', file.name, k / list.length);
    const duration = await fileDuration(file);
    if (duration < 0) { toast(`Не получилось открыть ${file.name}`); continue; }
    const vid = isVideoFile(file);
    const tags = vid ? { cover: await videoFrame(file) } : await readTags(file);
    const song = { id, name: tags.title || cleanName(file.name), artist: tags.artist || '', cover: tags.cover || null, blob: file, duration, added: Date.now() };
    await DB.put(song);
    songs.unshift(song);
    if (plById(view)) plById(view).ids.push(song.id);
    added++;
    first = first || song;
    findLyrics(song, true); // слова ищутся сами, в фоне
  }
  $('loading').hidden = true;
  savePls(); renderPls();
  renderSongs();
  if (first && !cur) load(first, true);
  else upText();
  if (added > 1) toast(`Добавлено песен: ${added}`);
}
$('file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
for (const ev of ['dragenter', 'dragover']) addEventListener(ev, (e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
addEventListener('drop', (e) => e.dataTransfer.types.includes('Files') && addFiles([...(e.dataTransfer?.files || [])].filter((x) => /^audio\//.test(x.type) || /^video\//.test(x.type) || /\.(mp3|ogg|wav|flac|m4a|opus|aac|mp4|webm|mov|mkv)$/i.test(x.name))));
$('find').addEventListener('input', () => { query = $('find').value.trim().toLowerCase(); renderSongs(); });

function renderSongs() {
  const box = $('songs');
  const keep = box.scrollTop;
  box.textContent = '';
  const shown = listOf(view).filter((s) => !query || (s.name + ' ' + s.artist).toLowerCase().includes(query));
  shown.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'song' + (s === cur ? ' on' : '');
    el.style.setProperty('--i', Math.min(i, 15));
    el.tabIndex = 0;
    el.draggable = true;
    el.innerHTML = '<img alt=""><b></b><button class="del" title="Убрать из плеера">×</button><small></small>';
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-linea-song', s.id); e.dataTransfer.effectAllowed = 'copy'; });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); songMenu(s, e.clientX, e.clientY); });
    const img = el.querySelector('img');
    if (s.imgUrl) img.src = s.imgUrl; else songImage(s).then(() => { img.src = s.imgUrl; });
    el.querySelector('b').textContent = s.name;
    el.querySelector('small').textContent = `${s.artist ? s.artist + ' · ' : ''}${fmtDur(s.duration)}${lyricsOf(s) ? ' · слова' : ''}`;
    const del = el.querySelector('.del');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!del.classList.contains('sure')) { del.classList.add('sure'); del.textContent = 'Убрать?'; setTimeout(() => { del.classList.remove('sure'); del.textContent = '×'; }, 2500); return; }
      await DB.del(s.id);
      songs.splice(songs.indexOf(s), 1);
      playlists.forEach((p) => { p.ids = p.ids.filter((id) => id !== s.id); });
      savePls(); renderPls();
      if (s === cur) { audio.pause(); audio.removeAttribute('src'); cur = null; if (songs[0]) load(songs[0], false); else showSong(); }
      renderSongs(); upText();
    });
    el.addEventListener('click', () => { ctx = view; if (s !== cur) { pushHist(); load(s, true); } else toggle(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(s, true); });
    box.appendChild(el);
  });
  if (!songs.length) box.innerHTML = '<p class="none">Тут будут твои песни. Можно добавить сразу пачку.</p>';
  else if (view !== 'all' && !listOf(view).length) box.innerHTML = '<p class="none">Плейлист пустой. Перетащи сюда песни из «Все песни» или нажми на песню правой кнопкой.</p>';
  else if (!shown.length) box.innerHTML = '<p class="none">Ничего не нашлось.</p>';
  box.scrollTop = keep;
}


// ==================== плейлисты ====================
let playlists = store.get('ln.playlists', []); // [{ id, name, ids }]
let view = 'all', ctx = 'all'; // что открыто в списке и откуда играет очередь
const savePls = () => store.set('ln.playlists', playlists);
const plById = (id) => playlists.find((p) => p.id === id);
const listOf = (v) => { const p = plById(v); return p ? p.ids.map((id) => songs.find((s) => s.id === id)).filter(Boolean) : songs; };
const queue = () => listOf(ctx);
const plural = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'песня' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'песни' : 'песен'}`;

function renderPls() {
  const box = $('pls');
  box.textContent = '';
  [{ id: 'all', name: 'Все песни' }, ...playlists].forEach((p) => {
    const el = document.createElement('div'), list = listOf(p.id);
    el.className = 'pl' + (view === p.id ? ' on' : '');
    el.tabIndex = 0;
    const mos = document.createElement('span');
    mos.className = 'mos' + (p.id === 'all' ? ' all' : '');
    if (p.id === 'all') mos.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"/></svg>';
    else list.slice(0, 4).forEach((s) => { const i = document.createElement('img'); i.alt = ''; if (s.imgUrl) i.src = s.imgUrl; else songImage(s).then(() => { i.src = s.imgUrl; }); mos.appendChild(i); });
    if (list.length && list.length < 4 && p.id !== 'all') mos.classList.add('one');
    const b = document.createElement('b'), sm = document.createElement('small');
    b.textContent = p.name; sm.textContent = plural(list.length);
    el.append(mos, b, sm);
    const open = () => { view = p.id; renderPls(); renderSongs(); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    if (p.id !== 'all') {
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); plMenu(p, e.clientX, e.clientY); });
      // песню из списка можно перетащить на плейлист
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-linea-song')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drop'); addToPl(p, e.dataTransfer.getData('text/x-linea-song')); });
    }
    box.appendChild(el);
  });
}
function addToPl(p, id) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  if (p.ids.includes(id)) { toast('Эта песня уже в плейлисте'); return; }
  p.ids.push(id);
  savePls(); renderPls();
  if (view === p.id) renderSongs();
  toast(`«${s.name}» → ${p.name}`);
}
function askName(title, value) {
  return new Promise((res) => {
    $('nameTitle').textContent = title;
    $('nameIn').value = value || '';
    $('nameDlg').hidden = false;
    $('nameIn').focus(); $('nameIn').select();
    const done = (v) => { $('nameDlg').hidden = true; $('nameOk').onclick = $('nameCancel').onclick = $('nameIn').onkeydown = null; res(v); };
    $('nameOk').onclick = () => done($('nameIn').value.trim() || null);
    $('nameCancel').onclick = () => done(null);
    $('nameIn').onkeydown = (e) => { if (e.key === 'Enter') done($('nameIn').value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}
async function newPl(withSong) {
  const name = await askName('Новый плейлист', `Плейлист ${playlists.length + 1}`);
  if (!name) return;
  const p = { id: 'p' + Date.now().toString(36), name: name.slice(0, 60), ids: [] };
  playlists.push(p);
  if (withSong) p.ids.push(withSong.id);
  savePls(); renderPls();
}
$('plNew').addEventListener('click', () => newPl());

// меню по правой кнопке
function showMenu(items, x, y) {
  const m = $('menu');
  m.textContent = '';
  for (const it of items) {
    if (it.label) { const h = document.createElement('p'); h.textContent = it.label; m.appendChild(h); continue; }
    const b = document.createElement('button');
    b.textContent = it.text;
    if (it.bad) b.className = 'bad';
    b.addEventListener('click', () => { hideMenu(); it.act(); });
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideMenu() { $('menu').hidden = true; }
addEventListener('pointerdown', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target)) hideMenu(); });
addEventListener('blur', hideMenu);
function songMenu(s, x, y) {
  const items = [{ text: 'Играть', act: () => { ctx = view; pushHist(); load(s, true); } }, { label: 'Добавить в плейлист' }];
  playlists.forEach((p) => items.push({ text: p.name, act: () => addToPl(p, s.id) }));
  items.push({ text: '+ Новый плейлист', act: () => newPl(s) });
  const cp = plById(view);
  if (cp) items.push({ text: 'Убрать из этого плейлиста', bad: true, act: () => { cp.ids = cp.ids.filter((id) => id !== s.id); savePls(); renderPls(); renderSongs(); upText(); } });
  showMenu(items, x, y);
}
function plMenu(p, x, y) {
  showMenu([
    { text: 'Играть', act: () => { const l = listOf(p.id); if (!l.length) return; view = ctx = p.id; renderPls(); renderSongs(); pushHist(); load(settings.shuffle ? l[Math.floor(Math.random() * l.length)] : l[0], true); } },
    { text: 'Переименовать', act: async () => { const n = await askName('Название плейлиста', p.name); if (n) { p.name = n.slice(0, 60); savePls(); renderPls(); } } },
    { text: 'Удалить плейлист', bad: true, act: () => { playlists = playlists.filter((x) => x !== p); if (view === p.id) view = 'all'; if (ctx === p.id) ctx = 'all'; savePls(); renderPls(); renderSongs(); upText(); toast('Плейлист удалён, песни остались'); } },
  ], x, y);
}

// ==================== фон: обложка, свои картинки или градиент ====================
const BG = Object.assign({ mode: 'cover', blur: 70, dim: 0.25, bright: 1, interval: 12, react: true, anim: true, colors: null }, settings.bg);
let bgImgs = [], bgLayer = 0, bgTimer = 0, bgIdx = 0, bgShown = null;
const saveBg = () => { settings.bg = BG; saveSettings(); };
// две картинки по очереди: новая проявляется поверх старой
function bgShow(u) {
  if (u === bgShown) return;
  bgShown = u;
  const next = $(bgLayer ? 'bgA' : 'bgB'), prev = $(bgLayer ? 'bgB' : 'bgA');
  bgLayer ^= 1;
  next.style.backgroundImage = u ? `url("${u}")` : 'none';
  next.classList.toggle('show', !!u);
  prev.classList.remove('show');
}
function songBgUrl(s) {
  if (!s || !s.bg) return null;
  if (!s.bgUrl) s.bgUrl = URL.createObjectURL(s.bg);
  return s.bgUrl;
}
function applyBg() {
  const r = document.documentElement.style;
  r.setProperty('--bg-blur', BG.blur + 'px');
  r.setProperty('--bg-dim', BG.dim);
  r.setProperty('--bg-bright', BG.bright);
  r.setProperty('--bg-react', BG.react ? 0.45 : 0);
  const cols = BG.colors || (cur && cur.pal) || ['#4A4A52', '#9A9AA4', '#26262C'];
  cols.slice(0, 3).forEach((c, i) => r.setProperty('--g' + (i + 1), c));
  $('backdrop').classList.toggle('grad-on', BG.mode === 'gradient');
  $('backdrop').classList.toggle('anim', !!BG.anim);
  clearInterval(bgTimer);
  const own = songBgUrl(cur);
  if (bgVideo()) { bgShow(null); return; }
  if (BG.mode === 'gradient') bgShow(own);
  else if (own) bgShow(own);
  else if (BG.mode === 'images' && bgImgs.length) {
    bgShow(bgImgs[bgIdx % bgImgs.length].url);
    if (bgImgs.length > 1) bgTimer = setInterval(() => { bgIdx++; bgShow(bgImgs[bgIdx % bgImgs.length].url); }, BG.interval * 1000);
  } else bgShow(cur ? cur.imgUrl || null : null);
}

const BG_RANGES = [
  ['bgBlur', 'blur', (v) => v + ' px'],
  ['bgDim', 'dim', (v) => Math.round(v * 100) + '%'],
  ['bgBright', 'bright', (v) => Math.round(v * 100) + '%'],
  ['bgInt', 'interval', (v) => v + ' с'],
];
function renderBgDlg() {
  document.querySelectorAll('#bgMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === BG.mode));
  $('bgImagesBox').hidden = BG.mode !== 'images';
  $('bgGradBox').hidden = BG.mode !== 'gradient';
  for (const [id, key, fmt] of BG_RANGES) { $(id).value = BG[key]; $(id + 'V').textContent = fmt(BG[key]); }
  const cols = BG.colors || (cur && cur.pal) || ['#4A4A52', '#9A9AA4', '#26262C'];
  ['g1', 'g2', 'g3'].forEach((id, i) => { $(id).value = cols[i]; });
  $('gAuto').classList.toggle('on', !BG.colors);
  $('gAnim').checked = !!BG.anim;
  $('bgReact').checked = !!BG.react;
  $('glassSel').value = settings.glass || 'liquid';
  $('xfSel').value = String(settings.xfade || 0);
  $('fxSel').value = settings.fx || 'snow';
  $('vidBg').checked = settings.videoBg !== false;
  $('keysG').checked = settings.globalKeys !== false;
  $('ovOn').checked = !!settings.overlay;
  $('ovMove').hidden = !settings.overlay;
  $('ovMove').textContent = ovMove ? 'Готово' : 'Подвинуть';
  document.querySelectorAll('.pcOnly').forEach((el) => { el.hidden = !window.lnApp; });
  $('bgSong').textContent = cur && cur.bg ? 'Убрать картинку этой песни' : 'Своя картинка для этой песни';
  $('bgSong').disabled = !cur;
  const box = $('bgThumbs');
  box.textContent = '';
  bgImgs.forEach((im) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.style.backgroundImage = `url("${im.url}")`;
    const x = document.createElement('button');
    x.textContent = '×'; x.title = 'Убрать';
    x.addEventListener('click', async () => { await DB.bgs.del(im.id); URL.revokeObjectURL(im.url); bgImgs = bgImgs.filter((y) => y !== im); bgShown = null; renderBgDlg(); applyBg(); });
    t.appendChild(x);
    box.appendChild(t);
  });
  const add = document.createElement('button');
  add.className = 'thumb addT'; add.textContent = '+';
  add.title = 'Добавить картинки';
  add.addEventListener('click', () => $('bgFile').click());
  box.appendChild(add);
}
$('bgBtn').addEventListener('click', () => { renderBgDlg(); $('bgDlg').hidden = false; });
$('bgClose').addEventListener('click', () => { $('bgDlg').hidden = true; });
$('bgDlg').addEventListener('click', (e) => { if (e.target === $('bgDlg')) $('bgDlg').hidden = true; });
document.querySelectorAll('#bgMode button').forEach((b) => b.addEventListener('click', () => { BG.mode = b.dataset.m; bgShown = null; saveBg(); applyBg(); renderBgDlg(); }));
for (const [id, key, fmt] of BG_RANGES) {
  $(id).addEventListener('input', () => { BG[key] = Number($(id).value); $(id + 'V').textContent = fmt(BG[key]); saveBg(); if (key !== 'interval') applyBg(); });
  if (key === 'interval') $(id).addEventListener('change', applyBg);
}
['g1', 'g2', 'g3'].forEach((id) => $(id).addEventListener('input', () => { BG.colors = ['g1', 'g2', 'g3'].map((g) => $(g).value); saveBg(); applyBg(); $('gAuto').classList.remove('on'); }));
$('gAuto').addEventListener('click', () => { BG.colors = null; saveBg(); applyBg(); renderBgDlg(); });
$('gAnim').addEventListener('change', () => { BG.anim = $('gAnim').checked; saveBg(); applyBg(); });
$('bgReact').addEventListener('change', () => { BG.react = $('bgReact').checked; saveBg(); applyBg(); });
$('bgFile').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    if (!/^image\//.test(f.type)) continue;
    const rec = { id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), blob: f, added: Date.now() };
    await DB.bgs.put(rec);
    bgImgs.push({ ...rec, url: URL.createObjectURL(f) });
  }
  e.target.value = '';
  if (BG.mode !== 'images') BG.mode = 'images';
  saveBg(); bgShown = null; applyBg(); renderBgDlg();
});
$('bgSong').addEventListener('click', () => {
  if (!cur) return;
  if (cur.bg) { if (cur.bgUrl) URL.revokeObjectURL(cur.bgUrl); cur.bg = null; cur.bgUrl = null; saveSong(cur); applyBg(); renderBgDlg(); }
  else $('bgSongFile').click();
});
$('bgSongFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !cur) return;
  cur.bg = f; cur.bgUrl = null;
  saveSong(cur); applyBg(); renderBgDlg();
});
$('glassSel').addEventListener('change', () => { settings.glass = $('glassSel').value; saveSettings(); lgRefresh(); });
$('xfSel').addEventListener('change', () => { settings.xfade = Number($('xfSel').value); saveSettings(); });
$('keysG').addEventListener('change', () => setGlobalKeys($('keysG').checked));
$('ovOn').addEventListener('change', () => { settings.overlay = $('ovOn').checked; saveSettings(); ovMove = false; ovApply(); renderBgDlg(); });
$('ovMove').addEventListener('click', () => { ovMove = !ovMove; ovApply(); renderBgDlg(); });

// ==================== жидкое стекло ====================
// Панель преломляет то, что под ней: у краёв фон «затягивает», как в линзе, с лёгкой радугой.
// Работает через SVG-фильтр в backdrop-filter — это умеет движок Chrome, на котором собран Linea.
const NS = 'http://www.w3.org/2000/svg';
const lgDefs = (() => { const sv = document.createElementNS(NS, 'svg'); sv.setAttribute('width', 0); sv.setAttribute('height', 0); sv.style.position = 'absolute'; const d = document.createElementNS(NS, 'defs'); sv.appendChild(d); document.body.appendChild(sv); return d; })();
const lgEls = new Map(); // элемент -> { id, w, h }
let lgN = 0;
// карта смещений: R — сдвиг по x, G — по y; 128 — без сдвига. Сдвиг растёт к краю, как у толстого стекла
function lgMap(w, h, r, bez) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'), im = x.createImageData(w, h), d = im.data;
  const hw = w / 2, hh = h / 2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const dx = i + 0.5 - hw, dy = j + 0.5 - hh, px = Math.abs(dx) - (hw - r), py = Math.abs(dy) - (hh - r);
    let dist, nx = 0, ny = 0;
    if (px > 0 && py > 0) { const l = Math.hypot(px, py) || 1; dist = r - l; nx = (px / l) * Math.sign(dx); ny = (py / l) * Math.sign(dy); }
    else if (px > py) { dist = r - px; nx = Math.sign(dx); } else { dist = r - py; ny = Math.sign(dy); }
    const k = (j * w + i) * 4, t = Math.max(0, 1 - dist / bez), s = t * t * (3 - 2 * t);
    d[k] = 128 + nx * s * 127; d[k + 1] = 128 + ny * s * 127; d[k + 2] = 128; d[k + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return c.toDataURL();
}
function lgApply(el) {
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
  if (!w || !h) return;
  let rec = lgEls.get(el);
  if (rec && rec.w === w && rec.h === h) return;
  if (!rec) { rec = { id: 'lg' + ++lgN }; lgEls.set(el, rec); }
  rec.w = w; rec.h = h;
  const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
  const bez = Math.max(8, Math.min(44, Math.min(w, h) * 0.42)), sc = Math.round(Math.min(72, bez * 1.8));
  let f = document.getElementById(rec.id);
  if (!f) { f = document.createElementNS(NS, 'filter'); f.id = rec.id; lgDefs.appendChild(f); }
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) f.setAttribute(k, v);
  const disp = (scale, res) => `<feDisplacementMap in="soft" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="${res}"/>`;
  // три канала смещаются чуть по-разному — получается радужная кромка
  f.innerHTML = `<feGaussianBlur in="SourceGraphic" stdDeviation="2" result="soft"/>
    <feImage href="${lgMap(w, h, r, bez)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
    ${disp(sc, 'dr')}${disp(Math.round(sc * 0.9), 'dg')}${disp(Math.round(sc * 0.8), 'db')}
    <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/>
    <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/>
    <feColorMatrix in="db" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/>
    <feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen" result="rgb"/>
    <feColorMatrix in="rgb" type="saturate" values="1.45"/>`;
  el.style.backdropFilter = `url(#${rec.id})`;
}
const lgRO = new ResizeObserver((es) => { if (settings.glass === 'plain') return; es.forEach((e) => lgApply(e.target)); });
const LG_SEL = '.step, .card, .menu';
function lgWatch(el) { el.classList.add('lg'); lgRO.observe(el); if (settings.glass !== 'plain') lgApply(el); }
function lgRefresh() {
  const on = settings.glass !== 'plain';
  document.body.classList.toggle('liquid', on);
  document.querySelectorAll(LG_SEL).forEach((el) => {
    if (on) { lgEls.delete(el); lgWatch(el); } else { el.style.backdropFilter = ''; }
  });
}
lgRefresh();
// ==================== воспроизведение ====================
let actx = null, analyser = null, freq = null;
const PATH = { play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z' };
function play(fadeIn) {
  if (!cur) { if (songs[0]) load(songs[0], true); return; }
  // анализатор баса для обложки и громкость каждой деки: подключаем один раз, после первого нажатия
  if (!actx) {
    actx = new AudioContext();
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    freq = new Uint8Array(analyser.frequencyBinCount);
    decks.forEach((d) => { const g = actx.createGain(); actx.createMediaElementSource(d).connect(g); g.connect(analyser); deckGain.set(d, g); });
    analyser.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  const g = deckGain.get(audio).gain, now = actx.currentTime;
  g.cancelScheduledValues(now);
  if (fadeIn) { g.setValueAtTime(0, now); g.linearRampToValueAtTime(1, now + settings.xfade); } else g.setValueAtTime(1, now);
  audio.play().catch(() => {});
}
function fadeOut(d) {
  const g = deckGain.get(d).gain, now = actx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + settings.xfade);
  setTimeout(() => { if (d !== audio) d.pause(); }, settings.xfade * 1000 + 80);
}
const toggle = () => (audio.paused ? play() : audio.pause());
function applyPalette(song) {
  const c = song.pal || paletteOfId(song.id), r = document.documentElement.style;
  r.setProperty('--a1', c[0]); r.setProperty('--a2', c[1]); r.setProperty('--a3', c[2]);
  const n = parseInt(c[0].slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  r.setProperty('--on-a1', lum > 0.62 ? '#16070C' : '#FFFFFF');
}
function showSong() {
  const meta = $('meta');
  meta.classList.remove('swap'); void meta.offsetWidth; meta.classList.add('swap');
  $('title').textContent = cur ? cur.name : 'Linea';
  if (!cur) $('coverImg').src = 'cube.png'; // пока песен нет — на месте обложки куб
  $('artist').textContent = cur ? cur.artist || 'Неизвестный исполнитель' : 'Добавь песни слева';
  $('dur').textContent = fmtDur(cur ? cur.duration : 0);
  document.title = cur ? `${cur.name} — Linea` : 'Linea';
  renderLines();
}
function upText() {
  const q = queue(), nx = cur && q.length && q[(q.indexOf(cur) + 1) % q.length];
  $('up').textContent = '';
  if (settings.shuffle && q.length > 2) { $('up').textContent = 'Дальше: случайная'; return; }
  if (!nx || nx === cur) return;
  const b = document.createElement('b'); b.textContent = nx.name;
  $('up').append('Дальше: ', b);
}
async function load(song, autoplay) {
  if (sync) syncDone(false);
  // плавный переход: старая песня затихает на своей деке, новая нарастает на другой
  const fade = !!(autoplay && actx && settings.xfade && cur && cur !== song && !audio.paused);
  const other = decks[decks[0] === audio ? 1 : 0];
  if (fade) { fadeOut(audio); audio = other; } else other.pause();
  xfading = false;
  cur = song;
  store.set('ln.last', song.id);
  setSrc(audio, srcOf(song));
  audio.defaultPlaybackRate = audio.playbackRate = SPEEDS[settings.speed || 0][0];
  audio.preservesPitch = false; // sped up и slowed как в тиктоке: вместе с темпом меняется и тон
  showSong(); upText(); renderSongs();
  if (slideDir) { const c = document.querySelector('.cover'); c.classList.remove('inNext', 'inPrev'); void c.offsetWidth; c.classList.add(slideDir > 0 ? 'inNext' : 'inPrev'); slideDir = 0; }
  waveDirty = true;
  if (!song.wave) waveOf(song);
  if (autoplay) play(fade);
  showModes();
  await songImage(song);
  if (cur !== song) return;
  applyPalette(song);
  waveDirty = true;
  $('coverImg').src = song.imgUrl;
  applyBg();
  if (window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: song.name, artist: song.artist || '', artwork: [{ src: song.imgUrl }] });
}
// история прослушанного: «назад» возвращает к тому, что реально играло, и в перемешке тоже
const hist = [];
let slideDir = 0;
function pushHist() { if (cur) { hist.push(cur); if (hist.length > 100) hist.shift(); } }
function step(d) {
  const q = queue().length ? queue() : songs;
  if (sync || !q.length) return;
  if (d < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; } // как в любом плеере: сначала в начало песни
  let nx = null;
  if (d < 0) while (hist.length && !nx) { const h = hist.pop(); if (songs.includes(h) && h !== cur) nx = h; }
  if (!nx && d > 0 && settings.shuffle && q.length > 1) do nx = q[Math.floor(Math.random() * q.length)]; while (nx === cur);
  if (!nx) { const i = cur ? q.indexOf(cur) : -1; nx = q[(i + d + q.length) % q.length]; }
  if (d > 0) pushHist();
  slideDir = d;
  load(nx, true);
}
function setVolume(v) {
  settings.volume = Math.round(Math.max(0, Math.min(1, v)) * 20) / 20;
  decks.forEach((d) => { d.volume = settings.volume; });
  $('vol').value = settings.volume;
  $('vol').style.setProperty('--pos', settings.volume * 100 + '%');
  saveSettings();
}
// события слушаем у обеих дек, но реагируем только на текущую
const onDeck = (ev, fn) => decks.forEach((d) => d.addEventListener(ev, (e) => { if (e.target === audio) fn(e); }));
let xfading = false;
onDeck('play', () => { vSync(true);  $('play').querySelector('path').setAttribute('d', PATH.pause); $('play').ariaLabel = 'Пауза'; });
onDeck('seeked', () => vSync(true));
onDeck('ratechange', () => vSync(false));
onDeck('pause', () => { vSync(false);  $('play').querySelector('path').setAttribute('d', PATH.play); $('play').ariaLabel = 'Играть'; });
// за несколько секунд до конца начинаем следующую — получается переход без тишины
onDeck('timeupdate', () => {
  if (!settings.xfade || settings.repeat || sync || xfading || !audio.duration || audio.paused) return;
  if ((audio.duration - audio.currentTime) / audio.playbackRate <= settings.xfade) { xfading = true; step(1); }
});
onDeck('ended', () => {
  if (!sync && settings.repeat) { audio.currentTime = 0; play(); return; }
  if (!sync) return step(1);
  // песня кончилась посреди разметки: сохраняем то, что успели
  if (sync.i) { sync.lines.length = sync.i; syncDone(true); } else syncDone(false);
});
onDeck('error', () => { if (cur) toast('Этот файл не играет. Попробуй mp3.'); });
// медиа-клавиши клавиатуры и наушников: работают и в свёрнутом окне
if ('mediaSession' in navigator) {
  for (const [a, f] of [['play', play], ['pause', () => audio.pause()], ['previoustrack', () => step(-1)], ['nexttrack', () => step(1)]]) {
    try { navigator.mediaSession.setActionHandler(a, f); } catch { /* нет такой кнопки */ }
  }
}

// ==================== слова ====================
let lineIdx = -2, sungN = -1, editing = false, sync = null, seeking = false, lastCur = '', kick = 0, bassAvg = 0;
const searching = new Set();
function renderLines() {
  const box = $('lines');
  box.textContent = '';
  const lines = sync ? sync.lines.map((text) => ({ text })) : lyricsOf(cur) || [];
  $('lyr').classList.toggle('syncing', !!sync);
  // в центре либо слова, либо обложка; кнопка «Слова» переключает
  $('stage').classList.toggle('lyrOn', lines.length > 0 && (!!sync || settings.lyricsOn !== false));
  $('lyrBtn').hidden = !lyricsOf(cur);
  $('lyrBtn').ariaPressed = String(settings.lyricsOn !== false);
  $('findLrc').hidden = !window.lnApp;
  $('offs').hidden = !lyricsOf(cur) || !!sync;
  $('offV').textContent = offText();
  lines.forEach((l) => {
    const el = document.createElement('div');
    el.className = 'ln' + (l.text ? '' : ' gap') + (l.words ? ' wl' : '');
    if (l.words) l.words.forEach((w, k) => { const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = (k ? ' ' : '') + w.text; el.appendChild(sp); });
    else el.textContent = l.text || '• • •';
    if (!sync) {
      el.addEventListener('click', () => { if (el.isContentEditable) return; audio.currentTime = Math.max(0, (l.t + (cur.lyrOff || 0)) / 1000); if (audio.paused) play(); });
      el.addEventListener('dblclick', () => editLine(el, l));
    }
    box.appendChild(el);
  });
  box.style.transform = '';
  lineIdx = -2;
  sungN = -1;
}
// опечатка в словах — двойной клик по строке, правишь текст, Enter; время слов сохраняется
function editLine(el, l) {
  if (editing) return;
  editing = true;
  const song = cur, L = song.lyrics, i = L.indexOf(l);
  el.textContent = l.text;
  el.contentEditable = 'true';
  el.focus();
  getSelection().selectAllChildren(el);
  const finish = (save) => {
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    editing = false;
    if (save && song === cur && i >= 0) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text) L.splice(i, 1);
      else if (text !== l.text) L[i] = retextLine(l, text, L[i + 1] && L[i + 1].t);
      saveSong(song);
    }
    renderLines();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}
// слова с таймингами — с lrclib.net (только в программе для Windows)
async function findLyrics(song, quiet, q) {
  if (!window.lnApp) return false;
  searching.add(song.id);
  if (song === cur) renderLines();
  try {
    const r = await window.lnApp.findLyrics(Object.assign({ title: song.name, artist: song.artist || '', duration: Math.round(song.duration / 1000) }, q));
    const lines = r && r.synced ? parseLRC(r.synced) : [];
    if (lines.length) { song.lyrics = lines; song.lyrOff = 0; }
    else if (r && r.plain) song.plain = r.plain;
    saveSong(song);
    if (!quiet && !lines.length) {
      if (r && r.plain && q) { searching.delete(song.id); syncOpen(r.plain); toast('Нашёлся текст. Разметь его пробелом'); }
      else toast(r && r.plain ? 'Нашёлся только текст без таймингов' : 'Слова не нашлись');
    }
    return lines.length > 0;
  } catch { return false; } finally {
    searching.delete(song.id);
    if (song === cur) renderLines();
    renderSongs();
  }
}
function findOpen() {
  if (!cur) return;
  $('findQ').value = cur.artist ? `${cur.artist} — ${cur.name}` : cur.name;
  $('findDlg').hidden = false;
  $('findQ').select();
}
function findGo() {
  const v = $('findQ').value.trim();
  if (!v) return;
  $('findDlg').hidden = true;
  const m = v.split(/\s+[-—–]\s+/);
  findLyrics(cur, false, m.length > 1 ? { artist: m[0], title: m.slice(1).join(' - '), loose: true } : { artist: '', title: v, loose: true });
}
$('findLrc').addEventListener('click', findOpen);
$('findGo').addEventListener('click', findGo);
$('findCancel').addEventListener('click', () => { $('findDlg').hidden = true; });
$('findQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') findGo(); });
$('fileLrc').addEventListener('click', () => cur && $('lrcFile').click());
$('lrcFile').addEventListener('change', async (e) => {
  const f = e.target.files[0], song = cur;
  e.target.value = '';
  if (!f || !song) return;
  const lines = parseLRC(await f.text());
  if (!lines.length) { toast('В файле нет меток времени вида [01:23.45]'); return; }
  song.lyrics = lines;
  saveSong(song);
  renderLines(); renderSongs();
});

// разметка: песня с начала, пробел на каждой новой строке
function syncOpen(text) {
  if (!cur) return;
  const L = lyricsOf(cur);
  $('syncText').value = typeof text === 'string' ? text : L ? L.map((l) => l.text).filter(Boolean).join('\n') : cur.plain || '';
  $('syncClear').hidden = !L;
  $('syncDlg').hidden = false;
  $('syncText').focus();
}
function syncTap() {
  sync.stamps[sync.i] = Math.max(0, audio.currentTime * 1000 - 120); // люди жмут чуть позже, чем начинают петь
  sync.i++;
  if (sync.i >= sync.lines.length) syncDone(true);
}
function syncUndo() {
  if (!sync.i) return;
  sync.i--;
  audio.currentTime = Math.max(0, sync.stamps[sync.i] / 1000 - 3);
}
function syncDone(save) {
  if (save) {
    cur.lyrics = sync.lines.map((text, k) => ({ t: sync.stamps[k], text }));
    cur.lyrOff = 0;
    saveSong(cur);
    renderSongs();
  }
  sync = null;
  $('syncBar').hidden = true;
  renderLines();
  if (save) { audio.currentTime = 0; play(); toast('Слова сохранены'); }
}
$('editLrc').addEventListener('click', syncOpen);
$('syncGo').addEventListener('click', () => {
  const lines = $('syncText').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) { $('syncText').focus(); return; }
  $('syncDlg').hidden = true;
  sync = { lines, i: 0, stamps: [] };
  $('syncBar').hidden = false;
  renderLines();
  audio.currentTime = 0;
  play();
});
$('syncClear').addEventListener('click', () => { cur.lyrics = null; saveSong(cur); $('syncDlg').hidden = true; renderLines(); renderSongs(); });
$('syncCancel').addEventListener('click', () => { $('syncDlg').hidden = true; });
$('syncTap').addEventListener('click', () => sync && syncTap());
$('syncUndo').addEventListener('click', () => sync && syncUndo());
$('syncStop').addEventListener('click', () => sync && syncDone(false));


let cancelJob = null;
$('loadCancel').addEventListener('click', () => cancelJob && cancelJob());


// ==================== волна, скорость, режимы, сдвиг слов ====================
let waveDirty = true, wavePx = -1;
async function waveOf(song) {
  try {
    // 8 кГц моно хватает, чтобы увидеть громкость, и считается быстро
    const buf = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await song.blob.arrayBuffer());
    song.wave = peaks(buf.getChannelData(0), 200);
    saveSong(song);
    if (song === cur) waveDirty = true;
  } catch { /* не декодируется — останется ровная полоска */ }
}
function drawWave() {
  const cv = $('waveCv'), w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
  if (!w) return;
  const v = cur && audio.duration ? (seeking ? $('seek').value / 1000 : audio.currentTime / audio.duration) : 0;
  const px = Math.round(v * w);
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); waveDirty = true; }
  if (!waveDirty && px === wavePx) return;
  waveDirty = false; wavePx = px;
  const x = cv.getContext('2d'), wave = cur && cur.wave, bw = 3, gap = 2, n = Math.floor(w / (bw + gap));
  const a1 = getComputedStyle(document.documentElement).getPropertyValue('--a1').trim() || '#fff';
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  for (let k = 0; k < n; k++) {
    const amp = wave ? wave[Math.floor((k / n) * wave.length)] : 0.3;
    const bh = Math.max(3, amp * (h - 4)), bx = k * (bw + gap);
    x.fillStyle = bx + bw / 2 <= px ? a1 : 'rgba(255,255,255,.22)';
    x.beginPath();
    x.roundRect(bx, (h - bh) / 2, bw, bh, 1.5);
    x.fill();
  }
}
addEventListener('resize', () => { waveDirty = true; });

// скорость: обычная, sped up, slowed
const SPEEDS = [[1, 'Обычная'], [1.25, 'Sped up'], [0.8, 'Slowed']];
function showModes() {
  const sp = SPEEDS[settings.speed || 0];
  $('spd').textContent = sp[1];
  $('spd').classList.toggle('on', sp[0] !== 1);
  $('shuf').ariaPressed = String(!!settings.shuffle);
  $('kar').ariaPressed = String(!!(settings.karaoke && cur && cur.inst));
  $('kar').hidden = !(window.lnApp && window.lnApp.separate);
  $('kar').title = cur && cur.inst ? 'Минус: песня без голоса' : 'Убрать голос из песни (нейросеть)';
  $('rep').ariaPressed = String(!!settings.repeat);
}
$('spd').addEventListener('click', () => {
  settings.speed = ((settings.speed || 0) + 1) % SPEEDS.length;
  decks.forEach((d) => { d.defaultPlaybackRate = d.playbackRate = SPEEDS[settings.speed][0]; });
  saveSettings(); showModes();
});
$('shuf').addEventListener('click', () => { settings.shuffle = !settings.shuffle; saveSettings(); showModes(); upText(); });
$('rep').addEventListener('click', () => { settings.repeat = !settings.repeat; saveSettings(); showModes(); });

// колесо мыши по обложке листает треки, как свайп в телефоне
let wheelAcc = 0, wheelAt = 0;
document.querySelector('.cover').addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - wheelAt < 550) return;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  step(wheelAcc > 0 ? 1 : -1);
  wheelAcc = 0; wheelAt = now;
}, { passive: false });

// слова спешат или опаздывают — двигаем на 0.1 с
function shiftLyrics(d) {
  if (!cur || !lyricsOf(cur)) return;
  cur.lyrOff = Math.max(-10000, Math.min(10000, (cur.lyrOff || 0) + d));
  saveSong(cur);
  $('offV').textContent = offText();
  lineIdx = -2;
}
function offText() { const v = ((cur && cur.lyrOff) || 0) / 1000; return (v >= 0 ? '+' : '') + v.toFixed(1) + ' с'; }
$('offM').addEventListener('click', () => shiftLyrics(-100));
$('offP').addEventListener('click', () => shiftLyrics(100));
showModes();


// ==================== стрелки везде, оверлей со словами ====================
async function setGlobalKeys(on, quiet) {
  settings.globalKeys = on;
  saveSettings();
  if (!window.lnApp || !window.lnApp.globalKeys) return;
  const ok = await window.lnApp.globalKeys(on);
  if (on && !ok && !quiet) toast('Стрелки уже заняты другой программой');
}
if (window.lnApp && window.lnApp.onStep) window.lnApp.onStep((d) => (d === 'play' ? play() : d === 'pause' ? audio.pause() : step(d)));

let ovMove = false, ovLast = '';
function ovApply() { if (window.lnApp && window.lnApp.overlay) window.lnApp.overlay({ on: !!settings.overlay, move: ovMove }); }
// раз в 80 мс шлём оверлею строку: таймер работает, даже когда окно плеера свёрнуто
setInterval(() => {
  if (!settings.overlay || !window.lnApp || !window.lnApp.overlayState) return;
  const L = lyricsOf(cur);
  let st = { i: -1, text: '' };
  if (L && !audio.paused) {
    const lt = audio.currentTime * 1000 - (cur.lyrOff || 0), i = lineAt(L, lt);
    if (i >= 0) {
      const l = L[i], nx = L.slice(i + 1).find((x) => x.text);
      st = { i, text: l.text, next: nx ? nx.text : '', color: (cur.pal || [])[0] };
      if (l.words) { st.words = l.words.map((w) => w.text); st.sung = l.words.filter((w) => w.t <= lt).length; }
      else { const end = i + 1 < L.length ? L[i + 1].t : l.t + 4000; st.p = Math.min(1, (lt - l.t) / Math.max(400, Math.min(end - l.t, 7000) * 0.85)); }
    }
  }
  const key = JSON.stringify(st);
  if (key !== ovLast) { ovLast = key; window.lnApp.overlayState(st); }
}, 80);

// ==================== минус: нейросеть отделяет голос ====================
function wav16(chans, sr) {
  const n = chans[0].length, ch = chans.length, v = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 32767, true); o += 2; }
  return new Blob([v.buffer], { type: 'audio/wav' });
}
const SEP_STAGE = {
  model: ['Скачиваю нейросеть', 'Один раз, около 170 МБ.'],
  run: ['Убираю голос', 'Нейросеть разбирает песню на голос и музыку.'],
  cpu: ['Убираю голос', 'Видеокарта не подошла, считаю на процессоре. Будет медленнее.'],
};
if (window.lnApp && window.lnApp.onSep) window.lnApp.onSep(({ stage, p }) => { const [a, b] = SEP_STAGE[stage] || SEP_STAGE.run; showLoading(a, b, p); });
async function sepOpen() {
  if (!cur || !window.lnApp || !window.lnApp.separate) return;
  $('sepFirst').hidden = await window.lnApp.sepReady().catch(() => false);
  $('sepDlg').hidden = false;
}
async function sepRun() {
  const song = cur;
  $('sepDlg').hidden = true;
  showLoading('Готовлю звук', song.name, 0);
  $('loadActs').hidden = false;
  cancelJob = () => window.lnApp.sepCancel();
  try {
    const buf = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(await song.blob.arrayBuffer());
    const left = buf.getChannelData(0), right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
    const out = await window.lnApp.separate({ left, right });
    if (!out) return; // отменили
    showLoading('Сохраняю', 'Минус готов.', 1);
    song.inst = wav16([out.iL, out.iR], 44100);
    saveSong(song);
    settings.karaoke = true; saveSettings();
    if (song === cur) reloadSrc();
    renderSongs();
    toast('Готово: играет без голоса. Кнопка «Минус» возвращает голос');
  } catch (e) {
    if (window.lnApp.log) window.lnApp.log(String((e && e.stack) || e));
    toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    $('loading').hidden = true;
    $('loadActs').hidden = true;
    cancelJob = null;
  }
}
// переключить оригинал/минус на ходу, с того же места
function reloadSrc() {
  const t = audio.currentTime, was = !audio.paused;
  setSrc(audio, srcOf(cur));
  audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; if (was) play(); }, { once: true });
  showModes();
}
$('kar').addEventListener('click', () => {
  if (!cur) return;
  if (!cur.inst) { sepOpen(); return; }
  settings.karaoke = !settings.karaoke;
  saveSettings();
  reloadSrc();
});
$('sepGo').addEventListener('click', sepRun);
$('sepCancel').addEventListener('click', () => { $('sepDlg').hidden = true; });

// ==================== частицы на фоне: снег или пылинки ====================
const fxCv = $('fx'), fxG = fxCv.getContext('2d');
let fxParts = [], fxW = 0, fxH = 0;
function fxResize() {
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  fxW = innerWidth; fxH = innerHeight;
  fxCv.width = Math.round(fxW * dpr); fxCv.height = Math.round(fxH * dpr);
  fxG.setTransform(dpr, 0, 0, dpr, 0, 0);
  // количество от площади окна: на большом экране не пусто, на маленьком не каша
  const n = Math.round(Math.min(180, (fxW * fxH) / 9000));
  fxParts = Array.from({ length: n }, () => fxNew(true));
}
function fxNew(anywhere) {
  const z = Math.random(); // глубина: дальние мельче, медленнее и тусклее
  return { x: Math.random() * fxW, y: anywhere ? Math.random() * fxH : -10, z, r: 0.8 + z * 2.6, vy: 14 + z * 46, ph: Math.random() * 6.28, sw: 8 + Math.random() * 22, a: 0.25 + z * 0.6 };
}
let fxLast = performance.now();
function fxFrame(now) {
  const mode = settings.fx || 'snow';
  const dt = Math.min(0.05, (now - fxLast) / 1000);
  fxLast = now;
  fxG.clearRect(0, 0, fxW, fxH);
  if (mode === 'off') return;
  const boost = 1 + kick * 1.8; // на ударах баса частицы чуть ускоряются и ярче
  const col = mode === 'dust' ? getComputedStyle(document.documentElement).getPropertyValue('--a1').trim() || '#fff' : '#fff';
  fxG.fillStyle = col;
  for (const p of fxParts) {
    p.ph += dt * 0.8;
    if (mode === 'snow') { p.y += p.vy * dt * boost; p.x += Math.sin(p.ph) * p.sw * dt; if (p.y > fxH + 10) Object.assign(p, fxNew(false)); }
    else { p.y -= p.vy * 0.35 * dt * boost; p.x += Math.sin(p.ph) * p.sw * 0.5 * dt; if (p.y < -10) Object.assign(p, fxNew(false), { y: fxH + 10 }); }
    if (p.x < -10) p.x = fxW + 10; else if (p.x > fxW + 10) p.x = -10;
    fxG.globalAlpha = Math.min(1, p.a * (mode === 'dust' ? 0.7 + 0.3 * Math.sin(p.ph * 3) : 1) * (0.85 + kick * 0.4));
    fxG.beginPath(); fxG.arc(p.x, p.y, p.r, 0, 6.283); fxG.fill();
  }
  fxG.globalAlpha = 1;
}
addEventListener('resize', fxResize);
fxResize();
$('vidBg').addEventListener('change', () => { settings.videoBg = $('vidBg').checked; saveSettings(); applyBg(); });
$('fxSel').addEventListener('change', () => { settings.fx = $('fxSel').value; saveSettings(); });

// ==================== mp4 как песня: звук играет плеер, видео — размытый фон ====================
const isVideoFile = (f) => !!f && (/^video\//.test(f.type || '') || /\.(mp4|webm|mov|mkv)$/i.test(f.name || ''));
// кадр из видео — обложка песни
function videoFrame(file) {
  return new Promise((res) => {
    const v = document.createElement('video'), u = URL.createObjectURL(file);
    const done = (b) => { clearTimeout(to); URL.revokeObjectURL(u); res(b || null); };
    const to = setTimeout(() => done(null), 8000);
    v.muted = true; v.preload = 'auto';
    v.onloadeddata = () => { v.currentTime = Math.min((v.duration || 0) * 0.15, 20); };
    v.onseeked = () => {
      const c = document.createElement('canvas'), s = Math.min(v.videoWidth, v.videoHeight);
      if (!s) { done(null); return; }
      c.width = c.height = 512;
      c.getContext('2d').drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, 512, 512);
      c.toBlob((b) => done(b), 'image/jpeg', 0.85);
    };
    v.onerror = () => done(null);
    v.src = u;
  });
}
let vUrl = '';
function bgVideo() {
  const v = $('bgV'), on = !!cur && isVideoFile(cur.blob) && settings.videoBg !== false;
  v.classList.toggle('show', on);
  if (!on) { v.pause(); if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = ''; v.removeAttribute('src'); v.dataset.id = ''; } return false; }
  if (v.dataset.id !== cur.id) { if (vUrl) URL.revokeObjectURL(vUrl); vUrl = URL.createObjectURL(cur.blob); v.src = vUrl; v.dataset.id = cur.id; }
  vSync(true);
  return true;
}
// видео идёт за звуком: та же скорость, то же место, пауза вместе
function vSync(force) {
  const v = $('bgV');
  if (!v.classList.contains('show')) return;
  v.playbackRate = audio.playbackRate;
  if (force || Math.abs(v.currentTime - audio.currentTime) > 0.3) { try { v.currentTime = audio.currentTime; } catch { /* ещё не загрузилось */ } }
  if (audio.paused) v.pause(); else v.play().catch(() => {});
}
setInterval(() => vSync(false), 1000);
// ==================== кадр: перемотка, бас, строка ====================
function frame(now) {
  requestAnimationFrame(frame);
  fxFrame(now || performance.now());
  const t = audio.currentTime * 1000;
  if (!seeking && cur) {
    const v = audio.duration ? audio.currentTime / audio.duration : 0;
    $('seek').value = Math.round(v * 1000);
    $('seek').style.setProperty('--pos', (v * 100).toFixed(2) + '%');
    const c = fmtDur(t);
    if (c !== lastCur) $('cur').textContent = lastCur = c;
  }
  // обложка подпрыгивает на ударах: бас сравниваем с недавним средним, а не с порогом
  if (analyser && !audio.paused) {
    analyser.getByteFrequencyData(freq);
    const b = (freq[0] + freq[1] + freq[2]) / 765;
    bassAvg += (b - bassAvg) * 0.04;
    kick = Math.max(Math.min(1, (b - bassAvg) * 5), kick * 0.86);
  } else kick *= 0.86;
  document.documentElement.style.setProperty('--kick', kick.toFixed(3));

  drawWave();
  const L = lyricsOf(cur), els = $('lines').children;
  const lt = t - ((cur && cur.lyrOff) || 0); // слова со сдвигом
  if (editing || !els.length || (!sync && !L)) return;
  const i = sync ? sync.i : lineAt(L, lt);
  if (i !== lineIdx) {
    lineIdx = i;
    sungN = -1;
    for (let k = 0; k < els.length; k++) {
      els[k].classList.toggle('past', k < i);
      els[k].classList.toggle(sync ? 'next' : 'on', k === i);
    }
    const el = els[Math.max(0, Math.min(els.length - 1, i))];
    $('lines').style.transform = `translateY(${-(el.offsetTop + el.offsetHeight / 2)}px)`;
  }
  if (!sync && i >= 0 && L[i].words) {
    // слово загорается в момент, когда его поют
    const W = L[i].words;
    let n = 0;
    while (n < W.length && W[n].t <= lt) n++;
    if (n !== sungN) { sungN = n; [...els[i].children].forEach((sp, k) => sp.classList.toggle('sung', k < n)); }
  } else if (!sync && i >= 0) {
    // строка заливается слева направо, пока её поют
    const end = i + 1 < L.length ? L[i + 1].t : L[i].t + 4000;
    els[i].style.setProperty('--p', Math.min(1, (lt - L[i].t) / Math.max(400, Math.min(end - L[i].t, 7000) * 0.85)).toFixed(3));
  }
}

// ==================== управление ====================
$('play').addEventListener('click', toggle);
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('vol').addEventListener('input', () => setVolume(Number($('vol').value)));
$('seek').addEventListener('input', () => {
  seeking = true;
  const v = $('seek').value / 1000;
  $('seek').style.setProperty('--pos', v * 100 + '%');
  if (audio.duration) $('cur').textContent = fmtDur(v * audio.duration * 1000);
});
$('seek').addEventListener('change', () => { if (audio.duration) audio.currentTime = $('seek').value / 1000 * audio.duration; seeking = false; });
// список песен выезжает слева поверх плеера
const libOpen = (on) => document.body.classList.toggle('lib', on);
const wide = () => matchMedia('(min-width:1200px)').matches;
// в широком окне список закреплён, кнопка его прячет и показывает; в узком — выдвигает поверх
$('libBtn').addEventListener('click', () => { if (wide()) { settings.libHide = document.body.classList.toggle('libHide'); saveSettings(); } else libOpen(!document.body.classList.contains('lib')); });
document.body.classList.toggle('libHide', !!settings.libHide);
$('libClose').addEventListener('click', () => libOpen(false));
$('scrim').addEventListener('click', () => libOpen(false));
$('songs').addEventListener('click', (e) => { if (e.target.closest('.song') && !e.target.closest('.del')) libOpen(false); });
document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => window.lnApp && window.lnApp.win && window.lnApp.win(b.dataset.win)));
if (!(window.lnApp && window.lnApp.win)) document.querySelector('.winBtns').hidden = true;
$('lyrBtn').addEventListener('click', () => { settings.lyricsOn = settings.lyricsOn === false; saveSettings(); renderLines(); });
// кнопка, нажатая мышью, не держит фокус: пробел остаётся паузой
addEventListener('mouseup', (e) => { const b = e.target.closest && e.target.closest('button,input[type=range]'); if (b) b.blur(); });
addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (e.target.isContentEditable) return;
  if (!$('menu').hidden && e.code === 'Escape') { hideMenu(); return; }
  if (document.body.classList.contains('lib') && e.code === 'Escape') { libOpen(false); return; }
  if (!$('nameDlg').hidden) return;
  if (!$('sepDlg').hidden) { if (e.code === 'Escape') $('sepDlg').hidden = true; return; }
  if (!$('bgDlg').hidden) { if (e.code === 'Escape') $('bgDlg').hidden = true; return; }
  if (!$('findDlg').hidden) { if (e.code === 'Escape') $('findDlg').hidden = true; return; }
  if (!$('syncDlg').hidden || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) {
    if (e.code === 'Escape') { $('syncDlg').hidden = true; e.target.blur(); }
    return;
  }
  if (sync) {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!e.repeat) syncTap(); }
    else if (e.code === 'Backspace') { e.preventDefault(); syncUndo(); }
    else if (e.code === 'Escape') syncDone(false);
    return;
  }
  if (e.code === 'Space' && tag === 'BUTTON') return; // кнопку с фокусом клавиатуры пробел нажмёт сам
  const act = { ArrowRight: () => step(1), ArrowLeft: () => step(-1), Space: toggle, PageDown: () => play(), PageUp: () => audio.pause(), ArrowUp: () => setVolume(settings.volume + 0.05), ArrowDown: () => setVolume(settings.volume - 0.05) }[e.code];
  if (!act) return;
  e.preventDefault();
  if (!e.repeat || e.code === 'ArrowUp' || e.code === 'ArrowDown') act();
});

// ==================== старт ====================
(async () => {
  setVolume(settings.volume);
  decks.forEach((d) => { d.defaultPlaybackRate = d.playbackRate = SPEEDS[settings.speed || 0][0]; });
  if (window.lnApp && window.lnApp.globalKeys) setGlobalKeys(settings.globalKeys !== false, true);
  ovApply();
  bgImgs = (await DB.bgs.all()).sort((a, b) => a.added - b.added).map((r) => ({ ...r, url: URL.createObjectURL(r.blob) }));
  applyBg();
  songs.push(...(await DB.all()).sort((a, b) => b.added - a.added));
  renderPls();
  renderSongs();
  const last = songs.find((s) => s.id === store.get('ln.last', '')) || songs[0];
  if (last) load(last, false); else showSong();
  requestAnimationFrame(frame);
})();
