'use strict';
const assert = require('assert');
const { parseLRC, lineAt, fmtDur, cleanName, retextLine, peaks, parseNetUrl, splitTitle } = require('../src/lib.js');

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
console.log('lib: ok');
