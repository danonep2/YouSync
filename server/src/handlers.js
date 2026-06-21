import { C2S, S2C, ERROR_CODES } from './protocol.js';

export function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function sendError(ws, code, message) {
  send(ws, S2C.ERROR, { code, message });
}

// Envia para todos da sala, opcionalmente pulando um userId.
function broadcast(room, type, payload, exceptUserId = null) {
  for (const [userId, user] of room.users) {
    if (userId === exceptUserId) continue;
    send(user.ws, type, payload);
  }
}

function userListOf(room) {
  return [...room.users.entries()].map(([id, u]) => ({
    userId: id,
    displayName: u.displayName,
    isHost: id === room.hostId,
  }));
}

function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    isPublic: room.isPublic,
    sharedControls: room.sharedControls,
    hostId: room.hostId,
    users: userListOf(room),
  };
}

const LOAD_TIMEOUT_MS = 12_000;

// Inicia a reprodução para todos simultaneamente (fim do carregamento sincronizado).
function startPlayback(manager, room) {
  manager.endVideoLoad(room);
  manager.updateState(room, { paused: false });
  broadcast(room, S2C.START_PLAYBACK, { time: room.state.time, serverTime: Date.now() });
}

function syncStatePayload(room) {
  return {
    videoId: room.state.videoId,
    time: room.state.time,
    paused: room.state.paused,
    rate: room.state.rate,
    serverTime: Date.now(),
  };
}

// Sai da sala atual (se houver) e notifica os demais.
export function leaveCurrentRoom(manager, ws) {
  if (!ws.roomCode) return;
  const room = manager.getRoom(ws.roomCode);
  ws.roomCode = null;
  if (!room) return;

  const result = manager.removeUser(room, ws.userId);
  if (!result || result.roomClosed) return;

  broadcast(room, S2C.USER_LEFT, {
    userId: ws.userId,
    users: userListOf(room),
  });

  if (result.hostChanged) {
    broadcast(room, S2C.HOST_CHANGED, { hostUserId: room.hostId });
  }

  // Saída de quem estava em anúncio pode liberar a sala.
  if (result.adResumed) {
    broadcast(room, S2C.AD_RESUME, {});
    broadcast(room, S2C.SYNC_STATE, syncStatePayload(room));
  }

  // Se faltava só ele para o carregamento sincronizado, inicia agora.
  if (room.loadingVideoId != null && manager.allReady(room)) {
    startPlayback(manager, room);
  }
}

