const path = require("path");
const { io: Client } = require("socket.io-client");

process.env.ROOMS_PATH = path.join(process.env.TEMP || process.env.TMP || ".", `cricket-online-smoke-${Date.now()}.json`);

const { server, io, startServer } = require("../server");

function emit(socket, eventName, payload = {}) {
  return new Promise((resolve) => socket.emit(eventName, payload, resolve));
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket did not connect in time.")), 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", reject);
  });
}

function assertOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed: ${response?.message || "no acknowledgement"}`);
  }
  return response;
}

async function closeServer() {
  await new Promise((resolve) => io.close(resolve));
}

(async () => {
  startServer(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const host = Client(baseUrl);
  const guest = Client(baseUrl);
  await Promise.all([waitForConnect(host), waitForConnect(guest)]);

  const created = assertOk(await emit(host, "room:create", {
    playerName: "Host",
    settings: { teamCount: 2, overs: 5, mode: "series", seriesMatches: 1 }
  }), "room:create");
  if (!created.roomId || !created.playerId || !created.playerKey) {
    throw new Error("room:create did not return a full reconnect identity.");
  }

  const roomPage = await fetch(`${baseUrl}/room/${created.roomId}`);
  if (roomPage.status !== 200) throw new Error("Room URL did not serve the app.");

  const joined = assertOk(await emit(guest, "room:join", {
    roomId: created.roomId,
    playerName: "Guest"
  }), "room:join");
  if (!joined.playerId || !joined.playerKey) {
    throw new Error("room:join did not return a full reconnect identity.");
  }

  const reclaimedHost = Client(baseUrl);
  await waitForConnect(reclaimedHost);
  assertOk(await emit(reclaimedHost, "room:join", {
    roomId: created.roomId,
    playerName: "Host",
    playerId: created.playerId,
    playerKey: created.playerKey
  }), "host reconnect");

  assertOk(await emit(reclaimedHost, "game:start"), "game:start after reconnect");

  host.close();
  guest.close();
  reclaimedHost.close();
  await closeServer();
  console.log(`Smoke test passed: room ${created.roomId} linked, joined, reconnected, and started.`);
})().catch(async (error) => {
  console.error(error);
  try {
    await closeServer();
  } catch {}
  process.exitCode = 1;
});
