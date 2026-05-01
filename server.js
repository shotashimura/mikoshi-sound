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

// ============================================================
//  揺れ集約 (チャリ振動センサー)
//  - motion_data: クライアントがローパス済みエネルギー (0..1) を ~5Hz 送信
//  - motion_peak: 鋭いジョルト (段差等) を即時送信
//  サーバーは 1.5 秒以上更新が無いクライアントを除外して平均を取り
//  250ms 周期で world_motion をブロードキャスト。
// ============================================================
const motionState = new Map();   // socketId -> { magnitude, lastUpdate }
const STALE_MOTION_MS = 1500;

const broadcastMotion = () => {
  const now = Date.now();
  let sum = 0, peak = 0, count = 0;
  for (const [id, m] of motionState) {
    if (now - m.lastUpdate < STALE_MOTION_MS) {
      sum += m.magnitude;
      if (m.magnitude > peak) peak = m.magnitude;
      count++;
    }
  }
  const avg = count > 0 ? sum / count : 0;
  io.emit('world_motion', {
    worldEnergy: avg,
    peakEnergy:  peak,
    contributors: count,
    serverNow: now,
  });
};
setInterval(broadcastMotion, 250);

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

  // 連続揺れエネルギー
  socket.on('motion_data', (data) => {
    const mag = Math.max(0, Math.min(1, +(data && data.magnitude) || 0));
    motionState.set(socket.id, { magnitude: mag, lastUpdate: Date.now() });
  });

  // ピーク (送信元以外へ即時ブロードキャスト。送信元はローカルで先に
  // 鳴らしているのでループバックさせない)
  socket.on('motion_peak', (data) => {
    const c = clients.get(socket.id);
    if (!c) return;
    const mag = Math.max(0, Math.min(1, +(data && data.magnitude) || 0));
    socket.broadcast.emit('motion_peak', {
      voiceIndex: c.voiceIndex,
      magnitude:  mag,
      serverNow:  Date.now(),
    });
  });

  socket.on('disconnect', () => {
    clients.delete(socket.id);
    motionState.delete(socket.id);
    broadcastClients();
    console.log(`[-] ${socket.id} (count=${clients.size})`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏮 http://localhost:${PORT}`));
