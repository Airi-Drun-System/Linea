'use strict';
// мостик между Linea и официальными плеерами SoundCloud и YouTube.
// Linea шлёт команды (open/play/pause/seek/vol/stop/list), мостик отвечает событиями (time/play/pause/ended/error/meta/list)
const send = (m) => parent.postMessage(Object.assign({ linea: 1, n: openN }, m), '*');
let openN = 0, kind = null, vol = 0.8;

const NO_NET = 'Нет связи с SoundCloud или YouTube. Проверь интернет или VPN.';
const ytApi = new Promise((res, rej) => {
  if (window.YT && window.YT.loaded) res(); else window.onYouTubeIframeAPIReady = res;
  setTimeout(() => rej(new Error(NO_NET)), 20000);
});
ytApi.catch(() => {});
const YT_ERR = {
  2: 'Неправильная ссылка на видео.',
  5: 'YouTube не смог проиграть это видео.',
  100: 'Видео удалено или скрыто.',
  101: 'Автор запретил проигрывать это видео вне YouTube.',
  150: 'Автор запретил проигрывать это видео вне YouTube.',
};

// ---------- YouTube ----------
let yt = null;
function ytState(e) {
  if (kind !== 'yt') return;
  if (e.data === 1) {
    send({ ev: 'play' });
    const v = yt.getVideoData ? yt.getVideoData() : {};
    send({ ev: 'meta', title: v.title || '', artist: v.author || '', d: yt.getDuration() || 0 });
  } else if (e.data === 2) send({ ev: 'pause' });
  else if (e.data === 0) send({ ev: 'ended' });
}
async function ytOpen(id, play, t) {
  await ytApi;
  if (!yt) {
    yt = await new Promise((res) => {
      const p = new YT.Player('yt', {
        videoId: id,
        playerVars: { autoplay: play ? 1 : 0, start: Math.floor(t || 0), playsinline: 1, rel: 0 },
        events: { onReady: () => res(p), onStateChange: ytState, onError: (e) => kind === 'yt' && send({ ev: 'error', msg: YT_ERR[e.data] || 'YouTube не смог проиграть это видео.' }) },
      });
    });
    yt.setVolume(vol * 100);
    if (play) yt.playVideo();
    return;
  }
  yt.setVolume(vol * 100);
  if (play) yt.loadVideoById({ videoId: id, startSeconds: t || 0 }); else yt.cueVideoById({ videoId: id, startSeconds: t || 0 });
}

// ---------- SoundCloud ----------
let sc = null, scT = 0, scD = 0, scAfter = null;
const scUrl = (url) => 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) + '&auto_play=false&visual=false&show_artwork=false&show_comments=false';
function scLoaded() {
  const a = scAfter; scAfter = null;
  sc.setVolume(vol * 100);
  sc.getDuration((d) => { scD = (d || 0) / 1000; });
  sc.getCurrentSound((s) => s && send({ ev: 'meta', title: s.title || '', artist: (s.user && s.user.username) || '', d: (s.duration || 0) / 1000 }));
  if (!a) return;
  if (a.t) sc.seekTo(a.t * 1000);
  if (a.play) sc.play();
}
function scOpen(url, play, t) {
  if (!window.SC) throw new Error(NO_NET);
  scT = 0; scD = 0; scAfter = { play, t };
  if (sc) { sc.load(url, { auto_play: false, callback: scLoaded }); return; }
  const f = document.getElementById('sc');
  f.src = scUrl(url);
  sc = SC.Widget(f);
  const E = SC.Widget.Events;
  sc.bind(E.READY, scLoaded);
  sc.bind(E.PLAY, () => kind === 'sc' && send({ ev: 'play' }));
  sc.bind(E.PAUSE, () => kind === 'sc' && send({ ev: 'pause' }));
  sc.bind(E.FINISH, () => kind === 'sc' && send({ ev: 'ended' }));
  sc.bind(E.PLAY_PROGRESS, (p) => { scT = ((p && p.currentPosition) || 0) / 1000; });
  sc.bind(E.ERROR, () => kind === 'sc' && send({ ev: 'error', msg: 'SoundCloud не смог проиграть этот трек.' }));
}

