/**
 * 手势抽牌独立模式
 * 握拳召唤 → 张掌展开圆环 → 挥手/拖拽转环 → 食指锁定 → 捏合翻牌 → 入槽
 * 无摄像头时完整按钮/拖拽兜底。
 */
import { DECK, DECK_SIZE } from './deck.js';
import {
  defaultSpreadForCount,
  resolvePositions,
  REFLECTION_LAYERS,
} from './spreads.js';
import {
  GESTURE,
  GestureEngine,
  requestCamera,
  stopCamera,
} from './hands.js';

const PHASE = {
  WELCOME: 'welcome',
  MEDITATE: 'meditate',
  WAIT_FIST: 'wait_fist',
  SUMMONED: 'summoned',
  SPREAD: 'spread',
  LOCKED: 'locked',
  FLIPPING: 'flipping',
  WAIT_NEXT: 'wait_next',
  COMPLETE: 'complete',
};

const HUD = {
  [PHASE.WELCOME]: '需要摄像头可选 · 也可全程用按钮与拖拽',
  [PHASE.MEDITATE]: '默想一个问题 · 准备好再继续',
  [PHASE.WAIT_FIST]: '握拳召唤牌堆 · 或点「召唤」',
  [PHASE.SUMMONED]: '张开手掌展开牌阵 · 或点「展开」',
  [PHASE.SPREAD]: '左右挥手／拖拽转牌 · 食指点选前方卡',
  [PHASE.LOCKED]: '捏合确认翻开 · 张掌取消 · 或点按钮',
  [PHASE.FLIPPING]: '牌面翻转中…',
  [PHASE.WAIT_NEXT]: '张开手掌继续抽下一张 · 或点「继续」',
  [PHASE.COMPLETE]: '牌阵已满 · 点卡翻开细看，或再抽一次',
};

