import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Dashboard de administração: GET /admin (página) e GET /admin/api/stats (JSON).
// Protegido pelo token em ADMIN_TOKEN. Sem token configurado, o painel fica desativado.

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PAGE = readFileSync(new URL('./admin.html', import.meta.url), 'utf-8');

// ----- monitoramento de consumo do processo -----

const SAMPLE_INTERVAL = 5_000;
const HISTORY_SIZE = 120; // 10 minutos de histórico
const cpuCount = os.availableParallelism?.() || os.cpus().length || 1;
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

/** @type {Array<{t:number,cpu:number,rss:number,heapUsed:number,loopP99:number,clients:number}>} */
const history = [];
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let wssRef = null;

function sampleProcess() {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage(lastCpu);
  const elapsedUs = Number(now - lastCpuAt) / 1000;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;

  const mem = process.memoryUsage();
  const sample = {
    t: Date.now(),
    // % de um núcleo (pode passar de 100 se usar threads de libuv)
    cpu: elapsedUs > 0 ? ((cpu.user + cpu.system) / elapsedUs) * 100 : 0,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    loopP99: loopDelay.percentile(99) / 1e6, // ms
    clients: wssRef ? wssRef.clients.size : 0,
  };
  loopDelay.reset();
  history.push(sample);
  if (history.length > HISTORY_SIZE) history.shift();
}

const sampler = setInterval(sampleProcess, SAMPLE_INTERVAL);
sampler.unref();

function processStats() {
  const mem = process.memoryUsage();
  const last = history[history.length - 1];
  return {
    pid: process.pid,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    uptimeSec: Math.round(process.uptime()),
    cpuCount,
    cpuPercent: last ? last.cpu : 0,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      systemTotal: os.totalmem(),
      systemFree: os.freemem(),
    },
    eventLoopP99Ms: last ? last.loopP99 : 0,
    loadAvg: os.loadavg(), // sempre [0,0,0] no Windows
    sampleIntervalMs: SAMPLE_INTERVAL,
    history,
  };
}

function tokenMatches(provided) {
  if (!ADMIN_TOKEN || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Posição atual estimada do vídeo, considerando o tempo desde a última atualização. */
function currentTime(state) {
  if (state.paused) return state.time;
  return state.time + ((Date.now() - state.updatedAt) / 1000) * (state.rate || 1);
}

/**
 * Monta as estatísticas. Salas privadas expõem apenas contagens e metadados
 * não identificáveis — nunca o vídeo nem quem está presente.
 */
export function buildStats(manager, wss) {
  let clientsInRooms = 0;
  let publicRooms = 0;
  let privateRooms = 0;
  const rooms = [];

  for (const room of manager.rooms.values()) {
    clientsInRooms += room.users.size;
    const base = {
      isPublic: room.isPublic,
      userCount: room.users.size,
      createdAt: room.createdAt,
      sharedControls: room.sharedControls,
    };

    if (!room.isPublic) {
      privateRooms++;
      rooms.push(base);
      continue;
    }

    publicRooms++;
    rooms.push({
      ...base,
      code: room.code,
      name: room.name,
      video: room.state.videoId
        ? {
            videoId: room.state.videoId,
            paused: room.state.paused,
            time: Math.max(0, Math.round(currentTime(room.state))),
          }
        : null,
      inAd: room.adUsers.size > 0,
      users: [...room.users].map(([userId, u]) => ({
        displayName: u.displayName,
        isHost: userId === room.hostId,
      })),
    });
  }

  rooms.sort((a, b) => b.userCount - a.userCount || b.createdAt - a.createdAt);

  return {
    generatedAt: Date.now(),
    serverStartedAt: manager.startedAt,
    totals: {
      connectedClients: wss.clients.size,
      clientsInRooms,
      clientsIdle: Math.max(0, wss.clients.size - clientsInRooms),
      openRooms: manager.rooms.size,
      publicRooms,
      privateRooms,
      roomsCreatedSinceStart: manager.totalCreated,
    },
    rooms,
    process: processStats(),
  };
}

/** Trata rotas /admin. @returns true se a requisição foi atendida. */
/** Liga o monitor ao WebSocketServer para registrar clientes no histórico. */
export function attachAdminMonitor(wss) {
  wssRef = wss;
  sampleProcess();
}

export function handleAdmin(req, res, manager, wss) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;

  if (!ADMIN_TOKEN) {
    json(res, 503, { error: 'Painel admin desativado: defina ADMIN_TOKEN no servidor.' });
    return true;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(PAGE);
    return true;
  }

  if (url.pathname === '/admin/api/stats') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(token)) {
      json(res, 401, { error: 'Token inválido.' });
      return true;
    }
    json(res, 200, buildStats(manager, wss));
    return true;
  }

  json(res, 404, { error: 'Não encontrado.' });
  return true;
}
