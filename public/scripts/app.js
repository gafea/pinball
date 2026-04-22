// Client-side script for account, lobby and room interactions
const socket = io();    
let me = null;
let currentRoom = null;
let _queueTimer = null;
let _queueStart = null;

async function api(path, data) {
    const res = await fetch(path, {
        method: data ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined
    });
    return res.json();
}

async function init() {
    Avatar.populate($("#register-avatar"));
    View.register('primary-view', 'home-view', 'game-play-view', 'game-over-view');
    View.register('secondary-view', 'signin-view', 'register-view', 'match-making-view');
    View.register('tertiary-view', 'idle-view', 'queue-status-view');

    // account registration
    $('#btn-register').click(async (e) => {
        e.preventDefault();
        const username = $('#reg-username').val().trim();
        const name = $('#reg-name').val().trim();
        const avatar = $('#register-avatar').val().trim() || 'Anon';
        const password = $('#reg-password').val();

        const r = await api('/register', { username, name, avatar, password });
        if (r.error) {
            showToast(r.error, "error", 3000);
        } else {
            showToast('Registration successful!', "success", 5000);
            View.show('signin-view');
        }
    });

    // player sign in
    $('#btn-signin').click(async (e) => {
        e.preventDefault();
        const username = $('#signin-username').val().trim();
        const password = $('#signin-password').val();
        const r = await api('/signin', { username, password });
        if (r.error) {
            showToast(r.error, "error", 5000);
        } else {
            me = r.user;
            onSignedIn();
        }
    });

    // show the account register form
    $('#btn-show-register').click((e) => {
        e.preventDefault();
        View.show('register-view');
    });

    // show the account sign in form
    $('#btn-show-signin').click((e) => {
        e.preventDefault();
        View.show('signin-view');
    });

    // player sign out
    $('#btn-signout').click(async () => {
        await api('/signout');
        // hide signout immediately and reload
        $('#btn-signout').hide();
        location.reload();
    });

    // create a private match with a unique code
    $('#btn-create-private-match').click(async () => {
        if (!me) return showToast('Please sign in first', 'error', 3000);
        
        $('#public-queue-timer').hide();
        $('#private-join-code').show();
        View.show('queue-status-view');

        currentRoom = null;
        socket.emit('create_private_room', me.username);
    });

    // join a private match with code
    $('#btn-join-private-match').click(async () => {
        if (!me) return showToast('Please sign in first', 'error', 3000);
        const code = $('#private-room-code-input').val().trim().toUpperCase();
        if (!code) return showToast('Please enter a room code', 'error', 3000);
        socket.emit('join_private_room', { code, username: me.username });
    });

    // join the match-making queue to find a random opponent
    $('#btn-find-match').click(async () => {
        if (!me) return showToast('Please sign in first', 'error', 3000);
        socket.emit('join_queue', me.username);

        $('#public-queue-timer').show();
        $('#private-join-code').hide();
        View.show('queue-status-view');

        startQueueTimer();
    });
    
    // player leave the match-making queue after joined or cancel private room
    $('#btn-leave-queue').click(async () => {
        if (currentRoom) {
            // owner cancelling private room
            socket.emit('cancel_private_room', currentRoom);
            currentRoom = null;
            $('#private-join-code').hide();
            View.show('idle-view');
            return;
        }
        socket.emit('leave_queue'); 
        stopQueueTimer();
        resetQueueTimerDisplay();
        View.show('idle-view');
        $('#private-join-code').hide();
    });
    
    // forfeit the current match and return to main page
    $('#btn-forfeit').click(async () => {
        if (!currentRoom) return showToast('Not in a room', 'error', 3000);
        socket.emit('forfeit', currentRoom);
        currentRoom = null;
        View.show('match-making-view');
    });

    // player join the match-making queue but something went wrong (e.g. already in queue)
    socket.on('queue_failed', (message) => {
        showToast(message, 'error', 3000);
        View.show('idle-view');
    });
    
    // server created a private room, show the join code on screen
    socket.on('private_room_created', ({ code }) => {
        currentRoom = code;
        console.log(`Created private room with code: ${code}`);
        // show join code
        $('#join-code').text(code);
        $('#private-join-code').show();

        // hide queue timer
        $('#public-queue-timer').hide();
    });

    // server moved the player to a room (either from queue or private match), now show the game page
    socket.on('room_joined', ({ code }) => {
        currentRoom = code;
        // stop timer if it was running
        stopQueueTimer();
        resetQueueTimerDisplay();
        View.show('game-play-view');
    });

    socket.on('room_update', (room) => {
        // const ul = document.getElementById('room-players'); 
        // ul.innerHTML = '';
        // for (const id in room.players) {
        //     const p = room.players[id];
        //     const li = document.createElement('li'); 
        //     li.textContent = p.username + (p.ready ? ' (ready)' : ''); 
        //     ul.appendChild(li);
        // }
    });

    // not able to join a room (e.g. wrong code, room full), show error message
    socket.on('room_error', (msg) => showToast(msg, 'error', 3000));
    
    // the server signaled the game to start (both players are ready), now we can initialize the game state and start the game loop
    socket.on('game_start', () => { 
        stopQueueTimer();
        resetQueueTimerDisplay();
        View.show('game-play-view');
        showToast('Match found!', 'success', 3000);
    });

    // TODO: a player in the same room forfeited, show message and goes to game over screen
    socket.on('player_forfeit', () => { 
        showToast('A player forfeited!', 'warning', 3000);
        View.show('idle-view');
        View.show('home-view');
        $('#private-room-code-input').val('');
    });

    // Check session
    const v = await api('/validate');
    if (!v.error) { 
        me = v.user; 
        onSignedIn(); 
    }







    function formatTimeElapsed(ms) {
        const total = Math.floor(ms / 1000);
        const mins = Math.floor(total / 60).toString().padStart(2, '0');
        const secs = (total % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    }

    function startQueueTimer() {
        stopQueueTimer();
        _queueStart = Date.now();
        const el = document.getElementById('queue-timer');
        if (!el) return;
        el.textContent = '00:00';
        _queueTimer = setInterval(() => {
            el.textContent = formatTimeElapsed(Date.now() - _queueStart);
        }, 500);
    }

    function stopQueueTimer() {
        if (_queueTimer) { clearInterval(_queueTimer); _queueTimer = null; }
        _queueStart = null;
    }

    function resetQueueTimerDisplay() {
        const el = document.getElementById('queue-timer');
        if (el) el.textContent = '00:00';
    }


}

function onSignedIn(){
    View.show('match-making-view');
    View.show('idle-view');

    $("#user-avatar").html(Avatar.getCode(me.avatar));
    $("#user-name").text(me.name);
    // show sign-out when user is signed in
    $('#btn-signout').show();
    
}

window.addEventListener('DOMContentLoaded', init);