const ASSET_V = '19';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function assetUrl(path) {
  if (!path) return path;
  return path + (path.includes('?') ? '&' : '?') + 'v=' + ASSET_V;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function windowedCount() {
  return window.innerWidth >= 768 ? 10 : 8;
}

/** @type {null|{showScreen:Function, closeSheet:Function}} */
let api = null;

const gState = {
  phase: PHASE.WELCOME,
  count: 3,
  spread: null,
  positions: [],
  drawnSlots: [],
  remaining: [],
  ringIds: [],
  cameraOn: false,
  touchFallback: false,
  gesturesDisabled: false,
  stream: null,
  engine: null,
  spinAngle: 0,
  velocity: 0,
  friction: 0.92,
  animating: false,
  dragMoved: false,
  focused: false,
  palmIdleTimer: null,
  lastFrontIdx: null,
};

function setHud(text) {
  const el = $('#gesture-hud');
  if (el) el.textContent = text || HUD[gState.phase] || '';
}

function setPhase(phase) {
  gState.phase = phase;
  const root = $('#gesture-root');
  if (root) root.dataset.phase = phase;
  setHud(HUD[phase]);
  updateFallbackButtons();
  updateCameraBadge();
}

function updateCameraBadge() {
  const badge = $('#gesture-cam-badge');
  if (!badge) return;
  if (gState.cameraOn) {
    badge.textContent = '摄像头 · 手势开';
    badge.dataset.on = '1';
  } else if (gState.touchFallback) {
    badge.textContent = '触屏兜底';
    badge.dataset.on = '0';
  } else {
    badge.textContent = '未开摄像头';
    badge.dataset.on = '0';
  }
}

function updateFallbackButtons() {
  const map = {
    summon: [PHASE.WAIT_FIST],
    expand: [PHASE.SUMMONED],
    flip: [PHASE.LOCKED],
    unlock: [PHASE.LOCKED],
    continue: [PHASE.WAIT_NEXT],
  };
  Object.entries(map).forEach(([key, phases]) => {
    const btn = $(`#gesture-btn-${key}`);
    if (!btn) return;
    btn.hidden = !phases.includes(gState.phase);
  });
  const bar = $('#gesture-fallback-bar');
  if (bar) {
    const any = Object.values(map).some((p) => p.includes(gState.phase));
    bar.hidden = !any;
  }
}

function updateProgress() {
  const segs = $('#gesture-progress');
  if (!segs) return;
  segs.innerHTML = '';
  segs.hidden = gState.count <= 1;
  const filled = gState.drawnSlots.filter(Boolean).length;
  const next = gState.drawnSlots.findIndex((s) => s === null);
  for (let i = 0; i < gState.count; i++) {
    const s = document.createElement('span');
    s.className =
      'gesture-prog-seg' +
      (i < filled ? ' done' : i === next ? ' active' : '');
    segs.appendChild(s);
  }
  const label = $('#gesture-pos-label');
  if (label) {
    if (next >= 0 && gState.positions[next]) {
      const p = gState.positions[next];
      label.textContent = `第 ${next + 1} 张 · ${p.label}`;
      label.hidden = false;
    } else {
      label.hidden = true;
    }
  }
}

function resetRound(count) {
  gState.count = count;
  gState.spread = defaultSpreadForCount(count);
  gState.positions = resolvePositions(gState.spread, count);
  gState.drawnSlots = Array.from({ length: count }, () => null);
  gState.remaining = shuffleArray(DECK.map((c) => c.id));
  gState.ringIds = [];
  gState.spinAngle = 0;
  gState.velocity = 0;
  gState.focused = false;
  gState.gesturesDisabled = false;
  gState.lastFrontIdx = null;
  clearRing();
  clearReveal();
  hideFlipOverlay();
  updateProgress();
  $('#gesture-stage')?.classList.remove('is-complete');
  $('#gesture-reveal')?.classList.remove('show');
  const head = document.querySelector('.gesture-play-head');
  if (head) head.hidden = false;
}

function clearRing() {
  const ring = $('#gesture-ring');
  if (ring) ring.innerHTML = '';
  const stack = $('#gesture-stack');
  if (stack) {
    stack.innerHTML = '';
    stack.hidden = true;
  }
  if (ring) ring.style.transform = 'rotateZ(0deg)';
}

function clearReveal() {
  const board = $('#gesture-reveal-board');
  if (board) board.innerHTML = '';
}

function cardById(id) {
  return DECK.find((c) => c.id === id);
}

function buildRingIds() {
  const n = Math.min(windowedCount(), gState.remaining.length);
  gState.ringIds = gState.remaining.slice(0, n);
}

function getRadius() {
  const w = window.innerWidth;
  if (w <= 480) return 150;
  if (w <= 768) return 200;
  return 260;
}

function cardTransform(baseAngle, radius, zLift = 0) {
  const rad = (baseAngle * Math.PI) / 180;
  const x = Math.sin(rad) * radius;
  const y = -Math.cos(rad) * radius;
  return `translate3d(${x}px, ${y}px, ${zLift}px) rotateZ(${baseAngle}deg) rotateX(-78deg)`;
}

function renderStack() {
  const stack = $('#gesture-stack');
  if (!stack) return;
  stack.hidden = false;
  stack.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const el = document.createElement('div');
    el.className = 'gesture-stack-card';
    el.style.transform = `translate(${i * 1.5}px, ${-i * 2}px) rotate(${(i - 2) * 1.2}deg)`;
    el.style.zIndex = String(i);
    stack.appendChild(el);
  }
  stack.classList.add('appear');
  spawnParticles();
}

function spawnParticles() {
  const stage = $('#gesture-stage');
  if (!stage) return;
  const wrap = document.createElement('div');
  wrap.className = 'gesture-particles';
  for (let i = 0; i < 14; i++) {
    const p = document.createElement('span');
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    p.style.setProperty('--dy', `${-40 - Math.random() * 80}px`);
    p.style.setProperty('--delay', `${Math.random() * 0.3}s`);
    wrap.appendChild(p);
  }
  stage.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1200);
}

