/**
 * 拟人层（humanize）：让"AI 操作角色"的时序与微动作不像机械臂。
 *
 * 这里全部是**纯函数 + 可 seed 的随机源**，不依赖 socket / 定时器 / DSH，
 * 所以可以单独用 `node tools/test_humanize.mjs` 做统计与边界测试：
 *   - 反应延迟：对数正态分布（中位数可配，长尾：偶尔会慢半拍）
 *   - 动作时长抖动：按比例抖动并夹紧
 *   - 间隔序列：区间内随机，且避免相邻值完全相等（杜绝"节拍器"感）
 *   - idle 微动作：由 seed + 时间决定的平滑、有界漂移（呼吸/重心转移）
 *   - 缓动：linear / easeOut / easeInOut（位姿插值用）
 *
 * 设计约束：
 *   - 同一个 (seed, t, 参数) 必须得到同一个输出（可复现、可单测）
 *   - 微动作幅度有严格上界（不会把人手甩出去）
 */

const TWO_PI = Math.PI * 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 把任意值夹成 [min, max] 内的整数；非法值用 fallback。 */
export function clampInt(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.round(clamp(fallback, min, max));
  return Math.round(clamp(number, min, max));
}

/** 把任意值夹成 [min, max] 内的浮点数；非法值用 fallback。 */
export function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return clamp(fallback, min, max);
  return clamp(number, min, max);
}

/**
 * mulberry32：32 位种子 PRNG，快、可复现、无依赖。
 * @param {number} seed
 */
export function createRng(seed = 1) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  let spare = null;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    seed,
    next,
    /** 均匀分布 [min, max) */
    float(min = 0, max = 1) {
      if (max < min) [min, max] = [max, min];
      return min + (max - min) * next();
    },
    /** 整数均匀分布 [min, max]，闭区间 */
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      if (hi <= lo) return lo;
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance(probability) {
      return next() < clamp(Number(probability) || 0, 0, 1);
    },
    pick(list) {
      if (!Array.isArray(list) || list.length === 0) return undefined;
      return list[Math.floor(next() * list.length)];
    },
    /** 标准正态（Box-Muller，缓存第二次采样） */
    gaussian() {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const magnitude = Math.sqrt(-2 * Math.log(u));
      spare = magnitude * Math.sin(TWO_PI * v);
      return magnitude * Math.cos(TWO_PI * v);
    },
  };
}

/** 对数正态采样（median 是中位数，sigma 越大长尾越明显）。 */
export function lognormalSample(rng, { median = 1, sigma = 0.35 } = {}) {
  const safeMedian = Math.max(1e-9, Number(median) || 1e-9);
  const safeSigma = clamp(Number(sigma) || 0, 0, 3);
  return safeMedian * Math.exp(safeSigma * rng.gaussian());
}

/**
 * 拟人反应延迟（毫秒）：对数正态，中位数 + 上下限夹紧。
 * 语用：看到玩家挥手后 300–1200ms 才回应的那种"人味"；偶尔会慢（长尾）。
 */
export function reactionDelay({
  medianMs = 400,
  sigma = 0.35,
  minMs = 120,
  maxMs = 1600,
  rng,
  seed,
} = {}) {
  const random = rng ?? createRng(seed ?? 1);
  const sampled = lognormalSample(random, { median: medianMs, sigma });
  return clampInt(sampled, Math.min(minMs, maxMs), Math.max(minMs, maxMs), medianMs);
}

/**
 * 动作时长抖动：baseMs * (1 ± relative)，再夹紧。
 * 语用：同一个"抬手"动作不要每次都精确 600.0ms。
 */
export function jitterMs(baseMs, {
  relative = 0.12,
  minMs = 0,
  maxMs = 60_000,
  rng,
  seed,
} = {}) {
  const random = rng ?? createRng(seed ?? 1);
  const base = Number(baseMs) || 0;
  const ratio = clamp(Number(relative) || 0, 0, 1);
  const low = Math.min(minMs, maxMs);
  const high = Math.max(minMs, maxMs);
  const jittered = base * (1 + random.float(-ratio, ratio));
  return clampInt(jittered, low, high, base);
}

/**
 * 生成一串人类式间隔（毫秒）：区间内随机、相邻不相等。
 * @returns {number[]} 长度 = count
 */