export function handleMessage(manager, ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(ws, ERROR_CODES.BAD_REQUEST, 'JSON inválido');
  }
  const { type, payload = {} } = msg || {};
  const room = ws.roomCode ? manager.getRoom(ws.roomCode) : null;
  const isHost = room && room.hostId === ws.userId;

  switch (type) {
    case C2S.PONG:
      ws.isAlive = true;
      return;

    case C2S.CREATE_ROOM: {
      leaveCurrentRoom(manager, ws);
      ws.displayName = payload.displayName || 'Anônimo';
      const created = manager.createRoom({
        name: payload.name,
        isPublic: payload.isPublic,
        sharedControls: payload.sharedControls,
        hostId: ws.userId,
        displayName: ws.displayName,
        ws,
      });
      ws.roomCode = created.code;
      return send(ws, S2C.ROOM_CREATED, {
        room: roomSummary(created),
        you: ws.userId,
        isHost: true,
      });
    }

    case C2S.JOIN_ROOM: {
      const target = manager.getRoom(payload.roomCode);
      if (!target) return sendError(ws, ERROR_CODES.ROOM_NOT_FOUND, 'Sala não encontrada');
      leaveCurrentRoom(manager, ws);
      ws.displayName = payload.displayName || 'Anônimo';
      manager.joinRoom({ code: target.code, userId: ws.userId, displayName: ws.displayName, ws });
      ws.roomCode = target.code;

      send(ws, S2C.ROOM_JOINED, {
        room: roomSummary(target),
        you: ws.userId,
        isHost: target.hostId === ws.userId,
      });
      // Se a sala está pausada por anúncio, informa antes do SYNC_STATE para
      // que o recém-chegado não tente reproduzir por um instante.
      if (target.adUsers.size > 0) {
        const adId = [...target.adUsers][0];
        const adUser = target.users.get(adId);
        send(ws, S2C.AD_PAUSE, { userId: adId, displayName: adUser?.displayName || '—' });
      }
      // Estado atual para o recém-chegado se alinhar.
      send(ws, S2C.SYNC_STATE, syncStatePayload(target));
      // Se há um carregamento sincronizado em andamento, inclui o recém-chegado.
      if (target.loadingVideoId != null) {
        send(ws, S2C.VIDEO_CHANGE, { videoId: target.loadingVideoId, time: target.state.time, startPaused: true });
      }
      return broadcast(target, S2C.USER_JOINED, {
        user: { userId: ws.userId, displayName: ws.displayName, isHost: false },
        users: userListOf(target),
      }, ws.userId);
    }

    case C2S.LIST_ROOMS:
      return send(ws, S2C.ROOM_LIST, { rooms: manager.listPublic() });

    case C2S.LEAVE_ROOM:
      return leaveCurrentRoom(manager, ws);

    case C2S.PLAYBACK_ACTION: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      // Host sempre controla; com controles compartilhados, qualquer um controla.
      if (!isHost && !room.sharedControls) {
        return sendError(ws, ERROR_CODES.NOT_HOST, 'Apenas o host controla a reprodução');
      }
      // Durante o carregamento sincronizado, ignora ações até o play coletivo.
      if (room.loadingVideoId != null) return;
      manager.updateState(room, {
        time: typeof payload.time === 'number' ? payload.time : room.state.time,
        paused: payload.action === 'pause' ? true : payload.action === 'play' ? false : room.state.paused,
        rate: typeof payload.rate === 'number' ? payload.rate : room.state.rate,
      });
      return broadcast(room, S2C.PLAYBACK_ACTION, { ...payload, serverTime: Date.now() }, ws.userId);
    }

    case C2S.VIDEO_CHANGE: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      // Trocar o vídeo é sempre exclusivo do host (mesmo com controles compartilhados).
      if (!isHost) return sendError(ws, ERROR_CODES.NOT_HOST, 'Apenas o host troca o vídeo');
      manager.updateState(room, {
        videoId: payload.videoId,
        time: typeof payload.time === 'number' ? payload.time : 0,
        paused: true,
      });
      // Inicia o carregamento sincronizado: todos pausados até todos ficarem prontos.
      manager.beginVideoLoad(room, payload.videoId);
      if (room.loadTimer) clearTimeout(room.loadTimer);
      room.loadTimer = setTimeout(() => startPlayback(manager, room), LOAD_TIMEOUT_MS);
      // Envia a TODOS (inclusive o host) o comando de carregar pausado.
      return broadcast(room, S2C.VIDEO_CHANGE, { videoId: payload.videoId, time: room.state.time, startPaused: true });
    }

    case C2S.VIDEO_READY: {
      if (!room) return;
      const all = manager.markReady(room, ws.userId, payload.videoId);
      if (all) startPlayback(manager, room);
      return;
    }

    case C2S.SET_SHARED_CONTROLS: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      if (!isHost) return sendError(ws, ERROR_CODES.NOT_HOST, 'Apenas o host altera os controles');
      manager.setSharedControls(room, payload.enabled);
      return broadcast(room, S2C.ROOM_UPDATED, { room: roomSummary(room) });
    }

    case C2S.TRANSFER_HOST: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      if (!isHost) return sendError(ws, ERROR_CODES.NOT_HOST, 'Apenas o host pode transferir');
      const ok = manager.transferHost(room, ws.userId, payload.targetUserId);
      if (!ok) return sendError(ws, ERROR_CODES.TARGET_NOT_FOUND, 'Usuário alvo não encontrado');
      return broadcast(room, S2C.HOST_CHANGED, { hostUserId: room.hostId });
    }

    case C2S.SYNC_REQUEST: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      return send(ws, S2C.SYNC_STATE, syncStatePayload(room));
    }

    case C2S.AD_STARTED: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      const shouldPause = manager.markAdStarted(room, ws.userId);
      if (shouldPause) {
        // NÃO marcamos paused no estado da sala: a pausa por anúncio é apenas
        // temporária e imposta no cliente. Assim, ao retomar, o SYNC_STATE
        // reflete o estado real (tocando) e todos voltam a reproduzir.
        const me = room.users.get(ws.userId);
        broadcast(room, S2C.AD_PAUSE, {
          userId: ws.userId,
          displayName: me?.displayName || ws.displayName || '—',
        });
      }
      return;
    }

    case C2S.AD_ENDED: {
      if (!room) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Você não está em uma sala');
      const shouldResume = manager.markAdEnded(room, ws.userId);
      if (shouldResume) {
        broadcast(room, S2C.AD_RESUME, {});
        broadcast(room, S2C.SYNC_STATE, syncStatePayload(room));
      }
      return;
    }

    default:
      return sendError(ws, ERROR_CODES.BAD_REQUEST, `Tipo desconhecido: ${type}`);
  }
}