function renderRing() {
  const ring = $('#gesture-ring');
  const stack = $('#gesture-stack');
  if (!ring) return;
  if (stack) stack.hidden = true;
  ring.innerHTML = '';
  const n = gState.ringIds.length;
  const radius = getRadius();
  gState.spinAngle = 0;
  gState.velocity = 0;
  gState.focused = false;
  gState.lastFrontIdx = null;

  gState.ringIds.forEach((id, i) => {
    const angle = (360 / n) * i;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'gesture-ring-card';
    el.dataset.index = String(i);
    el.dataset.id = String(id);
    el.style.transform = cardTransform(angle, radius);
    el.dataset.angle = String(angle);
    el.setAttribute('aria-label', '未翻开卡牌');
    el.innerHTML = `<div class="gesture-ring-inner"><div class="gesture-ring-face back"></div></div>`;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (gState.dragMoved) return;
      if (gState.phase !== PHASE.SPREAD && gState.phase !== PHASE.LOCKED) return;
      const cur = getCurrentIndex();
      if (i === cur) {
        if (gState.phase === PHASE.SPREAD) lockFront();
        else if (gState.phase === PHASE.LOCKED) confirmFlip();
      } else {
        // 点非前方：转到该位
        const step = 360 / n;
        gState.spinAngle = -i * step;
        snapToNearest();
        updateSpin();
      }
    });
    ring.appendChild(el);
  });
  ring.style.transform = `rotateZ(${gState.spinAngle}deg)`;
  updateFrontCard();
}

function getCurrentIndex() {
  const n = gState.ringIds.length || 1;
  const step = 360 / n;
  let idx = Math.round(-gState.spinAngle / step);
  idx = ((idx % n) + n) % n;
  return idx;
}

function updateSpin() {
  const ring = $('#gesture-ring');
  if (ring) ring.style.transform = `rotateZ(${gState.spinAngle}deg)`;
  if (gState.phase === PHASE.SPREAD || gState.phase === PHASE.LOCKED) {
    updateFrontCard();
  }
}

function updateFrontCard() {
  const cards = $$('.gesture-ring-card');
  if (!cards.length) return;
  const idx = getCurrentIndex();
  if (idx === gState.lastFrontIdx) return;
  if (gState.lastFrontIdx != null && cards[gState.lastFrontIdx]) {
    cards[gState.lastFrontIdx].classList.remove('is-front');
  }
  gState.lastFrontIdx = idx;
  if (cards[idx]) cards[idx].classList.add('is-front');
}

function snapToNearest() {
  const n = gState.ringIds.length || 1;
  const step = 360 / n;
  gState.spinAngle = Math.round(gState.spinAngle / step) * step;
  updateSpin();
}

function startPhysics() {
  if (gState.animating || gState.focused) return;
  gState.animating = true;
  const loop = () => {
    if (gState.focused) {
      gState.animating = false;
      return;
    }
    gState.velocity *= gState.friction;
    gState.spinAngle += gState.velocity;
    updateSpin();
    if (Math.abs(gState.velocity) > 0.15) {
      requestAnimationFrame(loop);
    } else {
      gState.velocity = 0;
      snapToNearest();
      gState.animating = false;
    }
  };
  requestAnimationFrame(loop);
}

function palmDrive(deltaAngle) {
  if (gState.phase !== PHASE.SPREAD || gState.focused) return;
  gState.spinAngle += deltaAngle;
  gState.velocity = deltaAngle * 0.5;
  updateSpin();
  clearTimeout(gState.palmIdleTimer);
  gState.palmIdleTimer = setTimeout(() => startPhysics(), 100);
}

