import { randomUUID } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem caracteres ambíguos
const CODE_LENGTH = 6;

/**
 * Gerencia salas em memória. Cada sala mantém seus usuários, o host atual,
 * o estado de reprodução e o conjunto de usuários atualmente em anúncio.
 */
export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} code -> Room */
    this.rooms = new Map();
  }

  generateCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  createRoom({ name, isPublic, sharedControls, hostId, displayName, ws }) {
    const code = this.generateCode();
    const room = {
      code,
      name: name || `Sala ${code}`,
      isPublic: Boolean(isPublic),
      sharedControls: Boolean(sharedControls),
      hostId,
      users: new Map(), // userId -> { ws, displayName }
      adUsers: new Set(), // userIds atualmente em anúncio
      adResumeTime: null, // posição do vídeo quando o anúncio começou (onde os demais pausaram)
      // Carregamento sincronizado de vídeo: enquanto loadingVideoId != null,
      // todos esperam todos reportarem "pronto" antes do play.
      loadingVideoId: null,
      readyUsers: new Set(),
      loadTimer: null,
      state: {
        videoId: null,
        time: 0,
        paused: true,
        rate: 1,
        updatedAt: Date.now(),
      },
    };
    room.users.set(hostId, { ws, displayName });
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  joinRoom({ code, userId, displayName, ws }) {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.users.set(userId, { ws, displayName });
    return room;
  }

  /**
   * Remove o usuário da sala em que estiver. Retorna informações sobre os
   * efeitos colaterais para que o chamador possa notificar os demais.
   * @returns {null | { room, removed, hostChanged, roomClosed, adResumed }}
   */
  removeUser(room, userId) {
    if (!room || !room.users.has(userId)) return null;
    const removed = room.users.get(userId);
    room.users.delete(userId);

    // Se estava em anúncio, libera; verifica se a sala pode retomar.
    const wasInAd = room.adUsers.delete(userId);
    const adResumed = wasInAd && room.adUsers.size === 0 && room.users.size > 0;

    if (room.users.size === 0) {
      this.rooms.delete(room.code);
      return { room, removed, hostChanged: false, roomClosed: true, adResumed: false };
    }

    let hostChanged = false;
    if (room.hostId === userId) {
      // Promove o próximo usuário (primeiro do Map de inserção).
      const [nextId] = room.users.keys();
      room.hostId = nextId;
      hostChanged = true;
    }

    return { room, removed, hostChanged, roomClosed: false, adResumed };
  }

  listPublic() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.isPublic) {
        list.push({ code: room.code, name: room.name, userCount: room.users.size });
      }
    }
    return list;
  }

  transferHost(room, fromId, targetId) {
    if (room.hostId !== fromId) return false;
    if (!room.users.has(targetId)) return false;
    room.hostId = targetId;
    return true;
  }

  updateState(room, patch) {
    Object.assign(room.state, patch, { updatedAt: Date.now() });
  }

  setSharedControls(room, enabled) {
    room.sharedControls = Boolean(enabled);
  }

  // ----- carregamento sincronizado de vídeo -----

  beginVideoLoad(room, videoId) {
    room.loadingVideoId = videoId;
    room.readyUsers = new Set();
  }

  /** Marca um usuário como pronto. @returns true se todos já estão prontos. */
  markReady(room, userId, videoId) {
    if (room.loadingVideoId == null || videoId !== room.loadingVideoId) return false;
    room.readyUsers.add(userId);
    return this.allReady(room);
  }

  allReady(room) {
    if (room.loadingVideoId == null) return false;
    for (const userId of room.users.keys()) {
      if (!room.readyUsers.has(userId)) return false;
    }
    return room.users.size > 0;
  }

  endVideoLoad(room) {
    room.loadingVideoId = null;
    room.readyUsers = new Set();
    if (room.loadTimer) {
      clearTimeout(room.loadTimer);
      room.loadTimer = null;
    }
  }

  /** Registra início de anúncio. @returns true se a sala deve pausar agora. */
  markAdStarted(room, userId) {
    const wasEmpty = room.adUsers.size === 0;
    room.adUsers.add(userId);
    return wasEmpty;
  }

  /** Registra fim de anúncio. @returns true se a sala deve retomar agora. */
  markAdEnded(room, userId) {
    const existed = room.adUsers.delete(userId);
    return existed && room.adUsers.size === 0;
  }
}

export function newUserId() {
  return randomUUID();
}
