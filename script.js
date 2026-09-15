'use strict';
/* =========================================================================
   BATTLE MAKER — vanilla JS 단일 스크립트
   구조: Editor(제작) -> Battle Data(JSON, localStorage) -> Runtime(Play) -> Playable
   빌드 도구 없이 index.html을 그대로 열거나 정적 호스팅(Vercel)에 올리면 동작합니다.
   ========================================================================= */

/* ------------------------------------------------------------------ *
 * 0. 공용 유틸
 * ------------------------------------------------------------------ */
function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('ko-KR'); } catch { return ''; }
}

/* ------------------------------------------------------------------ *
 * 1. 데이터 타입 상수 (types.ts 대응)
 * ------------------------------------------------------------------ */
const LAYER_ORDER = ['boss', 'player', 'bullet', 'laser', 'wall', 'obstacle', 'text', 'image'];
const LAYER_LABEL = {
  boss: 'BOSS', player: 'PLAYER', bullet: 'BULLETS', laser: 'LASER',
  wall: 'WALLS', obstacle: 'OBJECTS', text: 'TEXT', image: 'IMAGE',
};
const OBJECT_BUTTONS = [
  { type: 'boss', label: '보스', icon: '👹' },
  { type: 'player', label: '플레이어', icon: '🔵' },
  { type: 'bullet', label: '탄환', icon: '●' },
  { type: 'laser', label: '레이저', icon: '▬' },
  { type: 'wall', label: '벽', icon: '▮' },
  { type: 'obstacle', label: '장애물', icon: '◆' },
  { type: 'text', label: '텍스트', icon: 'T' },
  { type: 'image', label: '이미지', icon: '🖼' },
];
const EFFECT_TYPES = ['shake', 'flash', 'fadeIn', 'fadeOut', 'darken', 'brighten', 'particle', 'explosion', 'shockwave'];

/* ------------------------------------------------------------------ *
 * 2. 오브젝트/키프레임 팩토리 (utils/factory.ts 대응)
 * ------------------------------------------------------------------ */
let zCounter = 1;

function makeKeyframe(partial) {
  return Object.assign({ id: uid(), x: 50, y: 50, scale: 1, rotation: 0, opacity: 1 }, partial);
}

function defaultName(type) {
  return ({ boss: '보스', player: '플레이어', bullet: '탄환', laser: '레이저', wall: '벽', obstacle: '장애물', text: '텍스트', image: '이미지' })[type];
}
function defaultSize(type) {
  return ({
    boss: { w: 14, h: 22 }, player: { w: 4, h: 4 }, bullet: { w: 3, h: 3 },
    laser: { w: 60, h: 3 }, wall: { w: 20, h: 6 }, obstacle: { w: 8, h: 8 },
  })[type] || { w: 10, h: 6 };
}
function defaultColor(type) {
  return ({ boss: '#e0446f', player: '#5cc8ff', bullet: '#ffd166', laser: '#ff3b3b', wall: '#666677', obstacle: '#8a8a99' })[type] || '#ffffff';
}

function createObject(type, overrides) {
  overrides = overrides || {};
  const size = defaultSize(type);
  const base = {
    id: uid(),
    type,
    name: defaultName(type),
    x: 50,
    y: type === 'boss' ? 25 : 80,
    scale: 1,
    rotation: 0,
    opacity: 1,
    width: size.w,
    height: size.h,
    color: defaultColor(type),
    shape: type === 'laser' ? 'square' : type === 'bullet' ? 'circle' : type === 'image' ? 'image' : 'square',
    spawnTime: 0,
    despawnTime: 9999,
    collidable: type === 'bullet' || type === 'laser' || type === 'obstacle',
    hp: type === 'boss' ? 100 : type === 'player' ? 20 : undefined,
    maxHp: type === 'boss' ? 100 : type === 'player' ? 20 : undefined,
    damage: type === 'bullet' ? 5 : type === 'laser' ? 10 : undefined,
    keyframes: [],
    zIndex: zCounter++,
    laser: type === 'laser' ? { warnStart: 0, fireStart: 1, fireEnd: 2, length: 60, thickness: 14 } : undefined,
    frames: { idle: [], hit: [], attack: [], death: [] }, // 상태별 스프라이트 프레임(이미지 배열) - 있으면 이걸 우선 재생
    frameFps: 8,
  };
  Object.assign(base, overrides);
  base.keyframes = [makeKeyframe({ time: base.spawnTime, x: base.x, y: base.y, scale: base.scale, rotation: base.rotation, opacity: base.opacity })];
  return base;
}

/* ------------------------------------------------------------------ *
 * 3. 보간 (utils/interpolate.ts 대응)
 * ------------------------------------------------------------------ */
function getTransformAtTime(obj, time, smoothing) {
  if (smoothing === undefined) smoothing = true;
  const kfs = obj.keyframes;
  if (!kfs || kfs.length === 0) {
    return { x: obj.x, y: obj.y, scale: obj.scale, rotation: obj.rotation, opacity: obj.opacity };
  }
  const sorted = kfs.slice().sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) {
    const k = sorted[0];
    return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const k = sorted[sorted.length - 1];
    return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity };
  }
  let prev = sorted[0], next = sorted[sorted.length - 1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].time <= time && sorted[i + 1].time >= time) { prev = sorted[i]; next = sorted[i + 1]; break; }
  }
  const span = next.time - prev.time;
  let t = span === 0 ? 0 : (time - prev.time) / span;
  if (smoothing) t = smoothstep(t);
  return {
    x: lerp(prev.x, next.x, t), y: lerp(prev.y, next.y, t),
    scale: lerp(prev.scale, next.scale, t), rotation: lerp(prev.rotation, next.rotation, t),
    opacity: lerp(prev.opacity, next.opacity, t),
  };
}
function isObjectActive(obj, time) { return time >= obj.spawnTime && time <= obj.despawnTime; }

/* ------------------------------------------------------------------ *
 * 4. 샘플 보스전 (data/sampleBattle.ts 대응)
 * ------------------------------------------------------------------ */
const SAMPLE_BATTLE_ID = 'sample-001';

function bulletWave(prefix, startTime, damage, xs) {
  return xs.map((x, i) => ({
    id: prefix + '-' + i, type: 'bullet', name: '탄환', x, y: 15, scale: 1, rotation: 0, opacity: 1,
    width: 3.2, height: 3.2, color: '#ffd166', shape: 'circle', damage,
    spawnTime: startTime, despawnTime: startTime + 4, collidable: true, zIndex: 5,
    keyframes: [
      { id: prefix + '-' + i + '-k1', time: startTime, x, y: 15, scale: 1, rotation: 0, opacity: 1 },
      { id: prefix + '-' + i + '-k2', time: startTime + 4, x: x + (i % 2 === 0 ? -8 : 8), y: 95, scale: 1, rotation: 0, opacity: 1 },
    ],
  }));
}

function buildSampleBattle() {
  const now = new Date().toISOString();
  return {
    id: SAMPLE_BATTLE_ID,
    name: '샘플 보스전 - 심연의 파수꾼',
    createdAt: now, updatedAt: now, duration: 20,
    background: { type: 'gradient', value: 'linear-gradient(180deg,#1a0a1f 0%,#0a0a12 60%,#050507 100%)' },
    settings: { allowPlayerAttack: true, playerAttackDamage: 6, playerAttackCooldown: 0.4, invincibilityDuration: 1.0 },
    dialogues: [
      { id: 'd1', start: 1.5, end: 4, text: '여기까지 왔군.', display: 'above', speakerObjectId: 'boss1' },
      { id: 'd2', start: 4, end: 6.5, text: '그럼... 시작하지.', display: 'above', speakerObjectId: 'boss1' },
      { id: 'd3', start: 15, end: 17, text: '제법이군!', display: 'above', speakerObjectId: 'boss1' },
    ],
    effects: [
      { id: 'e1', time: 0, duration: 1, type: 'fadeIn' },
      { id: 'e2', time: 6, duration: 0.4, type: 'flash' },
      { id: 'e3', time: 10, duration: 0.6, type: 'shake' },
    ],
    objects: [
      {
        id: 'boss1', type: 'boss', name: '심연의 파수꾼', x: 50, y: 22, scale: 1, rotation: 0, opacity: 1,
        width: 16, height: 26, color: '#c23a63', shape: 'square', hp: 100, maxHp: 100,
        spawnTime: 0, despawnTime: 9999, collidable: false, zIndex: 10,
        keyframes: [
          { id: 'bk1', time: 0, x: 50, y: 15, scale: 0.2, rotation: 0, opacity: 0 },
          { id: 'bk2', time: 1.2, x: 50, y: 22, scale: 1, rotation: 0, opacity: 1 },
          { id: 'bk3', time: 6, x: 25, y: 25, scale: 1, rotation: -8, opacity: 1 },
          { id: 'bk4', time: 10, x: 75, y: 25, scale: 1, rotation: 8, opacity: 1 },
          { id: 'bk5', time: 14, x: 50, y: 20, scale: 1.1, rotation: 0, opacity: 1 },
          { id: 'bk6', time: 20, x: 50, y: 20, scale: 1.1, rotation: 0, opacity: 1 },
        ],
      },
      {
        id: 'player1', type: 'player', name: '플레이어', x: 50, y: 80, scale: 1, rotation: 0, opacity: 1,
        width: 4, height: 4, color: '#5cc8ff', shape: 'circle', hp: 20, maxHp: 20,
        spawnTime: 0, despawnTime: 9999, collidable: true, zIndex: 20,
        keyframes: [{ id: 'pk1', time: 0, x: 50, y: 80, scale: 1, rotation: 0, opacity: 1 }],
      },
      ...bulletWave('wave1', 7, 5, [10, 20, 30, 40, 50, 60, 70, 80, 90]),
      ...bulletWave('wave2', 11.5, 5, [15, 30, 45, 60, 75]),
      {
        id: 'laser1', type: 'laser', name: '레이저', x: 50, y: 45, scale: 1, rotation: 0, opacity: 1,
        width: 90, height: 3, color: '#ff3b3b', shape: 'square', damage: 12,
        spawnTime: 16, despawnTime: 19, collidable: true, zIndex: 15,
        laser: { warnStart: 16, fireStart: 17.2, fireEnd: 18.6, length: 90, thickness: 16 },
        keyframes: [{ id: 'lk1', time: 16, x: 50, y: 45, scale: 1, rotation: 0, opacity: 1 }],
      },
    ],
  };
}

function emptyBattle() {
  const now = new Date().toISOString();
  const boss = createObject('boss', { x: 50, y: 22 });
  const player = createObject('player', { x: 50, y: 80 });
  return {
    id: uid(), name: '이름 없는 전투', createdAt: now, updatedAt: now, duration: 15,
    background: { type: 'dark', value: '' },
    settings: { allowPlayerAttack: true, playerAttackDamage: 5, playerAttackCooldown: 0.4, invincibilityDuration: 1 },
    objects: [boss, player], dialogues: [], effects: [],
  };
}

/* ------------------------------------------------------------------ *
 * 5. 저장소 계층 (storage/battleRepository.ts 대응)
 *    지금은 localStorage. 나중에 서버로 교체할 때는 이 5개 함수만 바꾸면 된다.
 * ------------------------------------------------------------------ */
const STORAGE_KEY = 'battlemaker:battles:v1';
function readAll() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function writeAll(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }

const battleRepository = {
  list() {
    const all = readAll();
    return Object.values(all).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  },
  get(id) { return readAll()[id]; },
  save(battle) {
    const all = readAll();
    battle.updatedAt = new Date().toISOString();
    all[battle.id] = battle;
    writeAll(all);
  },
  remove(id) {
    const all = readAll();
    delete all[id];
    writeAll(all);
  },
};
function ensureSampleBattle() {
  if (!battleRepository.get(SAMPLE_BATTLE_ID)) battleRepository.save(buildSampleBattle());
}

