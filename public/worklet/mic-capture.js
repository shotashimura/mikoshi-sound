/**
 * mic-capture.js — AudioWorklet processor
 *
 * モード A (SharedArrayBuffer あり):
 *   マイク PCM サンプルを Int16 に変換して共有リングバッファに書き込む。
 *   書き込みポインタは Atomics で原子的に更新。
 *   メインスレッドはポインタを読み取り、任意位置から粒子サイズ分を取り出す。
 *
 * モード B (SharedArrayBuffer なし — フォールバック):
 *   Float32Array 4096 サンプル分を貯めて postMessage で転送。
 *   メインスレッドで AudioBuffer 化してグラニュラーに使用。
 *
 * ctrl バッファ (Int32Array[4]):
 *   [0] writePos   — 次に書き込むインデックス（モード A のみ使用）
 *   [1] hasWrapped — リングバッファが一周したら 1 になる（モード A のみ）
 *   [2], [3]       — 予約
 */
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Mode A
    this._ring = null;
    this._ctrl = null;
    this._size = 0;
    this._useShared = false;

    // Mode B
    this._pmBuf = null;
    this._pmPos = 0;
    this._PM_SIZE = 4096;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'init-shared') {
        this._ring = new Int16Array(data.ring);
        this._ctrl = new Int32Array(data.ctrl);
        this._size = this._ring.length;
        this._useShared = true;
      } else if (data.type === 'init-pm') {
        this._pmBuf = new Float32Array(this._PM_SIZE);
        this._pmPos = 0;
        this._useShared = false;
      }
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    if (this._useShared && this._ring) {
      // ── Mode A: SharedArrayBuffer ──────────────────────────
      let w = Atomics.load(this._ctrl, 0);
      for (let i = 0; i < ch.length; i++) {
        // float32 → int16 (clamp)
        let s = (ch[i] * 32767) | 0;
        if (s > 32767)  s =  32767;
        if (s < -32767) s = -32767;
        this._ring[w] = s;
        w++;
        if (w >= this._size) {
          w = 0;
          Atomics.store(this._ctrl, 1, 1); // hasWrapped = true
        }
      }
      Atomics.store(this._ctrl, 0, w);

    } else if (this._pmBuf) {
      // ── Mode B: postMessage フォールバック ─────────────────
      for (let i = 0; i < ch.length; i++) {
        this._pmBuf[this._pmPos++] = ch[i];
        if (this._pmPos >= this._PM_SIZE) {
          // Transfer buffer (zero-copy)
          const ab = this._pmBuf.buffer;
          this._pmBuf = new Float32Array(new ArrayBuffer(this._PM_SIZE * 4));
          this._pmPos = 0;
          this.port.postMessage({ type: 'pcm', buffer: ab }, [ab]);
        }
      }
    }

    return true; // keep alive
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
