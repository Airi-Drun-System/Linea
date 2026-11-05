'use strict';
const assert = require('assert');
const { parseLRC, lineAt, fmtDur, cleanName, retextLine, peaks, voiceEnv, autoLyrics, loudness, normDb, fpsSlow, md5, fmSig, fmNeed, sameSong, netOk, parseNetUrl, splitTitle, lrclibFind } = require('../src/lib.js');

const L = parseLRC('[ar:x]\n[00:01.50]раз\n[00:00.20][00:03.00]два\nбез метки\n[01:02.5]три');
assert.deepStrictEqual(L.map((l) => [Math.round(l.t), l.text]), [[200, 'два'], [1500, 'раз'], [3000, 'два'], [62500, 'три']]);
assert.strictEqual(parseLRC('[offset:+500]\n[00:02.00]x')[0].t, 1500);
assert.strictEqual(lineAt(L, 0), -1);
assert.strictEqual(lineAt(L, 1500), 1);
assert.strictEqual(lineAt(L, 99999), 3);
assert.strictEqual(fmtDur(65000), '1:05');
assert.strictEqual(cleanName('My_song.mp3'), 'My song');

const W = [null, { t: 4000, text: 'Второй куплет', words: [{ t: 4000, text: 'Второй' }, { t: 4400, text: 'куплет' }] }];
// правка: столько же слов — тайминги те же; больше слов — встают по порядку
assert.deepStrictEqual(retextLine(W[1], 'Второй припев', 6000).words.map((w) => [w.t, w.text]), [[4000, 'Второй'], [4400, 'припев']]);
const R = retextLine(W[1], 'а это второй куплет', 6000).words.map((w) => w.t);
assert.deepStrictEqual(R, [4000, 4200, 4400, 5200]);
assert.deepStrictEqual(retextLine({ t: 0, text: 'x' }, 'раз два', 2000).words.map((w) => w.t), [0, 1000]);
const pk = peaks(Float32Array.from({ length: 4000 }, (_, i) => (i < 2000 ? 0.1 : 0.5) * (i % 2 ? 1 : -1)), 4);
assert.deepStrictEqual(pk, [0.2, 0.2, 1, 1]);
// ссылки
assert.deepStrictEqual(parseNetUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), { kind: 'yt', vid: 'dQw4w9WgXcQ' });
assert.deepStrictEqual(parseNetUrl('https://youtu.be/dQw4w9WgXcQ?si=x'), { kind: 'yt', vid: 'dQw4w9WgXcQ' });
assert.deepStrictEqual(parseNetUrl('https://youtube.com/shorts/dQw4w9WgXcQ'), { kind: 'yt', vid: 'dQw4w9WgXcQ' });
assert.deepStrictEqual(parseNetUrl('https://music.youtube.com/playlist?list=PL123'), { kind: 'yt', list: 'PL123' });
assert.deepStrictEqual(parseNetUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123'), { kind: 'yt', vid: 'dQw4w9WgXcQ' });
assert.deepStrictEqual(parseNetUrl('https://soundcloud.com/forss/flickermood?utm_source=x'), { kind: 'sc', url: 'https://soundcloud.com/forss/flickermood' });
assert.deepStrictEqual(parseNetUrl('https://soundcloud.com/forss/sets/soulhack'), { kind: 'sc', list: true, url: 'https://soundcloud.com/forss/sets/soulhack' });
assert.strictEqual(parseNetUrl('https://soundcloud.com/forss/likes').list, true);
assert.strictEqual(parseNetUrl('https://on.soundcloud.com/abc').short, true);
assert.deepStrictEqual(parseNetUrl('https://x.org/a/song.mp3?dl=1'), { kind: 'file', url: 'https://x.org/a/song.mp3?dl=1' });
assert.strictEqual(parseNetUrl('просто текст'), null);
assert.strictEqual(parseNetUrl('https://example.com/'), null);
assert.strictEqual(parseNetUrl('javascript:alert(1)'), null);
// названия
assert.deepStrictEqual(splitTitle('Кино - Группа крови (Official Video)', 'KinoVEVO'), { name: 'Группа крови', artist: 'Кино' });
assert.deepStrictEqual(splitTitle('Blinding Lights', 'The Weeknd - Topic'), { name: 'Blinding Lights', artist: 'The Weeknd' });
assert.deepStrictEqual(splitTitle('mashup v2 by djx', 'djx'), { name: 'mashup v2', artist: 'djx' });
assert.deepStrictEqual(splitTitle('Song [Lyric Video]', ''), { name: 'Song', artist: '' });
// авторазметка на синтетике, 8 кГц: громкая бочка 60 Гц и тихий подклад всё время, «голос» 800 Гц — слогами в пяти фразах
const SR = 8000, tone = (f, t) => Math.sin(2 * Math.PI * f * t);
const phrases = [[4, 7.5], [8.3, 11.6], [12.4, 15.8], [26, 29.5], [30.2, 33.8]];
const song = Float32Array.from({ length: 40 * SR }, (_, i) => {
  const t = i / SR, kick = 0.8 * Math.max(0, Math.sin(Math.PI * (t % 0.5) / 0.125)) ** 2 * ((t % 0.5) < 0.125) * tone(60, t);
  const voice = phrases.some(([a, b]) => t >= a && t < b && (t - a) % 0.25 < 0.2) ? 0.3 * tone(800, t) : 0;
  return kick + 0.04 * tone(440, t) + voice;
});
// и то же в стерео без подклада, где гитара звучит только слева: в паузах L·R почти ноль, но тихий шорох
// за 0.2 с до фразы не должен сдвигать строку
const dry = song.map((v, i) => v - 0.04 * tone(440, i / SR) + (i >= 8.05 * SR && i < 8.15 * SR ? 0.003 * tone(1000, i / SR) : 0));
const left = dry.map((v, i) => v + 0.25 * Math.exp(-(i % 2000) / 1000) * tone([392, 494, 587, 659][(i / 2000 | 0) % 4], i / SR));
for (const [L, R] of [[song, null], [left, dry]]) {
  const e = voiceEnv(L, R, SR);
  assert.strictEqual(e.length, 800);
  const five = autoLyrics(e, 'раз два три\n\n[Припев]\nчетыре пять шесть\nсемь восемь\nдевять десять\nодиннадцать двенадцать');
  assert.deepStrictEqual(five.map((l) => l.text), ['раз два три', 'четыре пять шесть', 'семь восемь', 'девять десять', 'одиннадцать двенадцать']);
  five.forEach((l, i) => assert.ok(Math.abs(l.t - phrases[i][0] * 1000) <= 300, `${R ? 'стерео' : 'моно'}, строка ${i}: ${l.t}`));
}
const env = voiceEnv(song, null, SR);
// строк больше, чем фраз: по порядку, не раньше голоса и в пределах песни
const nine = autoLyrics(env, 'a\nb\nc\nd\ne\nf\ng\nh\ni').map((l) => l.t);
assert.ok(nine.every((t, i) => !i || t > nine[i - 1]) && nine[0] >= 3700 && nine[8] < 40000, String(nine));
// ровный звук без пауз — поровну на всю песню
assert.deepStrictEqual(autoLyrics(voiceEnv(Float32Array.from({ length: 20 * SR }, (_, i) => 0.3 * tone(1000, i / SR)), null, SR), 'a\nb\nc\nd').map((l) => l.t), [0, 4900, 9900, 14900]);
assert.deepStrictEqual(autoLyrics(env, '\n [Intro] \n'), []);
// полоса голоса: бас глушится больше чем на 30 дБ; звук только в одном канале или в противофазе — не голос
const one = (f, g = 1) => voiceEnv(Float32Array.from({ length: SR }, (_, i) => tone(f, i / SR)), Float32Array.from({ length: SR }, (_, i) => g * tone(f, i / SR)), SR)[10];
assert.ok(one(60) / one(1000) < 0.03 && one(1000, 0) === 0 && one(1000, -1) === 0 && Math.abs(one(1000) - Math.SQRT1_2) < 0.05);
// громкость: синус 0.5 — это −9 дБ rms и −6 дБ пик; тишина и тихое вступление не тянут среднее вниз
const sine = (a, sec) => Array.from({ length: sec * SR }, (_, i) => a * tone(1000, i / SR));
const lz = (x) => loudness(Float32Array.from(x), null, SR);
assert.deepStrictEqual(lz(sine(0.5, 10)), [-9, -6]);
assert.deepStrictEqual(lz([...sine(0.5, 10), ...new Array(10 * SR).fill(0)]), [-9, -6]);
assert.deepStrictEqual(lz([...sine(0.016, 4), ...sine(0.5, 10)]), [-9, -6]);
assert.deepStrictEqual(loudness(Float32Array.from(sine(0.5, 2)), new Float32Array(2 * SR), SR), [-12, -6]); // один канал из двух
assert.deepStrictEqual(lz(new Array(SR).fill(0)), [-70, -180]);
// громкую песню тише, тихую громче, но не выше пиков; совсем тихую не задираем больше чем на 6 дБ
assert.strictEqual(normDb(-8, -0.1), -6);
assert.strictEqual(normDb(-20, -8), 6);
assert.strictEqual(normDb(-20, -1), 0);
assert.strictEqual(normDb(-17, -6), 3);
assert.strictEqual(normDb(0, 0), -12);
// автокачество: 60 кадров/с — никогда, даже с заминкой раз в секунду; 30 — через 4 с и потом каждые 4 с; 3 — тоже тормоза;
// тормоза через окно — нет; сон окна — не тормоза
const fps = (list) => { const w = { t: 0, n: 0, s: 0, bad: 0 }, at = []; let t = 0; for (const dt of list) { t += dt; if (fpsSlow(w, dt)) at.push(Math.round(t / 1000)); } return at; };
const run = (f, sec) => new Array(Math.round(f * sec)).fill(1000 / f);
assert.deepStrictEqual(fps(run(60, 20)), []);
assert.deepStrictEqual(fps(run(30, 13)), [4, 8, 12]);
assert.deepStrictEqual(fps([...run(30, 2), ...run(60, 2), ...run(30, 2), ...run(60, 2)]), []);
assert.deepStrictEqual(fps(new Array(30).fill(1000)), []);
assert.deepStrictEqual(fps(new Array(10).fill([...run(60, 1), 600]).flat()), []);
assert.deepStrictEqual(fps(run(3, 13)), [5, 9]);
assert.deepStrictEqual(fps(run(44, 4.1)).length, 1);
assert.deepStrictEqual(fps(run(46, 10)), []);
// Last.fm: md5 как у Node (пусто, кириллица, ровно на границе блоков, длинное); подпись — по алфавиту и с секретом
const md5n = (x) => require('crypto').createHash('md5').update(x, 'utf8').digest('hex');
for (const x of ['', 'a', 'The quick brown fox jumps over the lazy dog', 'привет, Linea', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'ё'.repeat(1000)]) assert.strictEqual(md5(x), md5n(x));
assert.strictEqual(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
assert.strictEqual(fmSig({ token: 't1', method: 'auth.getSession', api_key: 'k' }, 'sec'), md5n('api_keykmethodauth.getSessiontokent1sec'));
assert.strictEqual(fmNeed(20), Infinity);
assert.strictEqual(fmNeed(200), 100);
assert.strictEqual(fmNeed(900), 240);
// перенос: свой файл с другим id, но тем же названием и длиной — дубль; ссылки — только настоящие
const own = { id: 'f1', name: 'Песня', artist: 'А', duration: 180000 };
assert.ok(sameSong(own, { id: 'f2', name: 'Песня', artist: 'А', duration: 180900 }));
assert.ok(!sameSong(own, { id: 'f2', name: 'Песня', artist: 'А', duration: 185000 }));
assert.ok(!sameSong(own, { id: 'f2', name: 'Песня', artist: 'Б', duration: 180000 }));
assert.ok(!sameSong({ id: 'yt1', kind: 'yt', name: 'Песня', duration: 1 }, { id: 'yt2', kind: 'yt', name: 'Песня', duration: 1 }));
assert.ok(sameSong({ id: 'ytA', kind: 'yt' }, { id: 'ytA', kind: 'yt' }));
assert.ok(netOk({ kind: 'yt', vid: 'dQw4w9WgXcQ' }) && netOk({ kind: 'sc', url: 'https://soundcloud.com/a/b' }) && netOk({}));
assert.ok(!netOk({ kind: 'yt', vid: 'x"><' }) && !netOk({ kind: 'sc', url: 'javascript:alert(1)' }) && !netOk({ kind: 'zz' }));
// слова: точное совпадение, потом поиск с близкой длиной
(async () => {
  const db = { get: { plainLyrics: 'p' }, search: [{ duration: 300, syncedLyrics: 'far' }, { duration: 182, syncedLyrics: 'near' }] };
  const gj = async (u) => (u.includes('/api/get') ? db.get : db.search);
  assert.deepStrictEqual(await lrclibFind(gj, { title: 'x', artist: 'y', duration: 180 }), { synced: 'near' });
  db.search = [];
  assert.deepStrictEqual(await lrclibFind(gj, { title: 'x', artist: 'y', duration: 180 }), { plain: 'p' });
  assert.strictEqual(await lrclibFind(gj, { title: '' }), null);
  assert.strictEqual(await lrclibFind(async () => { throw new Error('net'); }, { title: 'x' }), null);
  console.log('lib: ok');
})();
