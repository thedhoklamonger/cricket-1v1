const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || process.argv[2] || 3000);
const SKIPS_PER_TEAM = 2;
const SPEEDS = new Set([1, 2, 4]);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_PATH = path.join(PUBLIC_DIR, "index.html");
const PLAYERS_PATH = process.env.PLAYERS_PATH || path.join(DATA_DIR, "players.json");
const ROOMS_PATH = process.env.ROOMS_PATH || path.join(DATA_DIR, "rooms.json");

const CLIENT_EVENTS = {
  CREATE_ROOM: "room:create",
  JOIN_ROOM: "room:join",
  UPDATE_SETTINGS: "room:updateSettings",
  START_GAME: "game:start",
  DRAFT_SPIN: "draft:spin",
  DRAFT_PICK: "draft:pick",
  DRAFT_AUTO: "draft:auto",
  MATCH_START_NEXT: "match:startNext",
  MATCH_SET_SPEED: "match:setSpeed",
  MATCH_SKIP_TO_END: "match:skipToEnd",
  MATCH_RESET: "match:reset",
  SNAPSHOT: "room:snapshot"
};

const SERVER_EVENTS = {
  UPDATE: "room:update",
  ERROR: "room:error"
};

const { DB, NATIONS, DECADES } = loadDatabase();
const CARD_BY_ID = new Map(DB.map((card) => [card.id, card]));
const rooms = loadRooms();
const timers = new Map();
const cpuDraftTimers = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.static(PUBLIC_DIR));
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/api/status", (req, res) => res.json({
  ok: true,
  activeRooms: rooms.size,
  cards: DB.length,
  uptime: Math.round(process.uptime())
}));
app.get("/api/cards", (req, res) => res.json(DB));
app.get("/api/events", (req, res) => res.json({ client: CLIENT_EVENTS, server: SERVER_EVENTS }));
app.get("/room/:roomId", (req, res) => res.sendFile(INDEX_PATH));
app.get("/join/:roomId", (req, res) => res.redirect(302, `/room/${cleanRoomCode(req.params.roomId)}`));

io.on("connection", (socket) => {
  socket.on(CLIENT_EVENTS.CREATE_ROOM, (payload = {}, ack) => createRoom(socket, payload, ack));
  socket.on(CLIENT_EVENTS.JOIN_ROOM, (payload = {}, ack) => joinRoom(socket, payload, ack));
  socket.on(CLIENT_EVENTS.UPDATE_SETTINGS, (payload = {}, ack) => updateSettings(socket, payload, ack));
  socket.on(CLIENT_EVENTS.START_GAME, (payload = {}, ack) => startGame(socket, ack));
  socket.on(CLIENT_EVENTS.DRAFT_SPIN, (payload = {}, ack) => spinDraft(socket, payload, ack));
  socket.on(CLIENT_EVENTS.DRAFT_PICK, (payload = {}, ack) => pickDraftCard(socket, payload, ack));
  socket.on(CLIENT_EVENTS.DRAFT_AUTO, (payload = {}, ack) => autoDraftRemaining(socket, ack));
  socket.on(CLIENT_EVENTS.MATCH_START_NEXT, (payload = {}, ack) => startNextMatch(socket, ack));
  socket.on(CLIENT_EVENTS.MATCH_SET_SPEED, (payload = {}, ack) => setMatchSpeed(socket, payload, ack));
  socket.on(CLIENT_EVENTS.MATCH_SKIP_TO_END, (payload = {}, ack) => skipMatchToEnd(socket, ack));
  socket.on(CLIENT_EVENTS.MATCH_RESET, (payload = {}, ack) => resetMatches(socket, ack));
  socket.on(CLIENT_EVENTS.SNAPSHOT, (payload = {}, ack) => sendSnapshot(socket, ack));
  socket.on("disconnect", () => markDisconnected(socket));
});

if (require.main === module) {
  startServer();
}

process.on("SIGINT", () => {
  persistRooms();
  process.exit(0);
});

process.on("SIGTERM", () => {
  persistRooms();
  process.exit(0);
});

module.exports = { app, server, io, startServer };

function startServer(port = PORT) {
  return server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    console.log(`Cricket Versus Online running at http://localhost:${actualPort}`);
  });
}

function loadDatabase() {
  const payload = JSON.parse(readPlayerDatabase());
  return {
    DB: payload.cards,
    NATIONS: payload.nations,
    DECADES: payload.decades
  };
}

function readPlayerDatabase() {
  if (fs.existsSync(PLAYERS_PATH)) return fs.readFileSync(PLAYERS_PATH, "utf8");
  const packedPath = `${PLAYERS_PATH}.gz.b64`;
  if (!fs.existsSync(packedPath)) {
    throw new Error(`Player database not found at ${PLAYERS_PATH} or ${packedPath}`);
  }
  const packed = fs.readFileSync(packedPath, "utf8").replace(/\s+/g, "");
  return zlib.gunzipSync(Buffer.from(packed, "base64")).toString("utf8");
}

function loadRooms() {
  if (!fs.existsSync(ROOMS_PATH)) return new Map();
  try {
    const raw = fs.readFileSync(ROOMS_PATH, "utf8").trim();
    if (!raw) return new Map();
    const savedRooms = JSON.parse(raw);
    return new Map(savedRooms.map((room) => {
      const restored = restoreRoom(room);
      return [restored.id, restored];
    }));
  } catch (error) {
    console.warn(`Could not load saved rooms: ${error.message}`);
    return new Map();
  }
}

function restoreRoom(room) {
  const restored = {
    ...room,
    settings: sanitizeSettings(room.settings || {}),
    players: (room.players || []).map((player) => ({
      ...player,
      joinKey: player.joinKey || makeId("key"),
      socketId: null,
      connected: false
    })),
    managers: room.managers || [],
    pickOrder: room.pickOrder || [],
    draftLog: room.draftLog || [],
    matches: room.matches || [],
    runningMatchId: null
  };
  restored.matches.forEach((match) => {
    if (match.status === "running") {
      match.status = "pending";
      match.result = null;
      match.live = null;
    }
  });
  if (restored.phase !== "lobby") {
    restored.status = "Room restored. Players can rejoin by code.";
  }
  return restored;
}

