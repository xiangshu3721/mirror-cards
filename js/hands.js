/**
 * MediaPipe Hands 封装（浏览器本地推理，不上传视频）
 * 失败时由调用方降级到触屏/按钮模式。
 */
export const GESTURE = {
  NONE: 'none',
  FIST: 'fist',
  OPEN_PALM: 'open_palm',
  POINT: 'point',
  PINCH: 'pinch',
  PINCH_RELEASE: 'pinch_release',
  SWIPE_CONTINUOUS: 'swipe_continuous',
};

const CDN_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs',
  'https://unpkg.com/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs',
];

const WASM_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
  'https://unpkg.com/@mediapipe/tasks-vision@0.10.18/wasm',
];

const HAND_MODEL_MIN_BYTES = 4 * 1024 * 1024;
const HAND_MODEL_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const HAND_MODEL_MIRRORS = [
  'https://hf-mirror.com/lithiumice/models_hub/resolve/8a7b241f38e33d194a06f881a1211b3e7eda4edd/hand_landmarker.task',
  HAND_MODEL_REMOTE,
];

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function importWithTimeout(url, timeoutMs = 25000) {
  return Promise.race([
    import(/* @vite-ignore */ url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`加载超时(${timeoutMs / 1000}s)`)), timeoutMs)
    ),
  ]);
}

let _wasmBasePath = WASM_SOURCES[0];
let _mpModule = null;

export async function loadMediaPipe(onStatus) {
  if (_mpModule) return _mpModule;
  for (let i = 0; i < CDN_SOURCES.length; i++) {
    const src = CDN_SOURCES[i];
    const name = new URL(src).hostname;
    try {
      onStatus?.(`正在从 ${name} 加载手势库…`);
      const mod = await importWithTimeout(src, 25000);
      _wasmBasePath = WASM_SOURCES[i];
      _mpModule = mod;
      return mod;
    } catch (err) {
      console.warn(`CDN ${name} 失败:`, err?.message || err);
      onStatus?.(`${name} 失败，切换备用源…`);
    }
  }
  throw new Error('手势库加载失败，已切换到触屏模式');
}

async function fetchHandModelBuffer(onStatus) {
  const tryOnce = async (url, label, timeoutMs, useCache = false) => {
    onStatus?.(label);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const opts = { signal: ctrl.signal, mode: 'cors' };
      if (!useCache) opts.cache = 'no-cache';
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength < HAND_MODEL_MIN_BYTES) {
        throw new Error(`模型文件过小（${buf.byteLength}）`);
      }
      return buf;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`下载超时（>${timeoutMs / 1000}s）`);
      throw e;
    } finally {
      clearTimeout(tid);
    }
  };

  const localUrl = new URL('models/hand_landmarker.task', window.location.href).href;
  try {
    return await tryOnce(localUrl, '正在加载本地手势模型…', 15000, true);
  } catch (e) {
    console.warn('本地模型不可用:', e?.message || e);
  }

  const t0 = Date.now();
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    onStatus?.(`正在下载手势模型… ${s}s（约 8MB）`);
  }, 1000);
  try {
    for (let i = 0; i < HAND_MODEL_MIRRORS.length; i++) {
      try {
        const label = i === 0 ? '正在从镜像下载模型…' : `备用源 ${i + 1}…`;
        return await tryOnce(HAND_MODEL_MIRRORS[i], label, 90000);
      } catch (e) {
        console.warn(`模型源 ${i + 1} 失败:`, e?.message || e);
      }
    }
    throw new Error('所有模型源均失败');
  } finally {
    clearInterval(tick);
  }
}

export class GestureEngine {
  constructor() {
    this.handLandmarker = null;
    this._handModelBlobUrl = null;
    this.video = null;
    this.running = false;
    this.mirrored = true;
    this.onGesture = null;
    this.onHandUpdate = null;
    this._inferStride = 2;
    this._inferTick = 0;
    this._pollMs = 16;
    this.pinchStartTime = 0;
    this.PINCH_HOLD_MS = 300;
    this.isPinching = false;
    this._pinchConfirmed = false;
    this.cooldowns = {};
    this.COOLDOWN_MS = 600;
    this.GESTURE_COOLDOWNS = {
      [GESTURE.FIST]: 800,
      [GESTURE.OPEN_PALM]: 500,
      [GESTURE.POINT]: 500,
    };
    this.lastPalmX = null;
    this._lastSwipeDelta = 0;
    this.debugData = { gesture: GESTURE.NONE, handsCount: 0, confidence: 0 };
  }

  async init(videoElement, options = {}) {
    this.video = videoElement;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    const { HandLandmarker, FilesetResolver } = await loadMediaPipe(onStatus);
    if (!HandLandmarker || !FilesetResolver) {
      throw new Error('MediaPipe 未就绪');
    }

    onStatus?.('正在初始化推理引擎…');
    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(_wasmBasePath),
      60000,
      'WASM 加载超时'
    );

    let modelAssetPath;
    try {
      const modelBuf = await fetchHandModelBuffer(onStatus);
      if (this._handModelBlobUrl) URL.revokeObjectURL(this._handModelBlobUrl);
      this._handModelBlobUrl = URL.createObjectURL(
        new Blob([modelBuf], { type: 'application/octet-stream' })
      );
      modelAssetPath = this._handModelBlobUrl;
    } catch (e) {
      console.warn('改用在线模型地址:', e?.message || e);
      modelAssetPath = HAND_MODEL_REMOTE;
    }

