# Cricket Versus Online

Deployable Socket.IO website for live remote cricket draft rooms.

## Run Locally

```powershell
git clone https://github.com/thedhoklamonger/cricket-1v1.git
cd cricket-1v1
pnpm install
pnpm start
```

Open:

```text
http://localhost:3000
```

Create a room, then use **Copy Link**. The link will look like:

```text
http://localhost:3000/room/ABC123
```

On a published website it will use your real domain:

```text
https://your-domain.com/room/ABC123
```

Anyone opening that room link is taken straight into the room with their saved name, or a generated guest name if they are new. If you are only running locally, `localhost` links work on your computer only; other people need a deployed site URL or a reachable server address.

## Verify

```powershell
pnpm check
pnpm smoke
```

The smoke test creates a room, loads its `/room/ROOMCODE` URL, joins from a second simulated player, reconnects the host, and starts the draft.

## What Is Included

- Host creates a room code.
- Other players join by code or shared `/room/ROOMCODE` link.
- Host controls lobby settings.
- Server owns the draft state, draw state, fixtures, and match simulation.
- Server validates every spin, skip, pick, slot, speed, and skip-to-end request.
- Clients receive personalized `room:update` snapshots.
- Browsers store a private per-room reconnect key so refreshes and short disconnects can reclaim the same player seat.
- Player data loads from `data/players.json` when present, or from the compact `data/players.json.gz.b64` file included in this repo.
- Room state is saved to `data/rooms.json` by default.

See `EVENTS.md` for the event contract and `DEPLOYMENT.md` for publishing instructions.

## Publish Checklist

1. Deploy this repository as a Node web service, not a static site. Socket.IO needs a running server.
2. Use:

```text
Runtime: Node 20 or newer
Build command: corepack enable && pnpm install --frozen-lockfile
Start command: pnpm start
Health check path: /healthz
Instance count: 1
```

3. Make sure the host provides a `PORT` environment variable. The server binds to `0.0.0.0` and uses `process.env.PORT`.
4. Give the app persistent disk/storage if the host supports it, and keep `data/rooms.json` on that disk.
5. Keep the app on one server instance unless you add a shared Socket.IO adapter such as Redis.

## Storage

Defaults:

```text
Player database: data/players.json
Compressed fallback: data/players.json.gz.b64
Saved rooms: data/rooms.json
```

Optional environment variables:

```text
PLAYERS_PATH=/path/to/players.json
ROOMS_PATH=/path/to/rooms.json
```

If a room is restored after a server restart, players can rejoin using the same room code and original player name. A match that was running during restart is returned to pending.
