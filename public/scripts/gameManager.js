/**
 * gameManager.js
 * Handles canvas rendering, game loop, and in-game socket event handlers.
 */

const gameManager = (() => {
    const canvas = $("#game_canvas")[0];
    const ctx = canvas.getContext("2d");
     
    const player = new Character("Player", 100, 100);
    const otherPlayers = [];

    let lastFrameTime = 0;

    const drawPlayerList = () => {
        ctx.save();
        ctx.font = "20px Arial";
        ctx.fillStyle = "blue";
        ctx.fillText(`You: ${GameRoom.user.name}`, 50, 100);
        for (let i = 0; i < window.gameState.players.length; i++) {
            ctx.fillText(window.gameState.players[i].name, 50, 150 + i * 30);
        }
        ctx.restore();
    };

    const doFrame = (now) => {
        if (window.gameState.gameStartTime === 0) window.gameState.gameStartTime = now;

        physicsupdate(now - lastFrameTime);
        renderScreen(ctx, now);

        lastFrameTime = now;
        requestAnimationFrame(doFrame);
    };

    const startGameLoop = () => {
        setupInputHandlers();
        requestAnimationFrame(doFrame);
    };

    const physicsupdate = (deltaTime) => {
        window.eventManager.notify("physics_update", { deltaTime });
    };

    const renderScreen = (ctx, now) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawPlayerList();

        // background layer
        // static background, parallax layers etc.
        window.eventManager.notify("draw_background", { ctx, now });

        // entity layer
        // character, enemies, shop interactables
        window.eventManager.notify("draw_entities", { ctx, now });

        // attack layer
        // melee hitboxes, projectiles, AoE indicators
        window.eventManager.notify("draw_attacks", { ctx, now });

        // effect layer
        // hit effects, damage numbers, status effect particles
        window.eventManager.notify("draw_effects", { ctx, now });

        // UI layer
        // health bars, cooldown timers etc.
        window.eventManager.notify("draw_uis", { ctx, now });
    }

    const setupSocketHandlers = (socket) => {
        // handle joining and leaving of other players in the same room
        socket.on("new_player_connected", (player) => {
            console.log(`Player connected: ${player.name} (${player.id})`);
            window.gameState.players.push(player);
        });
        socket.on("player_disconnected", (playerId) => {
            const player = window.gameState.players.find(p => p.id === playerId);
            const index = window.gameState.players.findIndex(p => p.id === playerId);
            console.log(`Player disconnected: ${player ? player.name : "Unknown"} (${playerId})`);
            if (index !== -1) {
                window.gameState.players.splice(index, 1);
            }
        });

        // notify the server when this client closed the window
        window.addEventListener("beforeunload", () => {
            socket.emit("close_connection", { playerName: window.gameState.selfPlayerName, roomId: window.gameState.roomId });
        });
    };

    const setupInputHandlers = () => {
        if (window.mobileCheck()) {
            // mobile input handlers (e.g. on-screen joystick, buttons) 
        } else {
            // desktop input handlers (e.g. keyboard, mouse)
            $(document).on("keydown", (e) => {
                window.eventManager.notify("key_down", { key: e.key });
            });

            $(document).on("keyup", (e) => {
                window.eventManager.notify("key_up", { key: e.key });
            });
        }
    };

    return {
        startGameLoop,
        setupSocketHandlers
    };
})();

window.gameRenderer = gameManager;
