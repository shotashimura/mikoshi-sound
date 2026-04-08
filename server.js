const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 10000,
  maxHttpBufferSize: 1e7, // 10MB（ビデオフレーム送受信用）
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mikoshi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mikoshi.html')));
app.get('/audience', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audience.html')));

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

// ========== 状態管理 ==========
const state = {
  mikoshiDevices: new Map(),
  audienceDevices: new Set(),
  voiceIndex: 0,
};

// ビデオフレームのレート制限（デバイスごと2fps）
const frameTimestamps = new Map();

function computeWorldState() {
  const devices = Array.from(state.mikoshiDevices.values());
  const audienceCount = state.audienceDevices.size;
  const mikoshiCount = devices.length;
  if (mikoshiCount === 0) {
    return { mikoshiCount: 0, audienceCount, avgBrightness: 0.5, avgWhiteRatio: 0.3,
             avgColorTemp: 0.5, totalMovement: 0, maxMic: 0, avgAccX: 0, avgAccY: 0, devices: [] };
  }
  const avg = (k) => devices.reduce((s, d) => s + (d[k] ?? 0), 0) / mikoshiCount;
  const max = (k) => Math.max(...devices.map((d) => d[k] ?? 0));
  return {
    mikoshiCount, audienceCount,
    avgBrightness: avg('brightness'),
    avgWhiteRatio: avg('whiteRatio'),
    avgColorTemp: avg('colorTemp'),
    totalMovement: devices.reduce((s, d) => s + (d.accMagnitude ?? 0), 0),
    maxMic: max('micLevel'),
    avgAccX: avg('accX'),
    avgAccY: avg('accY'),
    devices: devices.map((d) => ({
      id: d.id, voiceIndex: d.voiceIndex,
      brightness: d.brightness, accMagnitude: d.accMagnitude,
      micLevel: d.micLevel, colorTemp: d.colorTemp,
    })),
  };
}

let broadcastScheduled = false;
function scheduleBroadcast() {
  if (broadcastScheduled) return;
  broadcastScheduled = true;
  setTimeout(() => { broadcastScheduled = false; io.emit('world_state', computeWorldState()); }, 100);
}

// ========== WebSocket ==========
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('join_mikoshi', () => {
    socket.role = 'mikoshi';
    const voiceIndex = state.voiceIndex % 8;
    state.voiceIndex++;
    state.mikoshiDevices.set(socket.id, {
      id: socket.id, voiceIndex,
      brightness: 0.5, whiteRatio: 0.3, colorTemp: 0.5,
      accMagnitude: 0, accX: 0, accY: 0, micLevel: 0,
    });
    socket.join('mikoshi');
    socket.emit('joined_mikoshi', { voiceIndex });
    scheduleBroadcast();
    console.log(`[mikoshi joined] voice=${voiceIndex}`);
  });

  socket.on('join_audience', () => {
    socket.role = 'audience';
    socket.join('audience');
    state.audienceDevices.add(socket.id);
    socket.emit('joined_audience', { audienceCount: state.audienceDevices.size });
    // 接続時に最新フレームを全デバイス分送信
    for (const [deviceId, frame] of frameTimestamps) {
      if (frame.data) {
        socket.emit('video_frame', {
          deviceId, voiceIndex: frame.voiceIndex, data: frame.data,
        });
      }
    }
    scheduleBroadcast();
  });

  socket.on('sensor_data', (data) => {
    if (socket.role !== 'mikoshi') return;
    const prev = state.mikoshiDevices.get(socket.id);
    if (!prev) return;
    state.mikoshiDevices.set(socket.id, {
      ...prev,
      brightness: clamp(data.brightness ?? prev.brightness, 0, 1),
      whiteRatio: clamp(data.whiteRatio ?? prev.whiteRatio, 0, 1),
      colorTemp: clamp(data.colorTemp ?? prev.colorTemp, 0, 1),
      accMagnitude: clamp(data.accMagnitude ?? prev.accMagnitude, 0, 20),
      accX: data.accX ?? prev.accX,
      accY: data.accY ?? prev.accY,
      micLevel: clamp(data.micLevel ?? prev.micLevel, 0, 1),
    });
    scheduleBroadcast();
  });

  // ビデオフレーム中継（2fps制限）
  socket.on('video_frame', (frameData) => {
    if (socket.role !== 'mikoshi') return;
    const now = Date.now();
    const prev = frameTimestamps.get(socket.id);
    if (prev && now - prev.ts < 450) return; // 2fps制限

    const device = state.mikoshiDevices.get(socket.id);
    const voiceIndex = device?.voiceIndex ?? 0;

    frameTimestamps.set(socket.id, { ts: now, data: frameData, voiceIndex });

    // 観客全員に中継
    socket.to('audience').emit('video_frame', {
      deviceId: socket.id, voiceIndex, data: frameData,
    });
  });

  socket.on('disconnect', () => {
    if (socket.role === 'mikoshi') {
      state.mikoshiDevices.delete(socket.id);
      frameTimestamps.delete(socket.id);
      // 切断通知（観客側で映像を消す）
      io.to('audience').emit('mikoshi_disconnected', { deviceId: socket.id });
    } else if (socket.role === 'audience') {
      state.audienceDevices.delete(socket.id);
    }
    scheduleBroadcast();
    console.log(`[disconnect] ${socket.id} (${socket.role})`);
  });
});

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🏮 神輿サウンドサーバー起動 → http://localhost:${PORT}`);
});
