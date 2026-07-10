# Publish Cricket Versus Online

This app is a live multiplayer website. Deploy it as a Node web service with WebSocket support. Do not deploy only `public/index.html` as a static site, because the shared room, draft, and match state live in `server.js`.

## What To Upload

Upload the whole `cricket-1v1` repository:

```text
server.js
package.json
public/index.html
data/players.json or data/players.json.gz.b64
EVENTS.md
Dockerfile
Procfile
```

Do not upload `node_modules`, logs, or `data/rooms.json`.

## Web Service Settings

Use these settings on any Node hosting service:

```text
Runtime: Node 20 or newer
Build command: npm install
Start command: node server.js
Health check path: /healthz
Public port: provided by the host as PORT
Instance count: 1
```

Important: keep the instance count at `1` unless you later add a shared Socket.IO adapter such as Redis. Multiple instances without shared socket state can split players into different copies of the same room.

## Optional Persistent Room Storage

The player database is already in `data/players.json`.
For compact repository publishing, the server can also load the same data from `data/players.json.gz.b64` when `data/players.json` is not present.

Room saves default to:

```text
data/rooms.json
```

For a hosted site, use persistent disk/storage if your provider offers it, then set:

```text
ROOMS_PATH=/your/persistent/disk/rooms.json
```

If you do not configure persistent storage, the game still works online, but rooms may disappear when the host restarts or redeploys.

## Docker Option

For a container host, build and run the included Dockerfile:

```powershell
docker build -t cricket-versus-online .
docker run -p 3000:3000 -e PORT=3000 cricket-versus-online
```

Then open:

```text
http://localhost:3000
```

## How Players Join

1. The host opens the published website.
2. The host creates a room.
3. The host presses **Copy Link**.
4. Other players open a link like:

```text
https://your-domain.com/room/ABC123
```

The link opens the website, joins the room, and keeps a private reconnect key in that browser so refreshes and short disconnects can recover the same seat.

## Verify Before Sharing

Run:

```powershell
npm run check
npm run smoke
```

The smoke test starts a temporary server, creates a room, opens the room URL, joins as a second player, reconnects the host, starts the draft, then verifies a solo CPU room can auto-complete its draft.
