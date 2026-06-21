// Service worker: cérebro da sessão YouSync.
// Mantém a conexão WebSocket, o estado da sala e roteia mensagens entre
// o popup (UI), o content script (player do YouTube) e o servidor.
importScripts('shared/protocol.js');

const { C2S, S2C, INTERNAL } = self.YOUSYNC_PROTOCOL;

const DEFAULT_SERVER = 'ws://localhost:8080';
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 15000;

const DEBUG = true;
const log = (...a) => DEBUG && console.log('%c[YouSync][bg]', 'color:#ff0033', ...a);

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let outbox = []; // mensagens enfileiradas enquanto o WS não está aberto

// Estado da sessão mantido em memória e espelhado em storage.session.
let state = {
  active: false,
  connected: false,
  serverUrl: DEFAULT_SERVER,
  you: null,
  room: null, // { code, name, isPublic, hostId, users:[] }
  isHost: false,
  publicRooms: [],
  adPause: null, // { displayName } quando a sala está pausada por anúncio
  lastError: null,
  // Guardado para reconectar automaticamente
  pending: null, // { kind:'create'|'join', ...payload, displayName }
};

// ---------- persistência leve ----------

async function persist() {
  try {
    await chrome.storage.session.set({ yousyncState: state });
  } catch (_) {}
}

async function restore() {
  try {
    const { yousyncServerUrl } = await chrome.storage.local.get('yousyncServerUrl');
    if (yousyncServerUrl) state.serverUrl = yousyncServerUrl;
    const { yousyncState } = await chrome.storage.session.get('yousyncState');
    if (yousyncState) state = { ...state, ...yousyncState, connected: false };
  } catch (_) {}
}

function pushState() {
  persist();
  chrome.runtime.sendMessage({ type: INTERNAL.STATE_UPDATE, payload: state }).catch(() => {});
}

// ---------- comunicação com o content script ----------

async function sendToContent(message) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    if (!tabs.length) {
      log('sendToContent: nenhuma aba do YouTube encontrada para', message.type);
      return;
    }
    log('-> content', message.type, message.payload?.kind || message.payload?.role || '', `(${tabs.length} aba(s))`);
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch((e) => {
        log('content não respondeu na aba', tab.id, '— recarregue a aba do YouTube?', e?.message || e);
      });
    }
  } catch (e) {
    log('sendToContent erro', e);
  }
}

function updateContentRole() {
  if (!state.room) return;
  sendToContent({ type: INTERNAL.CONTENT_SET_ROLE, payload: { role: state.isHost ? 'host' : 'participant' } });
}

// ---------- WebSocket ----------

function wsSend(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log('-> server', type, payload);
    ws.send(JSON.stringify({ type, payload }));
  } else {
    log('WS não aberto — enfileirando', type);
    outbox.push({ type, payload });
  }
}

function flushOutbox() {
  if (!outbox.length) return;
  log('esvaziando outbox:', outbox.length, 'mensagem(ns)');
  const queued = outbox;
  outbox = [];
  for (const m of queued) wsSend(m.type, m.payload);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log('connect(): já conectado/conectando');
    return;
  }
  clearTimeout(reconnectTimer);
  log('conectando em', state.serverUrl);

  try {
    ws = new WebSocket(state.serverUrl);
  } catch (e) {
    log('falha ao criar WebSocket', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log('WS aberto');
    reconnectAttempts = 0;
    state.connected = true;
    state.lastError = null;
    pushState();
    // Reentra na sala após reconexão.
    if (state.pending) {
      log('reentrando na sala (pending)', state.pending.kind);
      if (state.pending.kind === 'create') {
        wsSend(C2S.CREATE_ROOM, state.pending.payload);
      } else if (state.pending.kind === 'join') {
        wsSend(C2S.JOIN_ROOM, state.pending.payload);
        wsSend(C2S.SYNC_REQUEST, {});
      }
    }
    flushOutbox();
  };

  ws.onmessage = (ev) => handleServerMessage(ev.data);

  ws.onclose = (ev) => {
    log('WS fechado', ev.code, ev.reason);
    state.connected = false;
    pushState();
    if (state.active) scheduleReconnect();
  };

  ws.onerror = (e) => {
    log('WS erro', e?.message || e);
    state.lastError = 'Falha de conexão com o servidor';
  };
}

function scheduleReconnect() {
  if (!state.active) return;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE * 2 ** (reconnectAttempts - 1), RECONNECT_MAX);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  state.connected = false;
}

// ---------- mensagens do servidor ----------

function handleServerMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { type, payload = {} } = msg;
  if (type !== S2C.PING) log('<- server', type, payload);

  switch (type) {
    case S2C.PING:
      return wsSend(C2S.PONG, {});

    case S2C.ROOM_CREATED:
    case S2C.ROOM_JOINED:
      state.you = payload.you;
      state.room = payload.room;
      state.isHost = payload.isHost;
      state.adPause = null;
      state.pending = {
        kind: type === S2C.ROOM_CREATED ? 'create' : 'join',
        payload: type === S2C.ROOM_CREATED
          ? { name: payload.room.name, isPublic: payload.room.isPublic, displayName: displayNameOf() }
          : { roomCode: payload.room.code, displayName: displayNameOf() },
      };
      updateContentRole();
      return pushState();

    case S2C.ROOM_LIST:
      state.publicRooms = payload.rooms || [];
      return pushState();

    case S2C.USER_JOINED:
    case S2C.USER_LEFT:
      if (state.room) state.room.users = payload.users || state.room.users;
      return pushState();

    case S2C.HOST_CHANGED:
      if (state.room) state.room.hostId = payload.hostUserId;
      state.isHost = state.you === payload.hostUserId;
      if (state.room && state.room.users) {
        state.room.users = state.room.users.map((u) => ({ ...u, isHost: u.userId === payload.hostUserId }));
      }
      updateContentRole();
      return pushState();

    case S2C.PLAYBACK_ACTION:
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'playback', ...payload } });
      return;

    case S2C.VIDEO_CHANGE:
      applyVideoChange(payload);
      return;

    case S2C.SYNC_STATE:
      if (payload.videoId) applyVideoChange(payload, true);
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'sync', ...payload } });
      return;

    case S2C.AD_PAUSE:
      state.adPause = { userId: payload.userId, displayName: payload.displayName };
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'ad_pause' } });
      notifyAd(payload.displayName);
      return pushState();

    case S2C.AD_RESUME:
      state.adPause = null;
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'ad_resume' } });
      return pushState();

    case S2C.ERROR:
      state.lastError = payload.message || payload.code;
      return pushState();
  }
}

