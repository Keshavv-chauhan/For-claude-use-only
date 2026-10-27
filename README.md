# LinkPlay

A small web app that plays videos from a link. Paste a link, press **Play**.

**Supported links**

| Link type | How it plays |
|---|---|
| Terabox share links (terabox.com, 1024terabox, teraboxapp, terasharelink, 4funbox, mirrobox, nephobox, …) | Server reads the share, lists the videos, streams them through the proxy |
| Direct files (`.mp4`, `.webm`, `.mov`, …) | Built-in video player, with automatic proxy fallback |
| HLS (`.m3u8`) | hls.js (or native HLS on Safari / iOS) |
| DASH (`.mpd`) | dash.js |
| YouTube, Vimeo, Dailymotion, Streamable, Google Drive | Their official embed player |
| Dropbox | Converted to a raw file link |

Also: playback speed, picture-in-picture, recent links, and `/?url=<link>` to open a link directly.

## Live site (GitHub Pages)

**https://keshavv-chauhan.github.io/For-claude-use-only/**

The page is published from `public/` to the `gh-pages` branch by `.github/workflows/pages.yml` on every push.

GitHub Pages only hosts static files, so on its own the live site plays direct files, HLS/DASH streams, YouTube, Vimeo, Drive and so on. **Terabox links and the proxy need the server** (`server.js`) running somewhere:

1. Host the server for free on Render: Render dashboard → **New → Blueprint** → pick this repo (it reads `render.yaml`). Set `TERABOX_COOKIE` when asked.
2. Open the live site → **Server settings** → paste your server's URL (e.g. `https://linkplay.onrender.com`) → **Save**.
   To make it the default for everyone, set `window.LINKPLAY_SERVER` in `public/config.js` instead.

Render's free plan sleeps when idle, so the first Terabox link after a while can take ~30 seconds.

## Run it locally

Needs Node.js 18 or newer. No `npm install` needed (no dependencies).

```bash
cp .env.example .env   # then fill in TERABOX_COOKIE
npm start              # http://localhost:3000
```

Or with Docker:

```bash
docker build -t linkplay .
docker run -p 3000:3000 -e TERABOX_COOKIE="ndus=..." linkplay
```

## Terabox setup

Terabox only gives out file links to logged-in users, so the server needs your login cookie:

1. Log in at terabox.com in a desktop browser.
2. Open DevTools → Application → Cookies → `https://www.terabox.com`.
3. Copy the `ndus` cookie value and set `TERABOX_COOKIE=ndus=<value>` in `.env`.

If a share still fails, try `TERABOX_DOMAIN=www.1024tera.com` (or another Terabox domain). Terabox changes its private API from time to time, so a resolver update may occasionally be needed.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `TERABOX_COOKIE` | empty | Terabox login cookie (`ndus=...`) |
| `TERABOX_DOMAIN` | `www.terabox.com` | Domain used for Terabox API calls |
| `ALLOW_PRIVATE_PROXY` | off | Set to `1` to allow proxying to local/private addresses (testing only) |

## Notes

- The proxy (`/api/proxy`) refuses localhost and private network addresses. It is otherwise open, so if you host it publicly, put it behind a login or limit who can reach it, since anyone could use your bandwidth.
- Browsers can't play every format: `.mkv` with some codecs won't play directly. For Terabox, the app tries Terabox's own HLS stream first (works for any format), then the original file.
- Only play content you have the right to watch.
