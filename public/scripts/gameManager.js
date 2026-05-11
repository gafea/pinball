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
      x:
        flipper.x +
        Math.cos(flipper.angle) * flipper.length * flipper.direction,
      y:
        flipper.y +
        Math.sin(flipper.angle) * flipper.length * flipper.direction,
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

  class ImageManager {
    constructor() {
      this.images = {};
      this.loaded = 0;
      this.total = 0;
    }

    load(name, url) {
      this.total++;
      const img = new Image();
      img.src = url;
      img.onload = () => this.loaded++;
      this.images[name] = img;
    }

    get(name) {
      return this.images[name];
    }

    isReady() {
      return this.total > 0 && this.loaded === this.total;
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
      this.lastGameOverSoundMatchId = null;
      this.inputState = cloneInputState();
      this.keyState = cloneInputState();
      this.onInputFrame = null;
      this.onGameOver = null;
      this.rafId = null;
      this.bound = false;
      this.sequence = 0;
      this.previousInputState = cloneInputState();

      this.sounds = new SoundManager();
      this.sounds.load("bumper", "sounds/3d-pinball-soundtrack/SOUND104.mp3");
      this.sounds.load("goal", "sounds/3d-pinball-soundtrack/SOUND136.mp3");
      this.sounds.load("start", "sounds/3d-pinball-soundtrack/SOUND24.mp3");
      this.sounds.load("flipflap", "sounds/flipflap.mp3");
      this.sounds.load("win", "sounds/win.mp3");
      this.sounds.load("lose", "sounds/lose.mp3");

      this.sprites = new ImageManager();
      this.sprites.load("ball", "images/ball.png");
      this.sprites.load("bumper", "images/bouncyobstacles.png");
      this.sprites.load("p1l", "images/p1l.png");
      this.sprites.load("p1r", "images/p1r.png");
      this.sprites.load("p2l", "images/p2l.png");
      this.sprites.load("p2r", "images/p2r.png");
      this.sprites.load("speed", "images/speedup.png");
      this.sprites.load("slow", "images/slowdown.png");

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
      this.previousInputState = cloneInputState();
      this.lastGameOverSoundMatchId = null;
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
      this.previousInputState = cloneInputState();
      this.sequence = 0;
      this.lastGameOverSoundMatchId = null;

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
      const nextState = cloneInputState(state);
      const flapPressed =
        (!this.previousInputState.left && nextState.left) ||
        (!this.previousInputState.right && nextState.right) ||
        (!this.previousInputState.both && nextState.both);

      if (emit && this.running && flapPressed) {
        this.sounds.play("flipflap");
      }

      this.previousInputState = nextState;
      this.inputState = nextState;
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

      // Sound detection and Teleport detection
      if (snapshot.match) {
        const oldMatch = this.runtimeState.match;
        const scoreChanged =
          snapshot.match.score > oldMatch.score ||
          snapshot.match.topScore > oldMatch.topScore;
        const matchId = options.matchId || this.matchId;
        const gameOverChanged = snapshot.match.gameOver && !oldMatch.gameOver;
        const shouldPlayGameOverSound =
          snapshot.match.gameOver &&
          (gameOverChanged ||
            (matchId && this.lastGameOverSoundMatchId !== matchId));

        if (scoreChanged) {
          // Detect if it was a goal (score changed by 1) or bumper hit (score changed by 100)
          const scoreDiff = snapshot.match.score - oldMatch.score;
          const topScoreDiff = snapshot.match.topScore - oldMatch.topScore;
          if (scoreDiff === 1 || topScoreDiff === 1) {
            this.sounds.play("goal");
            // Force snap on goal to prevent gliding back to center
            this.previousBall = null;
          }
        }
        if (shouldPlayGameOverSound) {
          const winner = options.winner || core.getWinner(snapshot.match);
          if (winner === this.localSide) {
            this.sounds.play("win");
          } else if (winner === "top" || winner === "bottom") {
            this.sounds.play("lose");
          }
          if (matchId) {
            this.lastGameOverSoundMatchId = matchId;
          }
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
        // Also detect manual teleports or large jumps (e.g. cheat mode or resetBall)
        if (this.currentBall) {
          const dx = nextBall.x - this.currentBall.x;
          const dy = nextBall.y - this.currentBall.y;
          if (Math.hypot(dx, dy) > 100) {
            this.previousBall = null; // Reset interpolation history to force snap
          }
        }

        this.previousBall =
          currentVisualBall && this.previousBall
            ? { ...currentVisualBall }
            : nextBall;
        this.currentBall = nextBall;
        this.interpolatedBall = { ...this.previousBall };
        this.lastSnapshotAt = performance.now();
      }

      applySnapshot(this.runtimeState, snapshot);
      if (options.ack) {
        this.lastAck = options.ack;
      }

      if (
        this.runtimeState.match.gameOver &&
        typeof this.onGameOver === "function"
      ) {
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
        x:
          this.previousBall.x +
          (this.currentBall.x - this.previousBall.x) * alpha,
        y:
          this.previousBall.y +
          (this.currentBall.y - this.previousBall.y) * alpha,
        vx:
          this.previousBall.vx +
          (this.currentBall.vx - this.previousBall.vx) * alpha,
        vy:
          this.previousBall.vy +
          (this.currentBall.vy - this.previousBall.vy) * alpha,
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
        ball: ball ? { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy } : null,
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
      if (this.hud.livesLabel) this.hud.livesLabel.textContent = "Bottom Lives";
      if (this.hud.topLivesLabel)
        this.hud.topLivesLabel.textContent = "Top Lives";
      if (this.hud.score) this.hud.score.textContent = String(match.score);
      if (this.hud.lives) this.hud.lives.textContent = String(match.lives);
      if (this.hud.topScore)
        this.hud.topScore.textContent = String(match.topScore);
      if (this.hud.topLives)
        this.hud.topLives.textContent = String(match.topLives);
      if (this.hud.status) this.hud.status.textContent = match.status;
    }

    loop(timestamp) {
      if (!this.running) return;
      this.lastTimestamp = timestamp;
      this.updateInterpolatedBall();
      this.draw();
      this.rafId = requestAnimationFrame((nextTimestamp) =>
        this.loop(nextTimestamp),
      );
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
      ctx.fillText(
        "BOTTOM GOAL",
        core.BOTTOM_GOAL_MIN_X - 8,
        CANVAS_HEIGHT - 30,
      );
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
      const sprite = this.sprites.get("bumper");
      for (const bumper of this.runtimeState.scene.bumpers) {
        const active = Date.now() < bumper.activeUntil;
        ctx.save();
        if (sprite && this.sprites.isReady()) {
          ctx.translate(bumper.x, bumper.y);

          // Counteract global rotation so "BUMP" is always upright for the viewer
          if (this.isTopPerspective()) {
            ctx.rotate(Math.PI);
          }

          if (active) ctx.scale(1.15, 1.15);
          ctx.drawImage(
            sprite,
            -bumper.r * 1.5,
            -bumper.r * 1.5,
            bumper.r * 3,
            bumper.r * 3,
          );
        } else {
          ctx.beginPath();
          ctx.arc(bumper.x, bumper.y, bumper.r, 0, Math.PI * 2);
          ctx.fillStyle = active ? "#ff88aa" : "#ff0055";
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.45)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawAreaEffects(ctx) {
      const zones = this.runtimeState.scene.areaEffects || [];
      for (const zone of zones) {
        ctx.save();
        const isSpeed = zone.kind === "speed";
        const label = isSpeed ? "SPEED UP" : "SLOWDOWN";

        // Use semi-transparent primitives for better visibility/boundary checking
        ctx.fillStyle = isSpeed
          ? "rgba(255, 213, 79, 0.25)"
          : "rgba(64, 140, 255, 0.25)";
        ctx.strokeStyle = isSpeed
          ? "rgba(255, 213, 79, 0.8)"
          : "rgba(64, 140, 255, 0.8)";
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.roundRect(zone.x, zone.y, zone.w, zone.h, 8);
        ctx.fill();
        ctx.stroke();

        const centerX = zone.x + zone.w / 2;
        const centerY = zone.y + zone.h / 2;

        ctx.fillStyle = isSpeed ? "#ffd54f" : "#408cff";
        ctx.font = "bold 10px Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.translate(centerX, centerY);
        if (this.isTopPerspective()) {
          ctx.rotate(Math.PI);
        }
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    drawFlipper(ctx, flipper, spriteKey) {
      ctx.save();
      const sprite = this.sprites.get(spriteKey);

      if (sprite && this.sprites.isReady()) {
        ctx.translate(flipper.x, flipper.y);
        ctx.rotate(flipper.angle);

        const h = 30; // sprite draw height
        const w = flipper.length + 22; // sprite draw width (including base)
        const pivotOffset = 11; // center of the circular base in the sprite

        if (flipper.direction === 1) {
          // Left flipper: pivot is at the left end
          ctx.drawImage(sprite, -pivotOffset, -h / 2, w, h);
        } else {
          // Right flipper: pivot is at the right end
          ctx.drawImage(sprite, -w + pivotOffset, -h / 2, w, h);
        }
      } else {
        const segment = getFlipperSegment(flipper);
        ctx.lineCap = "round";
        ctx.lineWidth = 9;
        ctx.strokeStyle = flipper.active ? "#7be4ff" : "#00ccff";
        ctx.beginPath();
        ctx.moveTo(segment.p1.x, segment.p1.y);
        ctx.lineTo(segment.p2.x, segment.p2.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBall(ctx) {
      const ball = this.getRenderedBall();
      if (!ball) return;
      const sprite = this.sprites.get("ball");
      const drawX = this.isTopPerspective() ? CANVAS_WIDTH - ball.x : ball.x;
      const drawY = this.isTopPerspective() ? CANVAS_HEIGHT - ball.y : ball.y;

      ctx.save();
      // Reset transforms so the ball sprite stays upright on screen.
      if (typeof ctx.resetTransform === "function") {
        ctx.resetTransform();
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (sprite && this.sprites.isReady()) {
        ctx.translate(drawX, drawY);
        ctx.drawImage(sprite, -ball.r, -ball.r, ball.r * 2, ball.r * 2);
      } else {
        const gradient = ctx.createRadialGradient(
          drawX - 3,
          drawY - 4,
          2,
          drawX,
          drawY,
          ball.r,
        );
        gradient.addColorStop(0, "#ffffff");
        gradient.addColorStop(1, "#bcc7ff");
        ctx.beginPath();
        ctx.arc(drawX, drawY, ball.r, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }
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
      ctx.fillText("Waiting for the next rally.", CANVAS_WIDTH / 2, 366);
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
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.bottomLeft, "p1l");
      this.drawFlipper(
        ctx,
        this.runtimeState.scene.flippers.bottomRight,
        "p1r",
      );
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.topLeft, "p2l");
      this.drawFlipper(ctx, this.runtimeState.scene.flippers.topRight, "p2r");
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