    const makeOptions = (delegate) => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });

    let lastError = null;
    onStatus?.('正在启动手势识别…');
    for (const delegate of ['GPU', 'CPU']) {
      try {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, makeOptions(delegate));
        return true;
      } catch (e) {
        lastError = e;
        console.warn(`HandLandmarker ${delegate} 失败:`, e?.message || e);
      }
    }
    throw lastError || new Error('HandLandmarker 初始化失败');
  }

  start() {
    this.running = true;
    this._inferTick = 0;
    this._detect();
  }

  stop() {
    this.running = false;
  }

  dispose() {
    this.stop();
    if (this.handLandmarker) {
      try {
        this.handLandmarker.close?.();
      } catch (_) {}
      this.handLandmarker = null;
    }
    if (this._handModelBlobUrl) {
      URL.revokeObjectURL(this._handModelBlobUrl);
      this._handModelBlobUrl = null;
    }
  }

  getSwipeDelta() {
    const d = this._lastSwipeDelta || 0;
    this._lastSwipeDelta = 0;
    return d;
  }

  _detect() {
    if (!this.running) return;
    const now = performance.now();
    const doInfer = this._inferTick % this._inferStride === 0;
    this._inferTick += 1;

    if (!doInfer || !this.video || this.video.readyState < 2) {
      setTimeout(() => this._detect(), this._pollMs);
      return;
    }

    let results;
    try {
      results = this.handLandmarker.detectForVideo(this.video, now);
    } catch (e) {
      console.warn('detectForVideo error', e);
      setTimeout(() => this._detect(), this._pollMs);
      return;
    }

    this.debugData.handsCount = results?.landmarks?.length || 0;

    if (results?.landmarks?.length > 0) {
      const hand = results.landmarks[0];
      const handedness = results.handednesses?.[0]?.[0];
      this.debugData.confidence = handedness ? Math.round(handedness.score * 100) : 0;
      const gesture = this._analyzeGesture(hand, now);
      this.debugData.gesture = gesture;
      if (gesture !== GESTURE.NONE && this.onGesture) {
        if (gesture === GESTURE.PINCH_RELEASE || gesture === GESTURE.SWIPE_CONTINUOUS) {
          this.onGesture(gesture, hand);
        } else if (this._checkCooldown(gesture, now)) {
          this.onGesture(gesture, hand);
        }
      }
    } else {
      if (this._pinchConfirmed) {
        this._pinchConfirmed = false;
        this.isPinching = false;
        this.onGesture?.(GESTURE.PINCH_RELEASE, null);
      }
      this.debugData.gesture = GESTURE.NONE;
      this.debugData.confidence = 0;
      this.pinchStartTime = 0;
      this.lastPalmX = null;
    }

    this.onHandUpdate?.(results);
    setTimeout(() => this._detect(), this._pollMs);
  }

  _analyzeGesture(hand, now) {
    const { thumb, index, middle, ring, pinky } = this._getFingerStates(hand);
    const thumbTip = hand[4];
    const indexTip = hand[8];
    const dx = thumbTip.x - indexTip.x;
    const dy = thumbTip.y - indexTip.y;
    const pinchDist = Math.sqrt(dx * dx + dy * dy);

    if (pinchDist < 0.05) {
      this.lastPalmX = null;
      if (this.pinchStartTime === 0) this.pinchStartTime = now;
      if (!this._pinchConfirmed && now - this.pinchStartTime >= this.PINCH_HOLD_MS) {
        this._pinchConfirmed = true;
        this.isPinching = true;
        this.pinchStartTime = 0;
        return GESTURE.PINCH;
      }
      return GESTURE.NONE;
    }

    if (this._pinchConfirmed) {
      this._pinchConfirmed = false;
      this.isPinching = false;
      this.pinchStartTime = 0;
      return GESTURE.PINCH_RELEASE;
    }
    this.pinchStartTime = 0;

    if (!thumb && !index && !middle && !ring && !pinky) {
      this.lastPalmX = null;
      return GESTURE.FIST;
    }

    // 张开手掌（小指不强制，减少误判）
    if (index && middle && ring && pinchDist >= 0.05) {
      const currentX = hand[9].x;
      if (this.lastPalmX !== null) {
        const deltaX = currentX - this.lastPalmX;
        if (Math.abs(deltaX) > 0.008) {
          this.lastPalmX = currentX;
          this._lastSwipeDelta = this.mirrored ? deltaX : -deltaX;
          return GESTURE.SWIPE_CONTINUOUS;
        }
      }
      this.lastPalmX = currentX;
      return GESTURE.OPEN_PALM;
    }

    this.lastPalmX = null;

    if (index && !middle && !ring && !pinky) {
      return GESTURE.POINT;
    }

    return GESTURE.NONE;
  }

  _getFingerStates(hand) {
    const wrist = hand[0];
    const thumbTip = hand[4];
    const thumbIP = hand[3];
    const thumb = Math.abs(thumbTip.x - wrist.x) > Math.abs(thumbIP.x - wrist.x);
    const index = hand[8].y < hand[6].y;
    const middle = hand[12].y < hand[10].y;
    const ring = hand[16].y < hand[14].y;
    const pinky = hand[20].y < hand[18].y;
    return { thumb, index, middle, ring, pinky };
  }

  _checkCooldown(gesture, now) {
    const cooldownTime = this.GESTURE_COOLDOWNS[gesture] || this.COOLDOWN_MS;
    const lastTime = this.cooldowns[gesture] || 0;
    if (now - lastTime < cooldownTime) return false;
    this.cooldowns[gesture] = now;
    return true;
  }
}

export async function requestCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.playsInline = true;
  await videoEl.play();
  return stream;
}

export function stopCamera(videoEl) {
  const stream = videoEl?.srcObject;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
}
