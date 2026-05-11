(() => {
  const core = window.GameplayCore;

  if (!core) {
    throw new Error("GameplayCore failed to load before gameManager.js");
  }

  const {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    cloneInputState,
    createRuntimeState,
    applySnapshot,
  } = core;

  const getFlipperSegment = (flipper) => ({
    p1: { x: flipper.x, y: flipper.y },
    p2: {
      x: flipper.x + Math.cos(flipper.angle) * flipper.length * flipper.direction,
      y: flipper.y + Math.sin(flipper.angle) * flipper.length * flipper.direction,
    },
  });

  class SoundManager {
    constructor() {
      this.sounds = {};
      this.enabled = true;
    }

    load(name, url) {
      const audio = new Audio(url);
      audio.preload = "auto";
      this.sounds[name] = audio;
    }

    play(name) {
      if (!this.enabled || !this.sounds[name]) return;
      const sound = this.sounds[name].cloneNode();
      sound.play().catch(() => {});
    }
  }

  class GameplayRuntime {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.hud = {};
      this.running = false;
      this.runtimeState = createRuntimeState();
      this.roomCode = "-";
      this.localSide = "bottom";
      this.matchId = null;
      this.lastAck = null;
      this.lastTimestamp = 0;
      this.lastSnapshotAt = 0;
      this.previousBall = null;
      this.currentBall = null;
      this.interpolatedBall = null;
      this.inputState = cloneInputState();
      this.keyState = cloneInputState();
      this.onInputFrame = null;
      this.onGameOver = null;
      this.rafId = null;
      this.bound = false;
      this.sequence = 0;

      this.sounds = new SoundManager();
      this.sounds.load("bumper", "sounds/3d-pinball-soundtrack/SOUND104.mp3");
      this.sounds.load("goal", "sounds/3d-pinball-soundtrack/SOUND136.mp3");
      this.sounds.load("start", "sounds/3d-pinball-soundtrack/SOUND24.mp3");
      this.sounds.load("gameover", "sounds/3d-pinball-soundtrack/SOUND1.mp3");

      this.mousePos = { x: 0, y: 0 };
      this.isDragging = false;

      this.handleMouseDown = (event) => {
        if (!this.keyState.cheat) return;
        this.isDragging = true;
        this.updateMousePos(event);
      };

      this.handleMouseMove = (event) => {
        this.updateMousePos(event);
        if (this.keyState.cheat) {
          this.emitInputFrame();
        }
      };

      this.handleMouseUp = () => {
        this.isDragging = false;
      };

      this.handleKeyDown = (event) => {
        const action = this.mapKey(event.key);
        if (!action) return;
        event.preventDefault();
        this.keyState[action] = true;
        this.setInputState(this.keyState, true);
      };

      this.handleKeyUp = (event) => {
        const action = this.mapKey(event.key);
        if (!action) return;
        event.preventDefault();
        this.keyState[action] = false;
        this.setInputState(this.keyState, true);
      };

      this.handleBlur = () => {
        this.keyState = cloneInputState();
        this.setInputState(this.keyState, true);
      };

      this.ensureDom();
      this.syncHud();
      this.draw();
    }

    ensureDom() {
      if (!this.canvas) {
        this.canvas = document.getElementById("gameplay-canvas");
        this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
      }

      this.hud.roomCode = document.getElementById("game-room-code");
      this.hud.score = document.getElementById("game-score");
      this.hud.lives = document.getElementById("game-lives");
      this.hud.topScore = document.getElementById("game-top-score");
      this.hud.topLives = document.getElementById("game-top-lives");
      this.hud.localSide = document.getElementById("game-local-side");
      this.hud.scoreLabel = document.getElementById("game-score-label");
      this.hud.topScoreLabel = document.getElementById("game-top-score-label");
      this.hud.livesLabel = document.getElementById("game-lives-label");
      this.hud.topLivesLabel = document.getElementById("game-top-lives-label");
      this.hud.status = document.getElementById("game-status");

      return !!(this.canvas && this.ctx);
    }

    mapKey(key) {
      switch (key) {
        case "z":
        case "Z":
        case "a":
        case "A":
        case "ArrowLeft":
          return "left";
        case "m":
        case "M":
        case "d":
        case "D":
        case "ArrowRight":
          return "right";
        case " ":
        case "Space":
        case "Spacebar":
          return "both";
        case "g":
        case "G":
          return "cheat";
        default:
          return null;
      }
    }

    isTopPerspective() {
      return this.localSide === "top";
    }

    updateMousePos(event) {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      let x = (event.clientX - rect.left) * scaleX;
      let y = (event.clientY - rect.top) * scaleY;

      // Flip coordinates if viewing from top perspective so drag matches visual
      if (this.isTopPerspective()) {
        x = CANVAS_WIDTH - x;
        y = CANVAS_HEIGHT - y;
      }

      this.mousePos = { x, y };
      if (this.isDragging) {
        this.emitInputFrame();
      }
    }

    bindInput() {
      if (this.bound) return;
      window.addEventListener("keydown", this.handleKeyDown);
      window.addEventListener("keyup", this.handleKeyUp);
      window.addEventListener("blur", this.handleBlur);
      if (this.canvas) {
        this.canvas.addEventListener("mousedown", this.handleMouseDown);
        window.addEventListener("mousemove", this.handleMouseMove);
        window.addEventListener("mouseup", this.handleMouseUp);
      }
      this.bound = true;
    }

    unbindInput() {
      if (!this.bound) return;
      window.removeEventListener("keydown", this.handleKeyDown);
      window.removeEventListener("keyup", this.handleKeyUp);
      window.removeEventListener("blur", this.handleBlur);
      if (this.canvas) {
        this.canvas.removeEventListener("mousedown", this.handleMouseDown);
        window.removeEventListener("mousemove", this.handleMouseMove);
        window.removeEventListener("mouseup", this.handleMouseUp);
      }
      this.bound = false;
    }

    start(options = {}) {
      if (!this.ensureDom()) return false;
      this.roomCode = options.roomCode || this.roomCode || "-";
      this.localSide = options.localSide || this.localSide || "bottom";
      this.matchId = options.matchId || this.matchId || null;
      this.onInputFrame = options.onInputFrame || this.onInputFrame || null;
      this.onGameOver = options.onGameOver || this.onGameOver || null;

      if (options.reset || !this.runtimeState) {
        this.runtimeState = createRuntimeState();
      }

      if (typeof options.status === "string") {
        this.runtimeState.match.status = options.status;
      }

      this.running = true;
      this.sequence = 0;
      this.lastTimestamp = 0;
      this.bindInput();
      this.syncHud();
      this.draw();
      this.sounds.play("start");

      if (!this.rafId) {
        this.rafId = requestAnimationFrame((timestamp) => this.loop(timestamp));
      }

      return true;
    }

    stop(options = {}) {
      this.running = false;
      this.unbindInput();
      this.inputState = cloneInputState();
      this.keyState = cloneInputState();
      this.sequence = 0;

      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }

      if (options.reset !== false) {
        this.runtimeState = createRuntimeState();
        this.previousBall = null;
        this.currentBall = null;
        this.interpolatedBall = null;
        this.lastSnapshotAt = 0;
      }

      if (typeof options.status === "string") {
        this.runtimeState.match.status = options.status;
      }

      if (Object.hasOwn(options, "roomCode")) {
        this.roomCode = options.roomCode || "-";
      }

      this.syncHud();
      this.draw();
      return true;
    }

    isRunning() {
      return this.running;
    }

    buildInputPayload() {
      const input = cloneInputState(this.inputState);
      const effectiveInput = this.isTopPerspective()
        ? {
            left: input.right,
            right: input.left,
            both: input.both,
            cheat: input.cheat,
          }
        : input;

      const payload = {
        roomCode: this.roomCode,
        matchId: this.matchId,
        seq: ++this.sequence,
        input: effectiveInput,
      };

      if (input.cheat) {
        payload.cheatPos = { ...this.mousePos };
      }

      return payload;
    }

    emitInputFrame() {
      if (!this.running || typeof this.onInputFrame !== "function") return;
      this.onInputFrame(this.buildInputPayload());
    }

    setInputState(state = {}, emit = false) {
      this.inputState = cloneInputState(state);
      if (emit) {
        this.emitInputFrame();
      }
      return this.getRuntimeState();
    }

    applyAuthoritativeSnapshot(snapshot, options = {}) {
      if (options.matchId && !this.matchId) {
        this.matchId = options.matchId;
      }

      const nextBall = snapshot?.scene?.ball
        ? { ...snapshot.scene.ball }
        : null;
      const currentVisualBall = this.getRenderedBall();

      // Sound detection
      if (snapshot.match) {
        const oldMatch = this.runtimeState.match;
        if (
          snapshot.match.score > oldMatch.score ||
          snapshot.match.topScore > oldMatch.topScore
        ) {
          // Detect if it was a goal (score changed by 1) or bumper hit (score changed by 100)
          const scoreDiff = snapshot.match.score - oldMatch.score;
          const topScoreDiff = snapshot.match.topScore - oldMatch.topScore;
          if (scoreDiff === 1 || topScoreDiff === 1) {
            this.sounds.play("goal");
          }
        }
        if (snapshot.match.gameOver && !oldMatch.gameOver) {
          this.sounds.play("gameover");
        }
      }

      if (snapshot.scene?.bumpers) {
        const oldBumpers = this.runtimeState.scene.bumpers;
        snapshot.scene.bumpers.forEach((b, i) => {
          if (oldBumpers[i] && b.activeUntil > oldBumpers[i].activeUntil) {
            this.sounds.play("bumper");
          }
        });
      }

      if (nextBall) {
        this.previousBall = currentVisualBall ? { ...currentVisualBall } : nextBall;
        this.currentBall = nextBall;
        this.interpolatedBall = { ...this.previousBall };
        this.lastSnapshotAt = performance.now();
      }

      applySnapshot(this.runtimeState, snapshot);
      if (options.ack) {
        this.lastAck = options.ack;
      }

      if (this.runtimeState.match.gameOver && typeof this.onGameOver === "function") {
        this.onGameOver(this.getRuntimeState());
      }

      this.syncHud();
      this.draw();
    }

    getRenderedBall() {
      if (this.interpolatedBall) return this.interpolatedBall;
      if (this.currentBall) return this.currentBall;
      return this.runtimeState?.scene?.ball || null;
    }

    updateInterpolatedBall(now = performance.now()) {
      if (!this.currentBall) return;
      if (!this.previousBall) {
        this.interpolatedBall = { ...this.currentBall };
        return;
      }

      const elapsed = now - this.lastSnapshotAt;
      const alpha = Math.max(0, Math.min(1, elapsed / 50));
      this.interpolatedBall = {
        x: this.previousBall.x + (this.currentBall.x - this.previousBall.x) * alpha,
        y: this.previousBall.y + (this.currentBall.y - this.previousBall.y) * alpha,
        vx: this.previousBall.vx + (this.currentBall.vx - this.previousBall.vx) * alpha,
        vy: this.previousBall.vy + (this.currentBall.vy - this.previousBall.vy) * alpha,
        r: this.currentBall.r,
      };
    }

    getRuntimeState() {
      const ball = this.runtimeState?.scene?.ball;
      const flippers = this.runtimeState?.scene?.flippers;
      return {
        running: this.running,
        score: this.runtimeState.match.score,
        lives: this.runtimeState.match.lives,
        topScore: this.runtimeState.match.topScore,
        topLives: this.runtimeState.match.topLives,
        status: this.runtimeState.match.status,
        roomCode: this.roomCode,
        matchId: this.matchId,
        localSide: this.localSide,
        ack: this.lastAck,
        ball: ball
          ? { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy }
          : null,
        flippers: flippers
          ? {
              leftAngle: flippers.bottomLeft.angle,
              rightAngle: flippers.bottomRight.angle,
              bottomLeftAngle: flippers.bottomLeft.angle,
              bottomRightAngle: flippers.bottomRight.angle,
              topLeftAngle: flippers.topLeft.angle,
              topRightAngle: flippers.topRight.angle,
            }
          : null,
      };
    }

    syncHud() {
      const { match } = this.runtimeState;
      if (this.hud.roomCode) this.hud.roomCode.textContent = this.roomCode;
      if (this.hud.localSide) {
        this.hud.localSide.textContent =
          this.localSide === "top" ? "Top" : "Bottom";
      }
      if (this.hud.scoreLabel)
        this.hud.scoreLabel.textContent = "Bottom Points";
      if (this.hud.topScoreLabel)
        this.hud.topScoreLabel.textContent = "Top Points";
      if (this.hud.livesLabel)
        this.hud.livesLabel.textContent = "Bottom Lives";
      if (this.hud.topLivesLabel)
        this.hud.topLivesLabel.textContent = "Top Lives";
      if (this.hud.score) this.hud.score.textContent = String(match.score);
      if (this.hud.lives) this.hud.lives.textContent = String(match.lives);
      if (this.hud.topScore) this.hud.topScore.textContent = String(match.topScore);
      if (this.hud.topLives) this.hud.topLives.textContent = String(match.topLives);
      if (this.hud.status) this.hud.status.textContent = match.status;
    }

    loop(timestamp) {
      if (!this.running) return;
      this.lastTimestamp = timestamp;
      this.updateInterpolatedBall();
      this.draw();
      this.rafId = requestAnimationFrame((nextTimestamp) => this.loop(nextTimestamp));
    }

    drawBackground(ctx) {
      const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
      gradient.addColorStop(0, "#091521");
      gradient.addColorStop(1, "#05070d");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.strokeStyle = "rgba(0, 180, 255, 0.18)";
      ctx.lineWidth = 2;
      ctx.strokeRect(14, 14, CANVAS_WIDTH - 28, CANVAS_HEIGHT - 28);

      ctx.fillStyle = "rgba(0, 204, 255, 0.16)";
      ctx.fillRect(20, 20, 360, CANVAS_HEIGHT / 2 - 20);
      ctx.fillStyle = "rgba(255, 80, 120, 0.16)";
      ctx.fillRect(20, CANVAS_HEIGHT / 2, 360, CANVAS_HEIGHT / 2 - 20);

      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(30, CANVAS_HEIGHT / 2);
      ctx.lineTo(CANVAS_WIDTH - 30, CANVAS_HEIGHT / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#89eeff";
      ctx.font = "600 14px Roboto, sans-serif";
      ctx.fillText("TOP GOAL", core.TOP_GOAL_MIN_X + 14, 46);
      ctx.fillStyle = "#ffb8c9";
      ctx.fillText("BOTTOM GOAL", core.BOTTOM_GOAL_MIN_X - 8, CANVAS_HEIGHT - 30);
    }

    drawSideLabels(ctx) {
      const topLabel = "TOP SIDE";
      const bottomLabel = "BOTTOM SIDE";

      ctx.save();
      if (this.isTopPerspective()) {
        ctx.translate(CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.rotate(Math.PI);
      }

      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.font = "600 13px Roboto, sans-serif";
      ctx.fillText(topLabel, 24, 68);
      ctx.fillText(bottomLabel, 24, CANVAS_HEIGHT - 48);
      ctx.restore();
    }

    drawWalls(ctx) {
      ctx.save();
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      for (const wall of this.runtimeState.scene.walls) {
        ctx.strokeStyle =
          wall.kind === "speedPad"
            ? "#ffd54f"
            : wall.oneWay
              ? "#00f2ff"
              : "#666";
        ctx.beginPath();
        ctx.moveTo(wall.p1.x, wall.p1.y);
        ctx.lineTo(wall.p2.x, wall.p2.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBumpers(ctx) {
      for (const bumper of this.runtimeState.scene.bumpers) {
        const active = Date.now() < bumper.activeUntil;
        ctx.save();
        ctx.beginPath();
        ctx.arc(bumper.x, bumper.y, bumper.r, 0, Math.PI * 2);
        ctx.fillStyle = active ? "#ff88aa" : "#ff0055";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
    }

    drawAreaEffects(ctx) {
      const zones = this.runtimeState.scene.areaEffects || [];
      for (const zone of zones) {
        ctx.save();
        const isSpeed = zone.kind === "speed";
        const label = isSpeed ? "SPEED UP" : "SLOWDOWN";
        ctx.fillStyle = isSpeed
          ? "rgba(255, 213, 79, 0.18)"
          : "rgba(64, 140, 255, 0.18)";
        ctx.strokeStyle = isSpeed
          ? "rgba(255, 213, 79, 0.85)"
          : "rgba(64, 140, 255, 0.85)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(zone.x, zone.y, zone.w, zone.h, 12);
        ctx.fill();
        ctx.stroke();

        const centerX = zone.x + zone.w / 2;
        const centerY = zone.y + zone.h / 2;
        const lines = label.split(" ");
        const lineHeight = 14;

        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = "600 11px Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.translate(centerX, centerY);
        if (this.isTopPerspective()) {
          ctx.rotate(Math.PI);
        }
        lines.forEach((line, index) => {
          const y = (index - (lines.length - 1) / 2) * lineHeight + 1;
          ctx.fillText(line, 0, y);
        });
        ctx.restore();
      }
    }

    drawFlipper(ctx, flipper) {
      const segment = getFlipperSegment(flipper);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = 9;
      ctx.strokeStyle = flipper.active ? "#7be4ff" : "#00ccff";
      ctx.beginPath();
      ctx.moveTo(segment.p1.x, segment.p1.y);
      ctx.lineTo(segment.p2.x, segment.p2.y);
      ctx.stroke();
      ctx.restore();
    }

    drawBall(ctx) {
      const ball = this.getRenderedBall();
      if (!ball) return;
      const gradient = ctx.createRadialGradient(
        ball.x - 3,
        ball.y - 4,
        2,
        ball.x,
        ball.y,
        ball.r,
      );
      gradient.addColorStop(0, "#ffffff");
      gradient.addColorStop(1, "#bcc7ff");
      ctx.save();
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();
    }

    drawOverlay(ctx) {
      if (this.running && !this.runtimeState.match.gameOver) return;

      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.fillRect(48, 312, 304, 74);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.font = "600 24px Roboto, sans-serif";
      ctx.fillText(this.runtimeState.match.status, CANVAS_WIDTH / 2, 342);
      ctx.font = "14px Roboto, sans-serif";
      ctx.fillText(
        "Waiting for the next rally.",
        CANVAS_WIDTH / 2,
        366,
      );
      ctx.restore();
    }

    draw() {
      if (!this.ensureDom()) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.save();
      if (this.isTopPerspective()) {
        ctx.translate(CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.rotate(Math.PI);
      }

      this.drawBackground(ctx);
      this.drawWalls(ctx);
      this.drawAreaEffects(ctx);
      this.drawBumpers(ctx);
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.bottomLeft);
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.bottomRight);
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.topLeft);
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.topRight);
      this.drawBall(ctx);
      this.drawOverlay(ctx);
      ctx.restore();

      this.drawSideLabels(ctx);
    }
  }

  const runtime = new GameplayRuntime();

  window.gameManager = {
    start(options = {}) {
      return runtime.start(options);
    },
    stop(options = {}) {
      return runtime.stop(options);
    },
    isRunning() {
      return runtime.isRunning();
    },
    getRuntimeState() {
      return runtime.getRuntimeState();
    },
    setInputState(state = {}) {
      return runtime.setInputState(state);
    },
    applyAuthoritativeSnapshot(snapshot, options = {}) {
      return runtime.applyAuthoritativeSnapshot(snapshot, options);
    },
  };
})();