// ---------- плейлисты: отдельный невидимый плеер, чтобы не мешать тому, что играет ----------
const tmp = document.getElementById('tmp');
async function ytList(list) {
  await ytApi;
  const host = document.createElement('div');
  tmp.appendChild(host);
  return new Promise((res) => {
    let done = false, p = null;
    const fin = (ids) => { if (done) return; done = true; try { p.destroy(); } catch { /* уже нет */ } tmp.textContent = ''; res((ids || []).map((id) => ({ vid: id }))); };
    p = new YT.Player(host, {
      playerVars: { listType: 'playlist', list, autoplay: 0 },
      events: {
        onReady: () => { let k = 0; const iv = setInterval(() => { const ids = p.getPlaylist && p.getPlaylist(); if ((ids && ids.length) || ++k > 40) { clearInterval(iv); fin(ids); } }, 300); },
        onError: () => fin([]),
      },
    });
    setTimeout(() => fin([]), 20000);
  });
}
function scList(url) {
  if (!window.SC) throw new Error(NO_NET);
  return new Promise((res) => {
    const f = document.createElement('iframe');
    f.src = scUrl(url);
    tmp.appendChild(f);
    const w = SC.Widget(f);
    let done = false;
    const conv = (s) => ({
      url: s.permalink_url || (s.id ? `https://api.soundcloud.com/tracks/${s.id}` : ''),
      title: s.title || '', artist: (s.user && s.user.username) || '', dur: s.duration || 0,
      art: String(s.artwork_url || (s.user && s.user.avatar_url) || '').replace('-large.', '-t500x500.'),
    });
    const fin = (ss) => { if (done) return; done = true; f.remove(); res((ss || []).filter(Boolean).map(conv).filter((x) => x.url)); };
    // виджет дозагружает данные треков сам: ждём, пока у всех появятся названия
    w.bind(SC.Widget.Events.READY, () => {
      let k = 0;
      const poll = () => w.getSounds((ss) => { const full = (ss || []).filter((s) => s && s.title).length; if ((ss && ss.length && full === ss.length) || ++k > 25) fin(ss); else setTimeout(poll, 600); });
      poll();
    });
    w.bind(SC.Widget.Events.ERROR, () => fin([]));
    setTimeout(() => fin([]), 25000);
  });
}

// ---------- команды от Linea ----------
async function handle(m) {
  if (m.cmd === 'open') {
    openN = m.n;
    if (kind === 'yt' && m.kind !== 'yt' && yt) yt.stopVideo();
    if (kind === 'sc' && m.kind !== 'sc' && sc) sc.pause();
    kind = m.kind;
    if (kind === 'yt') await ytOpen(m.src, m.play, m.t); else scOpen(m.src, m.play, m.t);
  } else if (m.cmd === 'list') {
    const items = m.kind === 'yt' ? await ytList(m.src) : await scList(m.src);
    parent.postMessage({ linea: 1, ev: 'list', req: m.req, items }, '*');
  } else if (m.cmd === 'vol') {
    vol = Math.max(0, Math.min(1, Number(m.v) || 0));
    if (yt && yt.setVolume) yt.setVolume(vol * 100);
    if (sc) sc.setVolume(vol * 100);
  } else if (kind === 'yt' && yt) {
    if (m.cmd === 'play') yt.playVideo();
    else if (m.cmd === 'pause') yt.pauseVideo();
    else if (m.cmd === 'seek') yt.seekTo(m.t, true);
    else if (m.cmd === 'stop') { yt.stopVideo(); kind = null; }
  } else if (kind === 'sc' && sc) {
    if (m.cmd === 'play') { if (scAfter) scAfter.play = true; else sc.play(); }
    else if (m.cmd === 'pause') { if (scAfter) scAfter.play = false; else sc.pause(); }
    else if (m.cmd === 'seek') { scT = m.t; sc.seekTo(m.t * 1000); }
    else if (m.cmd === 'stop') { sc.pause(); kind = null; }
  }
}
addEventListener('message', (e) => {
  if (e.source !== parent || !e.data || !e.data.cmd) return;
  const m = e.data;
  handle(m).catch((err) => {
    if (m.cmd === 'list') parent.postMessage({ linea: 1, ev: 'list', req: m.req, items: [], err: String((err && err.message) || err) }, '*');
    else send({ ev: 'error', msg: String((err && err.message) || err) });
  });
});
// где сейчас песня: 4 раза в секунду, этого хватает для слов и полосы
setInterval(() => {
  if (kind === 'yt' && yt && yt.getCurrentTime) send({ ev: 'time', t: yt.getCurrentTime() || 0, d: yt.getDuration() || 0 });
  else if (kind === 'sc' && sc) send({ ev: 'time', t: scT, d: scD });
}, 250);
send({ ev: 'hello' });
