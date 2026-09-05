/**
 * 镜像卡牌 · 主流程
 * Home → Mode → Draw (arc fan pick) → Reveal → Detail → Again
 * Spread picker skipped; default spread auto-selected.
 */
import { DECK, DECK_SIZE } from './deck.js';
import {
  MODE_OPTIONS,
  defaultSpreadForCount,
  resolvePositions,
  REFLECTION_LAYERS,
} from './spreads.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  screen: 'home',
  count: null,
  modeId: null,
  spread: null,
  positions: [],
  /** @type {Array<null|{card:object,flipped:boolean}>} */
  drawnSlots: [],
  /** shuffled deck card ids not yet drawn */
  remainingFan: [],
  /** fan carousel center index into remainingFan */
  fanCenter: 0,
  shuffling: false,
};

const imageCache = new Map();

function showScreen(id) {
  state.screen = id;
  $$('.screen').forEach((el) => {
    el.classList.toggle('active', el.dataset.screen === id);
  });
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
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

function cardById(id) {
  return DECK.find((c) => c.id === id);
}

function nextEmptyIndex() {
  return state.drawnSlots.findIndex((s) => s === null);
}

function filledCount() {
  return state.drawnSlots.filter(Boolean).length;
}

const ASSET_V = '15';
function assetUrl(path) {
  if (!path) return path;
  return path + (path.includes('?') ? '&' : '?') + 'v=' + ASSET_V;
}

function probeImage(card) {
  if (imageCache.has(card.id)) return Promise.resolve(imageCache.get(card.id));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(card.id, true);
      resolve(true);
    };
    img.onerror = () => {
      imageCache.set(card.id, false);
      resolve(false);
    };
    img.src = assetUrl(card.image);
  });
}

/* ——— Home ——— */
function initHome() {
  $('#btn-start').addEventListener('click', () => {
    renderMode();
    showScreen('mode');
  });
  $('#btn-about').addEventListener('click', () => showScreen('about'));
  $('#btn-about-back').addEventListener('click', () => showScreen('home'));
  $('#btn-about-start').addEventListener('click', () => {
    renderMode();
    showScreen('mode');
  });
}

/* ——— Mode ——— */
function renderMode() {
  const grid = $('#mode-grid');
  grid.innerHTML = '';
  MODE_OPTIONS.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-chip' + (opt.id === 'custom' ? ' wide' : '');
    btn.dataset.id = opt.id;
    btn.innerHTML = `<span class="label">${opt.label}</span><span class="sub">${opt.sub}</span>`;
    btn.addEventListener('click', () => selectMode(opt));
    grid.appendChild(btn);
  });

  const customRow = $('#custom-row');
  customRow.classList.remove('show');
  $('#custom-count').value = '';
  $('#btn-mode-next').disabled = true;
  state.count = null;
  state.modeId = null;
}

function selectMode(opt) {
  state.modeId = opt.id;
  $$('.mode-chip').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === opt.id);
  });
  const customRow = $('#custom-row');
  if (opt.id === 'custom') {
    customRow.classList.add('show');
    const input = $('#custom-count');
    input.focus();
    updateCustomCount();
  } else {
    customRow.classList.remove('show');
    state.count = opt.count;
    $('#btn-mode-next').disabled = false;
  }
}

function updateCustomCount() {
  const raw = $('#custom-count').value.trim();
  const n = parseInt(raw, 10);
  const ok = Number.isInteger(n) && n >= 1 && n <= DECK_SIZE;
  state.count = ok ? n : null;
  $('#btn-mode-next').disabled = !ok;
}

function enterDrawFromMode() {
  if (!state.count) return;
  const spread = defaultSpreadForCount(state.count);
  if (!spread) return;
  state.spread = spread;
  state.positions = resolvePositions(spread, state.count);
  state.drawnSlots = Array.from({ length: state.count }, () => null);
  state.remainingFan = shuffleArray(DECK.map((c) => c.id));
  state.fanCenter = Math.floor(state.remainingFan.length / 2);
  const layoutEl = document.querySelector('.draw-layout');
  if (layoutEl) layoutEl.classList.remove('is-reveal');
  renderDrawStage(true);
  showScreen('draw');
}

function initMode() {
  $('#btn-mode-back').addEventListener('click', () => showScreen('home'));
  $('#custom-count').addEventListener('input', updateCustomCount);
  $('#btn-mode-next').addEventListener('click', enterDrawFromMode);
}

/* ——— Draw ——— */
function renderDrawStage(withShuffleAnim) {
  const title = $('#draw-title');
  if (title) title.textContent = state.spread.name;

  $('#reveal-bar').style.display = 'none';
  $('#fan-stage').style.display = '';
  $('#draw-mid').style.display = '';
  // 抽牌过程不展示牌面：只显示进度与扇面
  const board = $('#spread-board');
  if (board) board.style.display = 'none';

  updateDrawMid();
  renderFan(withShuffleAnim);
}