function persistRooms() {
  fs.mkdirSync(path.dirname(ROOMS_PATH), { recursive: true });
  const payload = [...rooms.values()].map((room) => serializeRoom(room));
  const tempPath = `${ROOMS_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, ROOMS_PATH);
}

function serializeRoom(room) {
  const saved = JSON.parse(JSON.stringify(room));
  saved.players = saved.players.map((player) => ({
    ...player,
    socketId: null,
    connected: false
  }));
  saved.runningMatchId = null;
  saved.matches.forEach((match) => {
    if (match.status === "running") {
      match.status = "pending";
      match.result = null;
      match.live = null;
    }
  });
  return saved;
}

function createRoom(socket, payload, ack) {
  const playerName = cleanName(payload.playerName, "Host");
  const roomId = makeRoomId();
  const playerId = makeId("p");
  const joinKey = makeId("key");
  const settings = sanitizeSettings(payload.settings);
  const player = { id: playerId, joinKey, name: playerName, socketId: socket.id, connected: true, host: true };
  const room = {
    id: roomId,
    hostPlayerId: playerId,
    phase: "lobby",
    status: "Waiting for players.",
    settings,
    players: [player],
    managers: [],
    pickOrder: [],
    currentPick: 0,
    draw: null,
    draftLog: [],
    matches: [],
    runningMatchId: null,
    simSpeed: 1
  };
  rooms.set(roomId, room);
  socket.data.roomId = roomId;
  socket.data.playerId = playerId;
  socket.join(roomId);
  reply(ack, { roomId, playerId, playerKey: joinKey });
  emitRoom(room);
}

function joinRoom(socket, payload, ack) {
  const roomId = cleanRoomCode(payload.roomId);
  const room = rooms.get(roomId);
  if (!room) return fail(socket, ack, "Room not found.");
  const playerName = cleanName(payload.playerName, `Player ${room.players.length + 1}`);
  const requestedPlayerId = String(payload.playerId || "");
  const requestedPlayerKey = String(payload.playerKey || "");
  const existingByKey = room.players.find((player) => player.id === requestedPlayerId && player.joinKey === requestedPlayerKey);
  const existingByName = room.players.find((player) => player.name.toLowerCase() === playerName.toLowerCase());
  const existingPlayer = existingByKey || existingByName;

  if (existingPlayer) {
    const keyMatched = existingPlayer === existingByKey;
    if (existingPlayer.connected && existingPlayer.socketId && !keyMatched) return fail(socket, ack, "That player name is already connected.");
    if (!existingPlayer.joinKey) existingPlayer.joinKey = makeId("key");
    if (existingPlayer.socketId && existingPlayer.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingPlayer.socketId);
      if (oldSocket) {
        oldSocket.data.roomId = null;
        oldSocket.data.playerId = null;
        oldSocket.disconnect(true);
      }
    }
    existingPlayer.name = playerName;
    existingPlayer.socketId = socket.id;
    existingPlayer.connected = true;
    socket.data.roomId = roomId;
    socket.data.playerId = existingPlayer.id;
    socket.join(roomId);
    room.status = `${existingPlayer.name} rejoined the room.`;
    reply(ack, { roomId, playerId: existingPlayer.id, playerKey: existingPlayer.joinKey });
    emitRoom(room);
    scheduleCpuDraft(room);
    return;
  }

  if (room.phase !== "lobby") return fail(socket, ack, "This room has already started. Rejoin with your original player name.");
  if (room.players.length >= humanCapacity(room.settings)) return fail(socket, ack, "This room is full.");

  const playerId = makeId("p");
  const joinKey = makeId("key");
  const player = {
    id: playerId,
    joinKey,
    name: playerName,
    socketId: socket.id,
    connected: true,
    host: false
  };
  room.players.push(player);
  socket.data.roomId = roomId;
  socket.data.playerId = playerId;
  socket.join(roomId);
  room.status = `${player.name} joined the room.`;
  reply(ack, { roomId, playerId, playerKey: joinKey });
  emitRoom(room);
  scheduleCpuDraft(room);
}

function updateSettings(socket, payload, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (!isHost(room, socket.data.playerId)) return fail(socket, ack, "Only the host can change settings.");
  if (room.phase !== "lobby") return fail(socket, ack, "Settings are locked after the draft starts.");
  const nextSettings = sanitizeSettings({ ...room.settings, ...(payload.settings || {}) });
  if (room.players.length > humanCapacity(nextSettings)) {
    return fail(socket, ack, "Too many players are already in this room for that mode.");
  }
  room.settings = nextSettings;
  room.status = "Room settings updated.";
  reply(ack, {});
  emitRoom(room);
}

function startGame(socket, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (!isHost(room, socket.data.playerId)) return fail(socket, ack, "Only the host can start the draft.");
  if (room.phase !== "lobby") return fail(socket, ack, "The game has already started.");
  clearCpuDraftTimer(room);
  stopRoomTimer(room);
  const activePlayers = room.players.filter((player) => player.connected || player.socketId);
  const requiredHumans = requiredHumanPlayers(room.settings);
  if (activePlayers.length < requiredHumans) {
    return fail(socket, ack, `Need ${requiredHumans} player${requiredHumans === 1 ? "" : "s"} for this room.`);
  }

  if (room.settings.gameMode === "cpu") {
    const player = activePlayers[0];
    room.managers = [
      createManager(0, player.name, player.id, false),
      createManager(1, "CPU XI", null, true)
    ];
  } else {
    room.managers = activePlayers.slice(0, room.settings.teamCount).map((player, index) =>
      createManager(index, player.name, player.id, false)
    );
  }
  room.pickOrder = buildPickOrder(room.managers.length, 11);
  room.currentPick = 0;
  room.draw = null;
  room.draftLog = [];
  room.matches = [];
  room.runningMatchId = null;
  room.phase = "draft";
  room.status = `${activeManager(room).name} starts the snake draft.`;
  reply(ack, {});
  emitRoom(room);
  scheduleCpuDraft(room);
}

function spinDraft(socket, payload, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (room.phase !== "draft") return fail(socket, ack, "The draft is not active.");
  if (!isActivePlayer(room, socket.data.playerId)) return fail(socket, ack, "It is not your turn.");
  const teamIndex = activeTeamIndex(room);
  const manager = activeManager(room);
  const skip = Boolean(payload.skip);
  if (room.draw && !skip) return fail(socket, ack, "Pick from the current draw first.");
  if (skip) {
    if (!room.draw) return fail(socket, ack, "There is no draw to skip.");
    if (manager.skipsLeft <= 0) return fail(socket, ack, "No skips left.");
    manager.skipsLeft--;
  }
  const pair = randomValidPair(room, teamIndex);
  if (!pair) return fail(socket, ack, "No eligible cards remain.");
  room.draw = pair;
  room.status = `${manager.name} drew ${pair.nation}, ${pair.decade}.`;
  reply(ack, {});
  emitRoom(room);
}

function pickDraftCard(socket, payload, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (room.phase !== "draft") return fail(socket, ack, "The draft is not active.");
  if (!isActivePlayer(room, socket.data.playerId)) return fail(socket, ack, "It is not your turn.");
  if (!room.draw) return fail(socket, ack, "Spin a country and decade first.");
  const teamIndex = activeTeamIndex(room);
  const card = CARD_BY_ID.get(String(payload.cardId || ""));
  const slot = Number(payload.slot);
  if (!card) return fail(socket, ack, "Card not found.");
  if (card.nation !== room.draw.nation || card.decade !== room.draw.decade) return fail(socket, ack, "That card is not in the current draw.");
  if (takenByTeam(room, card)) return fail(socket, ack, `${card.baseName} has already been drafted.`);
  if (!Number.isInteger(slot) || !playableSlotsFor(room, card, teamIndex).includes(slot)) return fail(socket, ack, "That batting slot is not legal.");

  applyDraftPick(room, teamIndex, card, slot, `${room.draw.nation}, ${room.draw.decade}`);
  reply(ack, {});
  emitRoom(room);
  scheduleCpuDraft(room);
}

function autoDraftRemaining(socket, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (!isHost(room, socket.data.playerId)) return fail(socket, ack, "Only the host can auto draft.");
  if (room.phase !== "draft") return fail(socket, ack, "The draft is not active.");
  const picks = autoDraftRoom(room);
  if (!picks) return fail(socket, ack, "No legal auto draft pick was found.");
  room.status = draftComplete(room) ? "Draft complete. Matches are ready." : `Auto drafted ${picks} pick${picks === 1 ? "" : "s"}.`;
  reply(ack, { picks });
  emitRoom(room);
}

function startNextMatch(socket, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (room.phase !== "matches") return fail(socket, ack, "Complete the draft first.");
  if (runningMatch(room)) return fail(socket, ack, "A match is already running.");
  maybeCreateFinal(room);
  const match = room.matches.find((item) => item.status === "pending");
  if (!match) return fail(socket, ack, "No pending matches.");
  startLiveMatch(room, match);
  reply(ack, {});
  emitRoom(room);
}

function setMatchSpeed(socket, payload, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  const speed = Number(payload.speed);
  if (!SPEEDS.has(speed)) return fail(socket, ack, "Speed must be 1, 2, or 4.");
  room.simSpeed = speed;
  if (runningMatch(room)) startRoomTimer(room);
  reply(ack, {});
  emitRoom(room);
}

function skipMatchToEnd(socket, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (room.phase !== "matches") return fail(socket, ack, "Complete the draft first.");
  const running = runningMatch(room);
  if (running) {
    finishLiveMatchToEnd(room, running);
    reply(ack, {});
    emitRoom(room);
    return;
  }
  maybeCreateFinal(room);
  const match = room.matches.find((item) => item.status === "pending");
  if (!match) return fail(socket, ack, "No pending matches.");
  match.result = simulateMatch(room, match.a, match.b);
  match.status = "complete";
  room.status = match.result.summary;
  room.runningMatchId = null;
  maybeCreateFinal(room);
  reply(ack, {});
  emitRoom(room);
}

function resetMatches(socket, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  if (!isHost(room, socket.data.playerId)) return fail(socket, ack, "Only the host can reset results.");
  if (room.phase !== "matches") return fail(socket, ack, "Complete the draft first.");
  stopRoomTimer(room);
  buildFixtures(room);
  room.status = "Match results reset.";
  reply(ack, {});
  emitRoom(room);
}

function sendSnapshot(socket, ack) {
  const room = getSocketRoom(socket);
  if (!room) return fail(socket, ack, "Join or create a room first.");
  socket.emit(SERVER_EVENTS.UPDATE, publicRoom(room, socket.data.playerId));
  reply(ack, {});
}

function markDisconnected(socket) {
  const room = getSocketRoom(socket);
  if (!room) return;
  const player = room.players.find((item) => item.id === socket.data.playerId);
  if (player && player.socketId === socket.id) {
    player.connected = false;
    player.socketId = null;
    room.status = `${player.name} disconnected.`;
    emitRoom(room);
  }
}

function buildFixtures(room) {
  stopRoomTimer(room);
  room.matches = [];
  room.runningMatchId = null;
  if (room.settings.gameMode !== "tournament") {
    for (let index = 1; index <= room.settings.seriesMatches; index++) {
      room.matches.push({
        id: `match-${index}`,
        stage: room.settings.seriesMatches > 1 ? `Match ${index}` : "Match",
        a: 0,
        b: 1,
        status: "pending",
        result: null,
        live: null
      });
    }
    return;
  }
  if (room.managers.length === 2) {
    room.matches.push({ id: "final-1", stage: "Final", a: 0, b: 1, status: "pending", result: null, live: null });
    return;
  }
  let id = 1;
  for (let a = 0; a < room.managers.length; a++) {
    for (let b = a + 1; b < room.managers.length; b++) {
      room.matches.push({ id: `league-${id++}`, stage: "League", a, b, status: "pending", result: null, live: null });
    }
  }
}

function maybeCreateFinal(room) {
  if (room.settings.gameMode !== "tournament" || room.managers.length <= 2 || !room.matches.length) return;
  const hasFinal = room.matches.some((match) => match.stage === "Final");
  const league = room.matches.filter((match) => match.stage === "League");
  if (hasFinal || league.some((match) => match.status !== "complete")) return;
  const top = standings(room).slice(0, 2);
  room.matches.push({ id: "final", stage: "Final", a: top[0].index, b: top[1].index, status: "pending", result: null, live: null });
}

function scheduleCpuDraft(room) {
  clearCpuDraftTimer(room);
  if (room.phase !== "draft" || !activeManager(room)?.cpu) return;
  const timer = setTimeout(() => {
    cpuDraftTimers.delete(room.id);
    cpuPickTurn(room);
  }, 650);
  cpuDraftTimers.set(room.id, timer);
}

function clearCpuDraftTimer(room) {
  const timer = cpuDraftTimers.get(room.id);
  if (timer) clearTimeout(timer);
  cpuDraftTimers.delete(room.id);
}

function cpuPickTurn(room) {
  if (room.phase !== "draft") return;
  const teamIndex = activeTeamIndex(room);
  const manager = activeManager(room);
  if (!manager?.cpu || teamIndex == null) return;
  const pair = randomValidPair(room, teamIndex);
  if (!pair) {
    room.status = `${manager.name} could not find an eligible draw.`;
    emitRoom(room);
    return;
  }
  room.draw = pair;
  const pick = bestDraftPick(room, teamIndex, cardsForDraw(pair));
  if (!pick) {
    room.status = `${manager.name} could not find a legal pick.`;
    emitRoom(room);
    return;
  }
  applyDraftPick(room, teamIndex, pick.card, pick.slot, `${pair.nation}, ${pair.decade}`);
  emitRoom(room);
  scheduleCpuDraft(room);
}

function autoDraftRoom(room) {
  clearCpuDraftTimer(room);
  let picks = 0;
  let guard = 0;
  while (room.phase === "draft" && guard < 120) {
    guard++;
    const teamIndex = activeTeamIndex(room);
    if (teamIndex == null) break;
    const pair = randomValidPair(room, teamIndex);
    if (!pair) break;
    room.draw = pair;
    const pick = bestDraftPick(room, teamIndex, cardsForDraw(pair));
    if (!pick) break;
    applyDraftPick(room, teamIndex, pick.card, pick.slot, `${pair.nation}, ${pair.decade}`);
    picks++;
  }
  return picks;
}

function applyDraftPick(room, teamIndex, card, slot, drawLabel) {
  const manager = room.managers[teamIndex];
  manager.xi[slot - 1] = card.id;
  room.draftLog.unshift({
    pick: room.currentPick + 1,
    team: manager.name,
    player: card.baseName,
    slot,
    draw: drawLabel
  });
  room.currentPick++;
  room.draw = null;
  if (draftComplete(room)) {
    clearCpuDraftTimer(room);
    room.phase = "matches";
    buildFixtures(room);
    room.status = "Draft complete. Matches are ready.";
  } else {
    room.status = `${activeManager(room).name} is on the clock.`;
  }
}

function startLiveMatch(room, match) {
  stopRoomTimer(room);
  match.live = createMatchShell(room, match.a, match.b);
  match.result = null;
  match.status = "running";
  room.runningMatchId = match.id;
  room.status = `${match.stage} is live.`;
  startRoomTimer(room);
}

function startRoomTimer(room) {
  stopRoomTimer(room);
  const timer = setInterval(() => {
    const match = runningMatch(room);
    if (!match) {
      stopRoomTimer(room);
      return;
    }
    for (let index = 0; index < room.simSpeed && match.status === "running"; index++) {
      playLiveBall(room, match);
    }
    emitRoom(room);
  }, Math.max(80, Math.round(360 / room.simSpeed)));
  timers.set(room.id, timer);
}

function stopRoomTimer(room) {
  const timer = timers.get(room.id);
  if (timer) clearInterval(timer);
  timers.delete(room.id);
}

function runningMatch(room) {
  return room.runningMatchId ? room.matches.find((match) => match.id === room.runningMatchId && match.status === "running") : null;
}

function playLiveBall(room, match) {
  const live = match.live;
  const innings = live.innings[live.currentInnings];
  if (!innings.complete) playBall(room, innings);
  if (!innings.complete) return;
  if (live.currentInnings === 0) {
    beginSecondInnings(room, live);
  } else {
    finishRunningMatch(room, match);
  }
}

function beginSecondInnings(room, live) {
  if (live.innings[1]) {
    live.currentInnings = 1;
    return;
  }
  const first = live.innings[0];
  live.innings[1] = createInnings(room, first.bowlingIndex, first.teamIndex, first.runs + 1);
  live.currentInnings = 1;
}

function finishRunningMatch(room, match) {
  stopRoomTimer(room);
  match.result = finishMatchResult(room, match.live);
  match.status = "complete";
  match.live = null;
  room.runningMatchId = null;
  room.status = match.result.summary;
  maybeCreateFinal(room);
}

function finishLiveMatchToEnd(room, match) {
  if (!match.live) return;
  const live = match.live;
  if (!live.innings[0].complete) simulateInnings(room, live.innings[0]);
  if (!live.innings[1]) beginSecondInnings(room, live);
  if (!live.innings[1].complete) simulateInnings(room, live.innings[1]);
  finishRunningMatch(room, match);
}

function simulateMatch(room, aIndex, bIndex) {
  const live = createMatchShell(room, aIndex, bIndex);
  simulateInnings(room, live.innings[0]);
  beginSecondInnings(room, live);
  simulateInnings(room, live.innings[1]);
  return finishMatchResult(room, live);
}

function createMatchShell(room, aIndex, bIndex) {
  const tossWinner = Math.random() < 0.5 ? aIndex : bIndex;
  const other = tossWinner === aIndex ? bIndex : aIndex;
  const batFirst = Math.random() < 0.55 ? tossWinner : other;
  const bowlFirst = batFirst === aIndex ? bIndex : aIndex;
  return {
    a: aIndex,
    b: bIndex,
    tossWinner,
    batFirst,
    bowlFirst,
    currentInnings: 0,
    innings: [createInnings(room, batFirst, bowlFirst, null)],
    tossText: `${room.managers[tossWinner].name} won the toss. ${room.managers[batFirst].name} batted first.`
  };
}

function finishMatchResult(room, live) {
  const first = live.innings[0];
  const second = live.innings[1];
  let winner = null;
  let tie = false;
  let summary = "";
  if (second.runs >= first.runs + 1) {
    winner = second.teamIndex;
    const wicketsLeft = 10 - second.wickets;
    summary = `${room.managers[winner].name} won by ${wicketsLeft} wicket${wicketsLeft === 1 ? "" : "s"}.`;
  } else if (second.runs === first.runs) {
    tie = true;
    summary = `Tie: both teams made ${first.runs}.`;
  } else {
    winner = first.teamIndex;
    summary = `${room.managers[winner].name} won by ${first.runs - second.runs} runs.`;
  }
  const nrr = {};
  nrr[first.teamIndex] = runRate(first) - runRate(second);
  nrr[second.teamIndex] = runRate(second) - runRate(first);
  return {
    innings: [first, second],
    winner,
    tie,
    summary,
    nrr,
    tossText: live.tossText
  };
}

function createInnings(room, battingIndex, bowlingIndex, target) {
  const xi = selectedCards(room, battingIndex);
  const bowlingXi = selectedCards(room, bowlingIndex);
  const maxBalls = room.settings.overs * 6;
  return {
    teamIndex: battingIndex,
    bowlingIndex,
    battingName: room.managers[battingIndex].name,
    bowlingName: room.managers[bowlingIndex].name,
    xi,
    bowlingXi,
    target,
    maxBalls,
    runs: 0,
    wickets: 0,
    legal: 0,
    striker: 0,
    nonStriker: 1,
    next: 2,
    complete: false,
    plan: buildBowlingPlan(bowlingXi, room.settings.overs),
    bat: xi.map((card) => ({ card, r: 0, b: 0, fours: 0, sixes: 0, out: false, how: "not out" })),
    bowl: bowlingXi.map((card) => ({ card, balls: 0, r: 0, w: 0, dots: 0 })),
    commentary: [],
    balls: []
  };
}

function buildBowlingPlan(xi, oversCount) {
  const plan = [];
  const used = new Map();
  const cap = Math.max(1, Math.ceil(oversCount / 5));
  for (let over = 0; over < oversCount; over++) {
    const ph = bowlingPhase(over, oversCount);
    let choices = xi.map((card, index) => ({ card, index }))
      .filter((item) => item.card.bowlSkill >= 8)
      .filter((item) => (used.get(item.index) || 0) < cap);
    if (!choices.length) choices = xi.map((card, index) => ({ card, index })).filter((item) => item.card.bowlSkill >= 8);
    const previous = plan[plan.length - 1];
    choices.sort((a, b) => bowlingOverValue(b.card, ph) - bowlingOverValue(a.card, ph));
    const nonRepeat = choices.find((item) => item.index !== previous) || choices[0];
    plan.push(nonRepeat.index);
    used.set(nonRepeat.index, (used.get(nonRepeat.index) || 0) + 1);
  }
  return plan;
}

function bowlingOverValue(card, ph) {
  const fit = card.bowlType === "new" && ph === "powerplay" ? 8 :
    card.bowlType === "middle" && ph === "middle overs" ? 8 :
    card.bowlType === "death" && ph === "death overs" ? 9 :
    card.bowlType === "part" ? -12 : 0;
  return bowlingValue(card) + fit + Math.random() * 4;
}

function simulateInnings(room, innings) {
  while (!innings.complete) playBall(room, innings);
}

function playBall(room, innings) {
  const striker = innings.xi[innings.striker];
  const stat = innings.bat[innings.striker];
  const over = Math.floor(innings.legal / 6);
  const ballInOver = innings.legal % 6;
  const bowlerIndex = innings.plan[over] ?? bestBowlerIndex(innings.bowlingXi);
  const bowler = innings.bowlingXi[bowlerIndex];
  const bowlerStat = innings.bowl[bowlerIndex];
  const ph = bowlingPhase(over, room.settings.overs);
  const label = `${over}.${ballInOver + 1}`;
  const intent = matchIntent(striker, ph, innings);
  const batQuality = battingValue(striker, innings.striker + 1) + striker.batPower * 0.16;
  const bowlQuality = bowlingValue(bowler);
  const pressure = innings.wickets * 2.1 + chasePressure(innings);
  const phaseBoost = ph === "death overs" ? 8 : ph === "powerplay" ? 4 : 0;
  const quality = batQuality - (bowlQuality - 72) * 0.58 + intent * 22 + phaseBoost - pressure + randomNormal() * 10;
  const wicketChance = clamp(0.026 + (100 - striker.batSkill) / 1150 + (bowlQuality - 68) / 1450 + intent * 0.026 + innings.wickets * 0.0025, 0.012, 0.24);
  const wicket = Math.random() < wicketChance;
  const outcome = wicket ? "W" : runOutcome(quality, bowler);
  let text = "";
  let eventClass = "";
  innings.legal++;
  bowlerStat.balls++;

  if (outcome === "W") {
    innings.wickets++;
    stat.b++;
    stat.out = true;
    stat.how = `c/b ${bowler.baseName}`;
    bowlerStat.w++;
    bowlerStat.dots++;
    text = `${striker.baseName} is out to ${bowler.baseName}.`;
    eventClass = "wicket";
    if (innings.next < 11) innings.striker = innings.next++;
  } else {
    innings.runs += outcome;
    stat.r += outcome;
    stat.b++;
    bowlerStat.r += outcome;
    if (outcome === 0) bowlerStat.dots++;
    if (outcome === 4) stat.fours++;
    if (outcome === 6) stat.sixes++;
    eventClass = outcome >= 4 ? "boundary" : "";
    text = ballText(striker, bowler, outcome);
    if (outcome % 2 === 1) swapStrike(innings);
  }

  innings.balls.push({ label, runs: outcome === "W" ? 0 : outcome, wicket: outcome === "W", batter: striker.baseName, bowler: bowler.baseName });
  innings.commentary.push({ label, text, event: String(outcome), eventClass });

  if (innings.legal % 6 === 0 && !innings.complete) swapStrike(innings);
  if (innings.target && innings.runs >= innings.target) innings.complete = true;
  if (innings.legal >= innings.maxBalls || innings.wickets >= 10) innings.complete = true;
}

function runOutcome(quality, bowler) {
  const q = quality - (bowler.bowlVariation - 70) * 0.12;
  const r = Math.random();
  if (q > 124 && r < 0.22) return 6;
  if (q > 111 && r < 0.34) return 4;
  if (q > 98 && r < 0.14) return 6;
  if (q > 88 && r < 0.30) return 4;
  if (q < 56 && r < 0.44) return 0;
  if (q < 68 && r < 0.30) return 0;
  if (r < 0.12) return 0;
  if (r < 0.62) return 1;
  if (r < 0.83) return 2;
  if (r < 0.90) return 3;
  return q > 84 ? 4 : 1;
}

function matchIntent(card, ph, innings) {
  let intent = 0.48;
  if (card.archetype === "aggressor") intent += ph === "powerplay" ? 0.2 : 0.08;
  if (card.archetype === "finisher") intent += ph === "death overs" ? 0.24 : 0.04;
  if (card.archetype === "anchor") intent -= innings.wickets >= 3 ? 0.13 : 0.04;
  if (ph === "death overs") intent += 0.15;
  if (innings.target) {
    const ballsLeft = Math.max(1, innings.maxBalls - innings.legal);
    const requiredRate = (innings.target - innings.runs) / ballsLeft * 6;
    const currentRate = runRate(innings);
    if (requiredRate > currentRate + 2) intent += 0.16;
    if (requiredRate < currentRate - 2) intent -= 0.08;
  }
  if (innings.wickets >= 7) intent -= 0.13;
  return clamp(intent, 0.18, 0.92);
}

function chasePressure(innings) {
  if (!innings.target) return 0;
  const ballsLeft = Math.max(1, innings.maxBalls - innings.legal);
  const required = innings.target - innings.runs;
  const requiredRate = required / ballsLeft * 6;
  return Math.max(0, requiredRate - 9) * 0.8;
}

function ballText(striker, bowler, runs) {
  if (runs === 0) return `${bowler.baseName} pins ${striker.baseName} down.`;
  if (runs === 1) return `${striker.baseName} works ${bowler.baseName} for one.`;
  if (runs === 2) return `${striker.baseName} takes two into the gap.`;
  if (runs === 3) return `${striker.baseName} runs three.`;
  if (runs === 4) return `${striker.baseName} beats the field for four.`;
  if (runs === 6) return `${striker.baseName} clears the rope for six.`;
  return `${runs} runs.`;
}

function publicRoom(room, viewerPlayerId) {
  const viewerTeamIndex = room.managers.findIndex((manager) => manager.playerId === viewerPlayerId);
  const activeIndex = activeTeamIndex(room);
  return {
    id: room.id,
    phase: room.phase,
    status: room.status,
    settings: room.settings,
    requiredHumans: requiredHumanPlayers(room.settings),
    humanCapacity: humanCapacity(room.settings),
    simSpeed: room.simSpeed,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      host: player.id === room.hostPlayerId
    })),
    viewer: {
      playerId: viewerPlayerId,
      teamIndex: viewerTeamIndex,
      isHost: isHost(room, viewerPlayerId),
      isActive: room.phase === "draft" && isActivePlayer(room, viewerPlayerId)
    },
    draft: {
      activeTeamIndex: activeIndex,
      activeTeamName: activeManager(room)?.name || "",
      isCpuTurn: Boolean(activeManager(room)?.cpu),
      round: activeIndex == null ? 0 : Math.floor(room.currentPick / Math.max(1, room.managers.length)) + 1,
      currentPick: room.currentPick,
      totalPicks: room.pickOrder.length,
      draw: room.draw,
      log: room.draftLog.slice(0, 12)
    },
    teams: room.managers.map((manager, index) => ({
      name: manager.name,
      playerId: manager.playerId,
      cpu: Boolean(manager.cpu),
      skipsLeft: manager.skipsLeft,
      balance: teamBalance(room, index),
      xi: manager.xi.map((id, slotIndex) => {
        const card = id ? CARD_BY_ID.get(id) : null;
        return card ? publicCard(card, slotIndex + 1) : null;
      })
    })),
    pool: publicPool(room, activeIndex),
    matches: room.matches.map((match) => publicMatch(room, match)),
    standings: standings(room)
  };
}

function publicPool(room, activeIndex) {
  if (!room.draw || activeIndex == null) return [];
  return DB
    .filter((card) => card.nation === room.draw.nation && card.decade === room.draw.decade)
    .sort((a, b) => cardOverall(b) - cardOverall(a))
    .map((card) => {
      const taken = takenByTeam(room, card);
      const slots = taken ? [] : playableSlotsFor(room, card, activeIndex);
      return {
        ...publicCard(card),
        rating: cardOverall(card),
        slots,
        disabled: Boolean(taken) || slots.length === 0,
        reason: taken ? `Drafted by ${taken.name}` : slots.length ? `Open slots: ${slots.join(", ")}` : "No legal slot"
      };
    });
}

function publicMatch(room, match) {
  return {
    id: match.id,
    stage: match.stage,
    a: match.a,
    b: match.b,
    aName: room.managers[match.a]?.name,
    bName: room.managers[match.b]?.name,
    status: match.status,
    summary: match.result?.summary || liveMatchStatus(match.live) || "Pending",
    result: match.result ? {
      summary: match.result.summary,
      innings: match.result.innings.map(publicInnings),
      tossText: match.result.tossText
    } : null,
    live: match.live ? {
      status: liveMatchStatus(match.live),
      innings: match.live.innings.map(publicInnings),
      tossText: match.live.tossText
    } : null
  };
}

function publicInnings(innings) {
  return {
    battingName: innings.battingName,
    bowlingName: innings.bowlingName,
    runs: innings.runs,
    wickets: innings.wickets,
    legal: innings.legal,
    maxBalls: innings.maxBalls,
    target: innings.target,
    bat: innings.bat.map((row) => ({
      name: row.card.baseName,
      how: row.how,
      r: row.r,
      b: row.b,
      fours: row.fours,
      sixes: row.sixes
    })),
    bowl: innings.bowl
      .filter((row) => row.balls > 0)
      .map((row) => ({ name: row.card.baseName, balls: row.balls, r: row.r, w: row.w, dots: row.dots })),
    commentary: innings.commentary.slice(-24)
  };
}

function liveMatchStatus(live) {
  if (!live) return "";
  const innings = live.innings[live.currentInnings];
  if (!innings) return "Match starting";
  if (live.currentInnings === 0) return `${innings.battingName} ${innings.runs}/${innings.wickets} after ${oversText(innings.legal)} overs`;
  const need = Math.max(0, innings.target - innings.runs);
  const ballsLeft = Math.max(0, innings.maxBalls - innings.legal);
  if (need === 0) return `${innings.battingName} reached the target`;
  return `${innings.battingName} need ${need} from ${ballsLeft} balls`;
}

function publicCard(card, slot = null) {
  return {
    id: card.id,
    baseName: card.baseName,
    nation: card.nation,
    decade: card.decade,
    type: card.type,
    batRole: card.batRole,
    keeper: card.keeper,
    positions: card.positions,
    batSkill: card.batSkill,
    batPower: card.batPower,
    bowlSkill: card.bowlSkill,
    bowlVariation: card.bowlVariation,
    slot
  };
}

function emitRoom(room) {
  persistRooms();
  room.players.forEach((player) => {
    if (!player.socketId) return;
    io.to(player.socketId).emit(SERVER_EVENTS.UPDATE, publicRoom(room, player.id));
  });
}

function fail(socket, ack, message) {
  socket.emit(SERVER_EVENTS.ERROR, { message });
  if (typeof ack === "function") ack({ ok: false, message });
}

function reply(ack, payload) {
  if (typeof ack === "function") ack({ ok: true, ...payload });
}

function getSocketRoom(socket) {
  return socket.data.roomId ? rooms.get(socket.data.roomId) : null;
}

function isHost(room, playerId) {
  return room.hostPlayerId === playerId;
}

function activeTeamIndex(room) {
  return room.pickOrder[room.currentPick] ?? null;
}

function activeManager(room) {
  const index = activeTeamIndex(room);
  return Number.isInteger(index) ? room.managers[index] : null;
}

function isActivePlayer(room, playerId) {
  return activeManager(room)?.playerId === playerId;
}

function draftComplete(room) {
  return room.managers.length > 0 && room.currentPick >= room.pickOrder.length && room.managers.every((manager) => teamComplete(room, manager));
}

function teamComplete(room, manager) {
  return manager.xi.filter(Boolean).length === 11 && manager.xi.map((id) => CARD_BY_ID.get(id)).some((card) => card?.keeper);
}

function selectedCards(room, teamIndex) {
  const manager = room.managers[teamIndex];
  if (!manager) return [];
  return manager.xi.filter(Boolean).map((id) => CARD_BY_ID.get(id)).filter(Boolean);
}

function takenByTeam(room, card) {
  return room.managers.find((manager) => manager.xi.some((id) => CARD_BY_ID.get(id)?.baseName === card.baseName)) || null;
}

function hasWicketkeeper(room, teamIndex) {
  return selectedCards(room, teamIndex).some((card) => card.keeper);
}

function availableSlotsFor(room, card, teamIndex) {
  const manager = room.managers[teamIndex];
  if (!manager) return [];
  return card.positions.filter((slot) => !manager.xi[slot - 1]);
}

function playableSlotsFor(room, card, teamIndex) {
  return availableSlotsFor(room, card, teamIndex).filter((slot) => preservesKeeperPath(room, card, slot, teamIndex));
}

function preservesKeeperPath(room, card, slot, teamIndex) {
  if (hasWicketkeeper(room, teamIndex) || card.keeper) return true;
  const manager = room.managers[teamIndex];
  const remainingSlots = manager.xi
    .map((id, index) => id ? null : index + 1)
    .filter((position) => position && position !== slot);
  if (!remainingSlots.length) return false;
  return DB.some((candidate) =>
    candidate.keeper &&
    candidate.baseName !== card.baseName &&
    !takenByTeam(room, candidate) &&
    candidate.positions.some((position) => remainingSlots.includes(position))
  );
}

function randomValidPair(room, teamIndex) {
  const pairs = [];
  NATIONS.forEach((nation) => {
    DECADES.forEach((decade) => {
      const eligible = DB.some((card) =>
        card.nation === nation &&
        card.decade === decade &&
        !takenByTeam(room, card) &&
        playableSlotsFor(room, card, teamIndex).length > 0
      );
      if (eligible) pairs.push({ nation, decade });
    });
  });
  return pairs.length ? pairs[Math.floor(Math.random() * pairs.length)] : null;
}

function cardsForDraw(pair) {
  return DB.filter((card) => card.nation === pair.nation && card.decade === pair.decade);
}

function bestDraftPick(room, teamIndex, candidates) {
  const options = [];
  candidates.forEach((card) => {
    if (takenByTeam(room, card)) return;
    playableSlotsFor(room, card, teamIndex).forEach((slot) => {
      options.push({ card, slot, value: draftValue(room, card, slot, teamIndex) });
    });
  });
  options.sort((a, b) => b.value - a.value);
  return weightedPick(options.slice(0, Math.min(5, options.length)));
}

function weightedPick(options) {
  if (!options.length) return null;
  const weights = options.map((_, index) => Math.max(1, 8 - index * 1.4));
  const total = weights.reduce((sum, item) => sum + item, 0);
  let roll = Math.random() * total;
  for (let index = 0; index < options.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return options[index];
  }
  return options[0];
}

function draftValue(room, card, slot, teamIndex) {
  const teamHasKeeper = hasWicketkeeper(room, teamIndex);
  const topOrderBoost = slot <= 4 ? card.batSkill * 0.42 + card.batPower * 0.34 : 0;
  const lowerBoost = slot >= 7 ? card.bowlSkill * 0.62 + card.bowlVariation * 0.34 : 0;
  const finishBoost = slot >= 5 && slot <= 7 ? card.batPower * 0.46 + card.bowlSkill * 0.24 : 0;
  const keeperBoost = card.keeper && !teamHasKeeper ? 16 : 0;
  const scarcity = card.bowlSkill >= 78 && !selectedCards(room, teamIndex).some((item) => item.bowlType === card.bowlType && item.bowlSkill >= 70) ? 7 : 0;
  return cardOverall(card) + topOrderBoost + lowerBoost + finishBoost + keeperBoost + scarcity + Math.random() * 6;
}

function standings(room) {
  const rows = room.managers.map((team, index) => ({ index, team, p: 0, w: 0, l: 0, t: 0, pts: 0, nrr: 0 }));
  room.matches.filter((match) => match.status === "complete" && match.stage !== "Final").forEach((match) => {
    const result = match.result;
    const a = rows[match.a];
    const b = rows[match.b];
    a.p++;
    b.p++;
    a.nrr += result.nrr[match.a] || 0;
    b.nrr += result.nrr[match.b] || 0;
    if (result.tie) {
      a.t++;
      b.t++;
      a.pts++;
      b.pts++;
    } else if (result.winner === match.a) {
      a.w++;
      b.l++;
      a.pts += 2;
    } else {
      b.w++;
      a.l++;
      b.pts += 2;
    }
  });
  rows.forEach((row) => {
    row.nrr = row.p ? row.nrr / row.p : 0;
  });
  return rows.sort((a, b) => b.pts - a.pts || b.nrr - a.nrr || teamBalance(room, b.index).balance - teamBalance(room, a.index).balance)
    .map((row) => ({ ...row, team: { name: row.team.name } }));
}

function buildPickOrder(teamCount, rounds) {
  const forward = Array.from({ length: teamCount }, (_, index) => index);
  const reverse = [...forward].reverse();
  const order = [];
  for (let round = 0; round < rounds; round++) {
    order.push(...(round % 2 === 0 ? forward : reverse));
  }
  return order;
}

function createManager(index, name, playerId, cpu) {
  return {
    id: `team-${index}`,
    name,
    playerId,
    cpu,
    xi: Array(11).fill(null),
    skipsLeft: SKIPS_PER_TEAM
  };
}

function teamBalance(room, teamIndex) {
  const xi = selectedCards(room, teamIndex);
  if (!xi.length) return { batting: 0, bowling: 0, balance: 0, bowlers: 0, keeper: false, attack: "None" };
  const batting = xi.reduce((sum, card, index) => sum + battingValue(card, index + 1), 0) / xi.length;
  const bowlingOptions = xi.filter((card) => card.bowlSkill >= 45).sort((a, b) => bowlingValue(b) - bowlingValue(a));
  const mainBowlers = bowlingOptions.slice(0, Math.min(6, bowlingOptions.length));
  const bowling = mainBowlers.length ? mainBowlers.reduce((sum, card) => sum + bowlingValue(card), 0) / mainBowlers.length : 0;
  const phaseCoverage = ["new", "middle", "death"].filter((type) => bowlingOptions.some((card) => card.bowlType === type && card.bowlSkill >= 65)).length;
  const bowlerCountScore = Math.min(100, bowlingOptions.length * 16);
  const keeper = xi.some((card) => card.keeper);
  const balance = batting * 0.38 + bowling * 0.38 + bowlerCountScore * 0.12 + (keeper ? 100 : 38) * 0.06 + phaseCoverage / 3 * 100 * 0.06;
  return {
    batting: Math.round(batting),
    bowling: Math.round(bowling),
    balance: Math.round(balance),
    bowlers: bowlingOptions.length,
    keeper,
    attack: `${bowlingOptions.length} options, ${phaseCoverage}/3 phases`
  };
}

function cardOverall(card) {
  return Math.round(card.batSkill * 0.34 + card.batPower * 0.22 + card.bowlSkill * 0.28 + card.bowlVariation * 0.16);
}

function battingValue(card, slot) {
  const phaseFit = slot <= 2 && card.archetype === "aggressor" ? 5 :
    slot <= 4 && card.archetype === "anchor" ? 4 :
    slot >= 5 && slot <= 7 && card.archetype === "finisher" ? 6 :
    slot >= 8 && card.bowlSkill >= 70 ? 2 : 0;
  return Math.min(100, card.batSkill * 0.68 + card.batPower * 0.32 + phaseFit);
}

function bowlingValue(card) {
  return Math.min(100, card.bowlSkill * 0.68 + card.bowlVariation * 0.32);
}

function bowlingPhase(over, oversCount) {
  if (over < Math.ceil(oversCount * 0.3)) return "powerplay";
  if (over < Math.ceil(oversCount * 0.8)) return "middle overs";
  return "death overs";
}

function bestBowlerIndex(xi) {
  let best = 0;
  xi.forEach((card, index) => {
    if (bowlingValue(card) > bowlingValue(xi[best])) best = index;
  });
  return best;
}

function runRate(innings) {
  return innings.runs / Math.max(1, innings.legal) * 6;
}

function oversText(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function swapStrike(innings) {
  const temp = innings.striker;
  innings.striker = innings.nonStriker;
  innings.nonStriker = temp;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sanitizeSettings(input = {}) {
  const requestedMode = String(input.gameMode || input.mode || "").toLowerCase();
  const gameMode = ["cpu", "duel", "tournament"].includes(requestedMode)
    ? requestedMode
    : requestedMode === "tournament"
      ? "tournament"
      : "duel";
  const teamCount = gameMode === "tournament" ? clamp(Math.round(Number(input.teamCount) || 4), 2, 4) : 2;
  return {
    gameMode,
    mode: gameMode === "tournament" ? "tournament" : "series",
    teamCount,
    overs: [5, 10, 20].includes(Number(input.overs)) ? Number(input.overs) : 5,
    seriesMatches: clamp(Math.round(Number(input.seriesMatches) || 1), 1, 9)
  };
}

function requiredHumanPlayers(settings = {}) {
  if (settings.gameMode === "cpu") return 1;
  return humanCapacity(settings);
}

function humanCapacity(settings = {}) {
  if (settings.gameMode === "cpu") return 1;
  if (settings.gameMode === "tournament") return clamp(Math.round(Number(settings.teamCount) || 4), 2, 4);
  return 2;
}

function cleanName(value, fallback) {
  const text = String(value || "").trim().slice(0, 24);
  return text || fallback;
}

function cleanRoomCode(value) {
  return String(value || "").trim().replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 12);
}

function makeRoomId() {
  let id = "";
  do {
    id = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(id));
  return id;
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
