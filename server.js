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
//  Date.now() / SONG_DURATION_MS で全クライアントが同じ曲を独立計算できる
//  ようにし、加えてサーバーから push でも揃える。
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
//  接続管理: ロール無し。接続/切断のたびに人数を全員へ即配信。
// ============================================================
let connectedCount = 0;

const broadcastCount = () => {
  io.emit('world_state', { connectedCount, serverNow: Date.now() });
};

io.on('connection', (socket) => {
  connectedCount++;
  console.log(`[+] ${socket.id} (count=${connectedCount})`);

  // 接続直後: 現在の曲と人数を即送信(mid-song でもすぐ揃う)
  socket.emit('song_change', {
    songIdx:   computeSongIdx(),
    startedAt: computeSongStartTs(),
    serverNow: Date.now(),
  });
  broadcastCount();

  // 時刻同期 RPC: クライアントが Christian's algorithm で server オフセットを推定
  socket.on('time_sync', (_clientT0, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('disconnect', () => {
    connectedCount = Math.max(0, connectedCount - 1);
    broadcastCount();
    console.log(`[-] ${socket.id} (count=${connectedCount})`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏮 http://localhost:${PORT}`));