function updateDrawMid() {
  const next = nextEmptyIndex();
  const segs = $('#progress-segs');
  const prompt = $('#draw-prompt');
  const hint = $('#draw-prompt-hint');
  const swipe = $('#draw-swipe-hint');
  const autoBtn = $('#btn-auto-pick');
  const mid = $('#draw-mid');
  const board = $('#spread-board');

  if (next < 0) {
    // 抽完：收起扇面，统一展示完整牌阵（全部背面，手翻）
    mid.style.display = 'none';
    $('#fan-stage').style.display = 'none';
    const layoutEl = document.querySelector('.draw-layout');
    if (layoutEl) layoutEl.classList.add('is-reveal');
    if (board) {
      board.style.display = 'flex';
    }
    // 先预热全部牌图，再渲染，避免末张空白/数字占位
    const cards = state.drawnSlots.filter(Boolean).map((s) => s.card);
    Promise.all(cards.map((c) => probeImage(c))).finally(() => {
      renderBoard();
      $('#reveal-bar').style.display = 'flex';
      updateRevealBar();
    });
    return;
  }

  mid.style.display = '';
  $('#fan-stage').style.display = '';
  $('#reveal-bar').style.display = 'none';
  const layoutEl = document.querySelector('.draw-layout');
  if (layoutEl) layoutEl.classList.remove('is-reveal');
  if (board) board.style.display = 'none';

  segs.innerHTML = '';
  segs.style.display = state.count > 1 ? 'flex' : 'none';
  for (let i = 0; i < state.count; i++) {
    const s = document.createElement('span');
    s.className = 'prog-seg' + (i < filledCount() ? ' done' : i === next ? ' active' : '');
    segs.appendChild(s);
  }

  const pos = state.positions[next];
  prompt.textContent = `第 ${next + 1} 张 · ${pos.label}`;
  hint.textContent = pos.hint || '';
  swipe.textContent = '左右滑动转牌 · 点一张选它';
  autoBtn.style.display = '';
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

function fanAngle(i, n) {
  if (n <= 1) return 0;
  const span = Math.min(56, 8 * (n - 1));
  const start = -span / 2;
  const step = span / (n - 1);
  return start + step * i;
}

function cardFaceHTML(card) {
  // 始终挂 img，避免最后一张 probe 未完成时只剩数字占位
  return `
    <div class="card-inner">
      <div class="card-face card-back-face" aria-hidden="true"></div>
      <div class="card-face card-front-face">
        <div class="face-art">
          <img src="${assetUrl(card.image)}" alt="${card.name}" loading="eager" decoding="async"
               onerror="this.classList.add('is-broken')" />
          <span class="num-ring" aria-hidden="true"></span>
          <span class="num-face" aria-hidden="true">${pad2(card.id)}</span>
        </div>
      </div>
    </div>
  `;
}

function emptySlotHTML() {
  return `
    <div class="card-inner">
      <div class="card-face card-back-face" aria-hidden="true"></div>
      <div class="card-face card-front-face">
        <div class="face-art"></div>
      </div>
    </div>
  `;
}

function renderBoard() {
  const board = $('#spread-board');
  if (!board) return;
  // 仅在全部抽完后展示
  if (nextEmptyIndex() >= 0) {
    board.style.display = 'none';
    board.innerHTML = '';
    return;
  }
  board.style.display = 'flex';

  const layout = state.spread.layout;
  const slots = document.createElement('div');
  slots.className = `slots ${layoutClass(layout)}`;
  slots.setAttribute('role', 'list');

  state.positions.forEach((pos, i) => {
    const item = state.drawnSlots[i];
    const slot = document.createElement('div');
    slot.className = 'slot' + (item ? '' : ' is-empty');
    slot.dataset.key = pos.key;
    slot.setAttribute('role', 'listitem');

    if (layout === 'fan') {
      slot.style.transform = `rotate(${fanAngle(i, state.positions.length)}deg)`;
    }

    if (item) {
      const cardEl = document.createElement('button');
      cardEl.type = 'button';
      cardEl.className = 'card' + (item.flipped ? ' flipped' : '');
      cardEl.setAttribute(
        'aria-label',
        item.flipped ? item.card.name : `未翻开 · ${pos.label}`
      );
      cardEl.innerHTML = cardFaceHTML(item.card);
      cardEl.addEventListener('click', () => onSlotCardTap(i));
      slot.appendChild(cardEl);
    } else {
      const empty = document.createElement('div');
      empty.className = 'card empty';
      empty.setAttribute('aria-label', `空位 · ${pos.label}`);
      empty.innerHTML = emptySlotHTML();
      slot.appendChild(empty);
    }

    const label = document.createElement('div');
    label.className = 'slot-label';
    label.textContent = pos.label;
    slot.appendChild(label);

    if (pos.hint) {
      const h = document.createElement('div');
      h.className = 'slot-hint';
      h.textContent = pos.hint;
      slot.appendChild(h);
    }

    slots.appendChild(slot);
  });

  board.innerHTML = '';
  board.appendChild(slots);
}

function onSlotCardTap(index) {
  const item = state.drawnSlots[index];
  if (!item) return;
  if (!item.flipped) {
    item.flipped = true;
    // 只切换 class，保留 3D 翻转动画（避免整板重绘打断）
    const cards = $$('#spread-board .card');
    const cardEl = cards[index];
    if (cardEl) {
      cardEl.classList.add('is-flipping');
      // force reflow then flip
      void cardEl.offsetWidth;
      cardEl.classList.add('flipped');
      cardEl.setAttribute('aria-label', item.card.name);
      setTimeout(() => cardEl.classList.remove('is-flipping'), 1000);
    } else {
      renderBoard();
    }
    updateRevealBar();
    return;
  }
  openSheet(index);
}

/* ——— Arc fan（半圆弧） ——— */
const FAN_VISIBLE = 21; // odd

function renderFan(withShuffleAnim) {
  const track = $('#fan-track');
  const stage = $('#fan-stage');
  if (!track || !stage) return;

  const n = state.remainingFan.length;
  if (n === 0) {
    track.innerHTML = '';
    stage.classList.add('empty');
    return;
  }
  stage.classList.remove('empty');

  state.fanCenter = Math.max(0, Math.min(n - 1, state.fanCenter));

  const half = Math.floor(FAN_VISIBLE / 2);
  const start = Math.max(0, state.fanCenter - half);
  const end = Math.min(n - 1, state.fanCenter + half);

  track.innerHTML = '';
  track.classList.toggle('shuffling', !!withShuffleAnim);

  const maxAbs = Math.max(1, half);
  const maxAngleDeg = 78; // 半圆弧张角
  const R = Math.min(380, Math.max(260, stage.clientWidth * 0.55 || 320));

  for (let i = start; i <= end; i++) {
    const offset = i - state.fanCenter;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fan-card-btn' + (offset === 0 ? ' is-center' : '');
    btn.dataset.index = String(i);
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-label', `背面卡牌`);
    const abs = Math.abs(offset);
    const angle = (offset / maxAbs) * maxAngleDeg;
    const rad = (angle * Math.PI) / 180;
    // 半圆弧：中心贴底略抬，两侧沿圆弧向下沉入屏幕外缘
    const x = Math.sin(rad) * R;
    const y = (1 - Math.cos(rad)) * R;
    const z = 300 - abs;
    const scale = offset === 0 ? 1.1 : Math.max(0.78, 1 - abs * 0.028);
    btn.style.transform = `translate(-50%, 0) translateX(${x.toFixed(1)}px) translateY(${y.toFixed(1)}px) rotate(${angle.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    btn.style.zIndex = String(z);

    btn.innerHTML = `<span class="fan-card-face" aria-hidden="true"></span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if ($('#fan-stage')?.dataset.suppressClick) return;
      if (Math.abs(offset) > 2) {
        state.fanCenter = i;
        renderFan(false);
        return;
      }
      pickFanIndex(i);
    });
    track.appendChild(btn);
  }

  if (withShuffleAnim) {
    stage.classList.add('entering');
    setTimeout(() => {
      stage.classList.remove('entering');
      track.classList.remove('shuffling');
    }, 700);
  }
}

