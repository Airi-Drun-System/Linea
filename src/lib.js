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
if (typeof module !== 'undefined') module.exports = { hashStr, rng, fmtDur, cleanName, parseLRC, lineAt, retextLine, peaks, parseNetUrl, splitTitle };
