'use strict';
// Linea на Android (Capacitor): то же окно, что на ПК, но вместо Electron — запросы из самой страницы
// (Capacitor пускает их нативно, без CORS) и маленький нативный плагин Linea: «Поделиться», фоновая музыка, «Назад»
(() => {
  const C = window.Capacitor;
  if (window.lnApp || !C || !C.isNativePlatform || !C.isNativePlatform()) return;
  document.documentElement.classList.add('mobile');
  const L = C.registerPlugin('Linea');
  const BUILD = window.LN_BUILD || 0; // номер сборки, его вписывает сборка APK (build.js)
  const REL = 'https://github.com/Airi-Drun-System/Linea/releases/download/android/';
  const getJson = async (url) => {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
    return r.json();
  };
  const OEMBED = { yt: 'https://www.youtube.com/oembed?format=json&url=', sc: 'https://soundcloud.com/oembed?format=json&url=' };
  const SITES = { sc: 'https://soundcloud.com/discover', yt: 'https://m.youtube.com/' };
  let updReady = null, artId = '', art = '';
  const updListeners = [];
  async function updCheck() {
    try {
      const v = await getJson(REL + 'android.json?t=' + Date.now());
      if (v && v.build > BUILD) { updReady = v.version; updListeners.forEach((f) => f(v.version)); }
    } catch { /* нет сети — проверим потом */ }
    return true;
  }
  window.lnApp = {
    mobile: true,
    findLyrics: (q) => lrclibFind(getJson, q),
    log: () => {}, prefs: () => {},
    bridgeUrl: async () => new URL('bridge/player.html', location.href).href,
    oembed: async (kind, url) => { try { return await getJson(OEMBED[kind] + encodeURIComponent(url)); } catch { return null; } },
    netImg: async (url) => {
      if (!/^https:\/\/([a-z0-9-]+\.sndcdn\.com|i\.ytimg\.com)\//.test(String(url))) return null;
      try { const r = await fetch(url); return r.ok ? await r.arrayBuffer() : null; } catch { return null; }
    },
    netFile: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
      const buf = await r.arrayBuffer();
      return { buf, type: r.headers.get('content-type') || '', name: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'song.mp3') };
    },
    netFinal: async (url) => { try { const r = await fetch(url); return r.url || url; } catch { return url; } },
    // искать удобнее в самих приложениях SoundCloud и YouTube, а оттуда «Поделиться → Linea»
    browse: (site) => window.open(SITES[site], '_blank'),
    onNetAdd: (fn) => L.addListener('share', (d) => { const m = String((d && d.text) || '').match(/https?:\/\/\S+/); if (m) fn(m[0]); }),
    onStep: (fn) => L.addListener('cmd', (d) => {
      const c = d && d.cmd;
      if (c === 'back') return back();
      fn(c === 'next' ? 1 : c === 'prev' ? -1 : c);
    }),
    // уведомление с кнопками и работа в фоне, пока что-то играет
    media: (st) => {
      // обложка для шторки и экрана блокировки: квадрат 256×256, считаем один раз на песню
      if (st.img && st.id !== artId) {
        try {
          const c = document.createElement('canvas'), w = st.img.naturalWidth, h = st.img.naturalHeight, m = Math.min(w, h);
          c.width = c.height = 256;
          c.getContext('2d').drawImage(st.img, (w - m) / 2, (h - m) / 2, m, m, 0, 0, 256, 256);
          art = c.toDataURL('image/jpeg', 0.85).split(',')[1];
          artId = st.id;
        } catch { art = ''; }
      }
      return L.playing({ title: st.title, artist: st.artist, playing: st.playing, pos: Math.round(st.pos * 1000), dur: Math.round(st.dur * 1000), art: st.id === artId ? art : '' }).catch(() => {});
    },
    updState: async () => ({ version: window.LN_VERSION || 'Android', ready: updReady, can: true }),
    updCheck,
    updInstall: () => window.open(REL + 'Linea-android.apk', '_blank'),
    onUpd: (fn) => updListeners.push(fn),
  };
  // «Назад» закрывает окна и список песен; если закрывать нечего — сворачивает, музыка играет дальше
  function back() {
    const open = document.querySelector('.over:not([hidden]), #menu:not([hidden])') || document.body.classList.contains('lib');
    if (open) dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    else L.minimize().catch(() => {});
  }
  setTimeout(updCheck, 5000);
  setInterval(updCheck, 2 * 60 * 60 * 1000);
})();
