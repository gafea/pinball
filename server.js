const express = require("express");
const fs = require("fs");
const path = require("path");
const argon2 = require("argon2");
const session = require("express-session");
const { createServer } = require("http");
const { Server } = require("socket.io");
const GameplayCore = require("./public/scripts/gameplayCore.js");

const app = express();
app.use(express.static("public"));
app.use(express.json());

const gameSession = session({
  secret: "quantum-game-secret",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 1000 * 60 * 30 },
});
app.use(gameSession);

function containWordCharsOnly(text) {
  return /^\w+$/.test(text);
}

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const usersFile = path.join(dataDir, "users.json");
if (!fs.existsSync(usersFile))
  fs.writeFileSync(usersFile, JSON.stringify({}, null, 4));

app.post("/register", async (req, res) => {
  const { username, avatar, name, password } = req.body;

  if (!username || !avatar || !name || !password)
    return res.json({
      error: "Username/avatar/name/password cannot be empty.",
    });
  if (!containWordCharsOnly(username))
    return res.json({
      error: "Username can only contain underscores, letters or numbers.",
    });
  const users = JSON.parse(fs.readFileSync(usersFile));
  if (username in users)
    return res.json({ error: "Username has already been used." });

  const hash = await argon2.hash(password);
  users[username] = { avatar, name, password: hash };
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 4));
  res.json({ success: true });
});

app.post("/signin", async (req, res) => {
  const { username, password } = req.body;
  const users = JSON.parse(fs.readFileSync(usersFile));

  if (!(username in users))
    return res.json({ error: "Incorrect username/password." });
  const hash = users[username].password;
  const verified = await argon2.verify(hash, password);
  if (!verified) return res.json({ error: "Incorrect username/password." });

  const userInfo = {
    username,
    avatar: users[username].avatar,
    name: users[username].name,
  };
  req.session.user = userInfo;
  res.json({ user: userInfo });
});

app.get("/validate", (req, res) => {
  const userInfo = req.session.user;

  if (userInfo) res.json({ user: userInfo });
  else res.json({ error: "You are not logged in." });
});

