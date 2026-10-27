'use strict';

const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
const DASH_JS = 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js';
const HISTORY_KEY = 'linkplay.history';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form'), url: $('url'), play: $('play'), paste: $('paste'), useProxy: $('useProxy'),
  status: $('status'), stage: $('stage'), player: $('player'), controls: $('controls'),
  nowTitle: $('nowTitle'), speed: $('speed'), pip: $('pip'), download: $('download'),
  filesBox: $('filesBox'), proxyRow: $('proxyRow'), settings: $('settings'), server: $('server'), saveServer: $('saveServer'), serverState: $('serverState'), filesTitle: $('filesTitle'), files: $('files'),
  historyBox: $('historyBox'), history: $('history'), clearHistory: $('clearHistory'),
};

let cleanup = () => {};

// ---------- utils ----------

function setStatus(msg, kind = '') {
  els.status.hidden = !msg;
  els.status.textContent = msg || '';
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}

// Backend server (for Terabox + proxy). Empty base = same origin as this page.
// On static hosting (GitHub Pages) there is no backend unless a Server URL is set.
const backend = { base: '', ok: false };

function apiUrl(path) {
  return backend.base + path;
}

function proxied(u) {
  return apiUrl('/api/proxy?url=' + encodeURIComponent(u));
}

function cleanBase(v) {
  return (v || '').trim().replace(/\/+$/, '');
}

async function checkBackend() {
  const saved = storage(() => localStorage.getItem('linkplay.server'), null);
  backend.base = cleanBase(saved != null ? saved : window.LINKPLAY_SERVER);
  els.server.value = backend.base;
  try {
    const r = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
    const j = await r.json();
    backend.ok = r.ok && j.ok === true;
  } catch {
    backend.ok = false;
  }
  els.proxyRow.hidden = !backend.ok;
  els.serverState.textContent = backend.ok
    ? 'Connected. Terabox links and the proxy are available.'
    : backend.base
      ? "Can't reach that server. Terabox links won't work."
      : 'No server set. Direct links, streams and YouTube etc. work. Terabox needs a server.';
  els.serverState.className = 'hint ' + (backend.ok ? 'good' : '');
}

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

const scriptCache = {};
function loadScript(src) {
  scriptCache[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete scriptCache[src]; reject(new Error('Could not load player library')); };
    document.head.appendChild(s);
  });
  return scriptCache[src];
}

function storage(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// ---------- link detection ----------

const TERABOX_RE = /(^|\.)(terabox|1024terabox|1024tera|teraboxapp|terabox\.app|teraboxlink|terasharelink|terafileshare|teraboxshare|4funbox|mirrobox|nephobox|freeterabox|momerybox|tibibox|gibibox|terabox\.fun)\b/i;

function detect(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname;

  if (TERABOX_RE.test(u.hostname)) return { kind: 'terabox', url: u.href };

  // YouTube
  let id = null;
  if (host === 'youtu.be') id = path.slice(1).split('/')[0];
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    id = u.searchParams.get('v') || (path.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/) || [])[1];
  }
  if (id) {
    const t = parseInt(u.searchParams.get('t') || u.searchParams.get('start') || '0', 10) || 0;
    return { kind: 'embed', label: 'YouTube', url: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${t ? '&start=' + t : ''}` };
  }
  // Vimeo
  if (/(^|\.)vimeo\.com$/.test(host)) {
    const m = path.match(/(\d{5,})/);
    if (m) return { kind: 'embed', label: 'Vimeo', url: `https://player.vimeo.com/video/${m[1]}?autoplay=1` };
  }
  // Dailymotion
  if (host === 'dai.ly' || /(^|\.)dailymotion\.com$/.test(host)) {
    const m = path.match(/(?:video\/|^\/)([a-z0-9]+)/i);
    if (m) return { kind: 'embed', label: 'Dailymotion', url: `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1` };
  }
  // Google Drive
  if (host === 'drive.google.com') {
    const m = path.match(/\/file\/d\/([\w-]+)/);
    const gid = m ? m[1] : u.searchParams.get('id');
    if (gid) return { kind: 'embed', label: 'Google Drive', url: `https://drive.google.com/file/d/${gid}/preview` };
  }
  // Streamable
  if (host === 'streamable.com') {
    const m = path.match(/^\/(?:e\/)?(\w+)/);
    if (m) return { kind: 'embed', label: 'Streamable', url: `https://streamable.com/e/${m[1]}?autoplay=1` };
  }
  // Dropbox: force raw file
  if (/(^|\.)dropbox\.com$/.test(host)) {
    u.searchParams.delete('dl');
    u.searchParams.set('raw', '1');
    return { kind: 'file', url: u.href };
  }
  // Already-embeddable player pages
  if (/\/embed\//.test(path) && !/\.(m3u8|mpd|mp4|webm)$/i.test(path)) {
    return { kind: 'embed', label: 'Embed', url: u.href };
  }

  if (/\.m3u8$/i.test(path) || /m3u8/i.test(u.search)) return { kind: 'hls', url: u.href };
  if (/\.mpd$/i.test(path)) return { kind: 'dash', url: u.href };
  return { kind: 'file', url: u.href };
}