function lockFront() {
  if (gState.phase !== PHASE.SPREAD) return;
  gState.velocity = 0;
  gState.animating = false;
  snapToNearest();
  gState.focused = true;
  const cards = $$('.gesture-ring-card');
  const idx = getCurrentIndex();
  cards.forEach((c) => c.classList.remove('is-locked'));
  if (cards[idx]) {
    cards[idx].classList.add('is-locked');
    const radius = getRadius();
    const angle = Number(cards[idx].dataset.angle || 0);
    cards[idx].style.transform = cardTransform(angle, radius, 42);
  }
  setPhase(PHASE.LOCKED);
}

function unlockFront() {
  if (gState.phase !== PHASE.LOCKED) return;
  gState.focused = false;
  const cards = $$('.gesture-ring-card');
  const radius = getRadius();
  cards.forEach((c) => {
    c.classList.remove('is-locked');
    const angle = Number(c.dataset.angle || 0);
    c.style.transform = cardTransform(angle, radius, 0);
  });
  setPhase(PHASE.SPREAD);
}

async function confirmFlip() {
  if (gState.phase !== PHASE.LOCKED) return;
  const idx = getCurrentIndex();
  const id = gState.ringIds[idx];
  const card = cardById(id);
  if (!card) return;

  gState.gesturesDisabled = true;
  setPhase(PHASE.FLIPPING);

  const ringWrap = $('#gesture-ring-wrap');
  if (ringWrap) ringWrap.classList.add('dim');

  showFlipOverlay(card);
  await wait(900);

  // 入槽
  const slotIdx = gState.drawnSlots.findIndex((s) => s === null);
  if (slotIdx >= 0) {
    gState.drawnSlots[slotIdx] = { card, flipped: true };
  }
  gState.remaining = gState.remaining.filter((cid) => cid !== id);

  await wait(400);
  hideFlipOverlay();
  if (ringWrap) ringWrap.classList.remove('dim');
  clearRing();
  gState.focused = false;
  gState.gesturesDisabled = false;
  updateProgress();

  const next = gState.drawnSlots.findIndex((s) => s === null);
  if (next < 0) {
    enterComplete();
  } else {
    setPhase(PHASE.WAIT_NEXT);
  }
}

function showFlipOverlay(card) {
  const ov = $('#gesture-flip-overlay');
  if (!ov) return;
  ov.hidden = false;
  ov.innerHTML = `
    <div class="gesture-flip-card">
      <div class="gesture-flip-inner">
        <div class="gesture-flip-face back"></div>
        <div class="gesture-flip-face front">
          <img src="${assetUrl(card.image)}" alt="${card.name}"
               onerror="this.style.display='none'" />
          <span class="gesture-flip-num">${pad2(card.id)}</span>
        </div>
      </div>
    </div>
    <div class="gesture-flip-meta">
      <div class="name">${card.name}</div>
      <p class="prompt">${card.prompt}</p>
    </div>
  `;
  requestAnimationFrame(() => {
    ov.classList.add('show');
    requestAnimationFrame(() => {
      ov.querySelector('.gesture-flip-inner')?.classList.add('flipped');
    });
  });
}

function hideFlipOverlay() {
  const ov = $('#gesture-flip-overlay');
  if (!ov) return;
  ov.classList.remove('show');
  ov.hidden = true;
  ov.innerHTML = '';
}

function continueNext() {
  if (gState.phase !== PHASE.WAIT_NEXT) return;
  buildRingIds();
  renderRing();
  setPhase(PHASE.SPREAD);
}

function enterComplete() {
  setPhase(PHASE.COMPLETE);
  const head = document.querySelector('.gesture-play-head');
  if (head) head.hidden = true;
  $('#gesture-stage')?.classList.add('is-complete');
  renderGestureReveal();
  $('#gesture-reveal')?.classList.add('show');
}

