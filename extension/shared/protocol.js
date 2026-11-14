// Tipos de mensagem trocados com o servidor. Mantenha em sincronia com
// server/src/protocol.js. Definido como global para funcionar em service
// worker (importScripts), content script e popup (via <script>).
(function (root) {
  const PROTOCOL = {
    // Cliente -> Servidor
    C2S: {
      CREATE_ROOM: 'CREATE_ROOM',
      JOIN_ROOM: 'JOIN_ROOM',
      LIST_ROOMS: 'LIST_ROOMS',
      LEAVE_ROOM: 'LEAVE_ROOM',
      PLAYBACK_ACTION: 'PLAYBACK_ACTION',
      VIDEO_CHANGE: 'VIDEO_CHANGE',
      VIDEO_READY: 'VIDEO_READY',
      TRANSFER_HOST: 'TRANSFER_HOST',
      SET_SHARED_CONTROLS: 'SET_SHARED_CONTROLS',
      AD_STARTED: 'AD_STARTED',
      AD_ENDED: 'AD_ENDED',
      SYNC_REQUEST: 'SYNC_REQUEST',
      HOST_STATE: 'HOST_STATE',
      PONG: 'PONG',
    },
    // Servidor -> Cliente
    S2C: {
      ROOM_CREATED: 'ROOM_CREATED',
      ROOM_JOINED: 'ROOM_JOINED',
      ROOM_LIST: 'ROOM_LIST',
      USER_JOINED: 'USER_JOINED',
      USER_LEFT: 'USER_LEFT',
      HOST_CHANGED: 'HOST_CHANGED',
      ROOM_UPDATED: 'ROOM_UPDATED',
      PLAYBACK_ACTION: 'PLAYBACK_ACTION',
      VIDEO_CHANGE: 'VIDEO_CHANGE',
      START_PLAYBACK: 'START_PLAYBACK',
      AD_PAUSE: 'AD_PAUSE',
      AD_RESUME: 'AD_RESUME',
      SYNC_STATE: 'SYNC_STATE',
      ERROR: 'ERROR',
      PING: 'PING',
    },
    // Mensagens internas entre popup/background/content
    INTERNAL: {
      // popup <-> background
      GET_STATE: 'GET_STATE',
      STATE_UPDATE: 'STATE_UPDATE',
      ACTIVATE: 'ACTIVATE',
      DEACTIVATE: 'DEACTIVATE',
      CREATE_ROOM: 'UI_CREATE_ROOM',
      JOIN_ROOM: 'UI_JOIN_ROOM',
      LIST_ROOMS: 'UI_LIST_ROOMS',
      LEAVE_ROOM: 'UI_LEAVE_ROOM',
      TRANSFER_HOST: 'UI_TRANSFER_HOST',
      SET_SHARED_CONTROLS: 'UI_SET_SHARED_CONTROLS',
      FOCUS_TAB: 'UI_FOCUS_TAB', // foca a aba controlada
      // background <-> content
      CONTENT_SET_ROLE: 'CONTENT_SET_ROLE', // {role:'host'|'participant'}
      CONTENT_APPLY: 'CONTENT_APPLY', // aplica ação remota no player
      CONTENT_EVENT: 'CONTENT_EVENT', // evento local do player -> background
    },
  };

  root.YOUSYNC_PROTOCOL = PROTOCOL;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PROTOCOL;
  }
})(typeof self !== 'undefined' ? self : this);
