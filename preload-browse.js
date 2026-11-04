'use strict';
// окно поиска (сайт SoundCloud или YouTube): поверх сайта одна кнопка «В Linea», больше сайту ничего не доступно
const { ipcRenderer } = require('electron');

const addable = (u) => {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www\.|m\.)/, ''), seg = x.pathname.split('/').filter(Boolean);
    if (h === 'youtube.com') return x.pathname === '/watch' ? !!x.searchParams.get('v') : x.pathname === '/playlist' ? !!x.searchParams.get('list') : /^\/shorts\/[\w-]{11}/.test(x.pathname);
    if (h === 'soundcloud.com') return seg.length >= 2 && !['discover', 'search', 'you', 'stations', 'settings', 'messages', 'notifications', 'feed', 'charts', 'pages', 'popular'].includes(seg[0]);
  } catch { /* не ссылка */ }
  return false;
};

addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('button');
  b.textContent = '+ В Linea';
  b.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:14px 22px;border:0;border-radius:99px;'
    + 'font:800 15px system-ui,"Segoe UI",sans-serif;color:#0B0B0F;background:#E9E9EE;box-shadow:0 10px 30px rgba(0,0,0,.45);cursor:pointer;transition:opacity .2s,transform .2s';
  b.addEventListener('click', () => {
    if (!addable(location.href)) return;
    ipcRenderer.send('browse:add', location.href);
    b.textContent = 'Добавлено';
    setTimeout(() => { b.textContent = '+ В Linea'; }, 1500);
  });
  // сайты сами переходят между страницами без перезагрузки — проверяем адрес и возвращаем кнопку, если её убрали
  let last = '';
  setInterval(() => {
    if (!b.isConnected) document.documentElement.appendChild(b);
    if (location.href === last) return;
    last = location.href;
    const ok = addable(last);
    b.style.opacity = ok ? '1' : '0';
    b.style.pointerEvents = ok ? 'auto' : 'none';
    b.style.transform = ok ? 'none' : 'translateY(12px)';
  }, 400);
});