function layoutClass(layout) {
  const map = {
    single: 'layout-single',
    row: 'layout-row',
    triangle: 'layout-triangle',
    cross: 'layout-cross',
    grid3: 'layout-grid3',
    fan: 'layout-fan',
    gridAuto: 'layout-gridAuto',
  };
  return map[layout] || 'layout-gridAuto';
}

function renderGestureReveal() {
  const board = $('#gesture-reveal-board');
  if (!board) return;
  board.innerHTML = '';
  const slots = document.createElement('div');
  slots.className = `slots ${layoutClass(gState.spread.layout)}`;
  gState.positions.forEach((pos, i) => {
    const item = gState.drawnSlots[i];
    const slot = document.createElement('div');
    slot.className = 'slot' + (item ? '' : ' is-empty');
    const label = document.createElement('div');
    label.className = 'slot-label';
    label.textContent = pos.label;
    slot.appendChild(label);
    if (item) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card flipped';
      btn.setAttribute('aria-label', item.card.name);
      btn.innerHTML = `
        <div class="card-inner">
          <div class="card-face card-back-face" aria-hidden="true"></div>
          <div class="card-face card-front-face">
            <div class="face-art">
              <img src="${assetUrl(item.card.image)}" alt="${item.card.name}"
                   loading="eager" onerror="this.classList.add('is-broken')" />
              <span class="num-ring" aria-hidden="true"></span>
              <span class="num-face" aria-hidden="true">${pad2(item.card.id)}</span>
            </div>
          </div>
        </div>`;
      btn.addEventListener('click', () => openGestureSheet(i));
      slot.appendChild(btn);
    }
    slots.appendChild(slot);
  });
  board.appendChild(slots);
}

