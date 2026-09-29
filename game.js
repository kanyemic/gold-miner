/* 黄金矿工 · 核心玩法
 *
 * 坐标系统：世界坐标 960x640；地面线 y = 232，其下为矿区。
 * 状态机：IDLE(摆动) -> SHOOT(下探) -> PULL(收线，货物越重越慢) -> IDLE
 *
 * 设计上的三个关键取舍：
 * 1. 抓取判定用「爪头到本帧运动线段的距离」，而不是精确多边形碰撞：
 *    60fps 下爪头单帧位移约 9px，远小于最小判定半径，因此不会穿透；对手感也更宽容。
 * 2. 重量只影响收线速度，不做自由下坠，让「时机」保持为唯一的核心难度来源。
 * 3. 矿藏生成必须经过可达性校验（见 maxReach）：摆动角度与绳长受画布边界限制，
 *    若把物品放在不可达区，玩家会看到永远抓不到的金子。
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- 常量

  const W = 960;
  const H = 640;
  const GROUND_Y = 232;          // 地表高度
  const PLAYER_X = W / 2;
  const PLAYER_Y = GROUND_Y - 18;
  const HOOK_R = 15;
  const PIVOT = { x: PLAYER_X, y: PLAYER_Y + 8 };

  const IDLE = 'idle';
  const SHOOT = 'shoot';
  const PULL = 'pull';
  const FINISHED = 'finished';
  const PAUSED = 'paused';

  const REST_DIST = 62;          // 静止时爪头到支点的距离
  const SWING_RATE = 1.5;        // 摆角速度（弧度/秒）
  const SWING_LIMIT = 1.32;      // 单侧最大摆角 ~75.6°
  const SHOOT_SPEED = 560;       // 下探速度 px/s
  const EMPTY_PULL_SPEED = 900;  // 空钩收线速度
  const RESULT_DELAY_MS = 900;   // 时间耗尽到弹面板之间留给玩家看一眼的间隔

  const BOUND_X = 6;
  const BOUND_BOTTOM = H - 6;

  // ---------------------------------------------------------------- 物品表

  const LOOT = {
    gold_s:  { name: '小金块',   r: 13, value: 50,  pull: 330, kind: 'gold', tone: '#ffd75e', tone2: '#c98d19' },
    gold_m:  { name: '金块',     r: 19, value: 120, pull: 250, kind: 'gold', tone: '#ffcf47', tone2: '#b87c12' },
    gold_l:  { name: '大金块',   r: 27, value: 260, pull: 185, kind: 'gold', tone: '#ffc437', tone2: '#a96b0d' },
    gold_xl: { name: '巨型金矿', r: 36, value: 480, pull: 132, kind: 'gold', tone: '#ffbb2b', tone2: '#94590a' },
    rock_s:  { name: '碎石',     r: 12, value: 11,  pull: 300, kind: 'rock', tone: '#9a9591', tone2: '#5f5b59' },
    rock_l:  { name: '巨石',     r: 26, value: 20,  pull: 118, kind: 'rock', tone: '#8d8783', tone2: '#524e4c' },
    diamond: { name: '钻石',     r: 11, value: 600, pull: 390, kind: 'gem',  tone: '#a8f4ff', tone2: '#3ea8c9' },
    ruby:    { name: '红宝石',   r: 12, value: 420, pull: 345, kind: 'gem',  tone: '#ff8b7d', tone2: '#c2342b' },
    emerald: { name: '祖母绿',   r: 12, value: 360, pull: 345, kind: 'gem',  tone: '#8ef0b4', tone2: '#2a9c66' },
    skull:   { name: '头骨',     r: 15, value: 30,  pull: 235, kind: 'junk', tone: '#cfc7ba', tone2: '#7d7568' },
    boot:    { name: '破靴子',   r: 14, value: 10,  pull: 265, kind: 'junk', tone: '#8a6b4f', tone2: '#4e3a28' },
    bone:    { name: '骨头',     r: 13, value: 14,  pull: 270, kind: 'junk', tone: '#e2dccd', tone2: '#a09a8b' },
    bag:     { name: '神秘口袋', r: 14, value: 0,   pull: 245, kind: 'bag',  tone: '#c98b4b', tone2: '#6d451f' },
  };

  // 神秘口袋的随机结果（weight 为相对权重，期望值约 205）
  const BAG_TABLE = [
    { weight: 30, label: '一袋金币', value: 220, tone: '#ffd75e' },
    { weight: 22, label: '少许金币', value: 110, tone: '#ffd75e' },
    { weight: 14, label: '一颗宝石！', value: 380, tone: '#a8f4ff' },
    { weight: 16, label: '一些碎石', value: 20, tone: '#9a9591' },
    { weight: 12, label: '里面是老鼠夹…', value: 0, tone: '#ff6b5e' },
    { weight: 6,  label: '居然是整袋金子！', value: 700, tone: '#ffc93c' },
  ];

  /* 关卡表
   * goal 是「本关收入」的达标线（不累积）；money 是跨关钱包，用于商店。
   * 目标线由 tests/balance.mjs 按实测分位标定：以「新手模型」收入的低分位为基准，
   * 逐关抬高，让后期真正需要取舍（挑贵的抓、放弃重垃圾）。
   */
  const LEVELS = [
    { goal: 620,  time: 60, plans: [['gold_s', 8], ['rock_s', 8], ['gold_m', 3], ['bag', 1]] },
    { goal: 920,  time: 60, plans: [['gold_s', 8], ['rock_s', 7], ['gold_m', 5], ['rock_l', 2], ['bag', 2]] },
    { goal: 1250, time: 60, plans: [['gold_s', 7], ['rock_s', 7], ['gold_m', 5], ['rock_l', 3], ['diamond', 1], ['bag', 2]] },
    { goal: 1950, time: 55, plans: [['gold_s', 6], ['gold_m', 5], ['gold_l', 3], ['rock_s', 6], ['rock_l', 3], ['ruby', 2], ['bag', 2]] },
    { goal: 2100, time: 55, plans: [['gold_s', 6], ['gold_m', 5], ['gold_l', 4], ['rock_l', 3], ['skull', 3], ['emerald', 2], ['bag', 3]] },
    { goal: 2600, time: 55, plans: [['gold_m', 7], ['gold_l', 5], ['rock_l', 4], ['ruby', 2], ['skull', 3], ['bag', 2]] },
    { goal: 2900, time: 52, plans: [['gold_s', 5], ['gold_m', 5], ['gold_l', 4], ['rock_s', 6], ['rock_l', 4], ['diamond', 2], ['bag', 3]] },
    { goal: 3300, time: 50, plans: [['gold_m', 6], ['gold_l', 5], ['gold_xl', 2], ['rock_l', 5], ['ruby', 2], ['skull', 3], ['bag', 3]] },
    { goal: 3800, time: 50, plans: [['gold_s', 5], ['gold_m', 5], ['gold_l', 5], ['gold_xl', 2], ['rock_s', 6], ['rock_l', 5], ['diamond', 2], ['bag', 3]] },
    { goal: 4500, time: 50, plans: [['gold_m', 5], ['gold_l', 5], ['gold_xl', 2], ['rock_l', 5], ['bone', 3], ['emerald', 3], ['diamond', 2], ['bag', 3]] },
  ];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- DOM

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const dom = {
    stage: document.getElementById('stage'),
    level: document.getElementById('hud-level'),
    goal: document.getElementById('hud-goal'),
    money: document.getElementById('hud-money'),
    time: document.getElementById('hud-time'),
    strength: document.getElementById('hud-strength'),
    timeBar: document.getElementById('time-bar'),
    timeBarFill: document.getElementById('time-bar-fill'),
    overlay: document.getElementById('overlay'),
    panel: document.getElementById('panel'),
    panelTitle: document.getElementById('panel-title'),
    panelSub: document.getElementById('panel-sub'),
    panelBody: document.getElementById('panel-body'),
    panelActions: document.getElementById('panel-actions'),
    panelHint: document.getElementById('panel-hint'),
    toastLayer: document.getElementById('toast-layer'),
    lootList: document.getElementById('loot-list'),
    soundIco: document.getElementById('sound-ico'),
  };

  // ---------------------------------------------------------------- 音效（WebAudio 合成，零外部资源）

  const Sfx = (() => {
    let audioCtx = null;
    let muted = false;

    const ensure = () => {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    };

    const tone = (freq, dur, type = 'sine', vol = 0.16, slideTo = null) => {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      const t0 = ac.currentTime;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    };

    const noise = (dur = 0.28, vol = 0.2) => {
      if (muted) return;
      const ac = ensure();
      if (!ac) return;
      const len = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 1.6;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      const t0 = ac.currentTime;
      filter.frequency.setValueAtTime(1400, t0);
      filter.frequency.exponentialRampToValueAtTime(220, t0 + dur);
      const gain = ac.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter).connect(gain).connect(ac.destination);
      src.start();
    };

    return {
      shoot: () => tone(760, 0.26, 'sawtooth', 0.1, 190),
      grab: () => { tone(210, 0.1, 'square', 0.12); noise(0.14, 0.13); },
      coin: () => { tone(880, 0.09, 'triangle', 0.13); setTimeout(() => tone(1320, 0.13, 'triangle', 0.11), 62); },
      gem: () => [1046, 1318, 1568, 2093].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'triangle', 0.1), i * 52)),
      bag: () => { tone(420, 0.16, 'square', 0.11, 780); setTimeout(() => tone(1200, 0.16, 'triangle', 0.1), 110); },
      junk: () => tone(150, 0.24, 'square', 0.1, 90),
      blast: () => { noise(0.5, 0.3); tone(90, 0.4, 'sawtooth', 0.12, 42); },
      win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.12), i * 118)),
      lose: () => [440, 370, 294, 233].forEach((f, i) => setTimeout(() => tone(f, 0.34, 'sine', 0.13), i * 148)),
      tick: () => tone(1500, 0.06, 'square', 0.07),
      buy: () => { tone(660, 0.1, 'triangle', 0.12); setTimeout(() => tone(990, 0.14, 'triangle', 0.1), 80); },
      deny: () => tone(180, 0.22, 'sawtooth', 0.11, 120),
      get muted() { return muted; },
      toggle() { muted = !muted; if (!muted) ensure(); return muted; },
    };
  })();

  // ---------------------------------------------------------------- 状态

  const state = {
    phase: 'menu',        // menu | playing | shop | gameover | win
    mode: IDLE,           // idle | shoot | pull | paused | finished
    resumeMode: IDLE,
    level: 1,
    money: 0,             // 跨关钱包（商店消费）
    earnedThisLevel: 0,   // 本关收入（达标判定）
    totalEarned: 0,
    angle: 0,
    swingDir: 1,
    distance: REST_DIST,
    carrying: null,
    bombs: 0,
    strength: 0,          // 备好的药水数量
    luck: 0,
    strengthTimer: 0,     // 本关内剩余生效时间
    luckTimer: 0,
    time: 0,
    maxTime: 0,
    lastTick: -1,
    caught: 0,
    bestCatch: 0,
    shots: 0,
    hits: 0,
    shake: 0,
    coinShown: 0,
  };

  let items = [];
  let particles = [];
  let floaters = [];
  let endTimer = null;

  // ---------------------------------------------------------------- 几何：可达性

  /** 给定摆角，绳长能伸到多长（受画布左右与底部边界约束）。 */
  function maxReach(angle) {
    const sinA = Math.sin(angle);
    const cosA = Math.cos(angle);
    let reach = Infinity;
    if (sinA > 1e-4) reach = Math.min(reach, (W - BOUND_X - PIVOT.x) / sinA);
    if (sinA < -1e-4) reach = Math.min(reach, (PIVOT.x - BOUND_X) / -sinA);
    if (cosA > 1e-4) reach = Math.min(reach, (BOUND_BOTTOM - PIVOT.y) / cosA);
    return reach;
  }

  function isReachable(x, y, r) {
    const dx = x - PIVOT.x;
    const dy = y - PIVOT.y;
    if (dy <= 0) return false;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dx, dy);
    if (Math.abs(angle) > SWING_LIMIT - 0.02) return false;
    // 爪头要能贴到物品表面
    return dist - r <= maxReach(angle) - 4;
  }

  // ---------------------------------------------------------------- 关卡生成

  function generateLevel(levelIndex) {
    const conf = LEVELS[Math.min(levelIndex, LEVELS.length - 1)];
    const pool = [];
    for (const [type, count] of conf.plans) {
      for (let i = 0; i < count; i++) pool.push(type);
    }
    // 大件先放，保证巨型金矿这类大体积物品有位置
    pool.sort((a, b) => LOOT[b].r - LOOT[a].r);

    const top = GROUND_Y + 40;
    const bottom = H - 44;
    const left = 46;
    const right = W - 46;

    const placed = [];
    const cell = 72;
    const cols = Math.floor((right - left) / cell);
    const rows = Math.floor((bottom - top) / cell);
    const slots = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        slots.push({ x: left + cell * (c + 0.5), y: top + cell * (r + 0.5), used: false });
      }
    }
    for (let i = slots.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    const fits = (x, y, r) => {
      if (!isReachable(x, y, r)) return false;
      for (const o of placed) {
        const minD = o.r + r + 6;
        if ((o.x - x) ** 2 + (o.y - y) ** 2 < minD * minD) return false;
      }
      // 避免正中下钩总有必中之物，逼玩家等摆动
      if (Math.abs(x - PLAYER_X) < 24 && y < GROUND_Y + 140) return false;
      return true;
    };

    for (const type of pool) {
      const def = LOOT[type];
      let spot = null;

      // 第一轮：在随机空格里找位（分布自然）
      const shuffled = slots.filter((s) => !s.used);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (const s of shuffled) {
        const x = clamp(s.x + rand(-14, 14), left + def.r, right - def.r);
        const y = clamp(s.y + rand(-14, 14), top + def.r, bottom - def.r);
        if (fits(x, y, def.r)) { spot = { x, y, slot: s }; break; }
      }
      // 第二轮：全随机撒点
      if (!spot) {
        for (let attempt = 0; attempt < 200 && !spot; attempt++) {
          const x = rand(left + def.r, right - def.r);
          const y = rand(top + def.r, bottom - def.r);
          if (fits(x, y, def.r)) spot = { x, y, slot: null };
        }
      }
      if (!spot) continue;
      if (spot.slot) spot.slot.used = true;

      placed.push({
        type,
        x: spot.x,
        y: spot.y,
        r: def.r,
        rot: rand(-0.5, 0.5),
        wobble: rand(0, Math.PI * 2),
        taken: false,
        bagResult: type === 'bag' ? weightedPick(BAG_TABLE) : null,
      });
    }
    return placed;
  }

  function weightedPick(table) {
    const total = table.reduce((s, t) => s + t.weight, 0);
    let roll = Math.random() * total;
    for (const entry of table) {
      roll -= entry.weight;
      if (roll <= 0) return entry;
    }
    return table[0];
  }

  // ---------------------------------------------------------------- 工具

  const pointToSegment = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy || 1;
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1);
    return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
  };

  const hookPos = (dist = state.distance) => ({
    x: PIVOT.x + Math.sin(state.angle) * dist,
    y: PIVOT.y + Math.cos(state.angle) * dist,
  });

  function toast(text, warn = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (warn ? ' warn' : '');
    el.textContent = text;
    dom.toastLayer.appendChild(el);
    setTimeout(() => el.remove(), 1650);
  }

  function spawnParticles(x, y, tone, count = 16, spread = 220) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(40, spread);
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: rand(0.35, 0.9), max: 0.9,
        r: rand(1.6, 4.2), tone,
      });
    }
  }

  const spawnFloater = (x, y, text, tone) => floaters.push({ x, y, text, tone, life: 1.1, max: 1.1 });

  // ---------------------------------------------------------------- 数值

  const luckMul = () => (state.luckTimer > 0 ? 1.35 : 1);
  const strengthMul = () => (state.strengthTimer > 0 ? 1.75 : 1);

  /** 收线速度：物品自身的 pull 值，随绳长线性衰减（绳子越长越吃力）。 */
  function pullSpeed() {
    if (!state.carrying) return EMPTY_PULL_SPEED;
    const base = LOOT[state.carrying.type].pull;
    const decay = clamp(1 - 0.35 * (state.distance / 640), 0.55, 1);
    return base * decay * strengthMul();
  }

  // ---------------------------------------------------------------- 玩法

  function shoot() {
    if (state.phase !== 'playing' || state.mode !== IDLE) return;
    state.mode = SHOOT;
    state.shots++;
    Sfx.shoot();
  }

  function grabItem(item) {
    item.taken = true;
    state.carrying = item;
    state.mode = PULL;
    state.caught++;
    state.hits++;
    Sfx.grab();
    if (item.type === 'bag') Sfx.bag();
  }

  function deposit(carried) {
    const def = LOOT[carried.type];
    let value = def.value;
    let label = def.name;
    let tone = def.tone;

    if (carried.type === 'bag' && carried.bagResult) {
      value = carried.bagResult.value;
      label = carried.bagResult.label;
      tone = carried.bagResult.tone;
    }
    value = Math.round(value * luckMul());

    state.money += value;
    state.earnedThisLevel += value;
    state.totalEarned += value;
    if (value > state.bestCatch) state.bestCatch = value;

    const hook = hookPos();
    spawnFloater(hook.x, hook.y - 28, label + ' +' + value, tone);

    if (value >= 300) { spawnParticles(hook.x, hook.y, tone, 30, 280); Sfx.gem(); }
    else if (value >= 90) { spawnParticles(hook.x, hook.y, tone, 16, 190); Sfx.coin(); }
    else if (value > 0) { spawnParticles(hook.x, hook.y, tone, 8, 130); Sfx.coin(); }
    else { Sfx.junk(); spawnFloater(hook.x, hook.y - 56, '一无所获', '#ff6b5e'); }

    items = items.filter((i) => !i.taken);
    state.carrying = null;
    state.mode = IDLE;
    state.shake = Math.max(state.shake, value >= 300 ? 7 : 0);
    syncHud();
  }

  function detonate() {
    const carried = state.carrying;
    if (!carried) return;
    state.shake = 15;
    Sfx.blast();
    const hook = hookPos();
    spawnParticles(hook.x, hook.y, '#ff9a5a', 42, 420);
    spawnParticles(hook.x, hook.y, '#5c5350', 22, 260);
    spawnFloater(hook.x, hook.y - 32, '已炸毁 ' + LOOT[carried.type].name, '#ff9a5a');
    carried.taken = true;
    items = items.filter((i) => i !== carried);
    state.carrying = null;
    state.mode = IDLE;
    syncHud();
  }

  function updateTimers(dt) {
    if (state.strengthTimer > 0) {
      state.strengthTimer = Math.max(0, state.strengthTimer - dt);
      if (state.strengthTimer === 0) { toast('力量药水效果结束'); syncHud(); }
    }
    if (state.luckTimer > 0) {
      state.luckTimer = Math.max(0, state.luckTimer - dt);
      if (state.luckTimer === 0) { toast('幸运草效果结束'); syncHud(); }
    }
  }

  // ---------------------------------------------------------------- 循环

  let lastTime = performance.now();

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    update(dt);
    render(dt);
    requestAnimationFrame(tick);
  }

  function update(dt) {
    updateParticles(dt);
    if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 46);

    if (state.phase !== 'playing' || state.mode === PAUSED || state.mode === FINISHED) return;

    updateClock(dt);
    updateTimers(dt);

    if (state.mode === IDLE) {
      state.angle += SWING_RATE * state.swingDir * dt;
      if (state.angle > SWING_LIMIT) { state.angle = SWING_LIMIT; state.swingDir = -1; }
      else if (state.angle < -SWING_LIMIT) { state.angle = -SWING_LIMIT; state.swingDir = 1; }
      state.distance = REST_DIST;
      return;
    }

    if (state.mode === SHOOT) {
      const from = state.distance;
      state.distance += SHOOT_SPEED * dt;
      const hook = hookPos();

      if (hook.x < BOUND_X || hook.x > W - BOUND_X || hook.y > BOUND_BOTTOM) {
        state.distance = from;
        state.mode = PULL;
        Sfx.junk();
        spawnFloater(clamp(hook.x, 50, W - 50), clamp(hook.y, 60, H - 40), '空钩', '#ff6b5e');
        return;
      }

      // 用本帧的位移线段做扫掠判定，避免高速下探穿过小物品
      const prev = hookPos(from);
      for (const item of items) {
        if (item.taken) continue;
        if (pointToSegment(item.x, item.y, prev.x, prev.y, hook.x, hook.y) <= item.r + HOOK_R * 0.72) {
          grabItem(item);
          break;
        }
      }
      return;
    }

    if (state.mode === PULL) {
      const speed = pullSpeed();
      state.distance -= speed * dt;

      const hook = hookPos();
      if (state.carrying) {
        state.carrying.x = hook.x;
        state.carrying.y = hook.y;
        // 重物被硬拉时冒灰
        if (speed < 240 && Math.random() < 0.5) {
          particles.push({
            x: hook.x + rand(-8, 8), y: hook.y + rand(-8, 8),
            vx: rand(-30, 30), vy: rand(-60, -10),
            life: 0.3, max: 0.3, r: rand(1, 2.4), tone: '#cfc7ba',
          });
        }
      }

      if (state.distance <= REST_DIST) {
        state.distance = REST_DIST;
        if (state.carrying) deposit(state.carrying);
        else state.mode = IDLE;
      }
    }
  }

  function updateClock(dt) {
    state.time = Math.max(0, state.time - dt);
    const secs = Math.ceil(state.time);
    if (secs !== state.lastTick) {
      state.lastTick = secs;
      dom.time.textContent = String(secs);
      if (secs <= 10 && secs > 0) Sfx.tick();
    }
    const ratio = state.maxTime ? state.time / state.maxTime : 0;
    dom.timeBarFill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    dom.timeBar.classList.toggle('low', secs <= 10);
    if (state.time <= 0) endLevel();
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += 620 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dt;
      f.y -= 40 * dt;
      if (f.life <= 0) floaters.splice(i, 1);
    }
    // 金币滚动动画
    if (state.coinShown !== state.money) {
      const diff = state.money - state.coinShown;
      const step = Math.abs(diff) < 2 ? diff : diff * Math.min(1, dt * 9);
      state.coinShown += step;
      if (Math.abs(state.money - state.coinShown) < 0.6) state.coinShown = state.money;
      dom.money.textContent = String(Math.round(state.coinShown));
    }
  }

  // ---------------------------------------------------------------- 渲染

  function render() {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (state.shake > 0) {
      ctx.translate(rand(-state.shake, state.shake) * 0.4, rand(-state.shake, state.shake) * 0.4);
    }

    drawSky();
    drawGround();
    drawCave();
    for (const item of items) if (!item.taken) drawItem(item);
    drawRope();
    drawPlayer();
    if (state.carrying) drawItem(state.carrying, true);
    drawParticles();
    drawFloaters();
    drawPriceHints();

    ctx.restore();
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, '#2b1b3d');
    g.addColorStop(0.55, '#4a2a3c');
    g.addColorStop(1, '#71402f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, GROUND_Y);

    ctx.fillStyle = 'rgba(28, 16, 32, 0.55)';
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(0, GROUND_Y - 74);
    for (const [x, up] of [[90, 42], [180, 66], [268, 30], [372, 58], [470, 22], [580, 54], [690, 34], [800, 62], [900, 40], [960, 56]]) {
      ctx.lineTo(x, GROUND_Y - up - 16);
    }
    ctx.lineTo(W, GROUND_Y);
    ctx.closePath();
    ctx.fill();

    const t = performance.now() / 900;
    ctx.fillStyle = 'rgba(255, 244, 214, 0.72)';
    for (const [x, y] of [[62, 34], [148, 20], [236, 52], [318, 26], [420, 44], [512, 18], [604, 40], [700, 24], [792, 48], [880, 30], [944, 58]]) {
      ctx.globalAlpha = 0.45 + 0.45 * Math.sin(t + x);
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.globalAlpha = 1;

    const mg = ctx.createRadialGradient(828, 74, 4, 828, 74, 42);
    mg.addColorStop(0, 'rgba(255, 240, 205, 0.9)');
    mg.addColorStop(1, 'rgba(255, 220, 160, 0)');
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.arc(828, 74, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffeec9';
    ctx.beginPath();
    ctx.arc(828, 74, 21, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, GROUND_Y - 14, 0, GROUND_Y + 22);
    g.addColorStop(0, '#8a5a3a');
    g.addColorStop(0.45, '#5f3d28');
    g.addColorStop(1, '#3a2517');
    ctx.fillStyle = g;
    ctx.fillRect(0, GROUND_Y - 14, W, 36);

    ctx.fillStyle = '#3f6b33';
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y - 14);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, GROUND_Y - 14 - Math.abs(Math.sin(x / 34)) * 4);
    ctx.lineTo(W, GROUND_Y - 10);
    ctx.lineTo(0, GROUND_Y - 10);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1;
    for (let x = 10; x < W; x += 42) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y + 6);
      ctx.lineTo(x + 5, GROUND_Y + 14);
      ctx.stroke();
    }
  }

  function drawCave() {
    const top = GROUND_Y + 22;
    const g = ctx.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, '#2a1d1a');
    g.addColorStop(0.4, '#20161a');
    g.addColorStop(1, '#140d13');
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, H - top);

    ctx.strokeStyle = 'rgba(255, 216, 170, 0.045)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const x = (i * 137) % W;
      const y = top + 30 + ((i * 91) % (H - top - 80));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 28, y + 14, x + 12, y + 40);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    for (let i = 0; i < 14; i++) {
      const x = 30 + i * 68 + ((i * 37) % 20);
      const len = 12 + ((i * 53) % 26);
      ctx.beginPath();
      ctx.moveTo(x - 9, top);
      ctx.lineTo(x + 9, top);
      ctx.lineTo(x, top + len);
      ctx.closePath();
      ctx.fill();
    }

    const light = ctx.createRadialGradient(PIVOT.x, PIVOT.y + 120, 30, PIVOT.x, PIVOT.y + 120, 500);
    light.addColorStop(0, 'rgba(255, 196, 110, 0.1)');
    light.addColorStop(1, 'rgba(255, 196, 110, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, top, W, H - top);
  }

  function drawPlayer() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.beginPath();
    ctx.ellipse(PLAYER_X, GROUND_Y - 4, 40, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    const bodyGrad = ctx.createLinearGradient(0, PLAYER_Y - 40, 0, GROUND_Y);
    bodyGrad.addColorStop(0, '#3f7fd1');
    bodyGrad.addColorStop(1, '#28518a');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.roundRect(PLAYER_X - 25, PLAYER_Y - 22, 50, 48, 12);
    ctx.fill();

    ctx.fillStyle = '#f2c39b';
    ctx.beginPath();
    ctx.arc(PLAYER_X, PLAYER_Y - 40, 21, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffb52e';
    ctx.beginPath();
    ctx.arc(PLAYER_X, PLAYER_Y - 46, 22, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(PLAYER_X - 27, PLAYER_Y - 48, 54, 6);
    ctx.fillStyle = '#ffe08a';
    ctx.beginPath();
    ctx.arc(PLAYER_X, PLAYER_Y - 60, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#33241c';
    ctx.beginPath();
    ctx.arc(PLAYER_X - 7, PLAYER_Y - 40, 2.6, 0, Math.PI * 2);
    ctx.arc(PLAYER_X + 7, PLAYER_Y - 40, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#b9795a';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(PLAYER_X, PLAYER_Y - 34, 7, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = '#4b4b52';
    ctx.beginPath();
    ctx.roundRect(PLAYER_X - 16, PLAYER_Y + 20, 32, 12, 4);
    ctx.fill();
    ctx.fillStyle = '#8d8d97';
    ctx.beginPath();
    ctx.arc(PIVOT.x - 9, PIVOT.y + 4, 5, 0, Math.PI * 2);
    ctx.arc(PIVOT.x + 9, PIVOT.y + 4, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRope() {
    const hook = hookPos();

    ctx.strokeStyle = '#cbb083';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(PIVOT.x, PIVOT.y);
    ctx.lineTo(hook.x, hook.y);
    ctx.stroke();

    ctx.fillStyle = '#7d6a4c';
    ctx.beginPath();
    ctx.arc(PIVOT.x, PIVOT.y, 4.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(hook.x, hook.y);
    ctx.rotate(-state.angle);
    ctx.fillStyle = '#9fa4ad';
    ctx.strokeStyle = '#5e636c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-HOOK_R * 0.7, -HOOK_R * 0.5, HOOK_R * 1.4, HOOK_R * 1.1, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#b7bcc4';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * HOOK_R * 0.55, -HOOK_R * 0.6);
      ctx.lineTo(side * HOOK_R * 1.5, HOOK_R * 0.25);
      ctx.lineTo(side * HOOK_R * 1.42, HOOK_R * 0.95);
      ctx.lineTo(side * HOOK_R * 0.6, HOOK_R * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    const dirX = Math.sin(state.angle);
    const perpX = Math.cos(state.angle);
    ctx.fillStyle = state.mode === SHOOT ? 'rgba(255, 240, 200, 0.85)' : 'rgba(255, 240, 200, 0.38)';
    ctx.beginPath();
    ctx.arc(hook.x + perpX * 3, hook.y - dirX * 3, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawItem(item, inHand = false) {
    const def = LOOT[item.type];
    const rot = item.rot + Math.sin(performance.now() / 620 + item.wobble) * 0.045;
    // 被抓住时挂在爪头下方，看起来像被夹住
    const oy = inHand ? item.r * 0.55 : 0;

    ctx.save();
    ctx.translate(item.x, item.y + oy);

    if (!inHand) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.beginPath();
      ctx.ellipse(3, item.r * 0.72, item.r * 0.92, item.r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(rot);

    if (def.kind === 'bag') {
      const grad = ctx.createLinearGradient(0, -item.r, 0, item.r);
      grad.addColorStop(0, def.tone);
      grad.addColorStop(1, def.tone2);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(-item.r * 0.86, -item.r * 0.2);
      ctx.quadraticCurveTo(-item.r * 1.1, item.r, 0, item.r * 1.05);
      ctx.quadraticCurveTo(item.r * 1.1, item.r, item.r * 0.86, -item.r * 0.2);
      ctx.quadraticCurveTo(0, -item.r * 0.5, -item.r * 0.86, -item.r * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.strokeStyle = '#4a3116';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-item.r * 0.6, -item.r * 0.28);
      ctx.quadraticCurveTo(0, -item.r * 0.62, item.r * 0.6, -item.r * 0.28);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 245, 220, 0.92)';
      ctx.font = 'bold ' + Math.round(item.r * 1.15) + 'px "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, item.r * 0.2);
      ctx.restore();
      return;
    }

    const grad = ctx.createRadialGradient(-item.r * 0.32, -item.r * 0.4, item.r * 0.16, 0, 0, item.r * 1.15);
    grad.addColorStop(0, def.tone);
    grad.addColorStop(1, def.tone2);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, item.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.beginPath();
    ctx.ellipse(-item.r * 0.34, -item.r * 0.4, item.r * 0.28, item.r * 0.17, -0.6, 0, Math.PI * 2);
    ctx.fill();

    if (def.kind === 'gold') {
      ctx.strokeStyle = 'rgba(255, 240, 190, 0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, item.r * 0.62, 0.6, 2.2);
      ctx.stroke();
    } else if (def.kind === 'gem') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-item.r * 0.7, 0);
      ctx.lineTo(0, -item.r * 0.8);
      ctx.lineTo(item.r * 0.7, 0);
      ctx.lineTo(0, item.r * 0.8);
      ctx.closePath();
      ctx.stroke();
    } else if (def.kind === 'junk') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.beginPath();
      ctx.arc(-item.r * 0.3, item.r * 0.2, item.r * 0.16, 0, Math.PI * 2);
      ctx.arc(item.r * 0.36, -item.r * 0.16, item.r * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.tone;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.6 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
      ctx.font = 'bold 18px "PingFang SC", -apple-system, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.tone;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  /** 前 3 关给未抓取的物品标注价值，降低上手门槛 */
  function drawPriceHints() {
    if (state.level > 3 || state.phase !== 'playing') return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
    for (const item of items) {
      if (item.taken) continue;
      const def = LOOT[item.type];
      const txt = def.kind === 'bag' ? '?' : String(def.value);
      const cheap = def.kind === 'rock' || def.kind === 'junk';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.beginPath();
      ctx.roundRect(item.x - 15, item.y - item.r - 18, 30, 14, 6);
      ctx.fill();
      ctx.fillStyle = cheap ? 'rgba(255, 255, 255, 0.62)' : '#ffd75e';
      ctx.fillText(txt, item.x, item.y - item.r - 11);
    }
  }

  // ---------------------------------------------------------------- 关卡流程

  function startLevel(levelIndex) {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    const conf = LEVELS[Math.min(levelIndex, LEVELS.length - 1)];

    state.level = levelIndex + 1;
    state.mode = IDLE;
    state.resumeMode = IDLE;
    state.angle = 0;
    state.swingDir = 1;
    state.distance = REST_DIST;
    state.carrying = null;
    state.time = conf.time;
    state.maxTime = conf.time;
    state.earnedThisLevel = 0;
    state.lastTick = -1;
    state.phase = 'playing';
    state.strengthTimer = 0;
    state.luckTimer = 0;
    // 结算面板展示的是「本关」抓取与命中，必须按关重置，否则会跨关累加
    state.shots = 0;
    state.hits = 0;
    state.caught = 0;
    state.bestCatch = 0;
    state.shake = 0;

    items = generateLevel(levelIndex);
    particles = [];
    floaters = [];

    hideOverlay();
    syncHud();
    toast('第 ' + state.level + ' 关 · 目标 ' + conf.goal);
  }

  function endLevel() {
    if (state.phase !== 'playing') return;
    state.phase = 'result';
    state.mode = FINISHED;
    state.carrying = null;
    state.distance = REST_DIST;
    // 残余货物作废，避免「时间到了还在拉」的歧义
    items = items.filter((i) => !i.taken);

    const conf = LEVELS[Math.min(state.level - 1, LEVELS.length - 1)];
    const passed = state.earnedThisLevel >= conf.goal;

    endTimer = setTimeout(() => {
      endTimer = null;
      if (passed) showNextPanel(conf);
      else showFailPanel(conf);
    }, RESULT_DELAY_MS);
  }

  function summaryHtml(conf, failed = false) {
    const acc = state.shots ? Math.round((state.hits / state.shots) * 100) : 0;
    const cells = [
      { k: '本关收入', v: String(state.earnedThisLevel), cls: failed ? 'bad' : 'gold' },
      { k: '本关目标', v: String(conf.goal), cls: failed ? 'bad' : 'ok' },
      { k: '抓取', v: state.caught + ' 件', cls: '' },
      { k: '命中率', v: acc + '%', cls: acc >= 60 ? 'ok' : '' },
      { k: '最大单笔', v: String(state.bestCatch), cls: 'gold' },
      { k: '钱包余额', v: String(state.money), cls: '' },
    ];
    return '<div class="score-grid">' + cells.map((c) =>
      '<div class="score-cell"><span class="k">' + c.k + '</span><span class="v ' + c.cls + '">' + c.v + '</span></div>'
    ).join('') + '</div>';
  }

  const SHOP_GOODS = [
    { key: 'bomb', ico: '🧨', nm: '炸药', ds: '钩住重物时炸掉它，立刻收杆', price: 120 },
    { key: 'strength', ico: '💪', nm: '力量药水', ds: '本关收线速度 +75%', price: 180 },
    { key: 'luck', ico: '🍀', nm: '幸运草', ds: '本关所有矿物价值 +35%', price: 150 },
  ];

  function shopHtml() {
    const rows = SHOP_GOODS.map((g) => {
      const have = g.key === 'bomb' ? state.bombs : g.key === 'strength' ? state.strength : state.luck;
      const owned = have > 0;
      const label = owned
        ? (g.key === 'bomb' ? '已有 ' + have : '已备好')
        : g.price + ' 金';
      const cls = owned && g.key !== 'bomb' ? 'shop-buy owned' : 'shop-buy';
      const disabled = state.money < g.price ? ' disabled' : '';
      return '<div class="shop-item">' +
        '<span class="ico">' + g.ico + '</span>' +
        '<span class="txt"><span class="nm">' + g.nm + '</span><span class="ds">' + g.ds + '</span></span>' +
        '<button class="' + cls + '" data-buy="' + g.key + '"' + disabled + '>' + label + '</button>' +
      '</div>';
    }).join('');
    return '<div class="shop-list">' + rows + '</div>';
  }

  function showNextPanel(conf) {
    const isLast = state.level >= LEVELS.length;

    if (isLast) {
      state.phase = 'win';
      Sfx.win();
      showPanel({
        title: '全部通关',
        sub: '第 ' + LEVELS.length + ' 关清点完毕，这条矿脉被你挖空了。',
        body: summaryHtml(conf),
        actions: [{ label: '再玩一次', primary: true, on: () => restartGame() }],
        hint: '本轮累计收入 ' + state.totalEarned + ' 金币',
      });
      return;
    }

    state.phase = 'shop';
    Sfx.win();
    const nextGoal = LEVELS[state.level].goal;
    showPanel({
      title: '第 ' + state.level + ' 关达标',
      sub: '超额 ' + (state.earnedThisLevel - conf.goal) + ' 金币。进商店补给，下一关目标 ' + nextGoal + '。',
      body: summaryHtml(conf) + shopHtml(),
      actions: [
        { label: '进入第 ' + (state.level + 1) + ' 关', primary: true, on: () => startLevel(state.level) },
        { label: '返回主菜单', on: () => restartGame(true) },
      ],
      hint: '商店只在关间开放，道具会留到后面的关卡',
    });
    bindShopButtons();
  }

  function showFailPanel(conf) {
    state.phase = 'gameover';
    Sfx.lose();
    showPanel({
      title: '时间到了',
      sub: '本关挖到 ' + state.earnedThisLevel + ' 金币，离目标 ' + conf.goal +
        ' 还差 ' + (conf.goal - state.earnedThisLevel) + '。',
      body: summaryHtml(conf, true),
      actions: [
        { label: '重试本关', primary: true, on: () => retryLevel() },
        { label: '返回主菜单', on: () => restartGame(true) },
      ],
      hint: '试试：先抓小金子稳住节奏，把重物留在摆动幅度大时下钩',
    });
  }

  function buyGood(key) {
    const good = SHOP_GOODS.find((g) => g.key === key);
    if (!good) return false;
    if (state.money < good.price) { Sfx.deny(); toast('金币不够', true); return false; }
    if (good.key !== 'bomb') {
      const cur = good.key === 'strength' ? state.strength : state.luck;
      if (cur > 0) { Sfx.deny(); toast('这一关已经备好了', true); return false; }
    }
    state.money -= good.price;
    if (good.key === 'bomb') state.bombs += 1;
    if (good.key === 'strength') state.strength = 1;
    if (good.key === 'luck') state.luck = 1;
    Sfx.buy();
    syncHud();
    return true;
  }

  function bindShopButtons() {
    dom.panelBody.querySelectorAll('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!buyGood(btn.dataset.buy)) return;
        const conf = LEVELS[Math.min(state.level - 1, LEVELS.length - 1)];
        dom.panelBody.innerHTML = summaryHtml(conf) + shopHtml();
        bindShopButtons();
      });
    });
  }

  function retryLevel() {
    // 把本关已入账的钱退回，避免反复重试刷钱包
    state.money = Math.max(0, state.money - state.earnedThisLevel);
    startLevel(state.level - 1);
  }

  function restartGame(toMenu = false) {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    Object.assign(state, {
      money: 0, earnedThisLevel: 0, totalEarned: 0, bombs: 0, strength: 0, luck: 0,
      strengthTimer: 0, luckTimer: 0, caught: 0, bestCatch: 0, shots: 0, hits: 0,
      coinShown: 0, shake: 0, carrying: null,
    });
    items = [];
    particles = [];
    floaters = [];
    if (toMenu) { state.level = 1; state.phase = 'menu'; state.mode = IDLE; showMenu(); }
    else startLevel(0);
  }

  function usePowerup(kind) {
    if (state.phase !== 'playing' || state.mode === PAUSED) return;

    if (kind === 'bomb') {
      if (state.bombs <= 0) { Sfx.deny(); toast('没有炸药了', true); return; }
      if (!state.carrying) { Sfx.deny(); toast('要先钩住东西才能炸', true); return; }
      state.bombs -= 1;
      detonate();
      return;
    }
    if (kind === 'strength') {
      if (state.strength <= 0) { Sfx.deny(); toast('没有力量药水', true); return; }
      if (state.strengthTimer > 0) { Sfx.deny(); toast('药水还在生效', true); return; }
      state.strength -= 1;
      state.strengthTimer = state.time;   // 本关剩余时间
      Sfx.buy();
      toast('力量药水生效：收线更快');
      syncHud();
      return;
    }
    if (kind === 'luck') {
      if (state.luck <= 0) { Sfx.deny(); toast('没有幸运草', true); return; }
      if (state.luckTimer > 0) { Sfx.deny(); toast('幸运草还在生效', true); return; }
      state.luck -= 1;
      state.luckTimer = state.time;
      Sfx.buy();
      toast('幸运草生效：矿物价值提升');
      syncHud();
    }
  }

  // ---------------------------------------------------------------- HUD 与面板

  function syncHud() {
    const conf = LEVELS[Math.min(state.level - 1, LEVELS.length - 1)];
    const met = state.earnedThisLevel >= conf.goal;

    dom.level.textContent = String(state.level);
    dom.goal.textContent = '本关 ' + state.earnedThisLevel + ' / ' + conf.goal;
    dom.goal.classList.toggle('done', met);
    dom.time.textContent = String(Math.ceil(state.time));
    dom.strength.textContent = strengthMul().toFixed(2);
    // 金币显示由 updateParticles 的滚动动画驱动，这里不做赋值，避免动画被立刻抹平
    dom.timeBarFill.style.transform =
      'scaleX(' + (state.maxTime ? (state.time / state.maxTime).toFixed(4) : 1) + ')';
    dom.timeBar.classList.toggle('low', state.time <= 10 && state.time > 0);

    const badges = { bomb: state.bombs, strength: state.strength, luck: state.luck };
    for (const [key, value] of Object.entries(badges)) {
      const el = document.getElementById('pw-' + key);
      el.textContent = String(value);
      el.classList.toggle('hidden', value === 0);
    }

    document.querySelectorAll('.pw[data-item]').forEach((btn) => {
      const item = btn.dataset.item;
      const count = badges[item];
      const active = (item === 'strength' && state.strengthTimer > 0) || (item === 'luck' && state.luckTimer > 0);
      btn.disabled = state.phase !== 'playing' || (count === 0 && !active);
      btn.classList.toggle('active', active);
    });
  }

  function showPanel({ title, sub, body, actions, hint }) {
    dom.panelTitle.textContent = title;
    dom.panelSub.textContent = sub || '';
    dom.panelBody.innerHTML = body || '';
    dom.panelHint.textContent = hint || '';

    dom.panelActions.innerHTML = '';
    for (const a of actions || []) {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost2');
      btn.textContent = a.label;
      btn.addEventListener('click', () => a.on());
      dom.panelActions.appendChild(btn);
    }
    dom.overlay.classList.remove('hidden');
  }

  const hideOverlay = () => dom.overlay.classList.add('hidden');

  function showMenu() {
    state.phase = 'menu';
    state.mode = IDLE;
    state.level = 1;
    state.time = 0;
    state.maxTime = 0;
    state.earnedThisLevel = 0;
    items = [];
    syncHud();
    showPanel({
      title: '黄金矿工',
      sub: '摆动的爪子，等一个精准的时机。越重的宝贝拖得越慢，越贵的越值得冒险。',
      body:
        '<div class="score-grid">' +
        '<div class="score-cell"><span class="k">关卡</span><span class="v gold">' + LEVELS.length + '</span></div>' +
        '<div class="score-cell"><span class="k">核心手感</span><span class="v">越重越慢</span></div>' +
        '<div class="score-cell"><span class="k">隐藏玩法</span><span class="v">口袋有惊喜</span></div>' +
        '</div>',
      actions: [
        { label: '开始挖矿', primary: true, on: () => startLevel(0) },
      ],
      hint: '推荐键盘操作：空格放钩 · B 炸药 · S 力量 · L 幸运 · Esc 暂停 · M 静音',
    });
  }

  function togglePause() {
    if (state.phase !== 'playing') return;
    if (state.mode === PAUSED) {
      state.mode = state.resumeMode || IDLE;
      hideOverlay();
      lastTime = performance.now();
      syncHud();
      return;
    }
    state.resumeMode = state.mode;
    state.mode = PAUSED;
    showPanel({
      title: '已暂停',
      sub: '绳子和秒表都停住了。',
      body: summaryHtml(LEVELS[Math.min(state.level - 1, LEVELS.length - 1)]),
      actions: [
        { label: '继续挖矿', primary: true, on: () => togglePause() },
        { label: '返回主菜单', on: () => restartGame(true) },
      ],
      hint: 'Esc 或 P 也可以继续',
    });
  }

  // ---------------------------------------------------------------- 输入

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();

    if (k === ' ' || k === 'arrowdown') {
      e.preventDefault();
      if (state.phase === 'playing') shoot();
      else if (state.phase === 'menu') startLevel(0);
      return;
    }
    if (k === 'b') { e.preventDefault(); usePowerup('bomb'); return; }
    if (k === 's') { e.preventDefault(); usePowerup('strength'); return; }
    if (k === 'l') { e.preventDefault(); usePowerup('luck'); return; }
    if (k === 'm') { toggleSound(); return; }
    if (k === 'p' || k === 'escape') { e.preventDefault(); togglePause(); return; }
    if (k === 'enter') {
      if (state.phase === 'menu') startLevel(0);
      else if (state.phase === 'shop') startLevel(state.level);
      else if (state.phase === 'gameover') retryLevel();
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state.phase === 'playing') shoot();
    else if (state.phase === 'menu') startLevel(0);
  });

  document.querySelectorAll('.pw[data-item]').forEach((btn) => {
    btn.addEventListener('click', () => usePowerup(btn.dataset.item));
  });

  document.getElementById('btn-sound').addEventListener('click', toggleSound);

  function toggleSound() {
    const muted = Sfx.toggle();
    dom.soundIco.textContent = muted ? '🔇' : '🔊';
    toast(muted ? '已静音' : '音效已开启');
  }

  // ---------------------------------------------------------------- 自适应

  function fitStage() {
    const wrap = document.getElementById('stage-wrap');
    const pad = 36;
    const scale = Math.max(0.4, Math.min(1, Math.min(
      (wrap.clientWidth - pad) / W,
      (wrap.clientHeight - pad) / H
    )));
    // 舞台布局尺寸恒为 960×640；grid 居中后缩放溢出是对称的，因此无需修正边距
    dom.stage.style.setProperty('--scale', scale.toFixed(4));
  }
  window.addEventListener('resize', fitStage);

  // ---------------------------------------------------------------- 侧栏

  function buildLootList() {
    const rows = [
      ['diamond', '钻石'], ['gold_xl', '巨型金矿'], ['ruby', '红宝石'],
      ['emerald', '祖母绿'], ['gold_l', '大金块'], ['gold_m', '金块'],
      ['gold_s', '小金块'], ['bag', '神秘口袋'], ['rock_l', '巨石'],
      ['rock_s', '碎石'], ['skull', '头骨'],
    ];
    dom.lootList.innerHTML = rows.map(([type, label]) => {
      const def = LOOT[type];
      const val = def.kind === 'bag' ? '0 ~ 700' : String(def.value);
      return '<li><span class="dot" style="background:' + def.tone + '"></span>' +
        '<span class="nm">' + label + '</span><span class="val">' + val + '</span></li>';
    }).join('');
  }

  // ---------------------------------------------------------------- 启动

  function boot() {
    buildLootList();
    fitStage();
    showMenu();
    requestAnimationFrame((t) => { lastTime = t; tick(t); });
  }

  boot();

  // 供自动化冒烟测试使用
  window.__goldMiner = {
    state, LOOT, LEVELS, SHOP_GOODS, startLevel, shoot, usePowerup, buyGood,
    MODES: { IDLE, SHOOT, PULL, PAUSED, FINISHED },
    step: (dt) => update(dt),          // 手动推进一帧，便于确定性测试
    reachable: isReachable,
    get items() { return items; },
  };
})();
