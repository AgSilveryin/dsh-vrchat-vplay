// 拟人层单测（纯函数、可 seed、无 UDP / 无 DSH）。
// 运行：node tools/test_humanize.mjs
import assert from 'node:assert/strict';
import {
  clampInt,
  clampNumber,
  createHumanizer,
  createRng,
  easeProgress,
  humanIntervals,
  jitterMs,
  lognormalSample,
  microMotionAt,
  normalizeEasing,
  reactionDelay,
} from '../lib/humanize.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// ── 可复现随机源 ────────────────────────────────────────────────────────────

check('同 seed 的随机序列完全一致，不同 seed 不同', () => {
  const seqA = [];
  const seqB = [];
  const seqC = [];
  const ra = createRng(1234);
  const rb = createRng(1234);
  const rc = createRng(99);
  for (let i = 0; i < 20; i += 1) {
    seqA.push(ra.next());
    seqB.push(rb.next());
    seqC.push(rc.next());
  }
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  // 第一个采样必须由 seed 决定，且落在 [0,1)
  assert.equal(createRng(1234).next(), seqA[0]);
  for (const value of seqA) {
    assert.ok(value >= 0 && value < 1, `rng out of range: ${value}`);
  }
});

check('rng.float 落在区间内、rng.int 是闭区间整数', () => {
  const rng = createRng(7);
  for (let i = 0; i < 500; i += 1) {
    const f = rng.float(2, 5);
    assert.ok(f >= 2 && f < 5, `float out of range: ${f}`);
    const n = rng.int(3, 6);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 6, `int out of range: ${n}`);
  }
});

check('gaussian() 均值≈0、标准差≈1', () => {
  const rng = createRng(2024);
  const samples = Array.from({ length: 20_000 }, () => rng.gaussian());
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  assert.ok(Math.abs(mean) < 0.05, `mean ${mean}`);
  const std = Math.sqrt(variance);
  assert.ok(std > 0.9 && std < 1.1, `std ${std}`);
});

// ── 反应延迟（对数正态） ────────────────────────────────────────────────────