/* ------------------------------------------------------------------ *
 * 6. 라우터 (해시 기반 - Vercel 정적 배포에서 새로고침/딥링크 안전)
 * ------------------------------------------------------------------ */
let activeCleanupFns = [];
function onCleanup(fn) { activeCleanupFns.push(fn); }
function teardownView() { activeCleanupFns.forEach((fn) => { try { fn(); } catch (e) { /* noop */ } }); activeCleanupFns = []; }

function navigate(hash) { location.hash = hash; }

/* ---- 공유 링크 인코딩/디코딩 (전투 데이터를 URL에 직접 담아 서버 없이 공유) ---- */
function encodeBattleForUrl(battle) {
  const json = JSON.stringify(battle);
  return encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
}
function decodeBattleFromUrl(encoded) {
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(encoded))));
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
function buildShareUrl(battle) {
  const base = location.origin + location.pathname;
  return `${base}#/battle/${battle.id}?d=${encodeBattleForUrl(battle)}`;
}

function route() {
  teardownView();
  const app = document.getElementById('app');
  app.innerHTML = '';
  let raw = location.hash.replace(/^#\/?/, '');
  let query = '';
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) { query = raw.slice(qIdx + 1); raw = raw.slice(0, qIdx); }
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0) renderHome(app);
  else if (parts[0] === 'library') renderLibrary(app);
  else if (parts[0] === 'edit' && parts[1]) renderEditor(app, parts[1]);
  else if (parts[0] === 'battle' && parts[1]) renderPlay(app, parts[1], query);
  else renderHome(app);
}
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { ensureSampleBattle(); route(); });

/* ------------------------------------------------------------------ *
 * 7. 전투 캔버스 공용 렌더러 (components/BattleCanvas.tsx 대응)
 *    - 에디터 미리보기 / 라이브러리 카드 / 플레이 화면 3곳에서 재사용
 * ------------------------------------------------------------------ */
function shapeStyle(shape) {
  switch (shape) {
    case 'circle': return 'border-radius:50%;';
    case 'diamond': return 'clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);';
    case 'triangle': return 'clip-path:polygon(50% 0%,100% 100%,0% 100%);';
    default: return 'border-radius:2px;';
  }
}
function backgroundCss(bg) {
  switch (bg.type) {
    case 'color': return bg.value || '#111111';
    case 'gradient': return bg.value || 'linear-gradient(180deg,#111,#000)';
    case 'image': return bg.value ? `center/cover no-repeat url(${bg.value})` : '#0a0a0c';
    default: return '#0a0a0c';
  }
}
function computeEffects(battle, time) {
  const active = battle.effects.filter((e) => time >= e.time && time <= e.time + e.duration);
  let darken = 0, brighten = 0, flash = 0, fadeBlack = 0, shakeX = 0, shakeY = 0;
  const particles = [];
  for (const e of active) {
    const t = (time - e.time) / e.duration;
    if (e.type === 'darken') darken = Math.max(darken, 0.6 * Math.sin(Math.PI * Math.min(1, t)));
    if (e.type === 'brighten') brighten = Math.max(brighten, 0.5 * Math.sin(Math.PI * Math.min(1, t)));
    if (e.type === 'flash') flash = Math.max(flash, 1 - t);
    if (e.type === 'fadeIn') fadeBlack = Math.max(fadeBlack, 1 - t);
    if (e.type === 'fadeOut') fadeBlack = Math.max(fadeBlack, t);
    if (e.type === 'shake') {
      const amp = 6 * (1 - t);
      shakeX += Math.sin(time * 90) * amp;
      shakeY += Math.cos(time * 70) * amp;
    }
    if (e.type === 'particle' || e.type === 'explosion' || e.type === 'shockwave') particles.push({ type: e.type, t });
  }
  return { darken, brighten, flash, fadeBlack, shakeX, shakeY, particles };
}

/**
 * container(빈 div) 안에 battle 상태를 currentTime 기준으로 그려 넣는다.
 * opts: { editable, selectedObjectId, onSelectObject(id), onDragObject(id,x,y), overridePositions }
 */
function renderBattleCanvasInto(container, battle, currentTime, opts) {
  opts = opts || {};
  container.innerHTML = '';
  container.classList.add('battle-canvas');
  container.style.background = backgroundCss(battle.background);

  if (opts.editable) {
    container.onpointerdown = (e) => {
      if (e.target === container || e.target.classList.contains('bc-inner')) {
        opts.onSelectObject && opts.onSelectObject(null);
      }
    };
  }

  const inner = el('div', 'bc-inner');
  const eff = computeEffects(battle, currentTime);
  inner.style.transform = `translate(${eff.shakeX}px, ${eff.shakeY}px)`;

  const sorted = battle.objects.slice().sort((a, b) => a.zIndex - b.zIndex);
  for (const obj of sorted) {
    if (!isObjectActive(obj, currentTime)) continue;
    const node = renderObjectNode(obj, battle, currentTime, opts, container);
    if (node) inner.appendChild(node);
  }

  for (const d of battle.dialogues) {
    const node = renderDialogueNode(d, battle, currentTime);
    if (node) inner.appendChild(node);
  }

  // 이펙트 오버레이
  const flashDiv = el('div', 'bc-effect-flash'); flashDiv.style.opacity = eff.flash * 0.9; inner.appendChild(flashDiv);
  const darkDiv = el('div', 'bc-effect-dark'); darkDiv.style.opacity = Math.max(eff.darken, eff.fadeBlack); inner.appendChild(darkDiv);
  const brightDiv = el('div', 'bc-effect-bright'); brightDiv.style.opacity = eff.brighten * 0.4; inner.appendChild(brightDiv);
  for (const p of eff.particles) {
    const size = p.type === 'shockwave' ? 40 + p.t * 200 : 20 + p.t * 100;
    const pd = el('div', 'bc-particle');
    pd.style.width = size + 'px'; pd.style.height = size + 'px';
    pd.style.transform = 'translate(-50%,-50%)';
    pd.style.opacity = String(1 - p.t);
    if (p.type === 'shockwave') { pd.style.border = '3px solid #ffcf6e'; }
    else { pd.style.background = 'radial-gradient(circle,#ffdd88,transparent 70%)'; }
    inner.appendChild(pd);
  }

  container.appendChild(inner);
}

/**
 * 오브젝트의 상태별 업로드 프레임(idle/hit/attack/death) 중 지금 재생해야 할 프레임의
 * 이미지 src를 계산한다. 우선순위: 사망 > 피격 > 공격 > 기본(idle). 업로드된 프레임이
 * 하나도 없으면 null을 반환하고, 호출부는 기존 도형/단일 이미지 렌더링으로 대체한다.
 */
function pickCurrentFrame(obj, time, opts) {
  const frames = obj.frames;
  if (!frames) return null;
  const fps = obj.frameFps || 8;

  if (opts.now != null && opts.dying && opts.dying.objId === obj.id && frames.death && frames.death.length) {
    const elapsed = Math.max(0, opts.now - opts.dying.start);
    const idx = Math.min(frames.death.length - 1, Math.floor(elapsed * fps));
    return frames.death[idx];
  }
  const hit = opts.hitFlash && opts.hitFlash[obj.id];
  if (opts.now != null && hit && opts.now < hit.end && frames.hit && frames.hit.length) {
    const elapsed = Math.max(0, opts.now - hit.start);
    const idx = Math.floor(elapsed * fps) % frames.hit.length;
    return frames.hit[idx];
  }
  const pulse = opts.attackPulse && opts.attackPulse[obj.id];
  if (opts.now != null && pulse && opts.now < pulse.end && frames.attack && frames.attack.length) {
    const elapsed = Math.max(0, opts.now - pulse.start);
    const idx = Math.floor(elapsed * fps) % frames.attack.length;
    return frames.attack[idx];
  }
  if (frames.idle && frames.idle.length) {
    const idx = Math.floor(Math.max(0, time) * fps) % frames.idle.length;
    return frames.idle[idx];
  }
  return null;
}

function renderObjectNode(obj, battle, time, opts, outerContainer) {
  const tr = getTransformAtTime(obj, time);
  const override = opts.overridePositions && opts.overridePositions[obj.id];
  const x = override ? override.x : tr.x;
  const y = override ? override.y : tr.y;
  const selected = opts.selectedObjectId === obj.id;

  // 레이저는 별도 렌더링 (경고선 -> 발사)
  if (obj.type === 'laser' && obj.laser) {
    const { warnStart, fireStart, fireEnd } = obj.laser;
    let visual = 'hidden';
    if (time >= warnStart && time < fireStart) visual = 'warn';
    else if (time >= fireStart && time <= fireEnd) visual = 'fire';
    if (visual === 'hidden') return null;
    const node = el('div');
    node.style.position = 'absolute';
    node.style.left = x + '%';
    node.style.top = y + '%';
    node.style.width = obj.laser.length + '%';
    node.style.height = (visual === 'fire' ? obj.laser.thickness : Math.max(2, obj.laser.thickness / 4)) + 'px';
    node.style.background = visual === 'fire'
      ? `linear-gradient(90deg, transparent, ${obj.color}, ${obj.color}, transparent)`
      : `repeating-linear-gradient(90deg, ${obj.color}55 0 6px, transparent 6px 12px)`;
    node.style.boxShadow = visual === 'fire' ? `0 0 16px 4px ${obj.color}aa` : 'none';
    node.style.transform = `translate(-50%,-50%) rotate(${obj.rotation}deg)`;
    node.style.opacity = visual === 'warn' ? '0.8' : '1';
    node.style.zIndex = String(obj.zIndex);
    node.style.outline = selected ? '2px solid #6cf7ff' : 'none';
    node.style.cursor = opts.editable ? 'move' : 'default';
    node.title = obj.name;
    node.dataset.objectId = obj.id;
    if (opts.editable) attachDrag(node, obj, opts, outerContainer);
    return node;
  }

  const node = el('div', 'bc-object no-select');
  node.style.left = x + '%';
  node.style.top = y + '%';
  const correctedH = obj.height * (16 / 9); // 16:9 캔버스 보정 (원이 타원으로 보이지 않도록)
  node.style.width = obj.width + '%';
  node.style.height = correctedH + '%';

  // ---- 피격/공격/사망 실시간 시각 효과 ----
  const frameSrc = pickCurrentFrame(obj, time, opts);
  const usingDeathFrames = !!(opts.dying && opts.dying.objId === obj.id && obj.frames && obj.frames.death && obj.frames.death.length && frameSrc);
  let extraScale = 1, extraOpacity = 1, filterStr = '';
  if (opts.now != null) {
    const hit = opts.hitFlash && opts.hitFlash[obj.id];
    if (hit && opts.now < hit.end) {
      const remain = Math.max(0, hit.end - opts.now) / Math.max(0.001, hit.end - hit.start);
      filterStr += ` brightness(${1 + remain * 3.5}) saturate(${1 + remain * 2})`;
    }
    const pulse = opts.attackPulse && opts.attackPulse[obj.id];
    if (pulse && opts.now < pulse.end) {
      const remain = Math.max(0, pulse.end - opts.now) / Math.max(0.001, pulse.end - pulse.start);
      extraScale *= 1 + remain * 0.35;
    }
    // 실제 사망 프레임 이미지가 있으면 그 애니메이션 자체가 사망 연출이므로,
    // 축소/페이드/흑백 효과를 추가로 겹치지 않는다(있으면 이중 연출로 어색해짐).
    if (opts.dying && opts.dying.objId === obj.id && !usingDeathFrames) {
      const t = clamp((opts.now - opts.dying.start) / opts.dying.duration, 0, 1);
      extraScale *= Math.max(0.05, 1 - t * 0.9);
      extraOpacity *= Math.max(0, 1 - t);
      filterStr += ` grayscale(${t})`;
    }
  }

  node.style.transform = `translate(-50%,-50%) rotate(${tr.rotation}deg) scale(${tr.scale * extraScale})`;
  node.style.opacity = String(tr.opacity * extraOpacity);
  if (filterStr) node.style.filter = filterStr.trim();
  node.style.zIndex = String(obj.zIndex);
  node.style.outline = selected ? '2px solid #6cf7ff' : 'none';
  node.style.outlineOffset = '2px';
  node.style.cursor = opts.editable ? 'move' : 'default';
  node.title = obj.name;
  node.dataset.objectId = obj.id;

  if (frameSrc) {
    const img = el('img'); img.src = frameSrc; img.alt = obj.name;
    node.appendChild(img);
  } else if (obj.shape === 'image' && obj.imageUrl) {
    const img = el('img'); img.src = obj.imageUrl; img.alt = obj.name;
    node.appendChild(img);
  } else if (obj.type === 'text') {
    const span = el('span', 'bc-object-text', obj.name);
    span.style.color = obj.color;
    node.appendChild(span);
  } else {
    const shape = el('div', 'bc-object-shape');
    shape.style.cssText += shapeStyle(obj.shape) + `background:${obj.color};`;
    if (obj.type === 'boss') shape.style.boxShadow = `0 0 24px 2px ${obj.color}66`;
    if (obj.type === 'player') shape.style.boxShadow = `0 0 12px 3px ${obj.color}88`;
    node.appendChild(shape);
  }

  if (obj.type === 'boss' && obj.hp !== undefined && obj.maxHp) {
    const wrap = el('div', 'bc-hpbar-wrap');
    const fill = el('div', 'bc-hpbar-fill');
    fill.style.width = Math.max(0, (obj.hp / obj.maxHp) * 100) + '%';
    wrap.appendChild(fill);
    node.appendChild(wrap);
  }

  if (opts.editable) attachDrag(node, obj, opts, outerContainer);
  return node;
}

