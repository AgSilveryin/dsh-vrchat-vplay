/**
 * 降级版"转头"：VRChat OSC 的 snap turn（离散 45° 转身）。
 *
 * 为什么是降级版：头部位姿需要 VMT 把 tracker 覆盖到 /user/head，本机实测这条路径会让
 * vrserver 崩溃（见 docs/vmt-pose.md），所以头部暂时用 `/input/*` 的 snap turn 近似：
 * 快速转头看起来像"顿一下"，但配合人类式的间隔抖动（180–320ms 随机）不会像节拍器。
 *
 * 实现要点：
 *   - snap turn 是**边沿触发**：发一次 `LookHorizontal=1`（或 ComfortLeft/Right 按钮 1），
 *     必须回 0 才能触发下一次；一直按着会连续转。
 *   - 轴用 float、按钮用 int（协议要求不同，见 lib/bridge.js 的 INPUT_AXES/INPUT_BUTTONS）。
 *   - `mode: 'axis'`（默认）= `/input/LookHorizontal`：桌面平滑转、VR 在开了 Comfort Turning
 *     时按值为 1 触发 snap；`mode: 'comfort'` = `/input/ComfortLeft|Right` 按钮，**仅 VR**。
 *   - 朝向只能"估计"：VRChat 不通过 OSC 暴露头/身体的 yaw，所以这里维护一个累计 yaw
 *     （由自己的 snap 次数推算），可用 `currentYawDeg` 校准。
 *
 * 本文件不依赖 DSH：`SnapTurner` 接受一个 `send(address, args)` 回调，
 * `node tools/test_look.mjs` 会用本地 UDP socket 当 mock VRChat 验证发送序列与字节。
 */
import {
  clampInt,
  clampNumber,
  createHumanizer,
  humanIntervals,
} from './humanize.js';

export const LOOK_DEFAULT = Object.freeze({
  stepDeg: 45,
  holdMs: 90,
  gapMinMs: 180,
  gapMaxMs: 320,
  mode: 'axis',
  maxSnaps: 16,
});

/**
 * 归一化 `mode` 参数（vrchat_look 的高层模式，不是 SnapTurner 的 axis/comfort）。
 *  - `auto`：A 线 HMD 可用就用真转头（vrchat_head），否则退回 snap turn
 *  - `head`：强制真转头；不可用时降级 snap
 *  - `snap`：强制 snap turn
 *  - 兼容旧值：`axis` / `comfort` 视为 snap + 对应子模式
 * @returns {{mode:'auto'|'head'|'snap', snapMode:'axis'|'comfort', legacy:boolean}}
 */
export function normalizeLookMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (mode) {
    case 'auto': return { mode: 'auto', snapMode: 'axis', legacy: false };
    case 'head': return { mode: 'head', snapMode: 'axis', legacy: false };
    case 'snap': return { mode: 'snap', snapMode: 'axis', legacy: false };
    case 'axis': return { mode: 'snap', snapMode: 'axis', legacy: true };
    case 'comfort': return { mode: 'snap', snapMode: 'comfort', legacy: true };
    default: return { mode: 'auto', snapMode: 'axis', legacy: false };
  }
}

/** 归一化 snap turn 的子模式。 */
export function normalizeSnapMode(value) {
  return value === 'comfort' ? 'comfort' : 'axis';
}

/** 两种模式对应的 OSC 地址。 */
export const LOOK_ADDRESSES = Object.freeze({
  axis: '/input/LookHorizontal',
  leftButton: '/input/ComfortLeft',
  rightButton: '/input/ComfortRight',
});

/** 把角度规范到 (-180, 180]。 */
export function normalizeAngle(deg) {
  const value = Number(deg);
  if (!Number.isFinite(value)) return 0;
  let angle = value % 360;
  if (angle <= -180) angle += 360;
  if (angle > 180) angle -= 360;
  return angle;
}

/**
 * 目标方向 → 世界 yaw（度）。Unity 左手系：+Z 前、+X 右，所以 yaw = atan2(x, z)。
 * @param {{x?:number,z?:number}|number[]|number} target
 */