// ---------- players ----------

function resetPlayer() {
  cleanup();
  cleanup = () => {};
  els.player.innerHTML = '';
  els.download.hidden = true;
}

function showStage(title, canControl) {
  els.stage.hidden = false;
  els.controls.hidden = false;
  els.nowTitle.textContent = title || '';
  els.speed.parentElement.hidden = !canControl;
  els.pip.hidden = !canControl || !document.pictureInPictureEnabled;
}

function playEmbed(src, label) {
  resetPlayer();
  const f = document.createElement('iframe');
  f.src = src;
  f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  els.player.appendChild(f);
  showStage(label, false);
  setStatus('');
}

function makeVideo() {
  const v = document.createElement('video');
  v.controls = true;
  v.autoplay = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.playbackRate = Number(els.speed.value) || 1;
  els.player.appendChild(v);
  return v;
}

// Try each source in order until one plays. Each source: { url, type: 'file'|'hls'|'dash' }.
async function playSources(sources, title, openUrl) {
  resetPlayer();
  showStage(title, true);
  if (openUrl) { els.download.href = openUrl; els.download.hidden = false; }
  let cancelled = false;
  cleanup = () => { cancelled = true; };

  for (let i = 0; i < sources.length; i++) {
    if (cancelled) return;
    const s = sources[i];
    setStatus(i === 0 ? 'Loading…' : 'Trying another source…');
    try {
      await attempt(s);
      if (!cancelled) setStatus('');
      return;
    } catch (e) {
      if (cancelled) return;
      if (i === sources.length - 1) {
        setStatus(`Couldn't play this video. ${e.message || ''} ${backend.ok ? 'Try turning on "Play through server proxy", or open the file directly.' : 'The site may block playback from other websites. Setting up the LinkPlay server (see Server settings) usually fixes this.'}`, 'err');
      }
    }
  }

  function attempt(s) {
    // remove previous video element / player instance
    els.player.innerHTML = '';
    const v = makeVideo();
    let inst = null;
    cleanup = () => { cancelled = true; try { inst && inst.destroy && inst.destroy(); inst && inst.reset && inst.reset(); } catch {} v.removeAttribute('src'); v.load(); };

    return new Promise(async (resolve, reject) => {
      let done = false;
      const ok = () => { if (!done) { done = true; resolve(); } };
      const fail = (msg) => {
        if (done) return;
        done = true;
        try { inst && inst.destroy && inst.destroy(); inst && inst.reset && inst.reset(); } catch {}
        reject(new Error(msg || ''));
      };
      v.addEventListener('loadedmetadata', ok, { once: true });
      v.addEventListener('error', () => fail(mediaError(v)), { once: true });
      const timer = setTimeout(() => fail('Timed out while loading.'), 30000);
      v.addEventListener('loadedmetadata', () => clearTimeout(timer), { once: true });

      try {
        if (s.type === 'hls') {
          if (v.canPlayType('application/vnd.apple.mpegurl')) {
            v.src = s.url;
          } else {
            await loadScript(HLS_JS);
            if (!window.Hls || !Hls.isSupported()) return fail('HLS is not supported in this browser.');
            inst = new Hls({ maxBufferLength: 60 });
            inst.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail('Stream error: ' + (d.details || d.type)); });
            inst.loadSource(s.url);
            inst.attachMedia(v);
          }
        } else if (s.type === 'dash') {
          await loadScript(DASH_JS);
          inst = dashjs.MediaPlayer().create();
          inst.on('error', (e) => fail('DASH error' + (e && e.error && e.error.message ? ': ' + e.error.message : '')));
          inst.initialize(v, s.url, true);
        } else {
          v.src = s.url;
        }
      } catch (e) {
        fail(e.message);
      }
      v.play().catch(() => { /* autoplay may be blocked; user can press play */ });
    });
  }
}

function mediaError(v) {
  const e = v.error;
  if (!e) return '';
  return ({
    1: 'Loading was aborted.',
    2: 'Network error.',
    3: 'The video could not be decoded.',
    4: 'The format is not supported or the link is blocked.',
  })[e.code] || '';
}

// ---------- terabox ----------

async function playTerabox(link) {
  if (!backend.ok) {
    els.settings.open = true;
    return setStatus('Terabox links need the LinkPlay server. Add your server URL under "Server settings" below (see README for free hosting).', 'err');
  }
  setStatus('Fetching Terabox share…');
  els.play.disabled = true;
  try {
    const r = await fetch(apiUrl('/api/terabox?url=' + encodeURIComponent(link)));
    const data = await r.json().catch(() => ({ error: 'Server error' }));
    if (!r.ok) throw new Error(data.error || 'Could not open this Terabox link');
    const videos = data.files.filter((f) => f.isVideo);
    const list = videos.length ? videos : data.files;
    if (!list.length) throw new Error('This share has no files.');
    renderFiles(data.title, list);
    playTeraboxFile(list[0], 0);
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    els.play.disabled = false;
  }
}