check('反应延迟：中位数接近配置、有右长尾、全部夹在上下限内', () => {
  const rng = createRng(555);
  const medianMs = 400;
  const minMs = 120;
  const maxMs = 1600;
  const samples = Array.from({ length: 5000 }, () => reactionDelay({ medianMs, sigma: 0.35, minMs, maxMs, rng }));
  for (const value of samples) {
    assert.ok(Number.isInteger(value), 'reaction delay must be integer ms');
    assert.ok(value >= minMs && value <= maxMs, `out of bounds: ${value}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(Math.abs(median - medianMs) < medianMs * 0.15, `median ${median} vs ${medianMs}`);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > median, 'lognormal must have a right tail (mean > median)');
});

check('lognormalSample 的 sigma=0 时退化为固定中位数', () => {
  const rng = createRng(1);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(lognormalSample(rng, { median: 250, sigma: 0 }), 250);
  }
});

// ── 动作时长抖动 ────────────────────────────────────────────────────────────

check('jitterMs：区间内、relative=0 时精确等于 base', () => {
  const rng = createRng(31);
  const values = Array.from({ length: 500 }, () => jitterMs(600, { relative: 0.12, minMs: 100, maxMs: 2000, rng }));
  for (const value of values) {
    assert.ok(value >= 528 && value <= 672, `jitter out of range: ${value}`);
  }
  assert.ok(new Set(values).size > 10, 'jitter should vary');
  assert.equal(jitterMs(600, { relative: 0, rng }), 600);
});

// ── 间隔序列 ────────────────────────────────────────────────────────────────

check('humanIntervals：数量正确、区间内、相邻不相等', () => {
  const rng = createRng(77);
  const gaps = humanIntervals({ count: 200, minMs: 180, maxMs: 320, rng });
  assert.equal(gaps.length, 200);
  for (let i = 0; i < gaps.length; i += 1) {
    assert.ok(Number.isInteger(gaps[i]));
    assert.ok(gaps[i] >= 180 && gaps[i] <= 320, `gap out of range: ${gaps[i]}`);
    if (i > 0) assert.notEqual(gaps[i], gaps[i - 1], `consecutive equal gaps at ${i}`);
  }
  assert.ok(new Set(gaps).size > 20, 'gap values should not be constant');
  assert.deepEqual(humanIntervals({ count: 0, rng }), []);
  assert.equal(humanIntervals({ count: 1, minMs: 5, maxMs: 5, rng }).length, 1);
});

check('humanIntervals：同 seed 可复现', () => {
  const a = humanIntervals({ count: 12, minMs: 100, maxMs: 400, rng: createRng(42) });
  const b = humanIntervals({ count: 12, minMs: 100, maxMs: 400, rng: createRng(42) });
  const c = humanIntervals({ count: 12, minMs: 100, maxMs: 400, rng: createRng(43) });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

// ── 微动作 ──────────────────────────────────────────────────────────────────

check('microMotionAt：同 (seed,t) 可复现、幅度严格有界', () => {
  const options = { seed: 7, amplitude: 0.012, rotationDeg: 0.4, frequency: 0.12 };
  for (let t = 0; t <= 60_000; t += 137) {
    const a = microMotionAt(t, options);
    const b = microMotionAt(t, options);
    assert.deepEqual(a, b);
    assert.ok(Math.abs(a.x) <= 0.012 + 1e-12, `x ${a.x}`);
    assert.ok(Math.abs(a.y) <= 0.012 + 1e-12, `y ${a.y}`);
    assert.ok(Math.abs(a.z) <= 0.012 + 1e-12, `z ${a.z}`);
    assert.ok(Math.abs(a.yawDeg) <= 0.4 + 1e-12, `yaw ${a.yawDeg}`);
    assert.ok(Math.abs(a.pitchDeg) <= 0.4 + 1e-12, `pitch ${a.pitchDeg}`);
    assert.ok(Math.abs(a.rollDeg) <= 0.4 + 1e-12, `roll ${a.rollDeg}`);
  }
});

check('microMotionAt：连续（16ms 内变化很小）、不同 seed 不同、amplitude=0 归零', () => {
  let maxDelta = 0;
  for (let t = 0; t <= 20_000; t += 97) {
    const a = microMotionAt(t, { seed: 3, amplitude: 0.012 });
    const b = microMotionAt(t + 16, { seed: 3, amplitude: 0.012 });
    maxDelta = Math.max(maxDelta, Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
  }
  // 0.12Hz 正弦在 16ms 内的最大位移远小于幅度的 5%
  assert.ok(maxDelta < 0.012 * 0.05, `not smooth: maxDelta ${maxDelta}`);

  const s1 = microMotionAt(1000, { seed: 1 });
  const s2 = microMotionAt(1000, { seed: 2 });
  assert.notDeepEqual(s1, s2);

  const zero = microMotionAt(1000, { seed: 1, amplitude: 0, rotationDeg: 0 });
  for (const key of ['x', 'y', 'z', 'yawDeg', 'pitchDeg', 'rollDeg']) {
    assert.ok(Math.abs(zero[key]) === 0, `${key} should be zero, got ${zero[key]}`);
  }
});

// ── 缓动 ────────────────────────────────────────────────────────────────────

check('easeProgress：端点/单调/形状正确、非法输入夹紧', () => {
  for (const easing of ['linear', 'easeOut', 'easeInOut']) {
    assert.equal(easeProgress(0, easing), 0);
    assert.equal(easeProgress(1, easing), 1);
    let previous = -1;
    for (let i = 0; i <= 100; i += 1) {
      const value = easeProgress(i / 100, easing);
      assert.ok(value >= previous - 1e-12, `${easing} not monotonic at ${i}`);
      previous = value;
    }
    assert.equal(easeProgress(-5, easing), 0);
    assert.equal(easeProgress(9, easing), 1);
  }
  assert.ok(easeProgress(0.5, 'easeOut') > easeProgress(0.5, 'linear'), 'easeOut should lead early');
  assert.ok(Math.abs(easeProgress(0.5, 'easeInOut') - 0.5) < 1e-12);
  assert.equal(normalizeEasing('bogus'), 'linear');
  assert.equal(easeProgress(0.5, 'bogus'), 0.5);
});

// ── 工具函数 ────────────────────────────────────────────────────────────────

check('clampInt / clampNumber 处理非法值与边界', () => {
  assert.equal(clampInt(4.6, 0, 10), 5);
  assert.equal(clampInt(-3, 0, 10), 0);
  assert.equal(clampInt(99, 0, 10), 10);
  assert.equal(clampInt('nope', 0, 10, 3), 3);
  assert.equal(clampNumber(2.5, 0, 2), 2);
  assert.equal(clampNumber(undefined, 0, 2, 1), 1);
});

check('createHumanizer：同 seed 全链路可复现', () => {
  const a = createHumanizer({ seed: 9 });
  const b = createHumanizer({ seed: 9 });
  assert.deepEqual(
    [a.reactionDelay(), a.jitterMs(500), a.intervals({ count: 4, minMs: 100, maxMs: 200 }), a.microMotionAt(321)],
    [b.reactionDelay(), b.jitterMs(500), b.intervals({ count: 4, minMs: 100, maxMs: 200 }), b.microMotionAt(321)],
  );
  const c = createHumanizer({ seed: 10 });
  assert.notDeepEqual(a.intervals({ count: 6, minMs: 100, maxMs: 200 }), c.intervals({ count: 6, minMs: 100, maxMs: 200 }));
});

console.log(`\n${passed} humanize checks passed`);
