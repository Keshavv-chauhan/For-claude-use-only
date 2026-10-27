// LinkPlay server: serves the player page, resolves Terabox share links,
// and proxies video streams (with Range support) so the browser can play
// files that need special headers or block cross-origin requests.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const TERABOX_COOKIE = (process.env.TERABOX_COOKIE || '').trim();
const TERABOX_DOMAIN = (process.env.TERABOX_DOMAIN || 'www.terabox.com').trim();
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PUBLIC_DIR = path.join(__dirname, 'public');

const TERABOX_HOST_RE =
  /(^|\.)(terabox|1024terabox|1024tera|teraboxapp|terabox\.app|teraboxlink|terasharelink|terafileshare|teraboxshare|4funbox|mirrobox|nephobox|freeterabox|momerybox|tibibox|gibibox|terabox\.fun)\b/i;

// Lets a page hosted elsewhere (e.g. GitHub Pages) use this server.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// ---------- helpers ----------

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env file */
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS,
  });
  res.end(body);
}

function isTeraboxHost(hostname) {
  return TERABOX_HOST_RE.test(hostname);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// Block requests to localhost / private networks (SSRF protection).
async function assertPublicUrl(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links are supported');
  if (process.env.ALLOW_PRIVATE_PROXY === '1') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address is not allowed');
  }
}

function upstreamHeaders(u, extra = {}) {
  const h = { 'User-Agent': UA, Accept: '*/*', ...extra };
  if (isTeraboxHost(u.hostname)) {
    if (TERABOX_COOKIE) h.Cookie = TERABOX_COOKIE;
    h.Referer = `https://${TERABOX_DOMAIN}/`;
  }
  return h;
}

// fetch that re-checks every redirect hop against the SSRF guard.
async function safeFetch(urlStr, opts = {}, hops = 0) {
  const u = new URL(urlStr);
  await assertPublicUrl(u);
  const res = await fetch(u, {
    ...opts,
    headers: upstreamHeaders(u, opts.headers),
    redirect: 'manual',
  });
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
    if (hops >= 6) throw new Error('Too many redirects');
    return safeFetch(new URL(res.headers.get('location'), u).href, opts, hops + 1);
  }
  res.finalUrl = u.href;
  return res;
}

// ---------- Terabox ----------

function parseTeraboxLink(link) {
  let u;
  try {
    u = new URL(link.trim());
  } catch {
    throw new Error('Not a valid link');
  }
  if (!isTeraboxHost(u.hostname)) throw new Error('Not a Terabox link');
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1].startsWith('1') ? m[1] : '1' + m[1];
  const surl = u.searchParams.get('surl');
  if (surl) return '1' + surl;
  throw new Error('Could not find the share ID in this Terabox link');
}

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi|m4v|flv|wmv|3gp|ts|mpg|mpeg)$/i;

