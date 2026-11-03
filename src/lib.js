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
// ответ whisper-cli (-ojf) -> строки караоке с таймингом каждого слова
const NOISE = /^[\s\-–—.,!?…'"«»()[\]*♪♫🎵]*$/u;
function whisperToLines(jsonText) {
  const data = JSON.parse(jsonText.replace(/[\u0000-\u001f]/g, ' '));
  const words = [];
  for (const seg of data.transcription || []) {
    let w = null, first = true;
    for (const tok of seg.tokens || []) {
      const text = tok.text || '';
      if (/^\[_|^<\|/.test(text)) continue; // служебные токены модели
      const t = tok.t_dtw > 0 ? tok.t_dtw * 10 : tok.offsets ? tok.offsets.from : seg.offsets.from;
      if (!w || /^\s/.test(text)) {
        if (w) words.push(w);
        w = { t, text: text.trim(), seg: first };
        first = false;
      } else w.text += text;
    }
    if (w) words.push(w);
  }
  // шум вместо слов: «[музыка]», «♪», одиночная пунктуация
  const clean = words.filter((w) => w.text && !NOISE.test(w.text) && !/^[[(].*[\])]$/.test(w.text));
  const lines = [];
  let line = null;
  clean.forEach((w, i) => {
    const prev = clean[i - 1];
    const brk = !line || w.seg || w.t - prev.t > 1200 || /[.!?…]$/.test(prev.text) || line.text.length + w.text.length > 42;
    if (brk) { line = { t: w.t, text: w.text, words: [{ t: w.t, text: w.text }] }; lines.push(line); }
    else { line.text += ' ' + w.text; line.words.push({ t: w.t, text: w.text }); }
  });
  // модель иногда зацикливается и повторяет одну строку: больше трёх подряд не берём
  return lines.filter((l, i) => !(i >= 3 && l.text === lines[i - 1].text && l.text === lines[i - 2].text && l.text === lines[i - 3].text));
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
if (typeof module !== 'undefined') module.exports = { hashStr, rng, fmtDur, cleanName, parseLRC, lineAt, whisperToLines, retextLine };
