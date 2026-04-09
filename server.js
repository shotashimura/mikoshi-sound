const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const QRCode  = require('qrcode');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout:  15000,
});

// SharedArrayBuffer を使うには Cross-Origin Isolation が必要
// COOP + COEP ヘッダーをすべてのレスポンスに付与する
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/',         (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mikoshi',  (_, res) => res.sendFile(path.join(__dirname, 'public', 'mikoshi.html')));
app.get('/audience', (_, res) => res.sendFile(path.join(__dirname, 'public', 'audience.html')));

app.get('/api/qr', async (req, res) => {
  const base = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
  try {
    const qr = await QRCode.toDataURL(base + '/audience', {
      color: { dark: '#1a0a2e', light: '#ffffff00' }, width: 256,
    });
    res.json({ audienceUrl: base + '/audience', mikoshiUrl: base + '/mikoshi', audienceQR: qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  状態管理
// ============================================================
const state = {
  mikoshiDevices: new Map(),  // socketId → センサーデータ
  audienceDevices: new Set(),
  voiceIndex: 0,
};

function computeWorldState() {
  const devices = Array.from(state.mikoshiDevices.values());
  const n = devices.length;
  if (n === 0) {
    return { mikoshiCount: 0, audienceCount: state.audienceDevices.size,
             avgBrightness: 0.5, avgWhiteRatio: 0.3, avgColorTemp: 0.5,
             totalMovement: 0, maxMic: 0, devices: [] };
  }
  const avg = (k) => devices.reduce((s, d) => s + (d[k] ?? 0), 0) / n;
  const max = (k) => Math.max(...devices.map((d) => d[k] ?? 0));
  return {
    mikoshiCount:  n,
    audienceCount: state.audienceDevices.size,
    avgBrightness: avg('brightness'),
    avgWhiteRatio: avg('whiteRatio'),
    avgColorTemp:  avg('colorTemp'),
    totalMovement: devices.reduce((s, d) => s + (d.accMagnitude ?? 0), 0),
    maxMic:        max('micLevel'),
    devices: devices.map((d) => ({
      id: d.id, voiceIndex: d.voiceIndex,
      brightness: d.brightness, accMagnitude: d.accMagnitude,
      micLevel: d.micLevel, colorTemp: d.colorTemp,
    })),
  };
}

let broadcastPending = false;
function scheduleBroadcast() {
  if (broadcastPending) return;
  broadcastPending = true;
  setTimeout(() => { broadcastPending = false; io.emit('world_state', computeWorldState()); }, 100);
}

// ============================================================
//  WebSocket
// ============================================================
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── 担ぎ手参加 ──────────────────────────────────────────
  socket.on('join_mikoshi', () => {
    socket.role = 'mikoshi';
    const vi = state.voiceIndex++ % 8;
    state.mikoshiDevices.set(socket.id, {
      id: socket.id, voiceIndex: vi,
      brightness: 0.5, whiteRatio: 0.3, colorTemp: 0.5,
      accMagnitude: 0, accX: 0, accY: 0, micLevel: 0,
    });
    socket.join('mikoshi');
    socket.emit('joined_mikoshi', { voiceIndex: vi });
    scheduleBroadcast();

    // 既にいる観客に「担ぎ手が来た」と通知（WebRTC offer を促す）
    socket.to('audience').emit('broadcaster_arrived', { broadcasterId: socket.id, voiceIndex: vi });
    console.log(`[mikoshi] ${socket.id} vi=${vi}`);
  });

  // ── 観客参加（ページロード直後に呼ばれる） ──────────────
  socket.on('join_audience', () => {
    socket.role = 'audience';
    socket.join('audience');
    state.audienceDevices.add(socket.id);
    socket.emit('joined_audience', { audienceCount: state.audienceDevices.size });
    scheduleBroadcast();

    // 既に接続中の担ぎ手全員を通知
    for (const [mid, mdata] of state.mikoshiDevices) {
      socket.emit('broadcaster_arrived', { broadcasterId: mid, voiceIndex: mdata.voiceIndex });
    }
    console.log(`[audience] ${socket.id}`);
  });

  // ── センサーデータ ─────────────────────────────────────
  socket.on('sensor_data', (data) => {
    if (socket.role !== 'mikoshi') return;
    const prev = state.mikoshiDevices.get(socket.id);
    if (!prev) return;
    state.mikoshiDevices.set(socket.id, {
      ...prev,
      brightness:   clamp(data.brightness   ?? prev.brightness,   0, 1),
      whiteRatio:   clamp(data.whiteRatio   ?? prev.whiteRatio,   0, 1),
      colorTemp:    clamp(data.colorTemp    ?? prev.colorTemp,    0, 1),
      accMagnitude: clamp(data.accMagnitude ?? prev.accMagnitude, 0, 20),
      accX: data.accX ?? prev.accX,
      accY: data.accY ?? prev.accY,
      micLevel: clamp(data.micLevel ?? prev.micLevel, 0, 1),
    });
    scheduleBroadcast();
  });

  // ──────────────────────────────────────────────────────────
  //  WebRTC シグナリング中継
  //  担ぎ手(broadcaster) ←→ 観客(viewer) の SDP/ICE を転送するだけ
  // ──────────────────────────────────────────────────────────

  // 観客→担ぎ手: 「見たい」リクエスト
  socket.on('viewer_request', ({ broadcasterId }) => {
    io.to(broadcasterId).emit('viewer_request', { viewerId: socket.id });
  });

  // 担ぎ手→観客: SDP offer
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  // 観客→担ぎ手: SDP answer
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  // 双方向: ICE candidate
  socket.on('ice', ({ to, ice }) => {
    io.to(to).emit('ice', { from: socket.id, ice });
  });

  // ── 切断 ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.role === 'mikoshi') {
      state.mikoshiDevices.delete(socket.id);
      io.to('audience').emit('broadcaster_left', { broadcasterId: socket.id });
    } else if (socket.role === 'audience') {
      state.audienceDevices.delete(socket.id);
    }
    scheduleBroadcast();
    console.log(`[-] ${socket.id} (${socket.role})`);
  });
});

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v) || 0)); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🏮 http://localhost:${PORT}`));
