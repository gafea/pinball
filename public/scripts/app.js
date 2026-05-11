// Client-side script for account, lobby and room interactions
const socket = io();
let me = null;
let currentRoom = null;
let _queueTimer = null;
let _queueStart = null;

async function api(path, data) {
  const res = await fetch(path, {
    method: data ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  return res.json();
}

async function init() {
  Avatar.populate($("#register-avatar"));
  View.register(
    "primary-view",
    "home-view",
    "game-play-view",
    "game-over-view",
  );
  View.register(
    "secondary-view",
    "signin-view",
    "register-view",
    "match-making-view",
  );
  View.register("tertiary-view", "idle-view", "queue-status-view");

  let currentMatchId = null;
  let localSide = "bottom";

  function getGameRuntime() {
    const gm = window.gameManager;
    if (!gm) return null;
    if (
      typeof gm.start !== "function" ||
      typeof gm.stop !== "function" ||
      typeof gm.isRunning !== "function" ||
      typeof gm.applyAuthoritativeSnapshot !== "function"
    ) {
      return null;
    }
    return gm;
  }

  function showLobbyHome() {
    View.show("home-view");
    View.show("match-making-view");
    View.show("idle-view");
  }

  function handleLocalGameOver(state) {
    const bottomScore = state?.score ?? 0;
    const topScore = state?.topScore ?? 0;
    const bottomLives = state?.lives ?? 0;
    const topLives = state?.topLives ?? 0;

    let outcome = "Draw";
    if (bottomLives > topLives) outcome = "Bottom wins";
    else if (topLives > bottomLives) outcome = "Top wins";
    else if (bottomScore > topScore) outcome = "Bottom wins";
    else if (topScore > bottomScore) outcome = "Top wins";

    $("#game-over-message").text(
      `${outcome}! Bottom ${bottomScore} (${bottomLives} lives) vs Top ${topScore} (${topLives} lives).`,
    );
    View.show("game-over-view");
  }

  function startGameplayRuntime(status = "Running", reset = false) {
    const gm = getGameRuntime();
    if (!gm) return;
    gm.start({
      roomCode: currentRoom || "-",
      matchId: currentMatchId,
      localSide,
      status,
      reset,
      onGameOver: handleLocalGameOver,
      onInputFrame: (payload) => {
        socket.emit("input_frame", payload);
      },
    });
  }

  function stopGameplayRuntime(
    status = "Stopped",
    roomCode = currentRoom || "-",
  ) {
    const gm = getGameRuntime();
    if (!gm) return;
    gm.stop({
      reset: true,
      roomCode,
      status,
    });
  }

  function leaveCurrentMatch({
    notifyServer = true,
    stopStatus = "Waiting",
    showHome = true,
  } = {}) {
    const roomToLeave = currentRoom;
    stopGameplayRuntime(stopStatus, roomToLeave || "-");
    if (notifyServer && roomToLeave) {
      socket.emit("forfeit", roomToLeave);
    }
    currentRoom = null;
    currentMatchId = null;
    $("#private-room-code-input").val("");
    $("#private-join-code").hide();
    if (showHome) {
      showLobbyHome();
    }
  }

  // account registration
  $("#btn-register").click(async (e) => {
    e.preventDefault();
    const username = $("#reg-username").val().trim();
    const name = $("#reg-name").val().trim();
    const avatar = $("#register-avatar").val().trim() || "Anon";
    const password = $("#reg-password").val();

    const r = await api("/register", { username, name, avatar, password });
    if (r.error) {
      showToast(r.error, "error", 3000);
    } else {
      showToast("Registration successful!", "success", 5000);
      View.show("signin-view");
    }
  });

  // player sign in
  $("#btn-signin").click(async (e) => {
    e.preventDefault();
    const username = $("#signin-username").val().trim();
    const password = $("#signin-password").val();
    const r = await api("/signin", { username, password });
    if (r.error) {
      showToast(r.error, "error", 5000);
    } else {
      me = r.user;
      onSignedIn();
    }
  });

  // show the account register form
  $("#btn-show-register").click((e) => {
    e.preventDefault();
    View.show("register-view");
  });

  // show the account sign in form
  $("#btn-show-signin").click((e) => {
    e.preventDefault();
    View.show("signin-view");
  });

  // player sign out
  $("#btn-signout").click(async () => {
    stopGameplayRuntime("Signed out");
    currentRoom = null;
    await api("/signout");
    // hide signout immediately and reload
    $("#btn-signout").hide();
    location.reload();
  });

  // create a private match with a unique code
  $("#btn-create-private-match").click(async () => {
    if (!me) return showToast("Please sign in first", "error", 3000);

    $("#public-queue-timer").hide();
    $("#private-join-code").show();
    View.show("queue-status-view");

    currentRoom = null;
    socket.emit("create_private_room", me.username);
  });

  // join a private match with code
  $("#btn-join-private-match").click(async () => {
    if (!me) return showToast("Please sign in first", "error", 3000);
    const code = $("#private-room-code-input").val().trim().toUpperCase();
    if (!code) return showToast("Please enter a room code", "error", 3000);
    socket.emit("join_private_room", { code, username: me.username });
  });

  // join the match-making queue to find a random opponent
  $("#btn-find-match").click(async () => {
    if (!me) return showToast("Please sign in first", "error", 3000);
    socket.emit("join_queue", me.username);

    $("#public-queue-timer").show();
    $("#private-join-code").hide();
    View.show("queue-status-view");

    startQueueTimer();
  });

  // player leave the match-making queue after joined or cancel private room
  $("#btn-leave-queue").click(async () => {
    if (currentRoom) {
      stopGameplayRuntime("Left room");
      // owner cancelling private room
      socket.emit("cancel_private_room", currentRoom);
      currentRoom = null;
      $("#private-join-code").hide();
      View.show("idle-view");
      return;
    }
    socket.emit("leave_queue");
    stopQueueTimer();
    resetQueueTimerDisplay();
    View.show("idle-view");
    $("#private-join-code").hide();
  });

  // forfeit the current match and return to main page
  $("#btn-forfeit").click(async () => {
    if (!currentRoom) return showToast("Not in a room", "error", 3000);
    leaveCurrentMatch({ notifyServer: true, stopStatus: "Forfeited" });
  });

  $("#btn-back-home").click(() => {
    leaveCurrentMatch({
      notifyServer: !!currentRoom,
      stopStatus: "Waiting",
      showHome: true,
    });
  });

  // player join the match-making queue but something went wrong (e.g. already in queue)
  socket.on("queue_failed", (message) => {
    showToast(message, "error", 3000);
    View.show("idle-view");
  });

  // server created a private room, show the join code on screen
  socket.on("private_room_created", ({ code }) => {
    currentRoom = code;
    // show join code
    $("#join-code").text(code);
    $("#private-join-code").show();

    // hide queue timer
    $("#public-queue-timer").hide();
  });

  // server moved the player to a room (either from queue or private match), now show the game page
  socket.on("room_joined", ({ code }) => {
    currentRoom = code;
    // stop timer if it was running
    stopQueueTimer();
    resetQueueTimerDisplay();
    View.show("game-play-view");
    stopGameplayRuntime("Room joined", code);
  });

  socket.on("room_update", () => {});

  // not able to join a room (e.g. wrong code, room full), show error message
  socket.on("room_error", (msg) => showToast(msg, "error", 3000));

  // the server signaled the game to start (both players are ready), now we can initialize the game state and start the game loop
  socket.on("game_start", () => {
    stopQueueTimer();
    resetQueueTimerDisplay();
    View.show("game-play-view");
    startGameplayRuntime("Waiting for server state", true);
    showToast("Match found!", "success", 3000);
  });

  socket.on("match_init", ({ roomCode, matchId, yourSide, state }) => {
    currentRoom = roomCode || currentRoom;
    currentMatchId = matchId;
    localSide = yourSide || "bottom";
    const gm = getGameRuntime();
    if (!gm) return;
    View.show("game-play-view");
    gm.start({
      roomCode: currentRoom || "-",
      matchId: currentMatchId,
      localSide,
      status: state?.match?.status || "Running",
      reset: true,
      onGameOver: handleLocalGameOver,
      onInputFrame: (payload) => {
        socket.emit("input_frame", payload);
      },
    });
    gm.applyAuthoritativeSnapshot(state, { matchId: currentMatchId });
  });

  socket.on("state_snapshot", ({ matchId, state, ack }) => {
    if (currentMatchId && matchId !== currentMatchId) return;
    const gm = getGameRuntime();
    if (!gm) return;
    gm.applyAuthoritativeSnapshot(state, { matchId, ack });
  });

  socket.on("match_end", ({ matchId, final, winner, reason }) => {
    if (currentMatchId && matchId !== currentMatchId) return;
    currentMatchId = null;
    const gm = getGameRuntime();
    if (gm && final) {
      gm.applyAuthoritativeSnapshot(
        {
          tick: final.tick ?? 0,
          match: {
            score: final.score,
            topScore: final.topScore,
            lives: final.lives,
            topLives: final.topLives,
            status: final.status || "Game Over",
            gameOver: true,
          },
        },
        {},
      );
    }

    const summary =
      winner === "draw"
        ? `Draw! Reason: ${reason}.`
        : `${winner === "bottom" ? "Bottom" : "Top"} wins! Reason: ${reason}.`;
    $("#game-over-message").text(summary);
    View.show("game-over-view");
  });

  socket.on("player_forfeit", () => {
    showToast("A player forfeited!", "warning", 3000);
    leaveCurrentMatch({
      notifyServer: false,
      stopStatus: "Opponent forfeited",
      showHome: true,
    });
  });

  // Check session
  const v = await api("/validate");
  if (!v.error) {
    me = v.user;
    onSignedIn();
  }

  function formatTimeElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const mins = Math.floor(total / 60)
      .toString()
      .padStart(2, "0");
    const secs = (total % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  }

  function startQueueTimer() {
    stopQueueTimer();
    _queueStart = Date.now();
    const el = document.getElementById("queue-timer");
    if (!el) return;
    el.textContent = "00:00";
    _queueTimer = setInterval(() => {
      el.textContent = formatTimeElapsed(Date.now() - _queueStart);
    }, 500);
  }

  function stopQueueTimer() {
    if (_queueTimer) {
      clearInterval(_queueTimer);
      _queueTimer = null;
    }
    _queueStart = null;
  }

  function resetQueueTimerDisplay() {
    const el = document.getElementById("queue-timer");
    if (el) el.textContent = "00:00";
  }
}

function onSignedIn() {
  View.show("match-making-view");
  View.show("idle-view");

  $("#user-avatar").html(Avatar.getCode(me.avatar));
  $("#user-name").text(me.name);
  // show sign-out when user is signed in
  $("#btn-signout").show();
}

window.addEventListener("DOMContentLoaded", init);