function pickFanIndex(fanIdx) {
  const next = nextEmptyIndex();
  if (next < 0) return;
  if (fanIdx < 0 || fanIdx >= state.remainingFan.length) return;

  const cardId = state.remainingFan[fanIdx];
  const card = cardById(cardId);
  if (!card) return;

  // 取走这张
  state.remainingFan.splice(fanIdx, 1);
  // 抽牌过程不亮牌：背面入库
  state.drawnSlots[next] = { card, flipped: false };
  probeImage(card);

  // 每抽一张：剩余牌重新洗牌，扇面复位到中间
  if (state.remainingFan.length > 0 && nextEmptyIndex() >= 0) {
    state.remainingFan = shuffleArray(state.remainingFan);
    state.fanCenter = Math.floor(state.remainingFan.length / 2);
    updateDrawMid();
    renderFan(true);
  } else {
    updateDrawMid();
    renderFan(false);
  }
}

function autoPickOne() {
  if (nextEmptyIndex() < 0 || state.remainingFan.length === 0) return;
  const idx = state.fanCenter;
  pickFanIndex(idx);
}

/* fan swipe / drag */
function initFanGestures() {
  const stage = $('#fan-stage');
  let startX = 0;
  let lastX = 0;
  let dragging = false;
  let moved = false;
  let acc = 0;

  const onDown = (x) => {
    dragging = true;
    moved = false;
    startX = x;
    lastX = x;
    acc = 0;
  };
  const onMove = (x) => {
    if (!dragging) return;
    const dx = x - lastX;
    lastX = x;
    if (Math.abs(x - startX) > 8) moved = true;
    acc += dx;
    // every ~28px shift center by 1
    while (acc <= -28) {
      acc += 28;
      if (state.fanCenter < state.remainingFan.length - 1) {
        state.fanCenter += 1;
        renderFan(false);
      }
    }
    while (acc >= 28) {
      acc -= 28;
      if (state.fanCenter > 0) {
        state.fanCenter -= 1;
        renderFan(false);
      }
    }
  };
  const onUp = () => {
    // suppress click after a real swipe
    if (moved) {
      stage.dataset.suppressClick = '1';
      setTimeout(() => { delete stage.dataset.suppressClick; }, 280);
    }
    dragging = false;
  };

  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches[0]) onDown(e.touches[0].clientX);
    },
    { passive: true }
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches[0]) onMove(e.touches[0].clientX);
    },
    { passive: true }
  );
  stage.addEventListener('touchend', onUp);
  stage.addEventListener('touchcancel', onUp);

  stage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    onDown(e.clientX);
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging) onMove(e.clientX);
  });
  window.addEventListener('mouseup', onUp);

  // wheel support
  stage.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) && Math.abs(e.deltaY) < 2) return;
      e.preventDefault();
      const d = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (d > 8 && state.fanCenter < state.remainingFan.length - 1) {
        state.fanCenter += 1;
        renderFan(false);
      } else if (d < -8 && state.fanCenter > 0) {
        state.fanCenter -= 1;
        renderFan(false);
      }
    },
    { passive: false }
  );
}

