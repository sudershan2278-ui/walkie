// Walkie channel server.
//
// Serves the app and relays push-to-talk audio between phones on the same channel.
// The server never sees channel passcodes or audio: phones derive the room id and
// the AES-GCM key from (channel, passcode) and only send the room id and ciphertext.
//
// Like a real radio, only one person can talk on a channel at a time.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Comma-separated list of allowed page origins, e.g. "https://walkie.example.com".
// Empty means any origin (fine for local testing, set it in production).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const MAX_FRAME_BYTES = 2048;        // one 20 ms audio frame is ~360 bytes
const MAX_ROOM_MEMBERS = 64;
const MAX_TX_MS = 60_000;            // talk timeout, like a radio's TOT
const MAX_MSGS_PER_SEC = 120;        // 50 audio frames/s plus control messages
const HEARTBEAT_MS = 15_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; " +
    "style-src 'self'; script-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_FRAME_BYTES,
  perMessageDeflate: false, // compression adds delay and audio doesn't compress
  verifyClient: ({ origin }) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin),
});

/** roomId -> { members: Set<ws>, talker: ws|null, txTimer } */
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const m of room.members) if (m !== except && m.readyState === m.OPEN) m.send(data);
}

function releaseFloor(room, reason) {
  if (!room.talker) return;
  const who = room.talker;
  clearTimeout(room.txTimer);
  room.talker = null;
  room.txTimer = null;
  broadcast(room, { t: 'rx-end', id: who.id, reason }, who);
  if (reason === 'timeout') send(who, { t: 'tx-timeout' });
}

function leave(ws) {
  const room = ws.room && rooms.get(ws.room);
  if (!room) return;
  if (room.talker === ws) releaseFloor(room, 'left');
  room.members.delete(ws);
  broadcast(room, { t: 'count', n: room.members.size });
  if (!room.members.size) rooms.delete(ws.room);
  ws.room = null;
}

let nextId = 1;

wss.on('connection', ws => {
  ws.id = nextId++;
  ws.room = null;
  ws.alive = true;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - ws.msgWindow > 1000) { ws.msgWindow = now; ws.msgCount = 0; }
    if (++ws.msgCount > MAX_MSGS_PER_SEC) return; // drop floods silently

    const room = ws.room && rooms.get(ws.room);

    if (isBinary) {
      // Encrypted audio: forward only from the current talker, untouched.
      if (!room || room.talker !== ws) return;
      for (const m of room.members) {
        if (m !== ws && m.readyState === m.OPEN && m.bufferedAmount < 64 * 1024) {
          m.send(data, { binary: true });
        }
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'join': {
        if (typeof msg.room !== 'string' || !/^[0-9a-f]{64}$/.test(msg.room)) {
          send(ws, { t: 'error', error: 'bad-room' });
          return;
        }
        leave(ws);
        let r = rooms.get(msg.room);
        if (!r) { r = { members: new Set(), talker: null, txTimer: null }; rooms.set(msg.room, r); }
        if (r.members.size >= MAX_ROOM_MEMBERS) { send(ws, { t: 'error', error: 'room-full' }); return; }
        r.members.add(ws);
        ws.room = msg.room;
        send(ws, { t: 'joined', id: ws.id, n: r.members.size, busy: !!r.talker });
        broadcast(r, { t: 'count', n: r.members.size }, ws);
        return;
      }
      case 'tx-start': {
        if (!room) return;
        if (room.talker && room.talker !== ws) { send(ws, { t: 'tx-denied' }); return; }
        room.talker = ws;
        clearTimeout(room.txTimer);
        room.txTimer = setTimeout(() => releaseFloor(room, 'timeout'), MAX_TX_MS);
        send(ws, { t: 'tx-granted' });
        broadcast(room, { t: 'rx-start', id: ws.id }, ws);
        return;
      }
      case 'tx-end': {
        if (room && room.talker === ws) releaseFloor(room, 'done');
        return;
      }
      case 'ping': {
        send(ws, { t: 'pong', ts: msg.ts });
        return;
      }
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Walkie server on http://localhost:${PORT}`);
});

module.exports = { server };