function teraboxSources(f) {
  const s = [];
  // The server always proxies Terabox since it needs the cookie + referer.
  if (f.hls) s.push({ type: 'hls', url: proxied(f.hls) });
  if (f.dlink) s.push({ type: 'file', url: proxied(f.dlink) });
  return s;
}

function playTeraboxFile(f, idx) {
  [...els.files.querySelectorAll('button')].forEach((b, i) => b.setAttribute('aria-current', String(i === idx)));
  const sources = teraboxSources(f);
  if (!sources.length) return setStatus('No playable link for this file.', 'err');
  playSources(sources, f.name, f.dlink ? proxied(f.dlink) : null);
}

function renderFiles(title, files) {
  els.filesBox.hidden = false;
  els.filesTitle.textContent = `${title} · ${files.length} file${files.length === 1 ? '' : 's'}`;
  els.files.innerHTML = '';
  files.forEach((f, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    if (f.thumb) {
      const img = document.createElement('img');
      img.src = proxied(f.thumb);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.replaceWith(placeholder());
      b.appendChild(img);
    } else b.appendChild(placeholder());
    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtSize(f.size);
    meta.append(name, size);
    b.appendChild(meta);
    b.onclick = () => { playTeraboxFile(f, i); els.stage.scrollIntoView({ behavior: 'smooth' }); };
    li.appendChild(b);
    els.files.appendChild(li);
  });
}

function placeholder() {
  const d = document.createElement('span');
  d.className = 'thumb-ph';
  d.textContent = '▶';
  return d;
}

// ---------- main ----------

function play(raw) {
  const d = detect(raw);
  if (!d) return setStatus('Please paste a valid http(s) link.', 'err');
  addHistory(raw.trim(), d.kind === 'embed' ? d.label : d.kind);
  els.filesBox.hidden = d.kind !== 'terabox' ? true : els.filesBox.hidden;

  const viaProxy = backend.ok && els.useProxy.checked;
  const name = decodeURIComponent(new URL(d.url).pathname.split('/').pop() || '') || new URL(d.url).hostname;

  switch (d.kind) {
    case 'terabox':
      return playTerabox(d.url);
    case 'embed':
      return playEmbed(d.url, d.label);
    case 'hls':
    case 'dash': {
      const direct = { type: d.kind, url: d.url };
      const prox = { type: d.kind, url: proxied(d.url) };
      return playSources(viaProxy ? [prox] : backend.ok ? [direct, prox] : [direct], name, null);
    }
    default: {
      const direct = { type: 'file', url: d.url };
      const prox = { type: 'file', url: proxied(d.url) };
      return playSources(viaProxy ? [prox] : backend.ok ? [direct, prox] : [direct], name, d.url);
    }
  }
}

// ---------- history ----------

function getHistory() {
  return storage(() => JSON.parse(localStorage.getItem(HISTORY_KEY)) || [], []);
}
function addHistory(url, kind) {
  const h = getHistory().filter((x) => x.url !== url);
  h.unshift({ url, kind, at: Date.now() });
  storage(() => localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 15))));
  renderHistory();
}
function renderHistory() {
  const h = getHistory();
  els.historyBox.hidden = !h.length;
  els.history.innerHTML = '';
  for (const item of h) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const link = document.createElement('span');
    link.className = 'link';
    link.textContent = item.url;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.kind;
    b.append(link, kind);
    b.onclick = () => { els.url.value = item.url; play(item.url); };
    li.appendChild(b);
    els.history.appendChild(li);
  }
}

// ---------- events ----------

els.form.addEventListener('submit', (e) => { e.preventDefault(); play(els.url.value); });
els.paste.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { els.url.value = t.trim(); play(t); }
  } catch {
    els.url.focus();
    setStatus('Clipboard access was blocked. Paste the link into the box instead.');
  }
});
els.speed.addEventListener('change', () => {
  const v = els.player.querySelector('video');
  if (v) v.playbackRate = Number(els.speed.value);
});
els.pip.addEventListener('click', async () => {
  const v = els.player.querySelector('video');
  if (!v) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } catch { /* not available */ }
});
els.clearHistory.addEventListener('click', () => {
  storage(() => localStorage.removeItem(HISTORY_KEY));
  renderHistory();
});
els.useProxy.checked = storage(() => localStorage.getItem('linkplay.proxy') === '1', false);
els.useProxy.addEventListener('change', () => storage(() => localStorage.setItem('linkplay.proxy', els.useProxy.checked ? '1' : '0')));

els.saveServer.addEventListener('click', async () => {
  const v = cleanBase(els.server.value);
  if (v && !/^https?:\/\//.test(v)) return (els.serverState.textContent = 'Server URL must start with http:// or https://');
  storage(() => localStorage.setItem('linkplay.server', v));
  els.serverState.textContent = 'Checking…';
  await checkBackend();
});

renderHistory();

// Support share links like ?url=https://...
checkBackend().then(() => {
  const initial = new URLSearchParams(location.search).get('url');
  if (initial) { els.url.value = initial; play(initial); }
});
