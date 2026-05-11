((root, factory) => {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameplayCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const CANVAS_WIDTH = 400;
  const CANVAS_HEIGHT = 700;
  const DEFAULT_LIVES = 3;
  const DEFAULT_STATUS = "Waiting";
  const TOP_GOAL_MIN_X = 150;
  const TOP_GOAL_MAX_X = 250;
  const BOTTOM_GOAL_MIN_X = 150;
  const BOTTOM_GOAL_MAX_X = 250;
  const MIDFIELD_Y = CANVAS_HEIGHT / 2;
  const GRAVITY_BLEND_HALF_BAND = 24;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const cloneInputState = (state = {}) => ({
    left: !!state.left,
    right: !!state.right,
    both: !!state.both,
  });

  const makeSegment = (p1, p2, extra = {}) => ({ p1, p2, ...extra });

  const getGravityScale = (ballY) => {
    const distanceFromMidfield = ballY - MIDFIELD_Y;
    return clamp(
      distanceFromMidfield / GRAVITY_BLEND_HALF_BAND,
      -1,
      1,
    );
  };

  const nearestPointOnSegment = (point, p1, p2) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lengthSquared = dx * dx + dy * dy || 1;
    const t = clamp(
      ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lengthSquared,
      0,
      1,
    );

    return {
      x: p1.x + dx * t,
      y: p1.y + dy * t,
    };
  };

  const reflectVelocity = (body, normal, restitution = 0.8) => {
    const velocityAlongNormal = body.vx * normal.x + body.vy * normal.y;
    if (velocityAlongNormal >= 0) return;

    const impulse = -(1 + restitution) * velocityAlongNormal;
    body.vx += impulse * normal.x;
    body.vy += impulse * normal.y;
  };

  const resolveSegmentCollision = (ball, segment, options = {}) => {
    const closest = nearestPointOnSegment(ball, segment.p1, segment.p2);
    const dx = ball.x - closest.x;
    const dy = ball.y - closest.y;
    const distance = Math.hypot(dx, dy) || 0.0001;
    const penetration = ball.r - distance;

    if (penetration <= 0) return false;

    if (segment.oneWay && segment.allowDir) {
      const velocityAlongAllowed =
        ball.vx * segment.allowDir.x + ball.vy * segment.allowDir.y;
      if (velocityAlongAllowed > 0.1) return false;
    }

    const normal = { x: dx / distance, y: dy / distance };
    ball.x += normal.x * penetration;
    ball.y += normal.y * penetration;
    reflectVelocity(ball, normal, options.restitution ?? ball.restitution);

    if (options.boost) {
      ball.vx += normal.x * options.boost;
      ball.vy += normal.y * options.boost;
    }

    return true;
  };

  const resolveBumperCollision = (ball, bumper, onHit) => {
    const dx = ball.x - bumper.x;
    const dy = ball.y - bumper.y;
    const distance = Math.hypot(dx, dy) || 0.0001;
    const minDistance = ball.r + bumper.r;

    if (distance >= minDistance) return false;

    const normal = { x: dx / distance, y: dy / distance };
    const penetration = minDistance - distance;
    ball.x += normal.x * penetration;
    ball.y += normal.y * penetration;
    reflectVelocity(
      ball,
      normal,
      Math.max(ball.restitution, bumper.restitution),
    );

    const now = Date.now();
    if (now - bumper.lastHitAt > 80) {
      bumper.lastHitAt = now;
      bumper.activeUntil = now + 120;
      onHit();
    }

    return true;
  };

  const getFlipperSegment = (flipper, usePrevious = false) => {
    const angle = usePrevious ? flipper.previousAngle : flipper.angle;
    return makeSegment(
      { x: flipper.x, y: flipper.y },
      {
        x: flipper.x + Math.cos(angle) * flipper.length * flipper.direction,
        y: flipper.y + Math.sin(angle) * flipper.length * flipper.direction,
      },
    );
  };

  const buildScene = () => {
    const ball = {
      x: CANVAS_WIDTH / 2,
      y: CANVAS_HEIGHT * 0.68,
      vx: 1.2,
      vy: -8,
      r: 8,
      restitution: 0.85,
    };

    const flippers = {
      bottomLeft: {
        x: 110,
        y: 630,
        length: 70,
        angle: 0.5,
        initialAngle: 0.5,
        previousAngle: 0.5,
        direction: 1,
        activationSign: -1,
        active: false,
      },
      bottomRight: {
        x: 290,
        y: 630,
        length: 70,
        angle: -0.5,
        initialAngle: -0.5,
        previousAngle: -0.5,
        direction: -1,
        activationSign: -1,
        active: false,
      },
      topLeft: {
        x: 110,
        y: 70,
        length: 70,
        angle: -0.5,
        initialAngle: -0.5,
        previousAngle: -0.5,
        direction: 1,
        activationSign: 1,
        active: false,
      },
      topRight: {
        x: 290,
        y: 70,
        length: 70,
        angle: 0.5,
        initialAngle: 0.5,
        previousAngle: 0.5,
        direction: -1,
        activationSign: 1,
        active: false,
      },
    };

    const bumpers = [
      {
        x: 95,
        y: 215,
        r: 18,
        restitution: 1.03,
        lastHitAt: 0,
        activeUntil: 0,
      },
      {
        x: 305,
        y: 215,
        r: 18,
        restitution: 1.03,
        lastHitAt: 0,
        activeUntil: 0,
      },
      {
        x: 95,
        y: 485,
        r: 18,
        restitution: 1.03,
        lastHitAt: 0,
        activeUntil: 0,
      },
      {
        x: 305,
        y: 485,
        r: 18,
        restitution: 1.03,
        lastHitAt: 0,
        activeUntil: 0,
      },
    ];

    const walls = [
      makeSegment({ x: 20, y: 20 }, { x: 20, y: 680 }),
      makeSegment({ x: 380, y: 20 }, { x: 380, y: 680 }),
      makeSegment({ x: 20, y: 20 }, { x: TOP_GOAL_MIN_X, y: 20 }),
      makeSegment({ x: TOP_GOAL_MAX_X, y: 20 }, { x: 380, y: 20 }),
      makeSegment({ x: 20, y: 680 }, { x: BOTTOM_GOAL_MIN_X, y: 680 }),
      makeSegment({ x: BOTTOM_GOAL_MAX_X, y: 680 }, { x: 380, y: 680 }),
      makeSegment({ x: 20, y: 140 }, { x: 90, y: 95 }),
      makeSegment({ x: 380, y: 140 }, { x: 310, y: 95 }),
      makeSegment({ x: 90, y: 95 }, { x: 118, y: 76 }),
      makeSegment({ x: 310, y: 95 }, { x: 282, y: 76 }),
      makeSegment({ x: 20, y: 560 }, { x: 90, y: 605 }),
      makeSegment({ x: 380, y: 560 }, { x: 310, y: 605 }),
      makeSegment({ x: 90, y: 605 }, { x: 118, y: 624 }),
      makeSegment({ x: 310, y: 605 }, { x: 282, y: 624 }),
      makeSegment({ x: 85, y: 330 }, { x: 145, y: 360 }),
      makeSegment({ x: 315, y: 330 }, { x: 255, y: 360 }),
    ];

    return {
      gravity: 0.06,
      friction: 0.986,
      ball,
      flippers,
      bumpers,
      walls,
      ballSpawnBottom: {
        x: CANVAS_WIDTH / 2,
        y: CANVAS_HEIGHT * 0.68,
        vx: 1.2,
        vy: -8,
      },
      ballSpawnTop: {
        x: CANVAS_WIDTH / 2,
        y: CANVAS_HEIGHT * 0.32,
        vx: -1.2,
        vy: 8,
      },
    };
  };

  const createInitialMatchState = () => ({
    score: 0,
    lives: DEFAULT_LIVES,
    topScore: 0,
    topLives: DEFAULT_LIVES,
    status: DEFAULT_STATUS,
    gameOver: false,
  });

  const createRuntimeState = () => ({
    meta: { tick: 0 },
    match: createInitialMatchState(),
    scene: buildScene(),
  });

  const buildManualInputFrame = (inputState = {}) => {
    const input = cloneInputState(inputState);
    return {
      bottomLeftActive: input.left || input.both,
      bottomRightActive: input.right || input.both,
    };
  };

  const buildTopManualInputFrame = (inputState = {}) => {
    const input = cloneInputState(inputState);
    return {
      topLeftActive: input.left || input.both,
      topRightActive: input.right || input.both,
    };
  };

  const buildTopAutoInputFrame = (runtimeState) => {
    const ball = runtimeState.scene.ball;
    const engageZone = CANVAS_HEIGHT * 0.46;
    const shouldEngage = ball.y < engageZone && ball.vy < 1.5;
    return {
      topLeftActive: shouldEngage && ball.x < CANVAS_WIDTH * 0.57,
      topRightActive: shouldEngage && ball.x > CANVAS_WIDTH * 0.43,
    };
  };

  const buildInputFrame = (
    runtimeState,
    {
      bottomInput = {},
      topInput = {},
      topControlMode = "manual",
    } = {},
  ) => ({
    ...buildManualInputFrame(bottomInput),
    ...(topControlMode === "auto"
      ? buildTopAutoInputFrame(runtimeState)
      : buildTopManualInputFrame(topInput)),
  });

  const applyInputFrame = (runtimeState, frame = {}) => {
    const { flippers } = runtimeState.scene;
    flippers.bottomLeft.active = !!frame.bottomLeftActive;
    flippers.bottomRight.active = !!frame.bottomRightActive;
    flippers.topLeft.active = !!frame.topLeftActive;
    flippers.topRight.active = !!frame.topRightActive;
  };

  const updateFlipper = (flipper) => {
    const speed = 0.15;
    const limit = 0.8;
    const activationSign = flipper.activationSign ?? -1;
    flipper.previousAngle = flipper.angle;

    if (flipper.active) {
      flipper.angle += speed * flipper.direction * activationSign;
    } else {
      flipper.angle += (flipper.initialAngle - flipper.angle) * 0.2;
    }

    if (flipper.direction === 1) {
      flipper.angle = Math.max(-limit, Math.min(0.5, flipper.angle));
    } else {
      flipper.angle = Math.min(limit, Math.max(-0.5, flipper.angle));
    }
  };

  const resetBall = (runtimeState, serveTo = "bottom") => {
    const spawn =
      serveTo === "top"
        ? runtimeState.scene.ballSpawnTop
        : runtimeState.scene.ballSpawnBottom;
    Object.assign(runtimeState.scene.ball, {
      x: spawn.x,
      y: spawn.y,
      vx: spawn.vx,
      vy: spawn.vy,
    });
  };

  const stepPhysics = (runtimeState) => {
    const { ball, flippers, bumpers, walls, gravity, friction } =
      runtimeState.scene;
    const events = [];

    updateFlipper(flippers.bottomLeft);
    updateFlipper(flippers.bottomRight);
    updateFlipper(flippers.topLeft);
    updateFlipper(flippers.topRight);

    const gravityScale = getGravityScale(ball.y);
    ball.vy += gravity * gravityScale;
    ball.vx *= friction;
    ball.vy *= friction;

    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx *= -0.7;
    }
    if (ball.x > CANVAS_WIDTH - ball.r) {
      ball.x = CANVAS_WIDTH - ball.r;
      ball.vx *= -0.7;
    }

    for (const wall of walls) {
      resolveSegmentCollision(ball, wall, { restitution: 0.85 });
    }

    const flipperSegments = [
      { flipper: flippers.bottomLeft, boostWhenActive: 7, boostWhenIdle: 2 },
      { flipper: flippers.bottomRight, boostWhenActive: 7, boostWhenIdle: 2 },
      { flipper: flippers.topLeft, boostWhenActive: 7, boostWhenIdle: 1.5 },
      { flipper: flippers.topRight, boostWhenActive: 7, boostWhenIdle: 1.5 },
    ];

    for (const config of flipperSegments) {
      resolveSegmentCollision(ball, getFlipperSegment(config.flipper), {
        restitution: 0.92,
        boost: config.flipper.active
          ? config.boostWhenActive
          : config.boostWhenIdle,
      });
    }

    for (const bumper of bumpers) {
      resolveBumperCollision(ball, bumper, () => {
        events.push({ type: "BUMPER_HIT", points: 100 });
      });
    }

    return events;
  };

  const detectMatchEvents = (runtimeState) => {
    const { ball } = runtimeState.scene;
    const events = [];

    const topGoalEntered =
      ball.y - ball.r <= 20 &&
      ball.x + ball.r >= TOP_GOAL_MIN_X &&
      ball.x - ball.r <= TOP_GOAL_MAX_X;

    const bottomGoalEntered =
      ball.y + ball.r >= 680 &&
      ball.x + ball.r >= BOTTOM_GOAL_MIN_X &&
      ball.x - ball.r <= BOTTOM_GOAL_MAX_X;

    if (topGoalEntered) {
      events.push({ type: "GOAL", side: "top" });
    } else if (bottomGoalEntered) {
      events.push({ type: "GOAL", side: "bottom" });
    }

    return events;
  };

  const getWinner = (match) => {
    if (match.lives <= 0 && match.topLives <= 0) return "draw";
    if (match.lives <= 0) return "top";
    if (match.topLives <= 0) return "bottom";
    if (match.score > match.topScore) return "bottom";
    if (match.topScore > match.score) return "top";
    return "draw";
  };

  const reduceMatchEvents = (runtimeState, events = []) => {
    const { match } = runtimeState;

    for (const event of events) {
      if (event.type === "BUMPER_HIT") {
        match.score += event.points;
        continue;
      }

      if (event.type !== "GOAL") continue;

      if (event.side === "top") {
        match.score += 1;
        match.topLives = Math.max(0, match.topLives - 1);
      } else {
        match.topScore += 1;
        match.lives = Math.max(0, match.lives - 1);
      }

      if (match.lives > 0 && match.topLives > 0) {
        resetBall(runtimeState, event.side === "top" ? "top" : "bottom");
        match.status =
          event.side === "top"
            ? `Bottom scored! Top lives: ${match.topLives}`
            : `Top scored! Bottom lives: ${match.lives}`;
        continue;
      }

      match.gameOver = true;
      const winner = getWinner(match);
      if (winner === "draw") {
        match.status = "Game Over - Draw";
      } else if (winner === "top") {
        match.status = "Game Over - Top Wins";
      } else {
        match.status = "Game Over - Bottom Wins";
      }
    }

    if (
      !match.gameOver &&
      (match.status.startsWith("Bottom scored") ||
        match.status.startsWith("Top scored"))
    ) {
      match.status = "Running";
    }
  };

  const stepRuntime = (runtimeState, inputFrame = {}) => {
    applyInputFrame(runtimeState, inputFrame);
    const physicsEvents = stepPhysics(runtimeState);
    const matchEvents = detectMatchEvents(runtimeState);
    const events = [...physicsEvents, ...matchEvents];
    reduceMatchEvents(runtimeState, events);
    runtimeState.meta.tick += 1;
    return events;
  };

  const serializeState = (runtimeState) => ({
    tick: runtimeState.meta.tick,
    match: {
      score: runtimeState.match.score,
      lives: runtimeState.match.lives,
      topScore: runtimeState.match.topScore,
      topLives: runtimeState.match.topLives,
      status: runtimeState.match.status,
      gameOver: runtimeState.match.gameOver,
    },
    scene: {
      ball: {
        x: runtimeState.scene.ball.x,
        y: runtimeState.scene.ball.y,
        vx: runtimeState.scene.ball.vx,
        vy: runtimeState.scene.ball.vy,
        r: runtimeState.scene.ball.r,
      },
      flippers: Object.fromEntries(
        Object.entries(runtimeState.scene.flippers).map(([key, flipper]) => [
          key,
          {
            angle: flipper.angle,
            active: flipper.active,
          },
        ]),
      ),
    },
  });

  const applySnapshot = (runtimeState, snapshot) => {
    if (!snapshot) return runtimeState;

    if (typeof snapshot.tick === "number") {
      runtimeState.meta.tick = snapshot.tick;
    }

    if (snapshot.match) {
      runtimeState.match = {
        ...runtimeState.match,
        ...snapshot.match,
      };
    }

    if (snapshot.scene?.ball) {
      Object.assign(runtimeState.scene.ball, snapshot.scene.ball);
    }

    if (snapshot.scene?.flippers) {
      for (const [key, value] of Object.entries(snapshot.scene.flippers)) {
        if (!runtimeState.scene.flippers[key]) continue;
        Object.assign(runtimeState.scene.flippers[key], value);
      }
    }

    return runtimeState;
  };

  return {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    DEFAULT_LIVES,
    DEFAULT_STATUS,
    TOP_GOAL_MIN_X,
    TOP_GOAL_MAX_X,
    BOTTOM_GOAL_MIN_X,
    BOTTOM_GOAL_MAX_X,
    MIDFIELD_Y,
    GRAVITY_BLEND_HALF_BAND,
    cloneInputState,
    getGravityScale,
    createInitialMatchState,
    createRuntimeState,
    buildInputFrame,
    buildTopAutoInputFrame,
    applyInputFrame,
    stepRuntime,
    serializeState,
    applySnapshot,
    getWinner,
  };
});