function displayNameOf() {
  return (state.pending && state.pending.payload && state.pending.payload.displayName) || 'Anônimo';
}

// Garante que a aba do YouTube esteja no vídeo certo antes de aplicar o estado.
async function applyVideoChange(payload, fromSync = false) {
  if (!payload.videoId) return;
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      const url = new URL(tab.url);
      const currentId = url.searchParams.get('v');
      if (currentId !== payload.videoId) {
        chrome.tabs.update(tab.id, { url: `https://www.youtube.com/watch?v=${payload.videoId}` });
      } else {
        chrome.tabs.sendMessage(tab.id, {
          type: INTERNAL.CONTENT_APPLY,
          payload: { kind: 'video', ...payload },
        }).catch(() => {});
      }
    }
  } catch (_) {}
}

function notifyAd(displayName) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'YouSync — pausado',
      message: `Anúncio em reprodução para ${displayName}. Todos pausados até terminar.`,
    });
  } catch (_) {}
}

// ---------- mensagens da UI (popup) e do content script ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload = {} } = message || {};
  if (type !== INTERNAL.GET_STATE && type !== INTERNAL.CONTENT_EVENT) log('<- ui/runtime', type, payload);

  switch (type) {
    case INTERNAL.GET_STATE:
      sendResponse(state);
      return false;

    case INTERNAL.ACTIVATE:
      state.active = true;
      if (payload.serverUrl) {
        state.serverUrl = payload.serverUrl;
        chrome.storage.local.set({ yousyncServerUrl: payload.serverUrl });
      }
      connect();
      pushState();
      sendResponse({ ok: true });
      return false;

    case INTERNAL.DEACTIVATE:
      wsSend(C2S.LEAVE_ROOM, {});
      state.active = false;
      state.room = null;
      state.isHost = false;
      state.adPause = null;
      state.pending = null;
      disconnect();
      sendToContent({ type: INTERNAL.CONTENT_SET_ROLE, payload: { role: 'idle' } });
      pushState();
      sendResponse({ ok: true });
      return false;

    case INTERNAL.CREATE_ROOM:
      state.lastError = null;
      wsSend(C2S.CREATE_ROOM, { name: payload.name, isPublic: payload.isPublic, displayName: payload.displayName });
      sendResponse({ ok: true });
      return false;

    case INTERNAL.JOIN_ROOM:
      state.lastError = null;
      wsSend(C2S.JOIN_ROOM, { roomCode: payload.roomCode, displayName: payload.displayName });
      sendResponse({ ok: true });
      return false;

    case INTERNAL.LIST_ROOMS:
      wsSend(C2S.LIST_ROOMS, {});
      sendResponse({ ok: true });
      return false;

    case INTERNAL.LEAVE_ROOM:
      wsSend(C2S.LEAVE_ROOM, {});
      state.room = null;
      state.isHost = false;
      state.adPause = null;
      state.pending = null;
      sendToContent({ type: INTERNAL.CONTENT_SET_ROLE, payload: { role: 'idle' } });
      pushState();
      sendResponse({ ok: true });
      return false;

    case INTERNAL.TRANSFER_HOST:
      wsSend(C2S.TRANSFER_HOST, { targetUserId: payload.targetUserId });
      sendResponse({ ok: true });
      return false;

    case INTERNAL.CONTENT_EVENT:
      handleContentEvent(payload);
      return false;
  }
});

// Eventos vindos do player (content script).
function handleContentEvent(payload) {
  log('<- content evento', payload.event, 'isHost=', state.isHost, payload);
  switch (payload.event) {
    case 'play':
    case 'pause':
    case 'seek':
    case 'rate':
      if (state.isHost) {
        wsSend(C2S.PLAYBACK_ACTION, {
          action: payload.event,
          time: payload.time,
          rate: payload.rate,
        });
      }
      return;
    case 'video':
      if (state.isHost) {
        wsSend(C2S.VIDEO_CHANGE, { videoId: payload.videoId, time: payload.time });
      }
      return;
    case 'ad_started':
      return wsSend(C2S.AD_STARTED, {});
    case 'ad_ended':
      return wsSend(C2S.AD_ENDED, {});
  }
}

// Quando uma aba do YouTube termina de carregar, reenvia o papel atual.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com') && state.room) {
    chrome.tabs.sendMessage(tabId, {
      type: INTERNAL.CONTENT_SET_ROLE,
      payload: { role: state.isHost ? 'host' : 'participant' },
    }).catch(() => {});
  }
});

restore().then(() => {
  if (state.active) connect();
});
