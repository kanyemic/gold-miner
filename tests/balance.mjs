/* 平衡性验证：三个技能档位的玩家模型各跑多次，检查难度曲线。
 *
 * 模型差异只在「什么时候出手」：
 * - skilled：等待真实摆角对准；误差按下方均匀分布参数采样。
 * - casual ：误差 σ≈0.20 rad，且有 35% 概率凭感觉乱放（不看摆角）。
 * - rookie ：误差 σ≈0.35 rad，50% 概率乱放，目标选择也不挑（只按距离近）。
 *
 * 期望曲线：新手能过前 2~3 关，中期开始需要认真操作，后期关卡通过率应明显下降但不为 0。
 */
import { loadGame } from './harness.mjs';

const RUNS = 30;

const PROFILES = {
  skilled: { jitter: 0.10, blind: 0.00, tol: 0.07, react: 0.25, greedy: true },
  casual:  { jitter: 0.34, blind: 0.35, tol: 0.14, react: 0.40, greedy: true },
  rookie:  { jitter: 0.66, blind: 0.50, tol: 0.28, react: 0.55, greedy: false },
};

function simulate(game, lv, rng, p) {
  const s = game.state;
  const dt = 1 / 60;
  let guard = 0;
  let intent = null;
  let reaction = 0;

  while (s.phase === 'playing' && guard++ < 60 * 80) {
    if (s.mode === 'idle') {
      if (reaction > 0) { reaction -= dt; game.step(dt); continue; }
      if (!intent) {
        const remaining = s.time;
        let best = null;
        let bestScore = -Infinity;

        for (const item of game.items) {
          if (item.taken) continue;
          const def = game.LOOT[item.type];
          const dist = Math.hypot(item.x - 480, item.y - 222);
          const travel = dist / 560 + dist / def.pull + p.react + 0.8;
          if (travel > remaining && remaining > 5) continue;
          const score = p.greedy
            ? def.value / travel                      // 熟练玩家算性价比
            : (450 - dist) + def.value * 0.05;        // 新手只想抓近的
          if (score > bestScore) { bestScore = score; best = item; }
        }
      if (!best) break;

      const want = Math.atan2(best.x - 480, best.y - 222);
      const blind = rng() < p.blind;
      const err = (rng() - 0.5) * p.jitter * 2 + (blind ? (rng() - 0.5) * 1.2 : 0);
      const tol = blind ? 3 : p.tol;

      intent = { angle: want + err, tol };
      reaction = p.react;
      }
      if (reaction > 0 || Math.abs(s.angle - intent.angle) > intent.tol) { game.step(dt); continue; }
      game.shoot();
      intent = null;
    }
    game.step(dt);
  }
  return { earned: s.earnedThisLevel, passed: s.earnedThisLevel >= game.LEVELS[lv].goal };
}

function makeRng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

const ref = loadGame();
const levels = ref.LEVELS.length;
const table = [];

for (let lv = 0; lv < levels; lv++) {
  const row = { level: lv + 1, goal: ref.LEVELS[lv].goal };
  for (const [name, p] of Object.entries(PROFILES)) {
    let passes = 0;
    let sum = 0;
    for (let run = 0; run < RUNS; run++) {
      const g = loadGame();
      g.setRandom(makeRng(0x12345678 + lv * 7919 + run * 104729));
      g.startLevel(lv);
      const r = simulate(g, lv, makeRng(0x9e3779b9 + lv * 7919 + run * 104729 + name.length * 31), p);
      if (r.passed) passes++;
      sum += r.earned;
    }
    row[name] = passes / RUNS;
    row[name + 'Avg'] = sum / RUNS;
  }
  table.push(row);
}

console.log('');
console.log('关卡 | 目标  | 熟练 | 普通 | 新手 | 普通平均收入');
console.log('-----+-------+------+------+------+-------------');
for (const r of table) {
  console.log(
    String(r.level).padStart(4) + ' | ' +
    String(r.goal).padStart(5) + ' | ' +
    (r.skilled * 100).toFixed(0).padStart(3) + '% | ' +
    (r.casual * 100).toFixed(0).padStart(3) + '% | ' +
    (r.rookie * 100).toFixed(0).padStart(3) + '% | ' +
    r.casualAvg.toFixed(0).padStart(11)
  );
}

const problems = [];
// 熟练玩家必须能全通
for (const r of table) if (r.skilled < 0.85) problems.push(`第 ${r.level} 关对熟练玩家过难（${(r.skilled * 100).toFixed(0)}%）`);
// 新手应该能过前两关，后期应明显吃力
if (table[0].rookie < 0.6) problems.push(`第 1 关对新手太难（${(table[0].rookie * 100).toFixed(0)}%）`);
if (table[levels - 1].rookie > 0.5) problems.push(`最后一关对新手过易（${(table[levels - 1].rookie * 100).toFixed(0)}%）`);
// 普通玩家全程不应 100%（否则没有张力）
const casualEasy = table.filter((r) => r.casual >= 0.98).length;
if (casualEasy >= levels) problems.push('普通玩家全程 100% 通过，难度曲线偏软');
// 后期必须真正收紧
if (table[levels - 1].casual > 0.9) problems.push(`最后一关对普通玩家过易（${(table[levels - 1].casual * 100).toFixed(0)}%）`);

console.log('');
if (problems.length) {
  console.log('需要调整：');
  for (const p of problems) console.log('  · ' + p);
  process.exitCode = 1;
} else {
  console.log('难度曲线合理：熟练玩家稳定通关，新手前期可过、后期明显吃力');
}
