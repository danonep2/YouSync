import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomManager, newUserId } from './rooms.js';
import { handleMessage, leaveCurrentRoom, send } from './handlers.js';
import { S2C } from './protocol.js';
import { handleAdmin, attachAdminMonitor } from './admin.js';

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30_000;

const manager = new RoomManager();

const server = http.createServer((req, res) => {
  if (handleAdmin(req, res, manager, wss)) return;
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', rooms: manager.rooms.size }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('YouSync WebSocket server. Conecte via WS.');
});

const wss = new WebSocketServer({ server });
attachAdminMonitor(wss);

wss.on('connection', (ws) => {
  ws.userId = newUserId();
  ws.displayName = 'Anônimo';
  ws.roomCode = null;
  ws.isAlive = true;

  ws.on('message', (data) => {
    handleMessage(manager, ws, data.toString());
  });

  ws.on('close', () => {
    leaveCurrentRoom(manager, ws);
  });

  ws.on('error', () => {
    leaveCurrentRoom(manager, ws);
  });
});

// Heartbeat: derruba conexões que não respondem ao PING.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      leaveCurrentRoom(manager, ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    send(ws, S2C.PING, {});
  }
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[YouSync] Servidor ouvindo em http://localhost:${PORT} (WS no mesmo host/porta)`);
});
