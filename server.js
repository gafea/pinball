const express = require("express");
const fs = require("fs");
const path = require("path");
const argon2 = require("argon2");
const session = require("express-session");
const { createServer } = require("http");
const { Server } = require("socket.io");

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

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
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
    if (allReady) io.to(code).emit("game_start");
  });

  socket.on("forfeit", (code) => {
    const room = rooms[code];
    if (!room) return;
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
        delete room.players[socket.id];
        io.to(code).emit("room_update", room);
        if (Object.keys(room.players).length === 0) delete rooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, () => console.log("Game server started on", PORT));