export function yawToTarget(target) {
  if (typeof target === 'number') {
    if (!Number.isFinite(target)) throw new Error('vrchat_look: `target` number must be finite degrees');
    return normalizeAngle(target);
  }
  if (Array.isArray(target)) {
    const x = Number(target[0]);
    const z = Number(target[2] ?? target[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('vrchat_look: `target` array must be [x,y,z] or [x,z]');
    }
    return (Math.atan2(x, z) * 180) / Math.PI;
  }
  if (target !== null && typeof target === 'object') {
    const x = Number(target.x);
    const z = Number(target.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('vrchat_look: `target` must be {x,z} (or {x,y,z}) world coordinates');
    }
    return (Math.atan2(x, z) * 180) / Math.PI;
  }
  throw new Error('vrchat_look: `target` must be a world position {x,z} or an absolute yaw in degrees');
}

/**
 * 纯函数：把"要转多少度"换算成 N 次 snap turn 的发送计划。
 *
 * @param {number} angleDeg 正 = 向右转
 * @returns {{
 *   requestedDeg:number, normalizedDeg:number, stepDeg:number, snaps:number,
 *   direction:number, achievedDeg:number, clamped:boolean,
 *   startYawDeg:number, endYawDeg:number, gapsMs:number[],
 *   steps:{direction:number,action:string,kind:'axis'|'button',holdMs:number,gapMs:number}[]
 * }}
 */
export function planSnapTurn(angleDeg, options = {}) {
  const stepDeg = clampNumber(options.stepDeg ?? LOOK_DEFAULT.stepDeg, 1, 180, LOOK_DEFAULT.stepDeg);
  const maxSnaps = clampInt(options.maxSnaps ?? LOOK_DEFAULT.maxSnaps, 1, 32, LOOK_DEFAULT.maxSnaps);
  const mode = options.mode === 'comfort' ? 'comfort' : 'axis';
  const holdMs = clampInt(options.holdMs ?? LOOK_DEFAULT.holdMs, 20, 500, LOOK_DEFAULT.holdMs);
  const gapMinMs = clampInt(options.gapMinMs ?? LOOK_DEFAULT.gapMinMs, 0, 5000, LOOK_DEFAULT.gapMinMs);
  const gapMaxMs = clampInt(options.gapMaxMs ?? LOOK_DEFAULT.gapMaxMs, 0, 5000, LOOK_DEFAULT.gapMaxMs);
  const seed = clampInt(options.seed ?? 1, 0, 2 ** 31 - 1, 1);
  const startYawDeg = Number.isFinite(options.currentYawDeg) ? options.currentYawDeg : 0;

  const angle = Number(angleDeg);
  if (!Number.isFinite(angle)) throw new Error('vrchat_look: `angleDeg` must be a finite number');

  const rawSnaps = Math.round(angle / stepDeg);
  const clamped = Math.abs(rawSnaps) > maxSnaps;
  const snaps = clamped
    ? Math.sign(rawSnaps) * maxSnaps
    : rawSnaps;
  const direction = Math.sign(snaps);
  const count = Math.abs(snaps);

  const humanizer = createHumanizer({ seed });
  const gapsMs = count > 1
    ? humanIntervals({
      count: count - 1,
      minMs: gapMinMs,
      maxMs: gapMaxMs,
      rng: humanizer.rng,
    })
    : [];

  const steps = [];
  for (let i = 0; i < count; i += 1) {
    // 每次按下的时长也轻微抖动（同一次转向里不要精确到毫秒一致）
    const jitteredHold = clampInt(
      holdMs * humanizer.rng.float(0.85, 1.15),
      20,
      500,
      holdMs,
    );
    steps.push({
      direction,
      action: mode === 'comfort'
        ? (direction > 0 ? 'ComfortRight' : 'ComfortLeft')
        : 'LookHorizontal',
      kind: mode === 'comfort' ? 'button' : 'axis',
      holdMs: jitteredHold,
      gapMs: i < count - 1 ? gapsMs[i] : 0,
    });
  }

  return {
    mode,
    requestedDeg: angle,
    normalizedDeg: normalizeAngle(angle),
    stepDeg,
    snaps,
    direction,
    achievedDeg: snaps * stepDeg,
    clamped,
    startYawDeg,
    endYawDeg: startYawDeg + snaps * stepDeg,
    gapsMs,
    steps,
  };
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(true);
      return;
    }
    let done = false;
    const onAbort = () => finish(true);
    const finish = (aborted) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      resolve(aborted);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * snap turn 执行器。`send` 必须是 `(address, args) => void`（通常包一层 bridge.send）。
 */
export class SnapTurner {
  constructor({ send, logger, mode = LOOK_DEFAULT.mode } = {}) {
    if (typeof send !== 'function') throw new Error('vrchat_look: SnapTurner needs a send(address, args) function');
    this.send = send;
    this.logger = logger ?? null;
    this.mode = mode === 'comfort' ? 'comfort' : 'axis';
    this.yawDeg = 0;
    this.packetsSent = 0;
    this.turns = 0;
  }

  _log(level, message) {
    const logger = this.logger;
    if (logger === null || logger === undefined) return;
    const fn = logger[level] ?? logger.info;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  _press(step) {
    if (step.kind === 'button') {
      this.send(`/input/${step.action}`, [{ type: 'i', value: 1 }]);
    } else {
      this.send(`/input/${step.action}`, [{ type: 'f', value: step.direction }]);
    }
    this.packetsSent += 1;
  }

  _release(step) {
    if (step.kind === 'button') {
      this.send(`/input/${step.action}`, [{ type: 'i', value: 0 }]);
    } else {
      this.send(`/input/${step.action}`, [{ type: 'f', value: 0 }]);
    }
    this.packetsSent += 1;
  }

  /** 只算计划、不发包（便于 agent 先确认会转几次）。 */
  plan(options = {}) {
    const angle = this._resolveAngle(options);
    const plan = planSnapTurn(angle, {
      ...options,
      mode: options.mode ?? this.mode,
      currentYawDeg: this.yawDeg,
    });
    return { ok: true, ...plan };
  }

  _resolveAngle(options = {}) {
    if (options.target !== undefined && options.target !== null) {
      const targetYaw = yawToTarget(options.target);
      const currentYaw = Number.isFinite(options.currentYawDeg) ? options.currentYawDeg : this.yawDeg;
      return normalizeAngle(targetYaw - currentYaw);
    }
    if (options.angleDeg === undefined || options.angleDeg === null) {
      throw new Error('vrchat_look: pass `angleDeg` (relative turn) or `target` (face a world point)');
    }
    const angle = Number(options.angleDeg);
    if (!Number.isFinite(angle)) throw new Error('vrchat_look: `angleDeg` must be a finite number');
    return angle;
  }

  /**
   * 执行一次转头。
   * @returns {Promise<object>} 结果（含实际转了多少度、每次间隔、是否被打断）
   */
  async turn(options = {}) {
    const signal = options.signal;
    const mode = options.mode === 'comfort' ? 'comfort' : (options.mode === 'axis' ? 'axis' : this.mode);
    if (Number.isFinite(options.currentYawDeg)) this.yawDeg = options.currentYawDeg;
    const angle = this._resolveAngle(options);
    const plan = planSnapTurn(angle, {
      ...options,
      mode,
      currentYawDeg: this.yawDeg,
    });
    const startedAt = Date.now();

    if (plan.snaps === 0) {
      this._log('debug', `vrchat_look: |${angle}°| < ${plan.stepDeg / 2}°, nothing to do`);
      return {
        ok: true,
        mode,
        requestedDeg: plan.requestedDeg,
        actualDeg: 0,
        stepDeg: plan.stepDeg,
        snaps: 0,
        direction: 0,
        startYawDeg: this.yawDeg,
        endYawDeg: this.yawDeg,
        holdMs: 0,
        gapsMs: [],
        steps: [],
        packetsSent: 0,
        elapsedMs: Date.now() - startedAt,
        cancelled: false,
        clamped: false,
        warning: `角度不足半格（${plan.stepDeg}°），没有发送 snap turn。`,
      };
    }

    let cancelled = false;
    let executed = 0;
    let pressed = null;
    try {
      for (const step of plan.steps) {
        if (signal?.aborted === true) { cancelled = true; break; }
        this._press(step);
        pressed = step;
        if (await sleepAbortable(step.holdMs, signal)) {
          // 按下沿已经发出去，这次 snap 大概率已触发，算作已完成（finally 里补发 0）
          cancelled = true;
          executed += 1;
          break;
        }
        this._release(step);
        pressed = null;
        executed += 1;
        if (step.gapMs > 0) {
          if (await sleepAbortable(step.gapMs, signal)) { cancelled = true; break; }
        }
      }
    } finally {
      // 被打断/抛错时不能把轴或按钮留在"按下"状态，否则角色会一直转/菜单一直切换
      if (pressed !== null) {
        try { this._release(pressed); } catch (error) {
          this._log('warn', `vrchat_look: failed to release ${pressed.action} — ${String(error?.message ?? error)}`);
        }
      }
    }

    const achieved = executed * plan.stepDeg * plan.direction;
    this.yawDeg = plan.startYawDeg + achieved;
    this.turns += 1;
    const elapsedMs = Date.now() - startedAt;
    this._log('info', `vrchat_look: ${mode} ${executed}/${Math.abs(plan.snaps)} snaps, `
      + `yaw ${plan.startYawDeg}° -> ${this.yawDeg}° (${elapsedMs}ms)`);

    return {
      ok: true,
      mode,
      requestedDeg: plan.requestedDeg,
      actualDeg: achieved,
      stepDeg: plan.stepDeg,
      snaps: plan.direction * executed,
      direction: plan.direction,
      startYawDeg: plan.startYawDeg,
      endYawDeg: this.yawDeg,
      holdMs: plan.steps[0]?.holdMs ?? 0,
      gapsMs: plan.gapsMs.slice(0, Math.max(0, executed - 1)),
      steps: plan.steps.slice(0, executed),
      packetsSent: executed * 2,
      elapsedMs,
      cancelled,
      clamped: plan.clamped,
      warning: plan.clamped
        ? `角度过大，已限制为 ${plan.snaps * plan.stepDeg}°（maxSnaps=${options.maxSnaps ?? LOOK_DEFAULT.maxSnaps}）`
        : null,
    };
  }

  state() {
    return {
      mode: this.mode,
      yawDeg: this.yawDeg,
      turns: this.turns,
      packetsSent: this.packetsSent,
    };
  }
}
