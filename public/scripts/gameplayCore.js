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
  const PLAYFIELD_LEFT_X = 20;
  const PLAYFIELD_RIGHT_X = 380;
  const MIDFIELD_Y = CANVAS_HEIGHT / 2;
  const GRAVITY_BLEND_HALF_BAND = 24;
  const DEFAULT_BUMPER_RADIUS = 18;
  const DEFAULT_BUMPER_RESTITUTION = 1.03;
  const AREA_EFFECT_WIDTH = 92;
  const AREA_EFFECT_HEIGHT = 118;
  const AREA_EFFECT_MIDFIELD_MARGIN = 24;
  const AREA_EFFECT_MULTIPLIER = {
    slow: 0.96,
    speed: 1.04,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const cloneInputState = (state = {}) => ({
    left: !!state.left,
    right: !!state.right,
    both: !!state.both,
    cheat: !!state.cheat,
  });

  const makeSegment = (p1, p2, extra = {}) => ({ p1, p2, ...extra });

  const makeBumper = (x, y, extra = {}) => ({
    x,
    y,
    r: DEFAULT_BUMPER_RADIUS,
    restitution: DEFAULT_BUMPER_RESTITUTION,
    lastHitAt: 0,
    activeUntil: 0,
    ...extra,
  });

  const mirrorPoint180 = ({ x, y }) => ({
    x: CANVAS_WIDTH - x,
    y: CANVAS_HEIGHT - y,
  });

  const mirrorRect180 = ({ x, y, w, h, kind }) => ({
    x: CANVAS_WIDTH - x - w,
    y: CANVAS_HEIGHT - y - h,
    w,
    h,
    kind,
  });

  const randomBetween = (min, max, random = Math.random) =>
    min + random() * (max - min);

  const createSymmetricBumperLayout = (random = Math.random) => {
    const radius = DEFAULT_BUMPER_RADIUS;
    const topLeftZone = {
      minX: 86,
      maxX: 138,
      minY: 190,
      maxY: 250,
    };
    const topRightZone = {
      minX: 262,
      maxX: 314,
      minY: 190,
      maxY: 250,
    };
    const minPairDistance = radius * 3;

    let topLeft;
    let topRight;
    let attempts = 0;

    do {
      topLeft = {
        x: randomBetween(topLeftZone.minX, topLeftZone.maxX, random),
        y: randomBetween(topLeftZone.minY, topLeftZone.maxY, random),
      };
      topRight = {
        x: randomBetween(topRightZone.minX, topRightZone.maxX, random),
        y: randomBetween(topRightZone.minY, topRightZone.maxY, random),
      };
      attempts += 1;
    } while (
      attempts < 100 &&
      Math.hypot(topLeft.x - topRight.x, topLeft.y - topRight.y) < minPairDistance
    );

    const bottomRight = mirrorPoint180(topLeft);
    const bottomLeft = mirrorPoint180(topRight);

    return [
      makeBumper(topLeft.x, topLeft.y),
      makeBumper(topRight.x, topRight.y),
      makeBumper(bottomLeft.x, bottomLeft.y),
      makeBumper(bottomRight.x, bottomRight.y),
    ];
  };

  const createSymmetricAreaEffectsLayout = (random = Math.random) => {
    const maxTopZoneY = MIDFIELD_Y - AREA_EFFECT_HEIGHT - AREA_EFFECT_MIDFIELD_MARGIN;

    const topLeftZone = {
      minX: 52,
      maxX: 120,
      minY: 170,
      maxY: maxTopZoneY,
    };
    const topRightZone = {
      minX: 228,
      maxX: 256,
      minY: 170,
      maxY: maxTopZoneY,
    };

    const topLeftSpeed = {
      x: randomBetween(topLeftZone.minX, topLeftZone.maxX, random),
      y: randomBetween(topLeftZone.minY, topLeftZone.maxY, random),
      w: AREA_EFFECT_WIDTH,
      h: AREA_EFFECT_HEIGHT,
      kind: "speed",
    };
    const topRightSlow = {
      x: randomBetween(topRightZone.minX, topRightZone.maxX, random),
      y: randomBetween(topRightZone.minY, topRightZone.maxY, random),
      w: AREA_EFFECT_WIDTH,
      h: AREA_EFFECT_HEIGHT,
      kind: "slow",
    };

    const bottomLeftSlow = {
      ...mirrorRect180(topRightSlow),
      kind: "slow",
    };
    const bottomRightSpeed = {
      ...mirrorRect180(topLeftSpeed),
      kind: "speed",
    };

    return [
      topLeftSpeed,
      topRightSlow,
      bottomLeftSlow,
      bottomRightSpeed,
    ];
  };

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

  const buildScene = (options = {}) => {
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

    const bumpers = (options.bumpers || createSymmetricBumperLayout()).map(
      (bumper) => makeBumper(bumper.x, bumper.y, bumper),
    );
    const areaEffects = (options.areaEffects || createSymmetricAreaEffectsLayout()).map(
      (zone) => ({
        x: zone.x,
        y: zone.y,
        w: zone.w,
        h: zone.h,
        kind: zone.kind,
      }),
    );

    const walls = [
      makeSegment({ x: 20, y: 20 }, { x: 20, y: 680 }),
      makeSegment({ x: 380, y: 20 }, { x: 380, y: 680 }),
      makeSegment({ x: 20, y: 20 }, { x: TOP_GOAL_MIN_X, y: 20 }),
      makeSegment({ x: TOP_GOAL_MAX_X, y: 20 }, { x: 380, y: 20 }),
      makeSegment({ x: 20, y: 680 }, { x: BOTTOM_GOAL_MIN_X, y: 680 }),
      makeSegment({ x: BOTTOM_GOAL_MAX_X, y: 680 }, { x: 380, y: 680 }),
      makeSegment(
        { x: 20, y: 140 },
        { x: 90, y: 95 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 380, y: 140 },
        { x: 310, y: 95 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 90, y: 95 },
        { x: 118, y: 76 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 310, y: 95 },
        { x: 282, y: 76 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 20, y: 560 },
        { x: 90, y: 605 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 380, y: 560 },
        { x: 310, y: 605 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 90, y: 605 },
        { x: 118, y: 624 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
      makeSegment(
        { x: 310, y: 605 },
        { x: 282, y: 624 },
        { kind: "speedPad", boost: 6, restitution: 0.98 },
      ),
    ];

    return {
      gravity: 0.06,
      friction: 0.986,
      ball,
      flippers,
      bumpers,
      areaEffects,
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

  const createRuntimeState = (options = {}) => ({
    meta: { tick: 0 },
    match: createInitialMatchState(),
    scene: buildScene(options),
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

  const applyAreaEffects = (runtimeState) => {
    const { ball, areaEffects } = runtimeState.scene;
    for (const zone of areaEffects) {
      const overlapsX = ball.x + ball.r >= zone.x && ball.x - ball.r <= zone.x + zone.w;
      const overlapsY = ball.y + ball.r >= zone.y && ball.y - ball.r <= zone.y + zone.h;
      if (!overlapsX || !overlapsY) continue;

      const multiplier = AREA_EFFECT_MULTIPLIER[zone.kind];
      if (!multiplier) continue;

      ball.vx *= multiplier;
      ball.vy *= multiplier;
    }
  };

  const stepPhysics = (runtimeState) => {
    const { ball, flippers, bumpers, walls, gravity, friction } =
      runtimeState.scene;
    const events = [];

    const overlapsTopGoalX =
      ball.x + ball.r >= TOP_GOAL_MIN_X && ball.x - ball.r <= TOP_GOAL_MAX_X;
    const overlapsBottomGoalX =
      ball.x + ball.r >= BOTTOM_GOAL_MIN_X &&
      ball.x - ball.r <= BOTTOM_GOAL_MAX_X;

    updateFlipper(flippers.bottomLeft);
    updateFlipper(flippers.bottomRight);
    updateFlipper(flippers.topLeft);
    updateFlipper(flippers.topRight);

    const gravityScale = getGravityScale(ball.y);
    ball.vy += gravity * gravityScale;
    ball.vx *= friction;
    ball.vy *= friction;
    applyAreaEffects(runtimeState);

    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.x < PLAYFIELD_LEFT_X + ball.r) {
      ball.x = PLAYFIELD_LEFT_X + ball.r;
      ball.vx *= -0.7;
    }
    if (ball.x > PLAYFIELD_RIGHT_X - ball.r) {
      ball.x = PLAYFIELD_RIGHT_X - ball.r;
      ball.vx *= -0.7;
    }
    if (ball.y < ball.r && !overlapsTopGoalX) {
      ball.y = ball.r;
      ball.vy *= -0.7;
    }
    if (ball.y > CANVAS_HEIGHT - ball.r && !overlapsBottomGoalX) {
      ball.y = CANVAS_HEIGHT - ball.r;
      ball.vy *= -0.7;
    }

    for (const wall of walls) {
      resolveSegmentCollision(ball, wall, {
        restitution: wall.restitution ?? 0.85,
        boost: wall.kind === "speedPad" ? wall.boost : undefined,
      });
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
      bumpers: runtimeState.scene.bumpers.map((bumper) => ({
        x: bumper.x,
        y: bumper.y,
        r: bumper.r,
        restitution: bumper.restitution,
        lastHitAt: bumper.lastHitAt,
        activeUntil: bumper.activeUntil,
      })),
      areaEffects: runtimeState.scene.areaEffects.map((zone) => ({
        x: zone.x,
        y: zone.y,
        w: zone.w,
        h: zone.h,
        kind: zone.kind,
      })),
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

    if (snapshot.scene?.bumpers) {
      runtimeState.scene.bumpers = snapshot.scene.bumpers.map((bumper) =>
        makeBumper(bumper.x, bumper.y, bumper),
      );
    }

    if (snapshot.scene?.areaEffects) {
      runtimeState.scene.areaEffects = snapshot.scene.areaEffects.map((zone) => ({
        x: zone.x,
        y: zone.y,
        w: zone.w,
        h: zone.h,
        kind: zone.kind,
      }));
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
    PLAYFIELD_LEFT_X,
    PLAYFIELD_RIGHT_X,
    MIDFIELD_Y,
    GRAVITY_BLEND_HALF_BAND,
    DEFAULT_BUMPER_RADIUS,
    DEFAULT_BUMPER_RESTITUTION,
    AREA_EFFECT_WIDTH,
    AREA_EFFECT_HEIGHT,
    AREA_EFFECT_MIDFIELD_MARGIN,
    AREA_EFFECT_MULTIPLIER,
    clamp,
    cloneInputState,
    getGravityScale,
    createInitialMatchState,
    createRuntimeState,
    createSymmetricBumperLayout,
    createSymmetricAreaEffectsLayout,
    buildInputFrame,
    buildTopAutoInputFrame,
    applyInputFrame,
    stepRuntime,
    serializeState,
    applySnapshot,
    getWinner,
  };
});
