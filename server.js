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

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const usersFile = path.join(dataDir, "users.json");

class Database {
  static getUsers() {
    try {
      if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, "{}");
      return JSON.parse(fs.readFileSync(usersFile));
    } catch (e) {
      return {};
    }
  }

  static saveUsers(users) {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 4));
  }

  static async register(username, name, avatar, password) {
    const users = this.getUsers();
    if (username in users) throw new Error("Username has already been used.");
    const hash = await argon2.hash(password);
    users[username] = { avatar, name, password: hash, wins: 0, matches: 0, xp: 0 };
    this.saveUsers(users);
  }

  static async verify(username, password) {
    const users = this.getUsers();
    if (!(username in users)) throw new Error("Incorrect username/password.");
    const valid = await argon2.verify(users[username].password, password);
    if (!valid) throw new Error("Incorrect username/password.");
    return { username, avatar: users[username].avatar, name: users[username].name };
  }

  static updateStats(username, won = false) {
    const users = this.getUsers();
    if (users[username]) {
      users[username].matches = (users[username].matches || 0) + 1;
      if (won) {
        users[username].wins = (users[username].wins || 0) + 1;
        users[username].xp = (users[username].xp || 0) + 50;
      }
      // Self-healing
      users[username].matches = Math.max(users[username].matches, users[username].wins || 0);
      this.saveUsers(users);
    }
  }
}

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

app.post("/register", async (req, res) => {
  const { username, avatar, name, password } = req.body;
  if (!username || !avatar || !name || !password) return res.json({ error: "Missing fields." });
  if (!containWordCharsOnly(username)) return res.json({ error: "Invalid characters." });
  try {
    await Database.register(username, name, avatar, password);
    res.json({ success: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post("/signin", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await Database.verify(username, password);
    req.session.user = user;
    res.json({ user });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/validate", (req, res) => {
  res.json(req.session.user ? { user: req.session.user } : { error: "Not logged in." });
});

app.get("/signout", (req, res) => {
  delete req.session.user;
  res.json({ success: true });
});

app.get("/leaderboard", (req, res) => {
  const users = Database.getUsers();
  const lb = Object.entries(users).map(([username, u]) => ({
    username, name: u.name, avatar: u.avatar, wins: u.wins || 0,
    winRate: (u.matches || 0) > 0 ? ((u.wins || 0) / u.matches * 100).toFixed(1) : "0.0"
  })).sort((a, b) => b.wins - a.wins).slice(0, 5);
  res.json(lb);
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

  const elapsedSeconds = Math.floor((Date.now() - match.startTime) / 1000);

  // Track wins, XP and matches using Database abstraction
  const room = rooms[roomCode];
  for (const sid of Object.keys(room?.players || {})) {
    const username = room.players[sid].username;
    if (username) {
      const isWinner = winner !== "draw" && match.socketIdBySide[winner] === sid;
      Database.updateStats(username, isWinner);
    }
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
      stats: {
        bounces: match.bounces || 0,
        duration: elapsedSeconds
      }
    },
  });

  stopAuthoritativeMatch(roomCode);
}

function startAuthoritativeMatch(roomCode) {
  const room = rooms[roomCode];
  if (!room || activeMatches[roomCode]) return;

  const sides = assignSides(room);
  if (!sides) return;

  const bumperLayout = GameplayCore.createSymmetricBumperLayout();
  const areaEffects = GameplayCore.createSymmetricAreaEffectsLayout();
  const runtime = GameplayCore.createRuntimeState({
    bumpers: bumperLayout,
    areaEffects,
  });
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
    startTime: Date.now(),
    bounces: 0,
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
    const bottomCheatPos = match.latestInputBySocketId[bottomSocketId]?.cheatPos;
    const topCheatPos = match.latestInputBySocketId[topSocketId]?.cheatPos;

    // Shared Cheat Mode
    const isCheating = bottomInput.cheat || topInput.cheat;
    if (isCheating) {
      const activeCheatPos = bottomInput.cheat ? bottomCheatPos : topCheatPos;
      if (activeCheatPos) {
        runtime.scene.ball.x = GameplayCore.clamp(activeCheatPos.x, 20, 380);
        runtime.scene.ball.y = GameplayCore.clamp(activeCheatPos.y, 20, 680);
        runtime.scene.ball.vx = 0;
        runtime.scene.ball.vy = 0;
      }
      runtime.match.status = "🚨 Cheating in Progress 🚨";
    }

    // Match duration limit (4 minutes)
    const elapsedMs = Date.now() - match.startTime;
    if (elapsedMs > 4 * 60 * 1000) {
      const winner = GameplayCore.getWinner(runtime.match);
      endAuthoritativeMatch(roomCode, "time_up", winner);
      return;
    }

    const inputFrame = GameplayCore.buildInputFrame(runtime, {
      bottomInput,
      topInput,
      topControlMode: "manual",
    });

    const events = GameplayCore.stepRuntime(runtime, inputFrame);
    if (events.some(e => e.type === "BUMPER_HIT")) {
      match.bounces += events.filter(e => e.type === "BUMPER_HIT").length;
    }

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

  socket.on("join_queue", (username) => {
    if (queue.find((q) => q.socketId === socket.id)) {
      socket.emit("queue_failed", "Already in queue");
      return;
    }
    queue.push({ socketId: socket.id, username });
    socket.emit("queue_joined");

    while (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      const code = makeRoomCode();
      
      // Safety: Ensure both sockets are still connected and not already in a match
      const s1 = io.sockets.sockets.get(p1.socketId);
      const s2 = io.sockets.sockets.get(p2.socketId);
      
      if (!s1 || !s2) {
        if (s1) queue.unshift(p1);
        if (s2) queue.unshift(p2);
        continue;
      }

      rooms[code] = { owner: p1.socketId, players: {} };
      rooms[code].players[p1.socketId] = { username: p1.username, ready: true };
      rooms[code].players[p2.socketId] = { username: p2.username, ready: true };

      s1.join(code);
      s2.join(code);

      io.to(code).emit("room_joined", { code });
      io.to(code).emit("room_update", rooms[code]);
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

  socket.on("cancel_private_room", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (room.owner !== socket.id) return;

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
    room.players[socket.id] = { username, ready: true };
    const ownerSocket = io.sockets.sockets.get(room.owner);
    if (ownerSocket) {
      ownerSocket.join(code);
      if (room.players[room.owner]) room.players[room.owner].ready = true;
    }
    socket.join(code);
    io.to(code).emit("room_update", room);
    io.to(code).emit("room_joined", { code });
    io.to(code).emit("game_start");
    startAuthoritativeMatch(code);
  });

  socket.on("rematch", (code) => {
    const room = rooms[code];
    if (!room) return;
    if (activeMatches[code]) stopAuthoritativeMatch(code);
    
    // Reset players ready status
    for (const sid of Object.keys(room.players)) {
      room.players[sid].ready = true;
    }
    
    io.to(code).emit("room_update", room);
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

  socket.on("input_frame", ({ roomCode, matchId, seq, input, cheatPos }) => {
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
      cheatPos,
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
    io.to(code).emit("player_forfeit", { socketId: socket.id });

    for (const sid of Object.keys(room.players)) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(code);
    }
    delete rooms[code];
  });

  socket.on("disconnect", () => {
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
