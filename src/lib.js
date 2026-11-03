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
if (typeof module !== 'undefined') module.exports = { hashStr, rng, fmtDur, cleanName, parseLRC, lineAt };