async function tbJson(url) {
  const res = await safeFetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Terabox returned an unexpected response (HTTP ${res.status})`);
  }
}

async function resolveTerabox(link) {
  const shorturl = parseTeraboxLink(link);
  const surl = shorturl.slice(1);
  const base = `https://${TERABOX_DOMAIN}`;
  const common = 'app_id=250528&web=1&channel=dubox&clienttype=0';

  // The share page contains a jsToken that newer API calls require.
  let jsToken = '';
  try {
    const page = await (await safeFetch(`${base}/sharing/link?surl=${surl}`)).text();
    const m = page.match(/fn%28%22([0-9A-Fa-f]+)%22%29/) || page.match(/"jsToken"\s*:\s*"([^"]+)"/);
    if (m) jsToken = m[1];
  } catch {
    /* jsToken is optional for some accounts */
  }
  const tok = jsToken ? `&jsToken=${jsToken}` : '';

  const info = await tbJson(`${base}/api/shorturlinfo?${common}${tok}&shorturl=${shorturl}&root=1`);
  if (info.errno !== 0) {
    const hint = TERABOX_COOKIE ? '' : ' Set TERABOX_COOKIE on the server (see README).';
    throw new Error(`Terabox refused the request (errno ${info.errno}).${hint}`);
  }
  const { shareid, uk, sign, timestamp } = info;

  async function listDir(dir, depth) {
    const q = dir ? `&dir=${encodeURIComponent(dir)}` : '&root=1';
    const data = await tbJson(`${base}/share/list?${common}${tok}&shorturl=${surl}${q}&page=1&num=1000&order=name`);
    if (data.errno !== 0) throw new Error(`Could not list shared files (errno ${data.errno})`);
    const out = [];
    for (const f of data.list || []) {
      if (String(f.isdir) === '1') {
        if (depth < 3) out.push(...(await listDir(f.path, depth + 1)));
        continue;
      }
      out.push(f);
    }
    return out;
  }

  const raw = await listDir('', 0);
  const files = raw.map((f) => {
    const isVideo = String(f.category) === '1' || VIDEO_EXT.test(f.server_filename || '');
    const streamParams = new URLSearchParams({
      uk, shareid, type: 'M3U8_AUTO_720', fid: f.fs_id, sign, timestamp,
      clienttype: '0', app_id: '250528', web: '1', channel: 'dubox', esl: '1', isplayer: '1', ehps: '1',
    });
    if (jsToken) streamParams.set('jsToken', jsToken);
    return {
      name: f.server_filename,
      size: Number(f.size) || 0,
      isVideo,
      thumb: f.thumbs && (f.thumbs.url3 || f.thumbs.url2 || f.thumbs.url1) || null,
      dlink: f.dlink || null,
      hls: isVideo ? `${base}/share/streaming?${streamParams}` : null,
    };
  });
  return { title: info.title || files[0]?.name || 'Terabox share', files };
}

// ---------- proxy ----------

function proxify(abs) {
  return '/api/proxy?url=' + encodeURIComponent(abs);
}

function rewritePlaylist(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(new URL(uri, baseUrl).href)}"`);
      }
      return proxify(new URL(t, baseUrl).href);
    })
    .join('\n');
}

async function handleProxy(req, res, target) {
  if (!target) return sendJson(res, 400, { error: 'Missing url' });
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  let up;
  try {
    up = await safeFetch(target, { headers, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    return sendJson(res, 502, { error: e.message });
  }

  const ct = up.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(up.finalUrl) || /\/share\/streaming/.test(up.finalUrl);
  if (isPlaylist && up.ok) {
    const text = await up.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', ...CORS });
      return res.end(rewritePlaylist(text, up.finalUrl));
    }
    // Terabox sends a JSON error instead of a playlist when something is wrong.
    return sendJson(res, 502, { error: 'Stream not available', detail: text.slice(0, 300) });
  }

  const out = { ...CORS };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  if (!out['accept-ranges'] && up.status === 206) out['accept-ranges'] = 'bytes';
  res.writeHead(up.status, out);
  if (!up.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body)
    .on('error', () => res.destroy())
    .pipe(res);
}

// ---------- static ----------

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS' && u.pathname.startsWith('/api/')) {
    res.writeHead(204, {
      ...CORS,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  try {
    if (u.pathname === '/api/terabox') {
      const link = u.searchParams.get('url');
      if (!link) return sendJson(res, 400, { error: 'Missing url' });
      return sendJson(res, 200, await resolveTerabox(link));
    }
    if (u.pathname === '/api/proxy') return await handleProxy(req, res, u.searchParams.get('url'));
    if (u.pathname === '/api/status') {
      return sendJson(res, 200, { ok: true, teraboxCookie: Boolean(TERABOX_COOKIE) });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    const msg = e.message === 'fetch failed' ? 'Could not reach Terabox from the server. Try again later.' : e.message;
    if (!res.headersSent) sendJson(res, 400, { error: msg || 'Something went wrong' });
    else res.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`LinkPlay running on http://localhost:${PORT}`);
    if (!TERABOX_COOKIE) console.log('Note: TERABOX_COOKIE is not set; many Terabox links will fail.');
  });
}

module.exports = { server, parseTeraboxLink, rewritePlaylist, isPrivateIp };
