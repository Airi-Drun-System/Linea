'use strict';
const $ = (id) => document.getElementById(id);
let lastKey = '';
// плеер присылает: текущую строку (со словами или без), сколько слов спето, заливку и следующую строку
window.ov.onState((st) => {
  if (st.color) document.body.style.setProperty('--a1', st.color);
  document.body.classList.toggle('grad', !!st.grad);
  if (st.grad) { document.body.style.setProperty('--t1', st.grad[0]); document.body.style.setProperty('--t2', st.grad[1]); }
  $('box').classList.toggle('hide', !st.text && !document.body.classList.contains('move'));
  const key = st.i + '|' + st.text;
  const line = $('line');
  if (key !== lastKey) {
    lastKey = key;
    line.textContent = '';
    line.className = 'line swap' + (st.words ? '' : ' fill');
    if (st.words) st.words.forEach((w, k) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = (k ? ' ' : '') + w; line.appendChild(s); });
    else line.textContent = st.text || '';
    $('next').textContent = st.next || '';
  }
  if (st.words) [...line.children].forEach((s, k) => s.classList.toggle('sung', k < st.sung));
  else line.style.setProperty('--p', st.p || 0);
});
window.ov.onMove((m) => {
  document.body.classList.toggle('move', m);
  if (m && !$('line').textContent) $('line').textContent = 'Тут будут слова песни';
  $('box').classList.toggle('hide', !m && !lastKey.split('|')[1]);
});
