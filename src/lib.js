'use strict';
// чистые помощники без DOM: их же проверяет test/lib.test.js
function hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const cleanName = (n) => n.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Без названия';

// слова в формате .lrc: [мм:сс.сс] строка; несколько меток на строке и [offset:] тоже понимаем
function parseLRC(textIn) {
  const lines = [];
  let offset = 0;
  for (const raw of textIn.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = Number(off[1]); continue; }
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    for (const m of tags) {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      lines.push({ t: (Number(m[1]) * 60 + Number(m[2]) + frac) * 1000 - offset, text: words });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}
// какая строка поётся в момент t (мс); -1 — ещё до первой
function lineAt(lines, t) {
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].t <= t) i++;
  return i;
}
// правка текста строки: новые слова раскладываются по времени старых, между ними — плавно
function retextLine(line, text, endT) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const old = (line.words && line.words.length ? line.words : [{ t: line.t }]).map((w) => w.t);
  const ends = [...old, Math.max(old[old.length - 1] + 300, endT || old[old.length - 1] + 3000)];
  const words = parts.map((p, k) => {
    const x = (k * old.length) / parts.length, i = Math.floor(x);
    return { t: Math.round(ends[i] + (ends[i + 1] - ends[i]) * (x - i)), text: p };
  });
  return { t: line.t, text: parts.join(' '), words };
}
// волна для полосы перемотки: n столбиков по громкости, 0..1
function peaks(data, n) {
  const out = new Array(n).fill(0), step = data.length / n;
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let i = Math.floor(k * step), e = Math.min(data.length, Math.floor((k + 1) * step)); i < e; i += 4) { s += data[i] * data[i]; c++; }
    out[k] = c ? Math.sqrt(s / c) : 0;
  }
  const max = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / max) * 100) / 100);
}
// авторазметка, шаг 1: огибающая голоса кадрами по 50 мс в полосе 300–3400 Гц. Берём среднее L·R, а не громкость:
// голос обычно посередине, а широкие гитары, подклады и хвосты эха в каналах разные и в произведении гасятся
function voiceEnv(L, R, rate) {
  const band = (x) => {
    const y = new Float32Array(x);
    for (const [f0, hp] of [[300, 1], [300, 1], [3400, 0]]) {
      const w = (2 * Math.PI * f0) / rate, c = Math.cos(w), al = Math.sin(w) / Math.SQRT2;
      const k = (hp ? 1 + c : 1 - c) / 2 / (1 + al), b1 = hp ? -2 * k : 2 * k, a1 = (-2 * c) / (1 + al), a2 = (1 - al) / (1 + al);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) { const v = k * (y[i] + x2) + b1 * x1 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = y[i] = v; }
    }
    return y;
  };
  const a = band(L), b = R ? band(R) : a, n = Math.round(rate / 20), env = new Float32Array(Math.floor(a.length / n));
  for (let f = 0; f < env.length; f++) {
    let s = 0;
    for (let i = f * n; i < (f + 1) * n; i++) s += a[i] * b[i];
    env[f] = Math.sqrt(Math.max(0, s / n));
  }
  return env;
}
// шаг 2: строки текста встают туда, где поют. Время без голоса (вступление, паузы) выкидываем, остальное делим
// между строками: длина строки — по числу слогов, начало — лучше сразу после паузы. Лучшую раскладку ищем перебором
// с запоминанием (для каждой строки и каждого возможного начала — цена лучшей раскладки всего, что до неё)
function autoLyrics(env, plain) {
  const lines = String(plain || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^\[.*\]$/.test(x)); // [Припев] не поют
  const n = lines.length, F = env.length;
  if (!n) return [];
  const db = Array.from(env, (v) => 20 * Math.log10(v + 1e-6)), q = [...db].sort((x, y) => x - y);
  // фраза — громче середины между тихим и громким. В паузах L·R бывает почти нулём, поэтому «тихое» — не ниже
  // громкого минус 30 дБ, иначе порог упадёт и пением станет любой шорох. Провалы между слогами короче 250 мс не пауза
  const hi = q[Math.floor(F * 0.8)], lo = Math.max(q[Math.floor(F * 0.2)], hi - 30);
  let seg = [];
  if (hi - lo > 3) {
    for (let f = 0; f < F; f++) {
      if (db[f] <= (lo + hi) / 2) continue;
      const s = seg[seg.length - 1];
      if (s && f - s[1] < 5) s[1] = f + 1; else seg.push([f, f + 1]);
    }
  }
  seg = seg.filter(([a, b]) => b - a >= 5);
  if (!seg.length) seg = [[0, F]]; // громкость ровная — пауз не найти, тогда поровну на всю песню
  // возможные начала строк — каждые полсекунды внутри фраз: поющее время u (паузы выкинуты), кадр, сразу ли после паузы
  const u = [], fr = [], on = [], g = Math.max(1, Math.min(10, Math.floor(F / n)));
  let U = 0;
  for (const [a, b] of seg) { for (let f = a; f < b; f += g) { u.push(U + f - a); fr.push(f); on.push(f === a ? 0 : 1); } U += b - a; }
  const syl = lines.map((x) => (x.match(/[aeiouyæøåäöüÿéèêëáàâíìîïóòôõúùûаеёиоуыэюяіїє]+/gi) || []).length || x.replace(/\s/g, '').length);
  const all = syl.reduce((s, x) => s + x, 0), C = u.length;
  // цена длины: квадрат ошибки в долях ожидаемой; если строка намного длиннее, дальше проигрыш — это дешевле
  const len = (x, e, avg) => { const r = (x - e) / e; return r < 0 ? r * r : Math.min(r * r, 1 + (0.1 * (x - e)) / avg); };
  let best = null;
  // часть «поющего» времени может оказаться гитарой, поэтому темп пробуем и чуть быстрее
  for (const k of [1, 0.85, 0.7]) {
    const avg = (U * k) / n, back = [];
    let cost = Float64Array.from(u, (x, c) => on[c] + (0.2 * x) / avg); // первая строка может пропустить вступление
    for (let i = 1; i < n; i++) {
      const e = (syl[i - 1] / all) * U * k, nc = new Float64Array(C), bk = new Int32Array(C);
      // начала дальше 3e: там цена растёт с длиной линейно, лучшее из них — бегущий минимум, без перебора
      let j = 0, fm = Infinity, fp = 0;
      for (let c = 0; c < C; c++) {
        for (; j < c && u[c] - u[j] > Math.max(3 * e, g); j++) { const v = cost[j] - (0.1 * u[j]) / avg; if (v < fm) { fm = v; fp = j; } }
        let m = fm + 1 + (0.1 * (u[c] - e)) / avg, b = fp;
        for (let p = j; p < c; p++) { const x = u[c] - u[p], v = x < g ? Infinity : cost[p] + len(x, e, avg); if (v < m) { m = v; b = p; } }
        nc[c] = m + on[c];
        bk[c] = b;
      }
      back.push(bk);
      cost = nc;
    }
    let c = 0, v = Infinity;
    cost.forEach((x, j) => { const y = x + len(U - u[j], (syl[n - 1] / all) * U * k, avg); if (y < v) { v = y; c = j; } });
    if (v < Infinity && (!best || v < best.v)) { const idx = [c]; for (let i = n - 2; i >= 0; i--) idx.unshift(back[i][idx[0]]); best = { v, idx }; }
  }
  // строк больше, чем полсекунд с голосом, — просто поровну
  const at = best ? best.idx.map((c) => fr[c]) : lines.map((_, i) => (i * F) / n);
  return lines.map((text, i) => ({ t: Math.max(0, Math.round(at[i] * 50 - 100)), text })); // чуть раньше голоса, как при разметке пробелом
}
// громкость песни для выравнивания, [rms, пик] в дБ: средняя по блокам 0.4 с без тишины и тихих мест
// (вступления, затухания) — как в стандарте EBU R128, только без частотной поправки
function loudness(L, R, rate) {
  const n = Math.round(rate * 0.4), ms = [], db = (x) => 10 * Math.log10(x);
  let peak = 0;
  for (let i = 0; i + n <= L.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) { const a = L[k], b = R ? R[k] : a; s += a * a + b * b; peak = Math.max(peak, Math.abs(a), Math.abs(b)); }
    ms.push(s / (2 * n));
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const loud = ms.filter((x) => db(x) > -70), gated = loud.filter((x) => db(x) > db(mean(loud)) - 10);
  return [gated.length ? Math.round(db(mean(gated)) * 10) / 10 : -70, Math.round(20 * Math.log10(peak || 1e-9) * 10) / 10];
}
// сколько дБ добавить песне: тянем к −14 дБ; тише чем на 12 дБ не делаем, а громче — только пока пики не упрутся
// в потолок (пик меряем на 8 кГц, он чуть занижен — отсюда запас 2 дБ)
const normDb = (rms, peak) => Math.max(-12, Math.min(-14 - rms, 6, Math.max(0, -2 - peak)));
// ссылка → что это: видео/плейлист YouTube, трек/плейлист SoundCloud или прямая ссылка на файл
function parseNetUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^(www\.|m\.|music\.)/, ''), seg = u.pathname.split('/').filter(Boolean);
  if (h === 'youtu.be' || h === 'youtube.com') {
    const v = h === 'youtu.be' ? seg[0] : u.searchParams.get('v') || (/^(shorts|embed|live)$/.test(seg[0] || '') ? seg[1] : '');
    const list = u.searchParams.get('list');
    if (list && (!v || u.pathname === '/playlist')) return { kind: 'yt', list };
    return /^[\w-]{11}$/.test(v || '') ? { kind: 'yt', vid: v } : null;
  }
  if (h === 'on.soundcloud.com') return { kind: 'sc', short: true, url: u.href };
  if (h === 'soundcloud.com' && seg.length) {
    const url = `https://soundcloud.com/${seg.join('/')}`;
    const list = seg.length === 1 || ['sets', 'likes', 'tracks', 'albums', 'reposts', 'popular-tracks'].includes(seg[1]);
    return list ? { kind: 'sc', list: true, url } : { kind: 'sc', url };
  }
  if (/\.(mp3|ogg|wav|flac|m4a|opus|aac|mp4|webm)$/i.test(u.pathname)) return { kind: 'file', url: u.href };
  return null;
}
// «Исполнитель - Песня (Official Video)» → { name, artist }; без тире исполнитель — автор канала
function splitTitle(title, author) {
  const junk = /\s*[([](official\s*)?(music\s*|lyrics?\s*|audio\s*|hd\s*|4k\s*|mv\s*|video\s*|visuali[sz]er\s*|клип\s*|премьера\s*)+[)\]]/gi;
  let t = String(title || '').replace(junk, '').trim();
  let a = String(author || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\s*official$/i, '').trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) { a = m[1].trim(); t = m[2].trim(); } else if (a && t.endsWith(' by ' + a)) t = t.slice(0, -(' by ' + a).length);
  return { name: t || 'Без названия', artist: a };
}
// слова с таймингами из lrclib.net; getJson(url) → объект или null (404). Общая для ПК и телефона
async function lrclibFind(getJson, q) {
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
    // текст без таймингов тоже пригодится: его можно разметить пробелом в плеере;
    // при поиске по названию оригинала (для мешапа) подойдёт и текст от трека другой длины
    if (!plain) { const p = list.filter((x) => x.plainLyrics && (q.loose || near(x))).sort(byDur)[0]; plain = p ? p.plainLyrics : null; }
    return plain ? { plain } : null;
  } catch { return null; }
}
// слабые устройства: кадры копим окнами по 2 с; если в двух окнах подряд больше половины кадров дольше 22 мс
// (меньше 45 в секунду) — пора упрощать картинку. Половина, а не среднее: одна заминка (декодируем файл) — не тормоза.
// Промежутки от секунды (окно свёрнуто, телефон спит) не считаем вовсе
function fpsSlow(w, dt) {
  if (!(dt > 0 && dt < 1000)) return false;
  w.t += dt; w.n++;
  if (dt > 22.2) w.s++;
  if (w.t < 2000) return false;
  w.bad = w.s * 2 > w.n ? w.bad + 1 : 0;
  w.t = w.n = w.s = 0;
  if (w.bad < 2) return false;
  w.bad = 0;
  return true;
}
// перенос .linea: свой файл на другом устройстве получает другой id (в нём дата файла), поэтому дубль узнаём
// и по названию, исполнителю и длине; песни по ссылке пускаем только с настоящим адресом YouTube или SoundCloud
const sameSong = (a, b) => a.id === b.id || (!a.kind && !b.kind && a.name === b.name && (a.artist || '') === (b.artist || '') && Math.abs((a.duration || 0) - (b.duration || 0)) < 1500);
const netOk = (r) => (r.kind === 'yt' ? /^[\w-]{11}$/.test(r.vid) : r.kind === 'sc' ? /^https:\/\/([a-z0-9-]+\.)?soundcloud\.com\//.test(r.url) : !r.kind);
if (typeof module !== 'undefined') module.exports = { lrclibFind, hashStr, rng, fmtDur, cleanName, parseLRC, lineAt, retextLine, peaks, voiceEnv, autoLyrics, loudness, normDb, fpsSlow, sameSong, netOk, parseNetUrl, splitTitle };