app.get("/signout", (req, res) => {
  if (req.session.user) delete req.session.user;
  res.json({ success: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer);

// Room management
let rooms = {}; // roomCode -> { players: {socketId: {username, ready}}, owner }
let queue = []; // [{ socketId, username }]
let activeMatches = {}; // roomCode -> authoritative runtime

const SERVER_TICK_MS = Math.round(1000 / 60);
const SNAPSHOT_EVERY_TICKS = 3;

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getMatchPlayers(room) {
  if (!room) return [];
  return Object.keys(room.players).slice(0, 2);
}

function assignSides(room) {
  const playerIds = getMatchPlayers(room);
  if (playerIds.length < 2) return null;

  let bottom = room.owner;
  let top = playerIds.find((id) => id !== bottom);

  if (!bottom || !room.players[bottom] || !top) {
    const stableIds = [...playerIds].sort();
    [bottom, top] = stableIds;
  }

  return {
    sideBySocketId: {
      [bottom]: "bottom",
      [top]: "top",
    },
    socketIdBySide: {
      bottom,
      top,
    },
  };
}

function stopAuthoritativeMatch(roomCode) {
  const match = activeMatches[roomCode];
  if (!match) return;
  clearInterval(match.intervalId);
  delete activeMatches[roomCode];
}

function emitSnapshot(roomCode, match, force = false) {
  if (!match) return;
  if (!force && match.runtime.meta.tick % SNAPSHOT_EVERY_TICKS !== 0) return;

  io.to(roomCode).emit("state_snapshot", {
    roomCode,
    matchId: match.matchId,
    tick: match.runtime.meta.tick,
    ack: { ...match.lastSeqBySocketId },
    state: GameplayCore.serializeState(match.runtime),
  });
}

function endAuthoritativeMatch(roomCode, reason, winner) {
  const match = activeMatches[roomCode];
  if (!match) return;

  match.runtime.match.gameOver = true;
  if (!match.runtime.match.status.startsWith("Game Over")) {
    if (winner === "draw") match.runtime.match.status = "Game Over - Draw";
    else if (winner === "top") match.runtime.match.status = "Game Over - Top Wins";
    else match.runtime.match.status = "Game Over - Bottom Wins";
  }

  emitSnapshot(roomCode, match, true);
  io.to(roomCode).emit("match_end", {
    roomCode,
    matchId: match.matchId,
    reason,
    winner,
    final: {
      tick: match.runtime.meta.tick,
      score: match.runtime.match.score,
      topScore: match.runtime.match.topScore,
      lives: match.runtime.match.lives,
      topLives: match.runtime.match.topLives,
      status: match.runtime.match.status,
      gameOver: true,
    },
  });

  stopAuthoritativeMatch(roomCode);
}

function startAuthoritativeMatch(roomCode) {
  const room = rooms[roomCode];
  if (!room || activeMatches[roomCode]) return;

  const sides = assignSides(room);
  if (!sides) return;

  const runtime = GameplayCore.createRuntimeState();
  runtime.match.status = "Running";
  const matchId = `${roomCode}:${Date.now()}`;

  const match = {
    matchId,
    runtime,
    sideBySocketId: sides.sideBySocketId,
    socketIdBySide: sides.socketIdBySide,
    latestInputBySocketId: {},
    lastSeqBySocketId: {},
    intervalId: null,
  };

  activeMatches[roomCode] = match;

  for (const [socketId, side] of Object.entries(match.sideBySocketId)) {
    io.to(socketId).emit("match_init", {
      roomCode,
      matchId,
      yourSide: side,
      tickRate: 60,
      tick: runtime.meta.tick,
      state: GameplayCore.serializeState(runtime),
    });
  }

  match.intervalId = setInterval(() => {
    const bottomSocketId = match.socketIdBySide.bottom;
    const topSocketId = match.socketIdBySide.top;

    const bottomInput = match.latestInputBySocketId[bottomSocketId]?.input || {};
    const topInput = match.latestInputBySocketId[topSocketId]?.input || {};

    const inputFrame = GameplayCore.buildInputFrame(runtime, {
      bottomInput,
      topInput,
      topControlMode: "manual",
    });

    GameplayCore.stepRuntime(runtime, inputFrame);

    if (runtime.match.gameOver) {
      const winner = GameplayCore.getWinner(runtime.match);
      endAuthoritativeMatch(roomCode, "game_over", winner);
      return;
    }

    emitSnapshot(roomCode, match, false);
  }, SERVER_TICK_MS);
}

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // Queue-based matchmaking: join queue and form 2-player rooms
  socket.on("join_queue", (username) => {
    // prevent duplicate
    if (queue.find((q) => q.socketId === socket.id)) {
      socket.emit("queue_failed", "Already in queue");
      return;
    }
    queue.push({ socketId: socket.id, username });
    socket.emit("queue_joined");

    // if enough players, form a match of 2 players
    while (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      const code = makeRoomCode();
      rooms[code] = { owner: p1.socketId, players: {} };
      rooms[code].players[p1.socketId] = { username: p1.username, ready: true };
      rooms[code].players[p2.socketId] = { username: p2.username, ready: true };

      // add sockets to room if still connected
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);
      if (s1) s1.join(code);
      if (s2) s2.join(code);

      // notify players
      // if (s1) s1.emit('room_joined', { code });
      // if (s2) s2.emit('room_joined', { code });
      io.to(code).emit("room_joined", { code });
      io.to(code).emit("room_update", rooms[code]);
      // immediately start game for 2-player match
      io.to(code).emit("game_start");
      startAuthoritativeMatch(code);
    }
  });

  socket.on("leave_queue", () => {
    const idx = queue.findIndex((q) => q.socketId === socket.id);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  });

  // Cancel a private room (owner only)
  socket.on("cancel_private_room", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) return; // only owner can cancel

    // notify players and remove room
    for (const sid of Object.keys(room.players)) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.leave(code);
        if (sid !== socket.id)
          s.emit("room_error", "Private room cancelled by owner");
      }
    }
    delete rooms[code];
  });

  socket.on("create_private_room", (username) => {
    const code = makeRoomCode();
    rooms[code] = { owner: socket.id, players: {} };
    rooms[code].players[socket.id] = { username, ready: false };
    socket.join(code);
    // notify owner with private room code
    socket.emit("private_room_created", { code });
    io.to(code).emit("room_update", rooms[code]);
  });
  socket.on("join_private_room", ({ code, username }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit("room_error", "Room not found");
      return;
    }
    if (Object.keys(room.players).length >= 4) {
      socket.emit("room_error", "Room full");
      return;
    }
    // add joining player and mark both as ready, then start match immediately
    room.players[socket.id] = { username, ready: true };
    const ownerSocket = io.sockets.sockets.get(room.owner);
    if (ownerSocket) {
      // ensure owner is joined and marked ready
      ownerSocket.join(code);
      if (room.players[room.owner]) room.players[room.owner].ready = true;
    }
    socket.join(code);
    io.to(code).emit("room_update", room);
    io.to(code).emit("room_joined", { code });
    io.to(code).emit("game_start");
    startAuthoritativeMatch(code);
  });

  socket.on("leave_room", (code) => {
    const room = rooms[code];
    if (!room) return;
    delete room.players[socket.id];
    socket.leave(code);
    if (Object.keys(room.players).length === 0) delete rooms[code];
    else {
      if (room.owner === socket.id) room.owner = Object.keys(room.players)[0];
      io.to(code).emit("room_update", room);
    }
  });

  socket.on("ready", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (room.players[socket.id]) room.players[socket.id].ready = true;
    io.to(code).emit("room_update", room);
    const allReady =
      Object.values(room.players).length > 0 &&
      Object.values(room.players).every((p) => p.ready);
    if (allReady) {
      io.to(code).emit("game_start");
      startAuthoritativeMatch(code);
    }
  });

  socket.on("input_frame", ({ roomCode, matchId, seq, input }) => {
    const match = activeMatches[roomCode];
    if (!match) return;
    if (match.matchId !== matchId) return;
    if (!match.sideBySocketId[socket.id]) return;

    const previousSeq = match.lastSeqBySocketId[socket.id] || 0;
    if (typeof seq !== "number" || seq <= previousSeq) return;

    match.lastSeqBySocketId[socket.id] = seq;
    match.latestInputBySocketId[socket.id] = {
      seq,
      input: GameplayCore.cloneInputState(input),
    };
  });

  socket.on("forfeit", (code) => {
    const room = rooms[code];
    if (!room) return;
    const match = activeMatches[code];
    if (match && match.sideBySocketId[socket.id]) {
      const forfeiterSide = match.sideBySocketId[socket.id];
      const winner = forfeiterSide === "bottom" ? "top" : "bottom";
      endAuthoritativeMatch(code, "forfeit", winner);
    }
    // notify all players that someone forfeited
    io.to(code).emit("player_forfeit", { socketId: socket.id });

    // make all players leave the room and remove the room entirely
    for (const sid of Object.keys(room.players)) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(code);
    }
    delete rooms[code];
  });

  socket.on("disconnect", () => {
    // remove from matchmaking queue if present
    const qi = queue.findIndex((q) => q.socketId === socket.id);
    if (qi !== -1) {
      queue.splice(qi, 1);
    }
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        const match = activeMatches[code];
        if (match && match.sideBySocketId[socket.id]) {
          const disconnectingSide = match.sideBySocketId[socket.id];
          const winner = disconnectingSide === "bottom" ? "top" : "bottom";
          endAuthoritativeMatch(code, "disconnect", winner);
        }
        delete room.players[socket.id];
        io.to(code).emit("room_update", room);
        if (Object.keys(room.players).length === 0) delete rooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, () => console.log("Game server started on", PORT));