export function humanIntervals({
  count = 1,
  minMs = 180,
  maxMs = 320,
  avoidRepeat = true,
  rng,
  seed,
} = {}) {
  const total = clampInt(count, 0, 10_000, 0);
  const low = Math.min(minMs, maxMs);
  const high = Math.max(minMs, maxMs);
  const random = rng ?? createRng(seed ?? 1);
  const out = [];
  for (let i = 0; i < total; i += 1) {
    let value = random.int(low, high);
    if (avoidRepeat && out.length > 0 && value === out[out.length - 1]) {
      // 最多重采 8 次；区间太窄时允许 ±1 微调，仍保证在 [low, high] 内
      for (let attempt = 0; attempt < 8 && value === out[out.length - 1]; attempt += 1) {
        value = random.int(low, high);
      }
      if (value === out[out.length - 1]) {
        value = value + 1 <= high ? value + 1 : Math.max(low, value - 1);
      }
    }
    out.push(value);
  }
  return out;
}

export const EASINGS = Object.freeze(['linear', 'easeOut', 'easeInOut']);

/** 校验缓动名；未知值回落 linear。 */
export function normalizeEasing(easing) {
  return EASINGS.includes(easing) ? easing : 'linear';
}

/**
 * 缓动进度：输入 [0,1]，输出 [0,1] 且单调。
 *  - linear：匀速
 *  - easeOut：起步快、收尾慢（"伸手接东西"的手感）
 *  - easeInOut：两头慢中间快
 */
export function easeProgress(t, easing = 'linear') {
  const x = clamp(Number(t) || 0, 0, 1);
  switch (normalizeEasing(easing)) {
    case 'easeOut': {
      const inv = 1 - x;
      return 1 - inv * inv * inv;
    }
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
    default:
      return x;
  }
}

/**
 * idle 微动作：由 (seed, tMs) 决定的平滑、有界漂移。
 *
 * 用两个不可通约频率的正弦叠加（类似低配 Perlin），所以：
 *   - 连续：dt 很小时位移变化也小
 *   - 有界：每个分量 ∈ [-amplitude, amplitude]
 *   - 可复现：同 seed 同时刻必得同一结果
 *
 * @returns {{x:number,y:number,z:number,yawDeg:number,pitchDeg:number,rollDeg:number}}
 */
export function microMotionAt(tMs, {
  seed = 1,
  amplitude = 0.012,
  rotationDeg = 0.4,
  frequency = 0.12,
} = {}) {
  const t = (Number(tMs) || 0) / 1000;
  const amp = clamp(Number(amplitude) || 0, 0, 0.2);
  const rotAmp = clamp(Number(rotationDeg) || 0, 0, 5);
  const baseFreq = clamp(Number(frequency) || 0.12, 0.01, 1);

  // 相位由 seed 决定（每次调用重建一个短生命周期 RNG，开销可忽略）
  const rng = createRng((Number(seed) >>> 0) * 2654435761 + 1);
  const component = (index) => {
    const f1 = baseFreq * rng.float(0.7, 1.1);
    const f2 = baseFreq * rng.float(1.9, 2.9);
    const p1 = rng.float(0, TWO_PI);
    const p2 = rng.float(0, TWO_PI);
    // 权重和 = 1，保证 |分量| <= 1
    const wave = 0.65 * Math.sin(TWO_PI * f1 * t + p1) + 0.35 * Math.sin(TWO_PI * f2 * t + p2);
    return wave * (index < 3 ? amp : rotAmp);
  };

  return {
    x: component(0),
    y: component(1),
    z: component(2),
    yawDeg: component(3),
    pitchDeg: component(4),
    rollDeg: component(5),
  };
}

/**
 * 便捷封装：一个带 seed 的拟人层实例。
 * PoseController / SnapTurner 用它，单测也可以直接构造。
 */
export function createHumanizer({
  seed = 1,
  reaction = {},
  jitter = {},
  drift = {},
} = {}) {
  const rng = createRng(seed);
  return {
    seed,
    rng,
    /** 反应延迟（毫秒） */
    reactionDelay(options = {}) {
      return reactionDelay({ ...reaction, ...options, rng });
    },
    /** 动作时长抖动（毫秒） */
    jitterMs(baseMs, options = {}) {
      return jitterMs(baseMs, { ...jitter, ...options, rng });
    },
    /** count 个区间抖动（毫秒） */
    intervals(options = {}) {
      return humanIntervals({ ...options, rng });
    },
    /** idle 微动作（位置偏移 + 角度偏移） */
    microMotionAt(tMs, options = {}) {
      return microMotionAt(tMs, { seed, ...drift, ...options });
    },
  };
}
