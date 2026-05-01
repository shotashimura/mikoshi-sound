const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout:  15000,
});

// HTML は no-store にして即時反映。静的アセットは default キャッシュ。
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
//  曲同期: 壁時計ベース
// ============================================================
const SONG_COUNT       = 4;
const SONG_DURATION_MS = 210000;   // 3:30/曲

const computeSongIdx     = () => Math.floor(Date.now() / SONG_DURATION_MS) % SONG_COUNT;
const computeSongStartTs = () => Math.floor(Date.now() / SONG_DURATION_MS) * SONG_DURATION_MS;

let _lastSongIdx = computeSongIdx();
console.log(`[song] start at ${_lastSongIdx}`);

setInterval(() => {
  const idx = computeSongIdx();
  if (idx !== _lastSongIdx) {
    _lastSongIdx = idx;
    io.emit('song_change', {
      songIdx:   idx,
      startedAt: computeSongStartTs(),
      serverNow: Date.now(),
    });
    console.log(`[song] -> ${idx}`);
  }
}, 250);

// ============================================================
//  接続管理 + voiceIndex 採番
//  ロール割当はクライアント側でラウンドロビンする（人数変動でも全員が
//  同じ計算をして同じ役を導く）。サーバーは「誰が居るか」を伝えるだけ。
// ============================================================
const clients = new Map();   // socketId -> { voiceIndex }
let _voiceCounter = 0;

const clientsPayload = () => Array.from(clients.entries())
  .map(([id, c]) => ({ id, voiceIndex: c.voiceIndex }))
  .sort((a, b) => a.voiceIndex - b.voiceIndex);

const broadcastClients = () => {
  io.emit('clients_update', { clients: clientsPayload(), serverNow: Date.now() });
};

io.on('connection', (socket) => {
  const voiceIndex = _voiceCounter++;
  clients.set(socket.id, { voiceIndex });
  console.log(`[+] ${socket.id} vi=${voiceIndex} (count=${clients.size})`);

  socket.emit('me', { id: socket.id, voiceIndex });
  socket.emit('song_change', {
    songIdx:   computeSongIdx(),
    startedAt: computeSongStartTs(),
    serverNow: Date.now(),
  });
  broadcastClients();

  // Christian's algorithm 用の即時 ack
  socket.on('time_sync', (_clientT0, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('disconnect', () => {
    clients.delete(socket.id);
    broadcastClients();
    console.log(`[-] ${socket.id} (count=${clients.size})`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏮 http://localhost:${PORT}`));