function flipAll() {
  const cards = $$('#spread-board .card');
  state.drawnSlots.forEach((item, i) => {
    if (!item || item.flipped) return;
    item.flipped = true;
    const cardEl = cards[i];
    if (cardEl) {
      cardEl.classList.add('is-flipping');
      // stagger for a softer wave
      setTimeout(() => {
        cardEl.classList.add('flipped');
        cardEl.setAttribute('aria-label', item.card.name);
        setTimeout(() => cardEl.classList.remove('is-flipping'), 1000);
      }, i * 90);
    }
  });
  setTimeout(updateRevealBar, state.count * 90 + 50);
}

function updateRevealBar() {
  const drawn = state.drawnSlots.filter(Boolean);
  const allFilled = drawn.length === state.count && state.count > 0;
  const allFlipped = allFilled && drawn.every((d) => d.flipped);
  const flipBtn = $('#btn-flip-all');
  if (flipBtn) {
    // only show if any still face-down
    const anyDown = drawn.some((d) => !d.flipped);
    flipBtn.style.display = anyDown ? '' : 'none';
    flipBtn.disabled = allFlipped || !anyDown;
    flipBtn.textContent = allFlipped ? '已全部翻开' : '全部翻开';
  }
}

function initDraw() {
  $('#btn-draw-back').addEventListener('click', () => {
    closeSheet();
    renderMode();
    showScreen('mode');
  });
  $('#btn-auto-pick').addEventListener('click', autoPickOne);
  $('#btn-flip-all').addEventListener('click', flipAll);
  $('#btn-again').addEventListener('click', () => {
    closeSheet();
    renderMode();
    showScreen('mode');
  });
  initFanGestures();
}

/* ——— Detail sheet ——— */
function openSheet(index) {
  const item = state.drawnSlots[index];
  if (!item || !item.flipped) return;
  const pos = state.positions[index];

  const sheet = $('#detail-sheet');
  const backdrop = $('#sheet-backdrop');
  const mini = $('#sheet-mini');
  const hasImg = imageCache.get(item.card.id);

  if (hasImg) {
    mini.innerHTML = `<img src="${item.card.image}" alt="" />`;
  } else {
    mini.innerHTML = `<span class="num">${pad2(item.card.id)}</span>`;
  }

  $('#sheet-pos').textContent = pos.label + (pos.hint ? ` · ${pos.hint}` : '');
  $('#sheet-name').textContent = item.card.name;
  $('#sheet-prompt').textContent = item.card.prompt;

  const layers = $('#sheet-layers');
  layers.innerHTML = REFLECTION_LAYERS.map(
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

function closeSheet() {
  $('#sheet-backdrop').classList.remove('open');
  $('#detail-sheet').classList.remove('open');
  $('#detail-sheet').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initSheet() {
  $('#btn-sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
}

/* ——— Boot ——— */
function boot() {
  initHome();
  initMode();
  initDraw();
  initSheet();
  showScreen('home');
}

boot();