function attachDrag(node, obj, opts, outerContainer) {
  node.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (!opts.editable) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = outerContainer.getBoundingClientRect();
    const DRAG_THRESHOLD = 3; // px - 이 이상 움직여야 "드래그"로 인정 (그 전엔 순수 클릭)
    let dragging = false;

    const move = (ev) => {
      if (!dragging) {
        const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (moved <= DRAG_THRESHOLD) return;
        dragging = true;
        opts.onDragStart && opts.onDragStart(obj.id); // 여기서 딱 1번만 undo 기록 + 선택
      }
      // 드래그 중에는 데이터/기록을 매번 건드리지 않고, 화면만 즉시 이동시켜 부드럽게 만든다.
      const nx = clamp(((ev.clientX - rect.left) / rect.width) * 100, 0, 100);
      const ny = clamp(((ev.clientY - rect.top) / rect.height) * 100, 0, 100);
      node.style.left = nx + '%';
      node.style.top = ny + '%';
      opts.onDragMove && opts.onDragMove(obj.id, nx, ny);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dragging) {
        opts.onDragEnd && opts.onDragEnd(obj.id); // 드래그가 끝난 뒤 딱 1번 전체 정리(패널/타임라인 갱신)
      } else {
        opts.onSelectObject && opts.onSelectObject(obj.id); // 실제로 안 움직였으면 순수 클릭 -> 선택 토글
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function renderDialogueNode(d, battle, time) {
  if (time < d.start || time > d.end) return null;
  const speaker = d.speakerObjectId ? battle.objects.find((o) => o.id === d.speakerObjectId) : null;
  const pos = speaker ? getTransformAtTime(speaker, time) : { x: 50, y: 50 };
  const fadeT = Math.min(1, Math.min(time - d.start, d.end - time) / 0.3);
  const opacity = clamp(fadeT, 0, 1);
  const node = el('div', 'bc-dialogue ' + d.display, d.text);
  node.style.opacity = String(opacity);
  if (d.display === 'bottom' || d.display === 'center') {
    // 고정 위치 (CSS로 처리됨)
  } else {
    node.style.left = pos.x + '%';
    node.style.top = pos.y + '%';
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * 8. 홈 화면
 * ------------------------------------------------------------------ */
function renderHome(app) {
  const count = battleRepository.list().length;
  const page = el('div', 'home-screen');
  page.innerHTML = `
    <div class="home-glow"></div>
    <div class="home-title-wrap">
      <div class="home-kicker">WEB BOSS BATTLE MAKER</div>
      <h1 class="home-title">BATTLE <span>MAKER</span></h1>
      <p class="home-sub">보스전을 직접 제작하고, 저장하고, 바로 플레이하세요.</p>
    </div>
    <div class="home-buttons">
      <button class="btn btn-primary" id="btn-new">＋ 새 전투 만들기</button>
      <button class="btn" id="btn-library">내 전투 ${count > 0 ? `(${count})` : ''}</button>
      <button class="btn btn-success" id="btn-sample">▶ 샘플 보스전 바로 플레이</button>
    </div>
    <div class="home-footer">Vercel 배포 준비 완료 · 데이터는 이 브라우저(localStorage)에 저장됩니다</div>
  `;
  app.appendChild(page);

  page.querySelector('#btn-new').onclick = () => {
    const b = emptyBattle();
    battleRepository.save(b);
    navigate(`#/edit/${b.id}`);
  };
  page.querySelector('#btn-library').onclick = () => navigate('#/library');
  page.querySelector('#btn-sample').onclick = () => navigate(`#/battle/${SAMPLE_BATTLE_ID}`);
}

/* ------------------------------------------------------------------ *
 * 9. 내 전투 라이브러리
 * ------------------------------------------------------------------ */
function renderLibrary(app) {
  const page = el('div', 'library-page');
  const header = el('div', 'library-header');
  header.innerHTML = `
    <button class="link-back" id="lib-back">← 홈</button>
    <h1>내 전투</h1>
    <div class="spacer"></div>
    <button class="btn btn-sm" id="lib-import">⬆ 가져오기</button>
    <button class="btn btn-primary btn-sm" id="lib-new">＋ 새 전투</button>
  `;
  page.appendChild(header);

  const battles = battleRepository.list();
  if (battles.length === 0) {
    page.appendChild(el('div', 'empty-msg', '아직 제작한 전투가 없습니다.'));
  }
  const grid = el('div', 'battle-grid');
  page.appendChild(grid);
  app.appendChild(page);

  header.querySelector('#lib-back').onclick = () => navigate('#/');
  header.querySelector('#lib-new').onclick = () => {
    const b = emptyBattle();
    battleRepository.save(b);
    navigate(`#/edit/${b.id}`);
  };
  header.querySelector('#lib-import').onclick = () => {
    const input = el('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        parsed.id = uid();
        parsed.updatedAt = new Date().toISOString();
        battleRepository.save(parsed);
        navigate(`#/edit/${parsed.id}`);
      } catch (e) {
        alert('전투 파일을 읽는 데 실패했습니다.');
      }
    };
    input.click();
  };

  battles.forEach((b) => grid.appendChild(buildBattleCard(b, () => refreshLibraryInPlace(app))));
}

function refreshLibraryInPlace(app) {
  // 카드 조작(삭제/복제/이름변경) 후 라이브러리 화면을 다시 그린다.
  app.innerHTML = '';
  renderLibrary(app);
}

function buildBattleCard(b, onChange) {
  const card = el('div', 'battle-card');
  const preview = el('div', 'battle-card-preview');
  card.appendChild(preview);
  renderBattleCanvasInto(preview, b, 0.01, {});

  const body = el('div', 'battle-card-body');
  const nameRow = el('div', 'battle-card-name', b.name);
  const dateRow = el('div', 'battle-card-date', fmtDate(b.updatedAt));
  const actions = el('div', 'battle-card-actions');
  actions.innerHTML = `
    <button class="btn btn-primary btn-sm" data-act="play">PLAY</button>
    <button class="btn btn-sm" data-act="edit">EDIT</button>
    <button class="btn btn-sm" data-act="share">공유</button>
    <button class="btn btn-sm" data-act="rename">이름변경</button>
    <button class="btn btn-sm" data-act="dup">복제</button>
    <button class="btn btn-danger btn-sm" data-act="del">삭제</button>
  `;
  body.appendChild(nameRow);
  body.appendChild(dateRow);
  body.appendChild(actions);
  card.appendChild(body);

  actions.querySelector('[data-act="play"]').onclick = () => navigate(`#/battle/${b.id}`);
  actions.querySelector('[data-act="edit"]').onclick = () => navigate(`#/edit/${b.id}`);
  actions.querySelector('[data-act="share"]').onclick = async () => {
    const url = buildShareUrl(b);
    try {
      await navigator.clipboard.writeText(url);
      alert(url.length > 6000 ? '공유 링크를 복사했습니다 (이미지/음악이 커서 링크가 깁니다).' : '공유 링크를 복사했습니다.');
    } catch (e) {
      prompt('이 링크를 복사하세요:', url);
    }
  };
  actions.querySelector('[data-act="dup"]').onclick = () => {
    const clone = Object.assign({}, b, { id: uid(), name: b.name + ' 사본', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    battleRepository.save(clone);
    onChange();
  };
  actions.querySelector('[data-act="del"]').onclick = () => {
    if (!confirm('이 전투를 삭제할까요? 되돌릴 수 없습니다.')) return;
    battleRepository.remove(b.id);
    onChange();
  };
  actions.querySelector('[data-act="rename"]').onclick = () => {
    const input = el('input', 'battle-card-name-input');
    input.value = b.name;
    nameRow.replaceWith(input);
    input.focus();
    const commit = () => { battleRepository.save(Object.assign({}, b, { name: input.value || b.name })); onChange(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') commit(); };
    input.onblur = commit;
  };

  return card;
}

/* ------------------------------------------------------------------ *
 * 10. 에디터 (제작 화면)
 * ------------------------------------------------------------------ */
const editorState = {
  battle: null,
  selectedObjectId: null,
  selectedDialogueId: null,
  showBattleSettings: false, // 처음엔 오른쪽 패널이 닫혀 있고, "설정" 버튼이나 오브젝트 클릭으로만 연다
  currentTime: 0,
  isPlaying: false,
  pixelsPerSecond: 80,
  clipboard: null,
  undoStack: [],
  redoStack: [],
};

function snapshotBattle() { return JSON.stringify(editorState.battle); }
function pushHistory() {
  editorState.undoStack.push(snapshotBattle());
  if (editorState.undoStack.length > 50) editorState.undoStack.shift();
  editorState.redoStack = [];
}
function undo() {
  if (!editorState.undoStack.length) return;
  editorState.redoStack.push(snapshotBattle());
  editorState.battle = JSON.parse(editorState.undoStack.pop());
  renderEditorAll();
}
function redo() {
  if (!editorState.redoStack.length) return;
  editorState.undoStack.push(snapshotBattle());
  editorState.battle = JSON.parse(editorState.redoStack.pop());
  renderEditorAll();
}

function findObj(id) { return editorState.battle.objects.find((o) => o.id === id); }

function actionAddObject(type) {
  pushHistory();
  const obj = createObject(type, { spawnTime: editorState.currentTime });
  editorState.battle.objects.push(obj);
  editorState.selectedObjectId = obj.id;
  editorState.selectedDialogueId = null;
  editorState.showBattleSettings = false;
  renderEditorAll();
}
function actionUpdateObject(id, patch, silent) {
  const o = findObj(id);
  if (!o) return;
  if (!silent) pushHistory();
  Object.assign(o, patch);
  renderEditorAll();
}
function actionDeleteObject(id) {
  pushHistory();
  editorState.battle.objects = editorState.battle.objects.filter((o) => o.id !== id);
  if (editorState.selectedObjectId === id) editorState.selectedObjectId = null;
  renderEditorAll();
}
function actionDuplicateObject(id) {
  const src = findObj(id);
  if (!src) return;
  pushHistory();
  const clone = JSON.parse(JSON.stringify(src));
  clone.id = uid();
  clone.name = src.name + ' 사본';
  clone.x = Math.min(96, src.x + 4);
  clone.y = Math.min(96, src.y + 4);
  clone.keyframes = src.keyframes.map((k) => Object.assign({}, k, { id: uid() }));
  clone.zIndex = zCounter++;
  editorState.battle.objects.push(clone);
  editorState.selectedObjectId = clone.id;
  renderEditorAll();
}
function actionCopySelected() {
  if (!editorState.selectedObjectId) return;
  const o = findObj(editorState.selectedObjectId);
  if (o) editorState.clipboard = JSON.parse(JSON.stringify(o));
}
function actionPaste() {
  if (!editorState.clipboard) return;
  pushHistory();
  const clone = JSON.parse(JSON.stringify(editorState.clipboard));
  clone.id = uid();
  clone.name = clone.name + ' 사본';
  clone.x = Math.min(96, clone.x + 4);
  clone.y = Math.min(96, clone.y + 4);
  clone.keyframes = clone.keyframes.map((k) => Object.assign({}, k, { id: uid() }));
  clone.zIndex = zCounter++;
  editorState.battle.objects.push(clone);
  editorState.selectedObjectId = clone.id;
  renderEditorAll();
}
function actionAddKeyframeAtCurrentTime(objectId) {
  const o = findObj(objectId);
  if (!o) return;
  pushHistory();
  const t = editorState.currentTime;
  const idx = o.keyframes.findIndex((k) => Math.abs(k.time - t) < 0.01);
  if (idx >= 0) Object.assign(o.keyframes[idx], { x: o.x, y: o.y, scale: o.scale, rotation: o.rotation, opacity: o.opacity });
  else o.keyframes.push(makeKeyframe({ time: t, x: o.x, y: o.y, scale: o.scale, rotation: o.rotation, opacity: o.opacity }));
  renderEditorAll();
}
function actionDeleteKeyframe(objectId, kfId) {
  const o = findObj(objectId);
  if (!o) return;
  pushHistory();
  o.keyframes = o.keyframes.filter((k) => k.id !== kfId);
  renderEditorAll();
}
function actionMoveObjectTo(objectId, x, y) {
  const o = findObj(objectId);
  if (!o) return;
  pushHistory();
  moveObjectData(o, x, y);
  renderEditorAll();
}

// 드래그 중에는 데이터만 조용히 갱신한다 (undo 기록 X, 재렌더 X) - 화면 이동은 attachDrag가 직접 처리.
function moveObjectDataSilently(objectId, x, y) {
  const o = findObj(objectId);
  if (!o) return;
  moveObjectData(o, x, y);
}
function moveObjectData(o, x, y) {
  const t = editorState.currentTime;
  o.x = x; o.y = y;
  const idx = o.keyframes.findIndex((k) => Math.abs(k.time - t) < 0.01);
  if (idx >= 0) { o.keyframes[idx].x = x; o.keyframes[idx].y = y; }
  else o.keyframes.push(makeKeyframe({ time: t, x, y, scale: o.scale, rotation: o.rotation, opacity: o.opacity }));
}

// 클릭(드래그 아님)으로 오브젝트를 고를 때: 같은 걸 다시 클릭하면 패널을 닫는다(토글).
function toggleSelectObject(id) {
  if (!id || editorState.selectedObjectId === id) editorState.selectedObjectId = null;
  else editorState.selectedObjectId = id;
  editorState.selectedDialogueId = null;
  editorState.showBattleSettings = false;
  renderToolPanel();
  renderPropertyPanel();
  renderTimelineSelectionOnly();
}
function toggleSelectDialogue(id) {
  if (!id || editorState.selectedDialogueId === id) editorState.selectedDialogueId = null;
  else editorState.selectedDialogueId = id;
  editorState.selectedObjectId = null;
  editorState.showBattleSettings = false;
  renderPropertyPanel();
  renderCanvas();
  renderTimeline();
}
function toggleBattleSettings() {
  editorState.showBattleSettings = !editorState.showBattleSettings;
  editorState.selectedObjectId = null;
  editorState.selectedDialogueId = null;
  renderToolPanel();
  renderPropertyPanel();
  renderTimeline();
}

function actionAddDialogue() {
  pushHistory();
  const t = editorState.currentTime;
  const d = { id: uid(), start: t, end: t + 2, text: '새 대사', display: 'bottom' };
  editorState.battle.dialogues.push(d);
  editorState.selectedDialogueId = d.id;
  editorState.selectedObjectId = null;
  editorState.showBattleSettings = false;
  renderEditorAll();
}
function actionUpdateDialogue(id, patch) {
  const d = editorState.battle.dialogues.find((x) => x.id === id);
  if (!d) return;
  pushHistory();
  Object.assign(d, patch);
  renderEditorAll();
}
function actionDeleteDialogue(id) {
  pushHistory();
  editorState.battle.dialogues = editorState.battle.dialogues.filter((d) => d.id !== id);
  if (editorState.selectedDialogueId === id) editorState.selectedDialogueId = null;
  renderEditorAll();
}
function actionAddEffect(type) {
  pushHistory();
  const t = editorState.currentTime;
  editorState.battle.effects.push({ id: uid(), time: t, duration: type === 'shake' ? 0.5 : 0.8, type });
  renderEditorAll();
}
function actionDeleteEffect(id) {
  pushHistory();
  editorState.battle.effects = editorState.battle.effects.filter((e) => e.id !== id);
  renderEditorAll();
}
function actionUpdateBackground(patch) { pushHistory(); Object.assign(editorState.battle.background, patch); renderEditorAll(); }
function actionUpdateMusic(patch) {
  pushHistory();
  if (!editorState.battle.music) editorState.battle.music = { startTime: 0, volume: 0.7, loop: true };
  Object.assign(editorState.battle.music, patch);
  renderEditorAll();
}
function actionUpdateSettings(patch) { pushHistory(); Object.assign(editorState.battle.settings, patch); renderEditorAll(); }
function actionUpdateMeta(patch) { pushHistory(); Object.assign(editorState.battle, patch); renderEditorAll(); }
function actionSave() { battleRepository.save(editorState.battle); }

let editorDom = {}; // 캐시된 DOM 참조

function renderEditor(app, id) {
  const b = battleRepository.get(id);
  if (!b) { navigate('#/library'); return; }
  editorState.battle = b;
  editorState.selectedObjectId = null;
  editorState.selectedDialogueId = null;
  editorState.showBattleSettings = false;
  editorState.currentTime = 0;
  editorState.isPlaying = false;
  editorState.undoStack = [];
  editorState.redoStack = [];

  const shell = el('div', 'editor-shell');
  shell.innerHTML = `
    <div class="editor-topbar">
      <button class="link-back" id="ed-home">← 홈</button>
      <div class="divider"></div>
      <span class="editor-logo">BATTLE MAKER</span>
      <span style="color:#555">/</span>
      <span class="editor-battle-name" id="ed-name-label"></span>
      <div class="spacer"></div>
      <span class="save-flash hidden" id="ed-saved-flash">저장됨 ✓</span>
      <button class="btn" id="ed-export">⬇ 내보내기</button>
      <button class="btn" id="ed-import">⬆ 가져오기</button>
      <button class="btn" id="ed-share">🔗 공유 링크 복사</button>
      <button class="btn" id="ed-settings">⚙ 전투 설정</button>
      <button class="btn" id="ed-save">💾 저장</button>
      <button class="btn btn-primary" id="ed-play">▶ PLAY</button>
    </div>
    <div class="editor-body">
      <div class="tool-panel" id="ed-tool-panel"></div>
      <div class="canvas-area">
        <div class="canvas-stage"><div class="canvas-wrap" id="ed-canvas-wrap"><div id="ed-canvas"></div></div></div>
        <div id="ed-timeline"></div>
      </div>
      <div class="property-panel" id="ed-property-panel"></div>
    </div>
  `;
  app.appendChild(shell);

  editorDom = {
    canvasWrap: shell.querySelector('#ed-canvas-wrap'),
    canvas: shell.querySelector('#ed-canvas'),
    toolPanel: shell.querySelector('#ed-tool-panel'),
    propertyPanel: shell.querySelector('#ed-property-panel'),
    timeline: shell.querySelector('#ed-timeline'),
    savedFlash: shell.querySelector('#ed-saved-flash'),
    nameLabel: shell.querySelector('#ed-name-label'),
  };

  shell.querySelector('#ed-home').onclick = () => navigate('#/');
  shell.querySelector('#ed-settings').onclick = () => toggleBattleSettings();
  shell.querySelector('#ed-save').onclick = () => {
    actionSave();
    flashMessage('저장됨 ✓');
  };
  shell.querySelector('#ed-play').onclick = () => { actionSave(); navigate(`#/battle/${editorState.battle.id}`); };

  shell.querySelector('#ed-share').onclick = async () => {
    actionSave();
    const url = buildShareUrl(editorState.battle);
    const tooLong = url.length > 6000;
    try {
      await navigator.clipboard.writeText(url);
      flashMessage(tooLong ? '복사됨(링크가 김 - 이미지/음악 포함) ✓' : '공유 링크 복사됨 ✓');
    } catch (e) {
      prompt('이 링크를 복사하세요:', url);
    }
    if (tooLong) {
      // eslint-disable-next-line no-alert
      console.warn('공유 링크가 매우 깁니다 (이미지/음악이 포함되어 있을 수 있음). 큰 전투는 "내보내기" JSON 파일 공유를 권장합니다.');
    }
  };

  shell.querySelector('#ed-export').onclick = () => {
    actionSave();
    const blob = new Blob([JSON.stringify(editorState.battle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${editorState.battle.name || 'battle'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashMessage('파일로 내보냄 ✓');
  };

  const importInput = el('input');
  importInput.type = 'file';
  importInput.accept = 'application/json';
  importInput.className = 'hidden';
  importInput.onchange = async () => {
    const f = importInput.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      parsed.id = uid(); // 충돌 방지를 위해 새 ID 부여
      parsed.updatedAt = new Date().toISOString();
      battleRepository.save(parsed);
      navigate(`#/edit/${parsed.id}`);
    } catch (e) {
      alert('전투 파일을 읽는 데 실패했습니다. 올바른 BATTLE MAKER JSON 파일인지 확인해주세요.');
    }
  };
  shell.appendChild(importInput);
  shell.querySelector('#ed-import').onclick = () => importInput.click();

  function flashMessage(text) {
    editorDom.savedFlash.textContent = text;
    editorDom.savedFlash.classList.remove('hidden');
    setTimeout(() => editorDom.savedFlash.classList.add('hidden'), 1600);
  }

  // 키보드 단축키
  const onKey = (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.code === 'Space') { e.preventDefault(); setEditorPlaying(!editorState.isPlaying); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (editorState.selectedObjectId) actionDeleteObject(editorState.selectedObjectId); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') { actionCopySelected(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') { actionPaste(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); if (editorState.selectedObjectId) actionDuplicateObject(editorState.selectedObjectId); }
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));

  let rafId = 0;
  function loop(now) {
    if (!editorState.isPlaying) return;
    if (!loop._last) loop._last = now;
    const dt = (now - loop._last) / 1000;
    loop._last = now;
    let next = editorState.currentTime + dt;
    if (next >= editorState.battle.duration) { next = 0; setEditorPlaying(false); }
    editorState.currentTime = next;
    renderCanvas();
    updatePlayheadOnly();
    rafId = requestAnimationFrame(loop);
  }
  window.__editorLoopStart = () => { loop._last = 0; rafId = requestAnimationFrame(loop); };
  onCleanup(() => cancelAnimationFrame(rafId));

  renderEditorAll();
}

function setEditorPlaying(v) {
  editorState.isPlaying = v;
  if (v) window.__editorLoopStart();
  renderTimelineControlsOnly();
}

function renderEditorAll() {
  if (!editorDom.canvas) return;
  editorDom.nameLabel.textContent = editorState.battle.name;
  renderCanvas();
  renderToolPanel();
  renderTimeline();
  renderPropertyPanel();
}

function renderCanvas() {
  renderBattleCanvasInto(editorDom.canvas, editorState.battle, editorState.currentTime, {
    editable: true,
    selectedObjectId: editorState.selectedObjectId,
    onSelectObject: (id) => toggleSelectObject(id),
    onDragStart: (id) => {
      pushHistory();
      editorState.selectedObjectId = id; // 드래그를 시작하면(=조작 의도가 분명하면) 무조건 선택 상태로 연다. 토글 없음.
      editorState.selectedDialogueId = null;
      editorState.showBattleSettings = false;
      renderToolPanel();
      renderPropertyPanel();
    },
    onDragMove: (id, x, y) => moveObjectDataSilently(id, x, y),
    onDragEnd: () => renderEditorAll(), // 드래그가 끝난 뒤 딱 한 번만 타임라인/패널까지 전부 정리
  });
}

function updatePlayheadOnly() {
  const ph = editorDom.timeline && editorDom.timeline.querySelector('.tl-playhead');
  const timeLabel = editorDom.timeline && editorDom.timeline.querySelector('.tl-time');
  if (ph) ph.style.left = (editorState.currentTime * editorState.pixelsPerSecond) + 'px';
  if (timeLabel) timeLabel.textContent = `${editorState.currentTime.toFixed(2)}s / ${editorState.battle.duration.toFixed(1)}s`;
}
function renderTimelineControlsOnly() { renderTimeline(); }
function renderTimelineSelectionOnly() { renderTimeline(); }

/* ---- 좌측 도구 패널 ---- */
function renderToolPanel() {
  const panel = editorDom.toolPanel;
  panel.innerHTML = '';
  panel.appendChild(el('div', 'panel-section-title', '오브젝트'));
  const grid = el('div', 'obj-btn-grid');
  OBJECT_BUTTONS.forEach((b) => {
    const btn = el('button', 'obj-btn');
    btn.innerHTML = `<span class="icon">${b.icon}</span>${b.label}`;
    btn.onclick = () => actionAddObject(b.type);
    grid.appendChild(btn);
  });
  panel.appendChild(grid);

  panel.appendChild(el('div', 'panel-section-title', '도구'));
  const toolsGrid = el('div', 'tool-btn-grid');
  const selected = editorState.selectedObjectId ? findObj(editorState.selectedObjectId) : null;

  function toolBtn(label, onClick, extraClass) {
    const btn = el('button', 'tool-btn ' + (extraClass || ''), label);
    btn.disabled = !selected && !!onClick.needsSelection;
    btn.onclick = onClick;
    return btn;
  }

  const rotateBtn = el('button', 'tool-btn', '↻ 회전'); rotateBtn.disabled = !selected;
  rotateBtn.onclick = () => selected && actionUpdateObject(selected.id, { rotation: (selected.rotation + 15) % 360 });
  toolsGrid.appendChild(rotateBtn);

  const growBtn = el('button', 'tool-btn', '＋ 확대'); growBtn.disabled = !selected;
  growBtn.onclick = () => selected && actionUpdateObject(selected.id, { scale: Math.max(0.2, selected.scale + 0.1) });
  toolsGrid.appendChild(growBtn);

  const shrinkBtn = el('button', 'tool-btn', '－ 축소'); shrinkBtn.disabled = !selected;
  shrinkBtn.onclick = () => selected && actionUpdateObject(selected.id, { scale: Math.max(0.2, selected.scale - 0.1) });
  toolsGrid.appendChild(shrinkBtn);

  const dupBtn = el('button', 'tool-btn', '⧉ 복제'); dupBtn.disabled = !selected;
  dupBtn.onclick = () => selected && actionDuplicateObject(selected.id);
  toolsGrid.appendChild(dupBtn);

  const delBtn = el('button', 'tool-btn danger', '✕ 삭제'); delBtn.disabled = !selected;
  delBtn.onclick = () => selected && actionDeleteObject(selected.id);
  toolsGrid.appendChild(delBtn);

  const undoBtn = el('button', 'tool-btn', '⎌ 실행취소'); undoBtn.onclick = undo;
  toolsGrid.appendChild(undoBtn);

  const redoBtn = el('button', 'tool-btn', '⎌ 다시실행'); redoBtn.onclick = redo;
  toolsGrid.appendChild(redoBtn);

  const copyBtn = el('button', 'tool-btn', '복사'); copyBtn.disabled = !selected;
  copyBtn.onclick = actionCopySelected;
  toolsGrid.appendChild(copyBtn);

  const pasteBtn = el('button', 'tool-btn span2', '붙여넣기'); pasteBtn.onclick = actionPaste;
  toolsGrid.appendChild(pasteBtn);

  panel.appendChild(toolsGrid);
}

/* ---- 우측 속성 패널 ---- */
/**
 * 오브젝트의 idle/hit/attack/death 프레임 애니메이션을 관리하는 UI를 만든다.
 * 여러 장의 이미지를 업로드하면 실제로 순서대로 재생된다(에디터 미리보기 idle은
 * 타임라인 시간 기준, 플레이 모드의 hit/attack/death는 실제 이벤트 발생 시점 기준).
 */
function buildFrameAnimationSection(obj) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'panel-heading', '애니메이션 프레임'));

  if (!obj.frames) obj.frames = { idle: [], hit: [], attack: [], death: [] };

  const fpsField = el('div', 'field');
  fpsField.appendChild(el('div', 'field-label', '재생 속도 (FPS)'));
  const fpsInput = el('input', 'field-input');
  fpsInput.type = 'number'; fpsInput.min = '1'; fpsInput.max = '30'; fpsInput.value = obj.frameFps || 8;
  fpsInput.onchange = () => actionUpdateObject(obj.id, { frameFps: Math.max(1, Number(fpsInput.value) || 8) });
  fpsField.appendChild(fpsInput);
  wrap.appendChild(fpsField);

  const states = (obj.type === 'boss' || obj.type === 'player')
    ? [
      { key: 'idle', label: '기본(Idle)' },
      { key: 'hit', label: '피격' },
      { key: 'attack', label: '공격' },
      { key: 'death', label: '사망' },
    ]
    : [{ key: 'idle', label: '기본(Idle)' }];

  states.forEach(({ key, label }) => {
    const box = el('div', 'field');
    const frames = obj.frames[key] || [];
    const fps = obj.frameFps || 8;
    const seconds = frames.length ? (frames.length / fps).toFixed(2) : '0';
    box.appendChild(el('div', 'field-label', `${label} 프레임 — ${frames.length}장 (${seconds}초 루프)`));

    const thumbRow = el('div');
    thumbRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;';
    frames.forEach((src, idx) => {
      const thumb = el('div');
      thumb.style.cssText = 'position:relative;width:32px;height:32px;border:1px solid #2c2c33;border-radius:3px;overflow:hidden;background:#000;';
      const img = el('img'); img.src = src; img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      thumb.appendChild(img);
      const rm = el('button', '', '✕');
      rm.style.cssText = 'position:absolute;top:0;right:0;background:rgba(0,0,0,0.7);color:#e0446f;border:none;font-size:9px;line-height:1;padding:1px 3px;cursor:pointer;';
      rm.onclick = () => {
        const nextFrames = Object.assign({}, obj.frames, { [key]: obj.frames[key].filter((_, i) => i !== idx) });
        actionUpdateObject(obj.id, { frames: nextFrames });
      };
      thumb.appendChild(rm);
      thumbRow.appendChild(thumb);
    });
    box.appendChild(thumbRow);

    const addBtn = el('button', 'btn btn-block btn-sm', `+ ${label} 프레임 추가 (여러 장 선택 가능)`);
    const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true; fileInput.className = 'hidden';
    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      const urls = await Promise.all(files.map(fileToDataUrl));
      const nextFrames = Object.assign({}, obj.frames, { [key]: [...(obj.frames[key] || []), ...urls] });
      actionUpdateObject(obj.id, { frames: nextFrames });
    };
    addBtn.onclick = () => fileInput.click();
    box.appendChild(addBtn);
    box.appendChild(fileInput);
    wrap.appendChild(box);
  });

  wrap.appendChild(el('div', 'hint-text', '프레임을 업로드하면 해당 상태(기본/피격/공격/사망)에서 도형 대신 실제로 이미지가 순서대로 재생됩니다. 프레임이 없는 상태는 기존 방식(색상/크기 변화)으로 자동 대체됩니다.'));
  return wrap;
}

function renderPropertyPanel() {
  const panel = editorDom.propertyPanel;
  panel.innerHTML = '';
  const battle = editorState.battle;
  const obj = editorState.selectedObjectId ? findObj(editorState.selectedObjectId) : null;
  const dialogue = editorState.selectedDialogueId ? battle.dialogues.find((d) => d.id === editorState.selectedDialogueId) : null;

  // 아무것도 선택 안 하고 "설정"도 안 눌렀으면 패널 자체를 접어서 캔버스 공간을 넓게 쓴다.
  if (!obj && !dialogue && !editorState.showBattleSettings) {
    panel.classList.add('collapsed');
    return;
  }
  panel.classList.remove('collapsed');

  function field(label, inputNode) {
    const wrap = el('div', 'field');
    wrap.appendChild(el('div', 'field-label', label));
    wrap.appendChild(inputNode);
    return wrap;
  }
  function textInput(value, onInput, type) {
    const i = el('input', 'field-input');
    i.type = type || 'text';
    i.value = value;
    // 주의: 매 키 입력마다 오브젝트 속성을 갱신하면 패널 전체가 다시 그려지면서
    // 입력 중인 필드 자체가 새 DOM 노드로 교체되어 포커스를 잃는다.
    // 그래서 change(포커스 해제/Enter) 시점에만 실제로 커밋한다.
    i.onchange = () => onInput(type === 'number' ? Number(i.value) : i.value);
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); };
    return i;
  }

  if (obj) {
    panel.appendChild(el('div', 'panel-section-title', '오브젝트 속성 · ' + obj.type.toUpperCase()));
    panel.appendChild(field('이름', textInput(obj.name, (v) => actionUpdateObject(obj.id, { name: v }))));

    const row1 = el('div', 'field-row');
    row1.appendChild(field('위치 X (%)', textInput(Math.round(obj.x), (v) => actionUpdateObject(obj.id, { x: v }), 'number')));
    row1.appendChild(field('위치 Y (%)', textInput(Math.round(obj.y), (v) => actionUpdateObject(obj.id, { y: v }), 'number')));
    const scaleInput = textInput(obj.scale, (v) => actionUpdateObject(obj.id, { scale: v }), 'number'); scaleInput.step = '0.1';
    row1.appendChild(field('크기(scale)', scaleInput));
    row1.appendChild(field('회전(deg)', textInput(obj.rotation, (v) => actionUpdateObject(obj.id, { rotation: v }), 'number')));
    const opacityInput = textInput(obj.opacity, (v) => actionUpdateObject(obj.id, { opacity: v }), 'number'); opacityInput.step = '0.1'; opacityInput.min = '0'; opacityInput.max = '1';
    row1.appendChild(field('투명도', opacityInput));
    const colorInput = el('input', 'field-input'); colorInput.type = 'color'; colorInput.value = obj.color; colorInput.style.height = '28px';
    colorInput.onchange = () => actionUpdateObject(obj.id, { color: colorInput.value });
    row1.appendChild(field('색상', colorInput));
    panel.appendChild(row1);

    if (obj.type === 'boss' || obj.type === 'player') {
      const row2 = el('div', 'field-row');
      row2.appendChild(field('HP', textInput(obj.hp || 0, (v) => actionUpdateObject(obj.id, { hp: v }), 'number')));
      row2.appendChild(field('최대 HP', textInput(obj.maxHp || 0, (v) => actionUpdateObject(obj.id, { maxHp: v, hp: v }), 'number')));
      panel.appendChild(row2);
    }

    if (obj.type === 'bullet' || obj.type === 'laser' || obj.type === 'obstacle') {
      panel.appendChild(field('데미지', textInput(obj.damage || 0, (v) => actionUpdateObject(obj.id, { damage: v }), 'number')));
      const chkWrap = el('label', 'field-check');
      const chk = el('input'); chk.type = 'checkbox'; chk.checked = obj.collidable;
      chk.onchange = () => actionUpdateObject(obj.id, { collidable: chk.checked });
      chkWrap.appendChild(chk); chkWrap.appendChild(document.createTextNode('플레이어와 충돌'));
      panel.appendChild(field('충돌 판정', chkWrap));
    }

    if (obj.type !== 'laser') {
      const sel = el('select', 'field-input');
      sel.innerHTML = `
        <option value="circle">● 원형</option><option value="diamond">◆ 다이아</option>
        <option value="square">■ 사각형</option><option value="triangle">▲ 삼각형</option>
        <option value="image">🖼 이미지</option>`;
      sel.value = obj.shape;
      sel.onchange = () => actionUpdateObject(obj.id, { shape: sel.value });
      panel.appendChild(field('모양', sel));
    }

    if (obj.shape === 'image') {
      const uploadWrap = el('div', 'field');
      uploadWrap.appendChild(el('div', 'field-label', '스프라이트 업로드'));
      const btn = el('button', 'btn btn-block btn-sm', '이미지 선택');
      const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.className = 'hidden';
      fileInput.onchange = async () => {
        const f = fileInput.files[0]; if (!f) return;
        const url = await fileToDataUrl(f);
        actionUpdateObject(obj.id, { imageUrl: url });
      };
      btn.onclick = () => fileInput.click();
      uploadWrap.appendChild(btn); uploadWrap.appendChild(fileInput);
      if (obj.imageUrl) { const prev = el('img'); prev.src = obj.imageUrl; prev.style.cssText = 'max-height:80px;display:block;margin:8px auto 0'; uploadWrap.appendChild(prev); }
      panel.appendChild(uploadWrap);
    }

    if (obj.type !== 'laser') {
      panel.appendChild(buildFrameAnimationSection(obj));
    }

    if (obj.type === 'laser' && obj.laser) {
      const rowL = el('div', 'field-row');
      const mk = (label, key, step) => {
        const input = textInput(obj.laser[key], (v) => { const laser = Object.assign({}, obj.laser); laser[key] = v; actionUpdateObject(obj.id, { laser }); }, 'number');
        if (step) input.step = step;
        rowL.appendChild(field(label, input));
      };
      mk('경고 시작(s)', 'warnStart', '0.1');
      mk('발사 시작(s)', 'fireStart', '0.1');
      mk('발사 종료(s)', 'fireEnd', '0.1');
      mk('두께(px)', 'thickness');
      mk('길이(%)', 'length');
      panel.appendChild(rowL);
    }

    const row3 = el('div', 'field-row');
    const spawnInput = textInput(obj.spawnTime, (v) => actionUpdateObject(obj.id, { spawnTime: v }), 'number'); spawnInput.step = '0.1';
    row3.appendChild(field('생성 시간(s)', spawnInput));
    const despawnInput = textInput(obj.despawnTime, (v) => actionUpdateObject(obj.id, { despawnTime: v }), 'number'); despawnInput.step = '0.1';
    row3.appendChild(field('삭제 시간(s)', despawnInput));
    panel.appendChild(row3);

    panel.appendChild(el('div', 'hint-text', `현재 시간 ${editorState.currentTime.toFixed(2)}s 기준으로 이 오브젝트를 캔버스에서 드래그하면 자동으로 키프레임이 생성됩니다.`));
    return;
  }

  if (dialogue) {
    panel.appendChild(el('div', 'panel-section-title', '대사 속성'));
    const ta = el('textarea', 'field-input'); ta.rows = 3; ta.value = dialogue.text;
    ta.onchange = () => actionUpdateDialogue(dialogue.id, { text: ta.value });
    panel.appendChild(field('대사 내용', ta));

    const row = el('div', 'field-row');
    const startInput = textInput(dialogue.start, (v) => actionUpdateDialogue(dialogue.id, { start: v }), 'number'); startInput.step = '0.1';
    row.appendChild(field('시작 시간(s)', startInput));
    const endInput = textInput(dialogue.end, (v) => actionUpdateDialogue(dialogue.id, { end: v }), 'number'); endInput.step = '0.1';
    row.appendChild(field('종료 시간(s)', endInput));
    panel.appendChild(row);

    const dispSel = el('select', 'field-input');
    dispSel.innerHTML = `<option value="bubble">말풍선</option><option value="bottom">화면 하단 대사창</option><option value="center">중앙 텍스트</option><option value="above">보스 위 텍스트</option>`;
    dispSel.value = dialogue.display;
    dispSel.onchange = () => actionUpdateDialogue(dialogue.id, { display: dispSel.value });
    panel.appendChild(field('표시 방식', dispSel));

    const speakerSel = el('select', 'field-input');
    speakerSel.innerHTML = '<option value="">(없음)</option>' + battle.objects.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
    speakerSel.value = dialogue.speakerObjectId || '';
    speakerSel.onchange = () => actionUpdateDialogue(dialogue.id, { speakerObjectId: speakerSel.value || undefined });
    panel.appendChild(field('화자 오브젝트', speakerSel));

    const delBtn = el('button', 'btn btn-danger btn-block btn-sm', '대사 삭제');
    delBtn.style.marginTop = '8px';
    delBtn.onclick = () => actionDeleteDialogue(dialogue.id);
    panel.appendChild(delBtn);
    return;
  }

  // 아무것도 선택 안 됨 -> 전투 전체 설정
  panel.appendChild(el('div', 'panel-section-title', '전투 설정'));
  panel.appendChild(field('전투 이름', textInput(battle.name, (v) => actionUpdateMeta({ name: v }))));
  panel.appendChild(field('전체 길이(s)', textInput(battle.duration, (v) => actionUpdateMeta({ duration: v }), 'number')));

  panel.appendChild(el('div', 'panel-heading', '배경'));
  const bgSel = el('select', 'field-input');
  bgSel.innerHTML = `<option value="dark">어두운 배경</option><option value="color">단색</option><option value="gradient">그라데이션</option><option value="image">이미지 업로드</option>`;
  bgSel.value = battle.background.type;
  bgSel.onchange = () => actionUpdateBackground({ type: bgSel.value, value: bgSel.value === 'dark' ? '' : battle.background.value });
  panel.appendChild(field('배경 종류', bgSel));

  if (battle.background.type === 'color') {
    const c = el('input'); c.type = 'color'; c.value = battle.background.value || '#111111'; c.style.cssText = 'width:100%;height:28px;';
    c.onchange = () => actionUpdateBackground({ value: c.value });
    panel.appendChild(field('색상', c));
  }
  if (battle.background.type === 'gradient') {
    const g = textInput(battle.background.value, (v) => actionUpdateBackground({ value: v }));
    g.placeholder = 'linear-gradient(...)';
    panel.appendChild(field('CSS gradient', g));
  }
  if (battle.background.type === 'image') {
    const f = el('input'); f.type = 'file'; f.accept = 'image/*';
    f.onchange = async () => { const file = f.files[0]; if (!file) return; actionUpdateBackground({ value: await fileToDataUrl(file) }); };
    panel.appendChild(field('이미지 업로드', f));
  }

  panel.appendChild(el('div', 'panel-heading', '음악'));
  const musicBtn = el('button', 'btn btn-block btn-sm', '음악 파일 선택' + (battle.music && battle.music.name ? ` (${battle.music.name})` : ''));
  const musicFile = el('input'); musicFile.type = 'file'; musicFile.accept = 'audio/*'; musicFile.className = 'hidden';
  musicFile.onchange = async () => { const f = musicFile.files[0]; if (!f) return; actionUpdateMusic({ dataUrl: await fileToDataUrl(f), name: f.name }); };
  musicBtn.onclick = () => musicFile.click();
  panel.appendChild(musicBtn); panel.appendChild(musicFile);
  if (battle.music) {
    const rowM = el('div', 'field-row'); rowM.style.marginTop = '8px';
    const st = textInput(battle.music.startTime, (v) => actionUpdateMusic({ startTime: v }), 'number');
    rowM.appendChild(field('시작 시간(s)', st));
    const vol = textInput(battle.music.volume, (v) => actionUpdateMusic({ volume: v }), 'number'); vol.step = '0.1'; vol.min = '0'; vol.max = '1';
    rowM.appendChild(field('볼륨', vol));
    const loopWrap = el('label', 'field-check');
    const loopChk = el('input'); loopChk.type = 'checkbox'; loopChk.checked = battle.music.loop;
    loopChk.onchange = () => actionUpdateMusic({ loop: loopChk.checked });
    loopWrap.appendChild(loopChk); loopWrap.appendChild(document.createTextNode('반복 재생'));
    rowM.appendChild(field('반복', loopWrap));
    panel.appendChild(rowM);
  }

  panel.appendChild(el('div', 'panel-heading', '대사 / 이펙트'));
  const addDialogueBtn = el('button', 'btn btn-block btn-sm', '+ 대사 추가 (현재 시간)');
  addDialogueBtn.style.marginBottom = '6px';
  addDialogueBtn.onclick = actionAddDialogue;
  panel.appendChild(addDialogueBtn);

  const effGrid = el('div', 'effect-quick-grid');
  EFFECT_TYPES.forEach((t) => {
    const b = el('button', 'effect-quick-btn', '+ ' + t);
    b.onclick = () => actionAddEffect(t);
    effGrid.appendChild(b);
  });
  panel.appendChild(effGrid);

  battle.effects.forEach((e) => {
    const item = el('div', 'effect-list-item');
    item.innerHTML = `<span>${e.type} @ ${e.time.toFixed(1)}s</span>`;
    const rm = el('button', '', '✕'); rm.onclick = () => actionDeleteEffect(e.id);
    item.appendChild(rm);
    panel.appendChild(item);
  });

  panel.appendChild(el('div', 'panel-heading', '게임 규칙'));
  const atkWrap = el('label', 'field-check');
  const atkChk = el('input'); atkChk.type = 'checkbox'; atkChk.checked = battle.settings.allowPlayerAttack;
  atkChk.onchange = () => actionUpdateSettings({ allowPlayerAttack: atkChk.checked });
  atkWrap.appendChild(atkChk); atkWrap.appendChild(document.createTextNode('Z / 클릭 공격 가능'));
  panel.appendChild(field('플레이어 보스 공격 허용', atkWrap));
  panel.appendChild(field('공격 데미지', textInput(battle.settings.playerAttackDamage, (v) => actionUpdateSettings({ playerAttackDamage: v }), 'number')));
  const invInput = textInput(battle.settings.invincibilityDuration, (v) => actionUpdateSettings({ invincibilityDuration: v }), 'number'); invInput.step = '0.1';
  panel.appendChild(field('무적 시간(s)', invInput));
}

/* ---- 하단 타임라인 ---- */
function renderTimeline() {
  const battle = editorState.battle;
  const container = editorDom.timeline;
  container.innerHTML = '';
  const tl = el('div', 'timeline');
  container.appendChild(tl);

  // 컨트롤 바
  const controls = el('div', 'timeline-controls');
  controls.innerHTML = `
    <button class="tl-btn" id="tl-tostart" title="정지(처음으로)">⏮</button>
    <button class="tl-btn" id="tl-prev" title="이전 프레임">◀|</button>
    <button class="tl-btn play" id="tl-playpause" title="재생/일시정지 (Space)">${editorState.isPlaying ? '❚❚' : '▶'}</button>
    <button class="tl-btn" id="tl-next" title="다음 프레임">|▶</button>
    <span class="tl-time">${editorState.currentTime.toFixed(2)}s / ${battle.duration.toFixed(1)}s</span>
  `;
  if (editorState.selectedObjectId) {
    const kfBtn = el('button', 'btn btn-sm', '◆ 키프레임 추가');
    kfBtn.style.marginLeft = '8px';
    kfBtn.onclick = () => actionAddKeyframeAtCurrentTime(editorState.selectedObjectId);
    controls.appendChild(kfBtn);
  }
  const zoomRow = el('div', 'zoom-row');
  zoomRow.innerHTML = `<span>축소</span>`;
  const zoomInput = el('input'); zoomInput.type = 'range'; zoomInput.min = '20'; zoomInput.max = '300'; zoomInput.value = String(editorState.pixelsPerSecond); zoomInput.style.width = '96px';
  // 슬라이더를 드래그하는 중에 전체 타임라인을 다시 그리면(innerHTML 교체) 슬라이더 자신도
  // 새 DOM 노드로 바뀌어 드래그가 끊긴다. 그래서 몸통(body)만 별도로 다시 그린다.
  zoomInput.oninput = () => { editorState.pixelsPerSecond = clamp(Number(zoomInput.value), 20, 400); rebuildTimelineBody(tl, battle); };
  zoomRow.appendChild(zoomInput);
  zoomRow.appendChild(el('span', '', '확대'));
  controls.appendChild(zoomRow);
  tl.appendChild(controls);

  controls.querySelector('#tl-tostart').onclick = () => { editorState.currentTime = 0; renderCanvas(); rebuildTimelineBody(tl, battle); };
  controls.querySelector('#tl-prev').onclick = () => { editorState.currentTime = Math.max(0, editorState.currentTime - 1 / 30); renderCanvas(); updatePlayheadOnly(); };
  controls.querySelector('#tl-next').onclick = () => { editorState.currentTime = Math.min(battle.duration, editorState.currentTime + 1 / 30); renderCanvas(); updatePlayheadOnly(); };
  controls.querySelector('#tl-playpause').onclick = () => setEditorPlaying(!editorState.isPlaying);

  rebuildTimelineBody(tl, battle);
}

function rebuildTimelineBody(tl, battle) {
  const old = tl.querySelector('.timeline-body');
  if (old) old.remove();
  const body = el('div', 'timeline-body');
  tl.appendChild(body);

  const labels = el('div', 'tl-labels');
  labels.appendChild(el('div', 'tl-label-header'));
  const objectsByType = LAYER_ORDER.map((t) => ({ type: t, objects: battle.objects.filter((o) => o.type === t) })).filter((g) => g.objects.length > 0);
  objectsByType.forEach((g) => {
    labels.appendChild(el('div', 'tl-group-label', LAYER_LABEL[g.type]));
    g.objects.forEach((o) => {
      const row = el('div', 'tl-obj-label' + (editorState.selectedObjectId === o.id ? ' selected' : ''), o.name);
      row.onclick = () => { toggleSelectObject(o.id); renderCanvas(); };
      labels.appendChild(row);
    });
  });
  labels.appendChild(el('div', 'tl-group-label', 'DIALOGUE'));
  battle.dialogues.forEach((d) => {
    const row = el('div', 'tl-obj-label' + (editorState.selectedDialogueId === d.id ? ' selected' : ''), d.text);
    row.onclick = () => { toggleSelectDialogue(d.id); };
    labels.appendChild(row);
  });
  labels.appendChild(el('div', 'tl-group-label', 'EFFECTS'));
  labels.appendChild(el('div', 'tl-obj-label', '이펙트 트랙'));
  labels.appendChild(el('div', 'tl-group-label', 'MUSIC'));
  labels.appendChild(el('div', 'tl-obj-label', (battle.music && battle.music.name) || '(없음)'));
  body.appendChild(labels);

  const scroll = el('div', 'tl-tracks-scroll');
  const width = battle.duration * editorState.pixelsPerSecond;
  const track = el('div');
  track.style.width = width + 'px';
  track.style.position = 'relative';

  const ruler = el('div', 'tl-ruler');
  for (let i = 0; i <= Math.ceil(battle.duration); i++) {
    const tick = el('div', 'tl-ruler-tick', i + 's');
    tick.style.left = (i * editorState.pixelsPerSecond) + 'px';
    ruler.appendChild(tick);
  }
  const seekFromClientX = (clientX) => {
    const rect = scroll.getBoundingClientRect();
    const offsetX = clientX - rect.left + scroll.scrollLeft;
    editorState.currentTime = clamp(offsetX / editorState.pixelsPerSecond, 0, battle.duration);
    renderCanvas();
    updatePlayheadOnly();
  };
  ruler.onpointerdown = (e) => {
    seekFromClientX(e.clientX);
    const move = (ev) => seekFromClientX(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  track.appendChild(ruler);

  const playhead = el('div', 'tl-playhead');
  playhead.style.left = (editorState.currentTime * editorState.pixelsPerSecond) + 'px';
  playhead.appendChild(el('div', 'tl-playhead-flag'));
  track.appendChild(playhead);

  objectsByType.forEach((g) => {
    track.appendChild(el('div', 'tl-group-strip'));
    g.objects.forEach((o) => {
      const row = el('div', 'tl-obj-row');
      row.onclick = () => { toggleSelectObject(o.id); renderCanvas(); };
      const bar = el('div', 'tl-active-bar');
      bar.style.left = (o.spawnTime * editorState.pixelsPerSecond) + 'px';
      bar.style.width = Math.max(2, (Math.min(o.despawnTime, battle.duration) - o.spawnTime) * editorState.pixelsPerSecond) + 'px';
      bar.style.background = o.color;
      row.appendChild(bar);
      o.keyframes.forEach((k) => {
        const dia = el('div', 'tl-keyframe');
        dia.style.left = (k.time * editorState.pixelsPerSecond - 5) + 'px';
        dia.title = `t=${k.time.toFixed(2)}s (Shift+클릭: 삭제)`;
        dia.onclick = (e) => {
          e.stopPropagation();
          // 키프레임을 다루는 중이므로 토글하지 않고 항상 해당 오브젝트 패널을 열어둔다.
          editorState.selectedObjectId = o.id;
          editorState.selectedDialogueId = null;
          editorState.showBattleSettings = false;
          if (e.shiftKey) actionDeleteKeyframe(o.id, k.id);
          else { editorState.currentTime = k.time; renderToolPanel(); renderPropertyPanel(); renderCanvas(); renderTimeline(); }
        };
        row.appendChild(dia);
      });
      track.appendChild(row);
    });
  });

  track.appendChild(el('div', 'tl-group-strip'));
  battle.dialogues.forEach((d) => {
    const row = el('div', 'tl-dialogue-row');
    row.onclick = () => { toggleSelectDialogue(d.id); };
    const bar = el('div', 'tl-dialogue-bar', d.text);
    bar.style.left = (d.start * editorState.pixelsPerSecond) + 'px';
    bar.style.width = Math.max(10, (d.end - d.start) * editorState.pixelsPerSecond) + 'px';
    row.appendChild(bar);
    track.appendChild(row);
  });

  track.appendChild(el('div', 'tl-group-strip'));
  const effRow = el('div', 'tl-effect-row');
  battle.effects.forEach((e) => {
    const mark = el('div', 'tl-effect-mark');
    mark.style.left = (e.time * editorState.pixelsPerSecond) + 'px';
    mark.title = `${e.type} @ ${e.time.toFixed(1)}s`;
    effRow.appendChild(mark);
  });
  track.appendChild(effRow);

  track.appendChild(el('div', 'tl-group-strip'));
  const musicRow = el('div', 'tl-music-row');
  if (battle.music) {
    const bar = el('div', 'tl-music-bar');
    bar.style.left = (battle.music.startTime * editorState.pixelsPerSecond) + 'px';
    bar.style.width = Math.max(20, (battle.duration - battle.music.startTime) * editorState.pixelsPerSecond * 0.3) + 'px';
    musicRow.appendChild(bar);
  }
  track.appendChild(musicRow);

  scroll.appendChild(track);
  body.appendChild(scroll);
}

/* ------------------------------------------------------------------ *
 * 11. 플레이 모드 (실제 게임 런타임 엔진)
 * ------------------------------------------------------------------ */
const PLAYER_SPEED = 42; // % of canvas per second

function renderPlay(app, id, query) {
  let battle = null;
  let sharedFromUrl = false;
  if (query) {
    const params = new URLSearchParams(query);
    const d = params.get('d');
    if (d) {
      const decoded = decodeBattleFromUrl(d);
      if (decoded) {
        battle = decoded;
        sharedFromUrl = true;
        // 이 기기/브라우저에도 저장해둔다 -> 다음부터는 링크의 데이터 없이도(짧은 URL로) 재생 가능
        battleRepository.save(Object.assign({}, decoded, { updatedAt: new Date().toISOString() }));
      }
    }
  }
  if (!battle) battle = battleRepository.get(id);
  if (!battle) { navigate('#/library'); return; }

  const DEATH_ANIM_DURATION = 0.7;

  const state = {
    battle,
    status: 'playing', // playing | dying | gameover | clear
    currentTime: 0,
    playerPos: { x: 50, y: 80 },
    playerHp: 20, playerMaxHp: 20,
    bossHp: 100, bossMaxHp: 100,
    keys: {},
    invincibleUntil: 0,
    lastAttackAt: -999,
    audio: null,
    musicStarted: false,
    bossObjId: null,
    playerObjId: null,
    rafId: 0,
    lastFrameAt: 0,
    hitFlash: {}, // objId -> 실시간(performance.now()/1000) 종료 시각
    attackPulse: {}, // objId -> 실시간 종료 시각 (공격 펀치감)
    dying: null, // { which: 'player'|'boss', objId, start }
  };

  const player = battle.objects.find((o) => o.type === 'player');
  const boss = battle.objects.find((o) => o.type === 'boss');
  state.playerObjId = player ? player.id : null;
  state.bossObjId = boss ? boss.id : null;
  if (player) { state.playerPos = { x: player.x, y: player.y }; state.playerHp = player.hp || 20; state.playerMaxHp = player.maxHp || 20; }
  if (boss) { state.bossHp = boss.hp || 100; state.bossMaxHp = boss.maxHp || 100; }

  const screen = el('div', 'play-screen');
  screen.innerHTML = `
    <div class="play-canvas-wrap" id="play-canvas-wrap">
      <div id="play-canvas"></div>
      <div class="hud">
        <div class="hud-box">
          <div class="hud-label player">PLAYER HP</div>
          <div class="hud-value" id="hud-player-value"></div>
          <div class="hud-bar"><div class="hud-bar-fill player" id="hud-player-fill"></div></div>
        </div>
        ${boss ? `<div class="hud-box right">
          <div class="hud-label boss">${boss.name}</div>
          <div class="hud-value" id="hud-boss-value"></div>
          <div class="hud-bar"><div class="hud-bar-fill boss" id="hud-boss-fill"></div></div>
        </div>` : ''}
      </div>
      <div class="play-hint">WASD/방향키: 이동 · Z/클릭: 공격 · ESC: 나가기</div>
      <button class="play-esc" id="play-esc">ESC</button>
    </div>
  `;
  app.appendChild(screen);

  const canvasWrap = screen.querySelector('#play-canvas-wrap');
  const canvas = screen.querySelector('#play-canvas');
  const hudPlayerValue = screen.querySelector('#hud-player-value');
  const hudPlayerFill = screen.querySelector('#hud-player-fill');
  const hudBossValue = boss && screen.querySelector('#hud-boss-value');
  const hudBossFill = boss && screen.querySelector('#hud-boss-fill');

  screen.querySelector('#play-esc').onclick = () => navigate(`#/edit/${battle.id}`);
  canvasWrap.onpointerdown = () => attack();

  function attack() {
    if (state.status !== 'playing' || !battle.settings.allowPlayerAttack) return;
    const t = performance.now() / 1000;
    if (t - state.lastAttackAt < battle.settings.playerAttackCooldown) return;
    state.lastAttackAt = t;
    // 공격 펀치감 (플레이어 스프라이트 살짝 커짐 / attack 프레임 재생)
    if (state.playerObjId) state.attackPulse[state.playerObjId] = { start: t, end: t + 0.15 };
    state.bossHp = Math.max(0, state.bossHp - battle.settings.playerAttackDamage);
    if (state.bossObjId) state.hitFlash[state.bossObjId] = { start: t, end: t + 0.25 };
    if (state.bossHp <= 0) triggerDeath('boss');
    updateHud();
  }

  function dealDamageToPlayer(dmg) {
    const t = performance.now() / 1000;
    state.invincibleUntil = t + battle.settings.invincibilityDuration;
    if (state.playerObjId) state.hitFlash[state.playerObjId] = { start: t, end: t + 0.25 };
    const flash = el('div', 'hit-flash'); canvasWrap.appendChild(flash);
    setTimeout(() => flash.remove(), 150);
    state.playerHp = Math.max(0, state.playerHp - dmg);
    if (state.playerHp <= 0) triggerDeath('player');
    updateHud();
  }

  function updateHud() {
    hudPlayerValue.textContent = `${Math.ceil(state.playerHp)} / ${state.playerMaxHp}`;
    hudPlayerFill.style.width = `${(state.playerHp / state.playerMaxHp) * 100}%`;
    if (boss) {
      hudBossValue.textContent = `${Math.ceil(state.bossHp)} / ${state.bossMaxHp}`;
      hudBossFill.style.width = `${(state.bossHp / state.bossMaxHp) * 100}%`;
    }
  }

  // HP가 0이 되면 곧바로 오버레이를 띄우지 않고, 축소+페이드+충격파(또는 사망 프레임) 연출을 먼저 재생한다.
  // 사망 프레임이 업로드되어 있으면, 그 프레임을 전부 보여줄 수 있도록 연출 시간을 늘린다.
  function triggerDeath(which) {
    if (state.status !== 'playing') return; // 중복 트리거 방지
    state.status = 'dying';
    const objId = which === 'player' ? state.playerObjId : state.bossObjId;
    const obj = battle.objects.find((o) => o.id === objId);
    let duration = DEATH_ANIM_DURATION;
    if (obj && obj.frames && obj.frames.death && obj.frames.death.length) {
      duration = Math.max(DEATH_ANIM_DURATION, obj.frames.death.length / (obj.frameFps || 8));
    }
    state.dying = { which, objId, start: performance.now() / 1000, duration };
    battle.effects.push({ id: 'rt-' + uid(), time: state.currentTime, duration, type: 'shockwave', runtime: true });
    battle.effects.push({ id: 'rt-' + uid(), time: state.currentTime, duration: 0.3, type: 'flash', runtime: true });
  }

  function endBattle(status) {
    state.status = status;
    cancelAnimationFrame(state.rafId);
    if (state.audio) state.audio.pause();
    showOverlay(status);
  }

  function showOverlay(status) {
    const existing = screen.querySelector('.play-overlay');
    if (existing) existing.remove();
    const overlay = el('div', 'play-overlay');
    const title = status === 'clear' ? 'BATTLE CLEAR' : 'GAME OVER';
    const color = status === 'clear' ? '#7dff9c' : '#e0446f';
    overlay.innerHTML = `<div class="play-overlay-title" style="color:${color};text-shadow:0 0 30px ${color}88">${title}</div>
      <div class="play-overlay-buttons">
        <button class="btn btn-primary" id="ov-retry">다시 플레이</button>
        <button class="btn" id="ov-edit">편집으로 돌아가기</button>
      </div>`;
    screen.querySelector('#play-canvas-wrap').appendChild(overlay);
    overlay.querySelector('#ov-retry').onclick = () => resetGame();
    overlay.querySelector('#ov-edit').onclick = () => navigate(`#/edit/${battle.id}`);
  }

  function resetGame() {
    const overlay = screen.querySelector('.play-overlay');
    if (overlay) overlay.remove();
    if (player) { state.playerPos = { x: player.x, y: player.y }; state.playerHp = player.hp || 20; state.playerMaxHp = player.maxHp || 20; }
    if (boss) { state.bossHp = boss.hp || 100; state.bossMaxHp = boss.maxHp || 100; }
    state.invincibleUntil = 0;
    state.lastAttackAt = -999;
    state.musicStarted = false;
    state.hitFlash = {};
    state.attackPulse = {};
    state.dying = null;
    battle.effects = battle.effects.filter((e) => !e.runtime); // 사망 연출용 임시 이펙트 제거
    if (state.audio) { state.audio.pause(); state.audio.currentTime = 0; }
    state.currentTime = 0;
    state.status = 'playing';
    updateHud();
    startLoop();
  }

  const onKeyDown = (e) => {
    state.keys[e.key.toLowerCase()] = true;
    if (e.key.toLowerCase() === 'z') attack();
    if (e.key === 'Escape') navigate(`#/edit/${battle.id}`);
  };
  const onKeyUp = (e) => { state.keys[e.key.toLowerCase()] = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  onCleanup(() => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); });
  onCleanup(() => { cancelAnimationFrame(state.rafId); if (state.audio) state.audio.pause(); });

  // 회전을 실제로 반영한 레이저(회전 사각형) + 원/타원(탄환·장애물) 충돌 판정.
  // 전부 픽셀 좌표로 변환해서 계산하므로 시각적으로 보이는 모양과 정확히 일치한다.
  function checkCollisions() {
    const now = performance.now() / 1000;
    if (now < state.invincibleUntil) return;
    const rect = canvasWrap.getBoundingClientRect();
    const pxW = rect.width, pxH = rect.height;
    const playerXpx = (state.playerPos.x / 100) * pxW;
    const playerYpx = (state.playerPos.y / 100) * pxH;

    for (const obj of battle.objects) {
      if (!obj.collidable) continue;
      if (obj.type !== 'bullet' && obj.type !== 'laser' && obj.type !== 'obstacle') continue;
      if (!isObjectActive(obj, state.currentTime)) continue;

      const tr = getTransformAtTime(obj, state.currentTime);
      const objXpx = (tr.x / 100) * pxW;
      const objYpx = (tr.y / 100) * pxH;

      if (obj.type === 'laser' && obj.laser) {
        if (state.currentTime < obj.laser.fireStart || state.currentTime > obj.laser.fireEnd) continue;
        const halfLenPx = (obj.laser.length / 100) * pxW / 2;
        const halfThickPx = obj.laser.thickness / 2;
        const dx = playerXpx - objXpx;
        const dy = playerYpx - objYpx;
        const rad = (-tr.rotation * Math.PI) / 180;
        const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
        const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
        if (Math.abs(localX) <= halfLenPx && Math.abs(localY) <= halfThickPx) { dealDamageToPlayer(obj.damage || 10); return; }
      } else {
        // 16:9 보정과 동일한 방식으로 실제 렌더링 크기(px)를 계산해 시각적 모양과 일치시킨다.
        const halfWpx = ((obj.width * tr.scale) / 100) * pxW / 2;
        const halfHpx = (((obj.height * (16 / 9)) * tr.scale) / 100) * pxH / 2;
        const dx = playerXpx - objXpx;
        const dy = playerYpx - objYpx;
        if ((dx * dx) / (halfWpx * halfWpx + 0.001) + (dy * dy) / (halfHpx * halfHpx + 0.001) <= 1) { dealDamageToPlayer(obj.damage || 5); return; }
      }
    }
  }

  function startLoop() {
    state.lastFrameAt = performance.now();
    state.rafId = requestAnimationFrame(loop);
  }

  function loop(now) {
    if (state.status !== 'playing' && state.status !== 'dying') return;
    const dt = Math.min(0.05, (now - state.lastFrameAt) / 1000);
    state.lastFrameAt = now;
    state.currentTime = Math.min(battle.duration, state.currentTime + dt);

    if (battle.music && battle.music.dataUrl && !state.musicStarted && state.currentTime >= (battle.music.startTime || 0)) {
      state.musicStarted = true;
      const audio = new Audio(battle.music.dataUrl);
      audio.volume = battle.music.volume != null ? battle.music.volume : 0.7;
      audio.loop = !!battle.music.loop;
      audio.play().catch(() => {});
      state.audio = audio;
    }

    let dx = 0, dy = 0;
    const k = state.keys;
    if (k['w'] || k['arrowup']) dy -= 1;
    if (k['s'] || k['arrowdown']) dy += 1;
    if (k['a'] || k['arrowleft']) dx -= 1;
    if (k['d'] || k['arrowright']) dx += 1;
    if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
    state.playerPos.x = clamp(state.playerPos.x + dx * PLAYER_SPEED * dt, 2, 98);
    state.playerPos.y = clamp(state.playerPos.y + dy * PLAYER_SPEED * dt, 2, 98);

    if (state.status === 'playing') checkCollisions();

    const overridePositions = {};
    if (state.playerObjId) overridePositions[state.playerObjId] = state.playerPos;
    const displayBattle = battle;
    if (state.bossObjId) {
      const b = displayBattle.objects.find((o) => o.id === state.bossObjId);
      if (b) { b.hp = state.bossHp; b.maxHp = state.bossMaxHp; }
    }

    const nowSec = performance.now() / 1000;
    const dyingOpts = state.dying ? { objId: state.dying.objId, start: state.dying.start, duration: state.dying.duration } : null;
    renderBattleCanvasInto(canvas, displayBattle, state.currentTime, {
      overridePositions, now: nowSec, hitFlash: state.hitFlash, attackPulse: state.attackPulse, dying: dyingOpts,
    });

    if (state.status === 'dying' && nowSec - state.dying.start >= state.dying.duration) {
      const finalStatus = state.dying.which === 'player' ? 'gameover' : 'clear';
      state.dying = null;
      endBattle(finalStatus);
      return;
    }

    state.rafId = requestAnimationFrame(loop);
  }

  updateHud();
  startLoop();
}
