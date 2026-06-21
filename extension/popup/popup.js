const { INTERNAL } = self.YOUSYNC_PROTOCOL;

const $ = (id) => document.getElementById(id);

let lastState = null;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

function displayName() {
  return ($('display-name').value || '').trim() || 'Anônimo';
}

// ---------- render ----------

function render(state) {
  lastState = state;
  if (!state) return;

  $('conn-dot').classList.toggle('connected', !!state.connected);
  $('conn-dot').title = state.connected ? 'conectado' : 'desconectado';

  // erro
  const err = $('error');
  if (state.lastError) {
    err.textContent = state.lastError;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }

  // banner de anúncio
  const ad = $('ad-banner');
  if (state.adPause) {
    ad.textContent = `⏸ Pausado: anúncio em reprodução para ${state.adPause.displayName}. Retoma quando terminar.`;
    ad.classList.remove('hidden');
  } else {
    ad.classList.add('hidden');
  }

  const showOff = !state.active;
  const showRoom = state.active && state.room;
  const showLobby = state.active && !state.room;

  $('view-off').classList.toggle('hidden', !showOff);
  $('view-lobby').classList.toggle('hidden', !showLobby);
  $('view-room').classList.toggle('hidden', !showRoom);

  if (showOff) {
    if (!$('server-url').value) $('server-url').value = state.serverUrl || 'ws://localhost:8080';
  }

  if (showLobby) renderRooms(state.publicRooms || []);
  if (showRoom) renderRoom(state);
}

function renderRooms(rooms) {
  const ul = $('public-rooms');
  ul.innerHTML = '';
  if (!rooms.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nenhuma sala pública no momento.';
    ul.appendChild(li);
    return;
  }
  for (const room of rooms) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = room.name;
    const right = document.createElement('span');
    right.className = 'room-meta';
    right.textContent = `${room.userCount} 👤`;
    const btn = document.createElement('button');
    btn.className = 'btn link';
    btn.textContent = 'entrar';
    btn.addEventListener('click', () => {
      send(INTERNAL.JOIN_ROOM, { roomCode: room.code, displayName: displayName() });
    });
    const meta = document.createElement('span');
    meta.style.display = 'flex';
    meta.style.gap = '8px';
    meta.style.alignItems = 'center';
    meta.appendChild(right);
    meta.appendChild(btn);
    li.appendChild(name);
    li.appendChild(meta);
    ul.appendChild(li);
  }
}

function renderRoom(state) {
  const room = state.room;
  $('room-title').textContent = room.name;
  $('room-code-display').textContent = room.code;
  $('host-badge').classList.toggle('hidden', !state.isHost);
  $('room-visibility').textContent = room.isPublic ? 'Sala pública' : 'Sala privada';

  const ul = $('participants');
  ul.innerHTML = '';
  for (const u of room.users || []) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = u.displayName + (u.userId === state.you ? ' (você)' : '');

    const right = document.createElement('span');
    right.className = 'host-action';

    if (u.isHost) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'HOST';
      right.appendChild(badge);
    } else if (state.isHost) {
      const btn = document.createElement('button');
      btn.className = 'btn link';
      btn.textContent = 'tornar host';
      btn.addEventListener('click', () => send(INTERNAL.TRANSFER_HOST, { targetUserId: u.userId }));
      right.appendChild(btn);
    }

    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  }
}

// ---------- eventos da UI ----------

$('btn-activate').addEventListener('click', async () => {
  const serverUrl = ($('server-url').value || '').trim() || 'ws://localhost:8080';
  await send(INTERNAL.ACTIVATE, { serverUrl });
  setTimeout(() => send(INTERNAL.LIST_ROOMS), 400);
});

$('btn-deactivate').addEventListener('click', () => send(INTERNAL.DEACTIVATE));

$('btn-create').addEventListener('click', () => {
  send(INTERNAL.CREATE_ROOM, {
    name: ($('room-name').value || '').trim(),
    isPublic: $('room-public').checked,
    displayName: displayName(),
  });
});

$('btn-join').addEventListener('click', () => {
  const code = ($('room-code').value || '').trim().toUpperCase();
  if (!code) return;
  send(INTERNAL.JOIN_ROOM, { roomCode: code, displayName: displayName() });
});

$('btn-refresh').addEventListener('click', () => send(INTERNAL.LIST_ROOMS));

$('btn-leave').addEventListener('click', () => send(INTERNAL.LEAVE_ROOM));

$('btn-copy').addEventListener('click', () => {
  if (lastState && lastState.room) {
    navigator.clipboard.writeText(lastState.room.code).catch(() => {});
  }
});

$('display-name').addEventListener('change', () => {
  localStorage.setItem('yousync_name', $('display-name').value);
});

// ---------- inicialização ----------

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === INTERNAL.STATE_UPDATE) {
    render(message.payload);
  }
});

(async function init() {
  const savedName = localStorage.getItem('yousync_name');
  if (savedName) $('display-name').value = savedName;
  const state = await chrome.runtime.sendMessage({ type: INTERNAL.GET_STATE }).catch(() => null);
  render(state);
  if (state && state.active && !state.room) send(INTERNAL.LIST_ROOMS);
})();
