'use strict';
const assert = require('assert');
const { parseLRC, lineAt, fmtDur, cleanName, whisperToLines, retextLine, peaks } = require('../src/lib.js');

const L = parseLRC('[ar:x]\n[00:01.50]раз\n[00:00.20][00:03.00]два\nбез метки\n[01:02.5]три');
assert.deepStrictEqual(L.map((l) => [Math.round(l.t), l.text]), [[200, 'два'], [1500, 'раз'], [3000, 'два'], [62500, 'три']]);
assert.strictEqual(parseLRC('[offset:+500]\n[00:02.00]x')[0].t, 1500);
assert.strictEqual(lineAt(L, 0), -1);
assert.strictEqual(lineAt(L, 1500), 1);
assert.strictEqual(lineAt(L, 99999), 3);
assert.strictEqual(fmtDur(65000), '1:05');
assert.strictEqual(cleanName('My_song.mp3'), 'My song');

// формат whisper-cli -ojf: offsets в мс, t_dtw в сотых долях секунды
const tok = (text, from, dtw) => ({ text, offsets: { from, to: from + 100 }, id: 1, p: 0.9, t_dtw: dtw == null ? -1 : dtw });
const seg = (from, tokens) => ({ offsets: { from, to: from + 3000 }, text: '', tokens });
const json = JSON.stringify({ transcription: [
  seg(1000, [tok('[_BEG_]', 1000), tok(' При', 1000, 105), tok('вет', 1200), tok(',', 1300), tok(' мир', 1500, 152), tok('.', 1700), tok(' ♪', 1800)]),
  seg(4000, [tok(' Второй', 4000), tok(' куплет', 4400), tok(' [Музыка]', 4800)]),
  seg(9000, [tok(' Снова', 9000)]), seg(9500, [tok(' Снова', 9500)]), seg(9900, [tok(' Снова', 9900)]), seg(10300, [tok(' Снова', 10300)]),
] });
const W = whisperToLines(json);
assert.deepStrictEqual(W.map((l) => l.text), ['Привет, мир.', 'Второй куплет', 'Снова', 'Снова', 'Снова']);
assert.deepStrictEqual(W[0].words.map((w) => w.t), [1050, 1520]);
assert.strictEqual(W[0].t, 1050);
// правка: столько же слов — тайминги те же; больше слов — встают по порядку
assert.deepStrictEqual(retextLine(W[1], 'Второй припев', 6000).words.map((w) => [w.t, w.text]), [[4000, 'Второй'], [4400, 'припев']]);
const R = retextLine(W[1], 'а это второй куплет', 6000).words.map((w) => w.t);
assert.deepStrictEqual(R, [4000, 4200, 4400, 5200]);
assert.deepStrictEqual(retextLine({ t: 0, text: 'x' }, 'раз два', 2000).words.map((w) => w.t), [0, 1000]);
const pk = peaks(Float32Array.from({ length: 4000 }, (_, i) => (i < 2000 ? 0.1 : 0.5) * (i % 2 ? 1 : -1)), 4);
assert.deepStrictEqual(pk, [0.2, 0.2, 1, 1]);
console.log('lib: ok');
