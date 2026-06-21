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
  room: null, // { code, name, isPublic, sharedControls, hostId, users:[] }
  isHost: false,
  sharedControls: false,
  publicRooms: [],
  adPause: null, // { displayName } quando a sala está pausada por anúncio
  lastError: null,
  // Guardado para reconectar automaticamente
  pending: null, // { kind:'create'|'join', ...payload, displayName }
};

// Ação a aplicar no content APÓS a aba terminar de navegar para o novo vídeo.
let pendingApply = null; // { kind, payload, videoId }

// Posso controlar a reprodução? (host sempre; demais só com controles compartilhados)
function canControl() {
  return state.isHost || state.sharedControls;
}

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

// Injeta o content script numa aba que ainda não o possui (ex.: aba aberta
// antes de a extensão ser carregada). Requer a permissão "scripting".
async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/protocol.js', 'content.js'],
    });
    log('content injetado na aba', tabId);
    return true;
  } catch (e) {
    log('falha ao injetar content na aba', tabId, e?.message || e);
    return false;
  }
}

async function tabSend(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // content provavelmente não está presente: injeta e tenta de novo.
    const ok = await injectContent(tabId);
    if (!ok) return false;
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (e2) {
      log('content ainda não respondeu após injeção na aba', tabId, e2?.message || e2);
      return false;
    }
  }
}

async function sendToContent(message) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    if (!tabs.length) {
      log('sendToContent: nenhuma aba do YouTube encontrada para', message.type);
      return;
    }
    log('-> content', message.type, message.payload?.kind || message.payload?.role || '', `(${tabs.length} aba(s))`);
    for (const tab of tabs) tabSend(tab.id, message);
  } catch (e) {
    log('sendToContent erro', e);
  }
}

function updateContentRole() {
  if (!state.room) return;
  log('updateContentRole: isHost=', state.isHost, 'sharedControls=', state.sharedControls, '-> canControl=', canControl());
  sendToContent({
    type: INTERNAL.CONTENT_SET_ROLE,
    payload: { role: state.isHost ? 'host' : 'participant', canControl: canControl() },
  });
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
      state.sharedControls = !!payload.room.sharedControls;
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

    case S2C.ROOM_UPDATED:
      if (payload.room) {
        state.room = { ...state.room, ...payload.room };
        state.sharedControls = !!payload.room.sharedControls;
        state.isHost = state.you === payload.room.hostId;
      }
      updateContentRole();
      return pushState();

    case S2C.PLAYBACK_ACTION:
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'playback', ...payload } });
      return;

    case S2C.VIDEO_CHANGE:
      // Carregamento sincronizado: prepara o vídeo pausado em todos.
      applyVideoState('prepare', payload);
      return;

    case S2C.START_PLAYBACK:
      // Todos prontos: inicia simultaneamente.
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'start', ...payload } });
      return;

    case S2C.SYNC_STATE:
      applyVideoState('sync', payload);
      return;

    case S2C.AD_PAUSE: {
      // Eu sou o dono do anúncio? (decisão autoritativa, sem corrida de timing)
      const isOwner = payload.userId === state.you;
      state.adPause = { userId: payload.userId, displayName: payload.displayName, isOwner };
      sendToContent({ type: INTERNAL.CONTENT_APPLY, payload: { kind: 'ad_pause', isOwner } });
      if (!isOwner) notifyAd(payload.displayName);
      return pushState();
    }

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

// Garante que a aba esteja no vídeo certo e aplica a ação ('prepare' | 'sync').
// Se precisar navegar, guarda a ação em pendingApply para aplicar quando a aba
// terminar de carregar (ver chrome.tabs.onUpdated).
async function applyVideoState(kind, payload) {
  const videoId = payload.videoId || null;
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    if (!tabs.length) {
      log('applyVideoState: nenhuma aba do YouTube');
      // Sem aba ainda: guarda para quando uma aba do YouTube carregar.
      if (videoId) pendingApply = { kind, payload, videoId };
      return;
    }
    for (const tab of tabs) {
      let currentId = null;
      try { currentId = new URL(tab.url).searchParams.get('v'); } catch {}
      if (videoId && currentId !== videoId) {
        log('navegando aba', tab.id, '-> vídeo', videoId, `(aplicar '${kind}' após carregar)`);
        pendingApply = { kind, payload, videoId };
        chrome.tabs.update(tab.id, { url: `https://www.youtube.com/watch?v=${videoId}` });
      } else {
        tabSend(tab.id, { type: INTERNAL.CONTENT_APPLY, payload: { kind, ...payload } });
      }
    }
  } catch (e) {
    log('applyVideoState erro', e);
  }
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
      wsSend(C2S.CREATE_ROOM, {
        name: payload.name,
        isPublic: payload.isPublic,
        sharedControls: payload.sharedControls,
        displayName: payload.displayName,
      });
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

    case INTERNAL.SET_SHARED_CONTROLS:
      wsSend(C2S.SET_SHARED_CONTROLS, { enabled: payload.enabled });
      sendResponse({ ok: true });
      return false;

    case INTERNAL.CONTENT_EVENT:
      handleContentEvent(payload);
      return false;
  }
});

// Eventos vindos do player (content script).
function handleContentEvent(payload) {
  log('<- content evento', payload.event, 'canControl=', canControl(), payload);
  switch (payload.event) {
    case 'play':
    case 'pause':
    case 'seek':
    case 'rate':
      // Host sempre; demais só com controles compartilhados.
      if (canControl()) {
        wsSend(C2S.PLAYBACK_ACTION, {
          action: payload.event,
          time: payload.time,
          rate: payload.rate,
        });
      }
      return;
    case 'video':
      // Trocar o vídeo é exclusivo do host.
      if (state.isHost) {
        wsSend(C2S.VIDEO_CHANGE, { videoId: payload.videoId, time: payload.time });
      }
      return;
    case 'video_ready':
      return wsSend(C2S.VIDEO_READY, { videoId: payload.videoId });
    case 'ad_started':
      return wsSend(C2S.AD_STARTED, {});
    case 'ad_ended':
      return wsSend(C2S.AD_ENDED, {});
  }
}

// Quando uma aba do YouTube termina de carregar, reenvia o papel atual e,
// se havia uma ação pendente de troca de vídeo, aplica-a agora.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com') && state.room) {
    log('aba', tabId, 'carregou — reenviando papel');
    tabSend(tabId, {
      type: INTERNAL.CONTENT_SET_ROLE,
      payload: { role: state.isHost ? 'host' : 'participant', canControl: canControl() },
    });
    if (pendingApply) {
      let currentId = null;
      try { currentId = new URL(tab.url).searchParams.get('v'); } catch {}
      if (currentId === pendingApply.videoId) {
        const { kind, payload } = pendingApply;
        pendingApply = null;
        log('aplicando ação pendente', kind, 'na aba', tabId);
        tabSend(tabId, { type: INTERNAL.CONTENT_APPLY, payload: { kind, ...payload } });
      }
    }
  }
});

restore().then(() => {
  if (state.active) connect();
});
