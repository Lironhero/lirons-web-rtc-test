# Liron's Web RTC Test

Godot browser multiplayer game: static web build (`public/`) + lobby/WebRTC
signaling server (`server.js`) served together by `serve.js`. Deploys on
Render via `render.yaml`.

## Run locally

```bash
npm install
npm start   # serves on PORT (default 8080)
```

## Deploy on Render

1. Push this repo to GitHub.
2. In Render dashboard: **New → Blueprint**, select this repo.
3. Choose the Free instance type. Render runs `npm install` + `npm start`
   and serves it at `https://lirons-web-rtc-test.onrender.com`.
4. Free instances sleep after 15 min idle (wake ~30s on next request).

## Redeploying the game build

When the Godot web build changes, copy the files from `build/web/` into
`public/` and commit. Render auto-deploys on push.
