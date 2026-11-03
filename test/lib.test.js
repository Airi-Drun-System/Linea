'use strict';
const assert = require('assert');
const { parseLRC, lineAt, fmtDur, cleanName } = require('../src/lib.js');

const L = parseLRC('[ar:x]\n[00:01.50]раз\n[00:00.20][00:03.00]два\nбез метки\n[01:02.5]три');
assert.deepStrictEqual(L.map((l) => [Math.round(l.t), l.text]), [[200, 'два'], [1500, 'раз'], [3000, 'два'], [62500, 'три']]);
assert.strictEqual(parseLRC('[offset:+500]\n[00:02.00]x')[0].t, 1500);
assert.strictEqual(lineAt(L, 0), -1);
assert.strictEqual(lineAt(L, 1500), 1);
assert.strictEqual(lineAt(L, 99999), 3);
assert.strictEqual(fmtDur(65000), '1:05');
assert.strictEqual(cleanName('My_song.mp3'), 'My song');
console.log('lib: ok');