function openGestureSheet(index) {
  const item = gState.drawnSlots[index];
  if (!item) return;
  const pos = gState.positions[index];
  const sheet = $('#detail-sheet');
  const backdrop = $('#sheet-backdrop');
  const mini = $('#sheet-mini');
  mini.innerHTML = `<img src="${assetUrl(item.card.image)}" alt="" onerror="this.remove()" />`;
  if (!mini.querySelector('img')) {
    mini.innerHTML = `<span class="num">${pad2(item.card.id)}</span>`;
  }
  $('#sheet-pos').textContent = pos.label + (pos.hint ? ` · ${pos.hint}` : '');
  $('#sheet-name').textContent = item.card.name;
  $('#sheet-prompt').textContent = item.card.prompt;
  $('#sheet-layers').innerHTML = REFLECTION_LAYERS.map(
    (L, i) => `
    <div class="layer">
      <div class="step">第 ${i + 1} 层</div>
      <h4>${L.title}</h4>
      <p>${L.q}</p>
    </div>`
  ).join('');
  backdrop.classList.add('open');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

/* ——— Gesture handling ——— */
function onGesture(gesture) {
  if (gState.gesturesDisabled) return;
  switch (gState.phase) {
    case PHASE.WAIT_FIST:
      if (gesture === GESTURE.FIST) doSummon();
      break;
    case PHASE.SUMMONED:
      if (gesture === GESTURE.OPEN_PALM || gesture === GESTURE.SWIPE_CONTINUOUS) {
        doExpand();
      }
      break;
    case PHASE.SPREAD:
      if (gesture === GESTURE.SWIPE_CONTINUOUS && gState.engine) {
        const d = gState.engine.getSwipeDelta();
        palmDrive(d * 160);
      } else if (gesture === GESTURE.POINT) {
        lockFront();
      }
      break;
    case PHASE.LOCKED:
      if (gesture === GESTURE.PINCH) {
        confirmFlip();
      } else if (gesture === GESTURE.OPEN_PALM || gesture === GESTURE.SWIPE_CONTINUOUS) {
        unlockFront();
      }
      break;
    case PHASE.WAIT_NEXT:
      if (gesture === GESTURE.OPEN_PALM) continueNext();
      break;
    default:
      break;
  }
}

function doSummon() {
  if (gState.phase !== PHASE.WAIT_FIST) return;
  renderStack();
  setPhase(PHASE.SUMMONED);
}

function doExpand() {
  if (gState.phase !== PHASE.SUMMONED) return;
  buildRingIds();
  renderRing();
  setPhase(PHASE.SPREAD);
}

/* ——— Touch / mouse ring drag ——— */
function initRingDrag() {
  const scene = $('#gesture-ring-wrap');
  if (!scene || scene.dataset.dragReady) return;
  scene.dataset.dragReady = '1';
  let pointerDown = false;
  let startX = 0;
  let startAngle = 0;
  let lastMomentum = 0;

  const onDown = (x) => {
    if (gState.phase !== PHASE.SPREAD || gState.focused) return;
    pointerDown = true;
    startX = x;
    startAngle = gState.spinAngle;
    lastMomentum = 0;
    gState.dragMoved = false;
    gState.velocity = 0;
    gState.animating = false;
  };
  const onMove = (x) => {
    if (!pointerDown) return;
    const dx = x - startX;
    if (Math.abs(dx) > 8) gState.dragMoved = true;
    // 小樱近似 1:1：dx 映射角度
    const newAngle = startAngle + dx * 0.45;
    lastMomentum = newAngle - gState.spinAngle;
    gState.spinAngle = newAngle;
    updateSpin();
  };
  const onUp = () => {
    if (!pointerDown) return;
    pointerDown = false;
    if (gState.dragMoved) {
      gState.velocity = lastMomentum;
      // 摩擦惯性 + 吸附
      const decay = () => {
        if (Math.abs(gState.velocity) < 0.05) {
          snapToNearest();
          return;
        }
        gState.velocity *= 0.92;
        gState.spinAngle += gState.velocity;
        updateSpin();
        requestAnimationFrame(decay);
      };
      requestAnimationFrame(decay);
    }
    setTimeout(() => {
      gState.dragMoved = false;
    }, 220);
  };

  scene.addEventListener('touchstart', (e) => {
    if (e.touches[0]) onDown(e.touches[0].clientX);
  }, { passive: true });
  scene.addEventListener('touchmove', (e) => {
    if (e.touches[0]) onMove(e.touches[0].clientX);
  }, { passive: true });
  scene.addEventListener('touchend', onUp);
  scene.addEventListener('mousedown', (e) => {
    e.preventDefault();
    onDown(e.clientX);
  });
  window.addEventListener('mousemove', (e) => onMove(e.clientX));
  window.addEventListener('mouseup', onUp);
}

/* ——— Camera / MediaPipe ——— */
async function startGestureRitual(preferCamera) {
  const status = $('#gesture-status');
  const setStatus = (t) => {
    if (status) status.textContent = t || '';
  };

  if (preferCamera && navigator.mediaDevices?.getUserMedia) {
    try {
      setStatus('正在请求摄像头…');
      const video = $('#gesture-video');
      gState.stream = await requestCamera(video);
      gState.cameraOn = true;
      $('#gesture-cam-panel')?.classList.add('show');
      setStatus('正在加载手势识别…');
      const engine = new GestureEngine();
      await engine.init(video, { onStatus: setStatus });
      engine.onGesture = onGesture;
      engine.start();
      gState.engine = engine;
      gState.touchFallback = false;
      setStatus('');
      enterMeditateOrRitual();
      return;
    } catch (err) {
      console.warn('摄像头/手势不可用，降级触屏:', err);
      setStatus('摄像头或手势不可用，已切换触屏拖环模式');
      stopCamera($('#gesture-video'));
      gState.cameraOn = false;
      gState.touchFallback = true;
    }
  } else {
    gState.touchFallback = true;
    setStatus('未使用摄像头 · 可用按钮与拖拽完成仪式');
  }
  updateCameraBadge();
  enterMeditateOrRitual();
}

function enterMeditateOrRitual() {
  showPanel('meditate');
  setPhase(PHASE.MEDITATE);
}

function beginRitual() {
  showPanel('play');
  resetRound(gState.count);
  setPhase(PHASE.WAIT_FIST);
  updateProgress();
}

function showPanel(name) {
  $$('.gesture-panel').forEach((el) => {
    el.classList.toggle('active', el.dataset.panel === name);
  });
}

function teardownCamera() {
  if (gState.engine) {
    gState.engine.dispose();
    gState.engine = null;
  }
  stopCamera($('#gesture-video'));
  gState.stream = null;
  gState.cameraOn = false;
  $('#gesture-cam-panel')?.classList.remove('show');
}

function enterGestureMode(count = 3) {
  gState.count = count;
  api?.closeSheet?.();
  api?.showScreen?.('gesture');
  showPanel('welcome');
  setPhase(PHASE.WELCOME);
  clearRing();
  clearReveal();
  hideFlipOverlay();
  $('#gesture-stage')?.classList.remove('is-complete');
  $('#gesture-reveal')?.classList.remove('show');
  // sync count chips
  $$('.gesture-count-chip').forEach((c) => {
    c.classList.toggle('selected', Number(c.dataset.count) === count);
  });
  updateCameraBadge();
}

function leaveToHome() {
  teardownCamera();
  api?.closeSheet?.();
  api?.showScreen?.('home');
}

function again() {
  api?.closeSheet?.();
  resetRound(gState.count);
  showPanel('play');
  setPhase(PHASE.WAIT_FIST);
  updateProgress();
  $('#gesture-reveal')?.classList.remove('show');
  $('#gesture-stage')?.classList.remove('is-complete');
  const head = document.querySelector('.gesture-play-head');
  if (head) head.hidden = false;
}

export function initGestureMode(helpers) {
  api = helpers;

  $('#btn-gesture-start')?.addEventListener('click', () => enterGestureMode(3));

  $$('.gesture-count-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const n = Number(chip.dataset.count);
      if (![1, 3, 5].includes(n)) return;
      gState.count = n;
      $$('.gesture-count-chip').forEach((c) =>
        c.classList.toggle('selected', Number(c.dataset.count) === n)
      );
    });
  });

  $('#gesture-btn-open-cam')?.addEventListener('click', () => startGestureRitual(true));
  $('#gesture-btn-touch-only')?.addEventListener('click', () => startGestureRitual(false));
  $('#gesture-btn-meditate-done')?.addEventListener('click', beginRitual);

  $('#gesture-btn-summon')?.addEventListener('click', doSummon);
  $('#gesture-btn-expand')?.addEventListener('click', doExpand);
  $('#gesture-btn-flip')?.addEventListener('click', confirmFlip);
  $('#gesture-btn-unlock')?.addEventListener('click', unlockFront);
  $('#gesture-btn-continue')?.addEventListener('click', continueNext);

  $('#gesture-btn-back')?.addEventListener('click', leaveToHome);
  $('#gesture-btn-again')?.addEventListener('click', again);
  $('#gesture-btn-to-normal')?.addEventListener('click', leaveToHome);
  $('#gesture-btn-cam-toggle')?.addEventListener('click', () => {
    $('#gesture-cam-panel')?.classList.toggle('collapsed');
  });

  initRingDrag();
  window.addEventListener('resize', () => {
    if (gState.phase === PHASE.SPREAD || gState.phase === PHASE.LOCKED) {
      const cards = $$('.gesture-ring-card');
      const radius = getRadius();
      cards.forEach((c) => {
        const angle = Number(c.dataset.angle || 0);
        const lift = c.classList.contains('is-locked') ? 42 : 0;
        c.style.transform = cardTransform(angle, radius, lift);
      });
    }
  });

  // URL 直达
  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'gesture') {
    const c = Number(params.get('n') || 3);
    enterGestureMode([1, 3, 5].includes(c) ? c : 3);
  }
}

export { enterGestureMode };
