/**
 * A 线（自研 HMD 驱动 dsh_hmd）头部位姿通道。
 *
 * 与手部 VMT 通道（lib/vmt.js）平行：手走 VMT 39570，头走 A 线驱动 39572。
 * A 线驱动直接提供 HMD 位姿，不再需要 `TrackingOverrides → /user/head`（那条路已实测会崩 SteamVR）。
 *
 * 协议（Lead 实测确认）：
 *   发 → 127.0.0.1:39572   /dsh/head/pose (float)x,(float)y,(float)z,
 *                          (float)qx,qy,qz,qw
 *   坐标系：**OpenVR 右手系**（+X 右、+Y 上、-Z 前、米制）；90Hz 流。
 *   驱动**没有回包**，所以"驱动是否在线"只能靠启发式（见 HeadClient.probeDriver）。
 *
 * 坐标换算（关键，别和 Unity 左手系的 `vrchat_pose` 搞混）：
 *   本工具对 agent 暴露的坐标系与 `vrchat_pose` 一致 —— Unity 左手系
 *   （+X 右、+Y 上、+Z 前、米，y≈1.6 为眼高）。内部发驱动前再换算成 OpenVR：
 *
 *     position_openvr = ( x,  y, -z )
 *     quat_openvr     = normalize( qx, qy, -qz, -qw )   （w 取正，等价旋转不变）
 *
 *   这是"Z 轴翻转"的基变换；它自逆（OpenVR→Unity 用同一公式），也对应 VMT 驱动
 *   源码里 Unity→OpenVR 的 (x, y, -z, qx, qy, -qz, -qw) 约定。
 *
 * 旋转入参的语义（比 `vrchat_pose` 更直观，头必须能"抬头/低头"）：
 *   - yaw  ：+ = 向右转
 *   - pitch：+ = 抬头看（向上）
 *   - roll ：+ = 向右歪头
 *   也接受四元数 {qx,qy,qz,qw}（Unity 左手系世界旋转），内部换算成上面的欧拉语义。
 *
 * 失败模式：驱动不在线时**不报错**，只返回 `driver.alive=false` + `warning`，包照发
 * （UDP 发出去没人收也无害），OSC-only 能力与其他工具完全不受影响。
 *
 * 本文件不依赖 DSH；`node tools/test_head.mjs` 用本地 UDP mock 直接测。
 */
import dgram from 'node:dgram';
import { encodeMessage } from './osc.js';
import {
  clampInt,
  clampNumber,
  createHumanizer,
  easeProgress,
  normalizeEasing,
} from './humanize.js';
import { quatFromEuler, normalizeQuat, quatMultiply, slerpQuat, lerpVec3 } from './vmt.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

export const HEAD_DEFAULT = Object.freeze({
  host: '127.0.0.1',
  port: 39_572,          // A 线驱动（dsh_hmd）的 OSC 输入端口
  hz: 90,                // 发送频率（30–90）
  holdHz: 30,            // hold 阶段（呼吸/微动作）的维持频率
  probeCacheMs: 5_000,   // 端口占用探测结果缓存
  assumed: null,         // true/false 可强制认为驱动在/不在；null = 自动探测
  driftAmplitude: 0.004, // hold 时位置微动 ±4mm（呼吸）
  driftRotationDeg: 0.3, // hold 时旋转微动 ±0.3°
});

export const HEAD_ADDRESS = '/dsh/head/pose';

/** 没有更早位姿时的默认头部位姿（站立眼高，Unity 左手系）。 */
export const DEFAULT_HEAD_POSE = Object.freeze({
  position: Object.freeze([0, 1.6, 0]),
  rotation: Object.freeze([0, 0, 0, 1]),                       // Unity 左手系四元数
  orientation: Object.freeze({ yaw: 0, pitch: 0, roll: 0 }),   // 直观欧拉角（度）
});

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const errorMessage = (error) => String(error?.message ?? error);

function normalizeDegrees(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  let angle = number % 360;
  if (angle <= -180) angle += 360;
  if (angle > 180) angle -= 360;
  return angle;
}

// ── 坐标换算 / 姿态数学 ─────────────────────────────────────────────────────

/**
 * Unity 左手系位姿 → A 线驱动的 OpenVR 右手系位姿。
 * @param {{position:number[], rotation:number[]}} pose
 * @returns {{position:number[], rotation:number[]}}
 */
export function unityToOpenVR(pose) {
  const position = pose?.position ?? DEFAULT_HEAD_POSE.position;
  const q = normalizeQuat(pose?.rotation ?? DEFAULT_HEAD_POSE.rotation);
  let openvrQuat = normalizeQuat([q[0], q[1], -q[2], -q[3]]);
  // q 与 -q 表示同一旋转；统一成 w>=0，日志/测试里更好比对，也避免某些驱动实现按分量插值时的跳变
  if (openvrQuat[3] < 0) openvrQuat = [-openvrQuat[0], -openvrQuat[1], -openvrQuat[2], -openvrQuat[3]];
  return {
    position: [Number(position[0]), Number(position[1]), -Number(position[2])],
    rotation: openvrQuat,
  };
}

/** OpenVR 右手系位姿 → Unity 左手系位姿（与上面是同一个自逆变换）。 */
export function openvrToUnity(pose) {
  return unityToOpenVR(pose);
}

/**
 * 直观欧拉角（yaw+右 / pitch+抬头 / roll+右歪）→ Unity 左手系四元数。
 * Unity 的 Quaternion.Euler 里 pitch+ 是低头、roll+ 是左歪，所以这里取反。
 */
export function orientationToQuat(orientation = {}) {
  const yaw = Number(orientation.yaw) || 0;
  const pitch = Number(orientation.pitch) || 0;
  const roll = Number(orientation.roll) || 0;
  return quatFromEuler({ yaw, pitch: -pitch, roll: -roll });
}

/**
 * Unity 左手系四元数 → 直观欧拉角（yaw+右 / pitch+抬头 / roll+右歪）。
 * 由 R = Ry(yaw) * Rx(pitchU) * Rz(rollU) 反解（Quaternion.Euler 的 ZXY 顺序）。
 */
export function orientationFromQuat(rotation) {
  const [x, y, z, w] = normalizeQuat(rotation);
  const r23 = 2 * (y * z - w * x);
  const pitchUnity = Math.asin(clamp(-r23, -1, 1));
  const r13 = 2 * (x * z + w * y);
  const r33 = 1 - 2 * (x * x + y * y);
  const yaw = Math.atan2(r13, r33);
  const r21 = 2 * (x * y + w * z);
  const r22 = 1 - 2 * (x * x + z * z);
  const rollUnity = Math.atan2(r21, r22);
  return {
    yaw: yaw * DEG,
    pitch: -pitchUnity * DEG,
    roll: -rollUnity * DEG,
  };
}

/** 归一化直观欧拉角：缺省轴沿用 current，pitch 夹到 ±89°，yaw/roll 规范到 (-180,180]。 */
export function normalizeOrientation(orientation = {}, current = DEFAULT_HEAD_POSE.orientation) {
  if (orientation === null || typeof orientation !== 'object' || Array.isArray(orientation)) {
    throw new Error('vrchat_head: `rotation` must be an object {yaw,pitch,roll} or {qx,qy,qz,qw}');
  }
  const pick = (key) => (orientation[key] === undefined
    ? Number(current?.[key]) || 0
    : Number(orientation[key]));
  const yaw = pick('yaw');
  const pitch = pick('pitch');
  const roll = pick('roll');
  if (![yaw, pitch, roll].every(Number.isFinite)) {
    throw new Error('vrchat_head: `rotation.yaw/pitch/roll` must be finite numbers (degrees)');
  }
  return {
    yaw: normalizeDegrees(yaw, 0),
    pitch: clamp(pitch, -89, 89),
    roll: normalizeDegrees(roll, 0),
  };
}

function isQuaternionInput(rotation) {
  if (Array.isArray(rotation)) return rotation.length === 4;
  if (rotation !== null && typeof rotation === 'object') {
    if (['qx', 'qy', 'qz', 'qw'].every((key) => rotation[key] !== undefined)) return true;
    if (['x', 'y', 'z', 'w'].every((key) => rotation[key] !== undefined)) return true;
  }
  return false;
}

function quatFromQuaternionInput(rotation) {
  if (Array.isArray(rotation)) {
    if (rotation.length !== 4) throw new Error('vrchat_head: quaternion array must have 4 numbers');
    const q = rotation.map(Number);
    if (!q.every(Number.isFinite)) throw new Error('vrchat_head: quaternion array must be finite');
    return normalizeQuat(q);
  }
  if (['qx', 'qy', 'qz', 'qw'].every((key) => rotation[key] !== undefined)) {
    return normalizeQuat([rotation.qx, rotation.qy, rotation.qz, rotation.qw]);
  }
  const q = [rotation.x, rotation.y, rotation.z, rotation.w].map(Number);
  if (!q.every(Number.isFinite)) throw new Error('vrchat_head: quaternion must be finite');
  return normalizeQuat(q);
}

/** 位置入参：{x,y,z}（缺省轴沿用 current）或 [x,y,z]（完整数组）。 */
export function headPositionFrom(target, current, label = 'target') {
  if (target === undefined) return [...current];
  if (Array.isArray(target)) {
    if (target.length < 3) throw new Error(`vrchat_head: \`${label}\` array must have 3 numbers`);
    const values = target.slice(0, 3).map(Number);
    if (!values.every(Number.isFinite)) throw new Error(`vrchat_head: \`${label}\` must contain finite numbers`);
    return values;
  }
  if (target === null || typeof target !== 'object') {
    throw new Error(`vrchat_head: \`${label}\` must be an object {x,y,z}`);
  }
  const keys = ['x', 'y', 'z'];
  const provided = keys.filter((key) => target[key] !== undefined);
  if (provided.length === 0) throw new Error(`vrchat_head: \`${label}\` must provide at least one of x/y/z`);
  const out = [...current];
  for (const key of provided) {
    const value = Number(target[key]);
    if (!Number.isFinite(value)) throw new Error(`vrchat_head: \`${label}.${key}\` must be a finite number`);
    out[keys.indexOf(key)] = value;
  }
  return out;
}

const clonePose = (pose) => ({
  position: [...pose.position],
  rotation: [...pose.rotation],
  orientation: { ...pose.orientation },
});

/**
 * 把工具参数解析成"头部的目标位姿"（Unity 左手系）。
 * 位置：`target`（缺省轴沿用当前）或内部 `position`（完整数组）。
 * 旋转：`rotation`（欧拉直观语义或四元数）或内部 `orientation`（绝对直观欧拉）。
 */
export function resolveHeadTarget(options = {}, currentPose = DEFAULT_HEAD_POSE) {
  const hasPosition = options.position !== undefined || options.target !== undefined;
  const hasRotation = options.orientation !== undefined || options.rotation !== undefined;
  if (!hasPosition && !hasRotation) {
    throw new Error('vrchat_head: pass `target` and/or `rotation` (or use cancel:true to stop)');
  }
  const position = options.position !== undefined
    ? headPositionFrom(options.position, currentPose.position, 'position')
    : headPositionFrom(options.target, currentPose.position, 'target');

  let orientation;
  let rotation;
  if (options.orientation !== undefined && options.orientation !== null) {
    orientation = normalizeOrientation(options.orientation, currentPose.orientation);
    rotation = orientationToQuat(orientation);
  } else if (options.rotation !== undefined && options.rotation !== null) {
    if (Array.isArray(options.rotation) && options.rotation.length === 3) {
      orientation = normalizeOrientation({
        yaw: options.rotation[0],
        pitch: options.rotation[1],
        roll: options.rotation[2],
      }, currentPose.orientation);
      rotation = orientationToQuat(orientation);
    } else if (Array.isArray(options.rotation) && options.rotation.length !== 4) {
      throw new Error('vrchat_head: `rotation` array must have 3 (yaw,pitch,roll) or 4 (qx,qy,qz,qw) numbers');
    } else if (isQuaternionInput(options.rotation)) {
      rotation = quatFromQuaternionInput(options.rotation);
      orientation = orientationFromQuat(rotation);
    } else {
      orientation = normalizeOrientation(options.rotation, currentPose.orientation);
      rotation = orientationToQuat(orientation);
    }
  } else {
    orientation = { ...currentPose.orientation };
    rotation = [...currentPose.rotation];
  }

  return {
    position: [...position],
    rotation: [...rotation],
    orientation: { ...orientation },
  };
}

// ── UDP 客户端（发位姿 + 端口占用探活）────────────────────────────────────

/**
 * 探测本机某 UDP 端口是否已被占用（= A 线驱动在听）。
 * 做法：尝试 bind 同一 host:port；EADDRINUSE=被占用，bind 成功=空闲。
 * 不往驱动发任何包，所以不会移动头部；探测后立刻释放端口。
 *
 * @returns {Promise<{alive: boolean|null, reason: string, error?: string}>}
 */
export function probePortOccupied(host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    socket.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        finish({ alive: true, reason: 'port-in-use' });
      } else {
        finish({ alive: null, reason: 'probe-error', error: errorMessage(error) });
      }
    });
    try {
      socket.bind(port, host, () => {
        // 端口空闲 → 驱动不在。等 close 回调再 resolve，避免下次探测撞上自己
        try {
          socket.close(() => finish({ alive: false, reason: 'port-free' }));
        } catch {
          finish({ alive: false, reason: 'port-free' });
        }
      });
    } catch (error) {
      finish({ alive: null, reason: 'probe-error', error: errorMessage(error) });
    }
  });
}

export class HeadClient {
  constructor(options = {}) {
    this.host = typeof options.host === 'string' && options.host.length > 0 ? options.host : HEAD_DEFAULT.host;
    this.port = clampInt(options.port ?? HEAD_DEFAULT.port, 1, 65_535, HEAD_DEFAULT.port);
    this.probeCacheMs = clampInt(options.probeCacheMs ?? HEAD_DEFAULT.probeCacheMs, 0, 60_000, HEAD_DEFAULT.probeCacheMs);
    this.assumed = options.assumed === true ? true : options.assumed === false ? false : null;
    this.logger = options.logger ?? null;

    this.sender = null;
    this.packetsSent = 0;
    this.sendErrors = 0;
    this.lastSendAt = 0;
    this.lastSent = null;       // { position, rotation } 实际发出去的 OpenVR 值
    this.lastProbeAt = 0;
    this.lastProbeResult = null;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new Error('dsh_hmd: client is closed');
    if (this.sender !== null) return;
    this.sender = dgram.createSocket('udp4');
    this.sender.unref?.();
    this.sender.on('error', (error) => {
      this.sendErrors += 1;
      this._log('warn', `dsh_hmd: send socket error — ${errorMessage(error)}`);
    });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    const sender = this.sender;
    this.sender = null;
    if (sender !== null) {
      try { sender.close(); } catch { /* ignore */ }
    }
  }

  _log(level, message) {
    const logger = this.logger;
    if (logger === null || logger === undefined) return;
    const fn = logger[level] ?? logger.info;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  /** 发一帧 `/dsh/head/pose`（入参 Unity 左手系，内部换算成 OpenVR 右手系）。 */
  sendPose(pose) {
    if (this.sender === null) throw new Error('dsh_hmd: client is not started');
    const openvr = unityToOpenVR(pose);
    const values = [...openvr.position, ...openvr.rotation];
    const packet = encodeMessage(HEAD_ADDRESS, values.map((value) => ({ type: 'f', value })));
    this.packetsSent += 1;
    this.lastSendAt = Date.now();
    this.lastSent = openvr;
    this.sender.send(packet, this.port, this.host, (error) => {
      if (error !== null && error !== undefined) {
        this.sendErrors += 1;
        this._log('warn', `dsh_hmd: send failed — ${errorMessage(error)}`);
      }
    });
    return packet.length;
  }

  /**
   * 判断 A 线驱动是否在线。
   * A 驱动没有回包，所以用"端口是否被占用"启发式：
   *   {alive:true,  reason:'port-in-use'}     驱动在听
   *   {alive:false, reason:'port-free'}       端口空着 → 驱动没起
   *   {alive:null,  reason:'probe-error'}     探测本身失败（权限/其他错误），只能 best-effort
   * 也可用配置 `headDriverAssumed: true|false` 跳过探测（确定驱动在/不在时用）。
   */
  async probeDriver({ force = false } = {}) {
    if (this.assumed !== null) {
      return {
        alive: this.assumed,
        reason: this.assumed ? 'assumed-on' : 'assumed-off',
        port: this.port,
      };
    }
    const now = Date.now();
    if (!force && this.lastProbeAt !== 0 && now - this.lastProbeAt <= this.probeCacheMs) {
      return this.lastProbeResult;
    }
    const result = { port: this.port, ...(await probePortOccupied(this.host, this.port)) };
    this.lastProbeAt = now;
    this.lastProbeResult = result;
    return result;
  }

  state() {
    const now = Date.now();
    return {
      host: this.host,
      port: this.port,
      assumed: this.assumed,
      driverAlive: this.lastProbeResult === null ? null : this.lastProbeResult.alive,
      driverReason: this.lastProbeResult === null ? null : this.lastProbeResult.reason,
      lastProbeMsAgo: this.lastProbeAt === 0 ? null : now - this.lastProbeAt,
      lastSendMsAgo: this.lastSendAt === 0 ? null : now - this.lastSendAt,
      packetsSent: this.packetsSent,
      sendErrors: this.sendErrors,
    };
  }
}

// ── 头部位姿控制器（90Hz 定时器发送循环）────────────────────────────────────

export class HeadController {
  constructor(options = {}) {
    this.client = options.client ?? new HeadClient({
      host: options.host,
      port: options.port,
      probeCacheMs: options.probeCacheMs,
      assumed: options.assumed,
      logger: options.logger,
    });
    this.hz = clampInt(options.hz ?? HEAD_DEFAULT.hz, 30, 90, HEAD_DEFAULT.hz);
    this.holdHz = clampInt(options.holdHz ?? HEAD_DEFAULT.holdHz, 5, 90, HEAD_DEFAULT.holdHz);
    this.humanize = options.humanize !== false;
    this.idleDrift = options.idleDrift !== false;
    this.driftAmplitude = clampNumber(
      options.driftAmplitude ?? HEAD_DEFAULT.driftAmplitude, 0, 0.05, HEAD_DEFAULT.driftAmplitude,
    );
    this.driftRotationDeg = clampNumber(
      options.driftRotationDeg ?? HEAD_DEFAULT.driftRotationDeg, 0, 3, HEAD_DEFAULT.driftRotationDeg,
    );
    this.seed = clampInt(options.seed ?? 1, 0, 2 ** 31 - 1, 1);
    this.logger = options.logger ?? null;
    this.humanizer = createHumanizer({
      seed: this.seed,
      drift: {
        amplitude: this.driftAmplitude,
        rotationDeg: this.driftRotationDeg,
        frequency: 0.1, // 呼吸/重心转移：10 秒左右一个周期
      },
    });

    this.pose = clonePose(DEFAULT_HEAD_POSE);
    this.lastSent = null;       // 最近一帧实际发出去的位姿（Unity 左手系 + openvr 快照）
    this.motion = null;
    this.holdState = null;
    this.framesSent = 0;
    this.sequences = 0;
    this.lastResult = null;
    this.started = false;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new Error('dsh_hmd: head controller is closed');
    if (this.started) return;
    this.client.start();
    this.started = true;
  }

  _log(level, message) {
    const logger = this.logger;
    if (logger === null || logger === undefined) return;
    const fn = logger[level] ?? logger.info;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  _warning(driver) {
    if (driver.alive === true) return null;
    if (driver.alive === null) {
      return 'A-line head driver state unknown (port probe failed). Head pose packets are sent best-effort.';
    }
    return `A-line head driver not detected on ${this.client.host}:${this.client.port} (port is free). `
      + 'Head pose packets are sent best-effort (degraded): start SteamVR with dsh_hmd and VRChat in VR mode.';
  }

  _driverSnapshot(driver) {
    return {
      alive: driver.alive,
      reason: driver.reason,
      port: this.client.port,
      lastProbeMsAgo: this.client.lastProbeAt === 0 ? null : Date.now() - this.client.lastProbeAt,
      sendErrors: this.client.sendErrors,
    };
  }

  _buildResult(motion, extra = {}) {
    const now = Date.now();
    const settledAt = motion.settledAt ?? now;
    const fromOpenVR = unityToOpenVR(motion.from);
    const toOpenVR = unityToOpenVR(motion.to);
    return {
      ok: extra.cancelled !== true,
      space: 'unity-lh', // 位置/旋转字段用 Unity 左手系；openvr 字段是实际发给驱动的值
      from: {
        position: [...motion.from.position],
        rotation: [...motion.from.rotation],
        orientation: { ...motion.from.orientation },
      },
      to: {
        position: [...motion.to.position],
        rotation: [...motion.to.rotation],
        orientation: { ...motion.to.orientation },
      },
      openvr: { from: fromOpenVR, to: toOpenVR },
      durationMs: motion.requestedDurationMs,
      effectiveDurationMs: motion.durationMs,
      easing: motion.easing,
      hz: motion.hz,
      frames: motion.frames,
      sequence: motion.id,
      hold: motion.hold,
      holdMs: motion.holdMs,
      humanize: motion.humanize,
      driver: motion.driver,
      warning: motion.warning,
      started: motion.startedAt !== 0,
      finished: extra.finished === true,
      interrupted: extra.interrupted === true,
      cancelled: extra.cancelled === true,
      holdActive: extra.holdActive === true,
      elapsedMs: motion.startedAt === 0 ? 0 : Math.max(0, settledAt - motion.startedAt),
      totalFramesSent: this.framesSent,
    };
  }

  _cleanupMotion(motion) {
    if (motion.timer !== null) {
      clearTimeout(motion.timer);
      motion.timer = null;
    }
    if (motion.startTimer !== null) {
      clearTimeout(motion.startTimer);
      motion.startTimer = null;
    }
    if (motion.signal !== undefined && motion.onAbort !== undefined) {
      try { motion.signal.removeEventListener?.('abort', motion.onAbort); } catch { /* ignore */ }
    }
    motion.stopped = true;
  }

  _sendCurrentFrame(motion) {
    this.client.sendPose(this.pose);
    this.framesSent += 1;
    motion.frames += 1;
    this.lastSent = {
      at: Date.now(),
      position: [...this.pose.position],
      rotation: [...this.pose.rotation],
      orientation: { ...this.pose.orientation },
      openvr: this.client.lastSent,
    };
  }

  _settleMotion(motion) {
    if (this.motion !== motion) return;
    this.motion = null;
    motion.settledAt = Date.now();
    this._cleanupMotion(motion);
    // 精确落到目标（插值末帧可能有 float 误差）
    this.pose = clonePose(motion.to);
    const holdActive = motion.hold === true;
    const result = this._buildResult(motion, { finished: true, holdActive });
    if (motion.resolve !== null) {
      const resolve = motion.resolve;
      motion.resolve = null;
      resolve(result);
    }
    this.lastResult = result;
    if (holdActive) this._startHold(motion);
  }

  _interruptMotion(motion, extra = {}) {
    this._cleanupMotion(motion);
    if (this.motion === motion) this.motion = null;
    motion.settledAt = Date.now();
    const result = this._buildResult(motion, {
      interrupted: extra.interrupted === true,
      cancelled: extra.cancelled === true,
    });
    if (motion.resolve !== null) {
      const resolve = motion.resolve;
      motion.resolve = null;
      resolve(result);
    }
    this.lastResult = result;
    return result;
  }

  _interruptActive() {
    if (this.motion !== null) {
      this._interruptMotion(this.motion, { interrupted: true });
      return true;
    }
    return false;
  }

  _runMotion(motion) {
    const startedAt = Date.now();
    motion.startedAt = startedAt;
    const interval = 1000 / motion.hz;
    const step = (tick) => {
      if (this.motion !== motion || motion.stopped === true) return;
      const elapsed = Date.now() - startedAt;
      const raw = motion.durationMs <= 0 ? 1 : Math.min(1, elapsed / motion.durationMs);
      const eased = easeProgress(raw, motion.easing);
      const rotation = slerpQuat(motion.from.rotation, motion.to.rotation, eased);
      this.pose = {
        position: lerpVec3(motion.from.position, motion.to.position, eased),
        rotation,
        // 逐帧反解朝向，保证中途被抢占/取消时"当前朝向"也是准的（look 依赖它）
        orientation: orientationFromQuat(rotation),
      };
      try {
        this._sendCurrentFrame(motion);
      } catch (error) {
        this._log('warn', `dsh_hmd: sendPose failed — ${errorMessage(error)}`);
      }
      if (raw >= 1) {
        this._settleMotion(motion);
        return;
      }
      const dueAt = startedAt + (tick + 1) * interval;
      motion.timer = setTimeout(() => step(tick + 1), Math.max(0, dueAt - Date.now()));
    };
    step(0);
  }

  _startHold(motion) {
    this._stopHold();
    const base = clonePose(motion.to);
    const holdState = {
      motion,
      base,
      holdMs: motion.holdMs,
      startedAt: Date.now(),
      timer: null,
      timeout: null,
    };
    this.holdState = holdState;
    const interval = 1000 / this.holdHz;
    const tick = () => {
      if (this.holdState !== holdState) return;
      const elapsed = Date.now() - holdState.startedAt;
      const drift = (this.humanize && this.idleDrift)
        ? this.humanizer.microMotionAt(elapsed)
        : { x: 0, y: 0, z: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
      const pose = {
        position: [
          base.position[0] + drift.x,
          base.position[1] + drift.y,
          base.position[2] + drift.z,
        ],
        rotation: quatMultiply(
          base.rotation,
          quatFromEuler({ yaw: drift.yawDeg, pitch: drift.pitchDeg, roll: drift.rollDeg }),
        ),
        orientation: { ...base.orientation },
      };
      this.pose = pose;
      try {
        this.client.sendPose(pose);
        this.framesSent += 1;
        this.lastSent = {
          at: Date.now(),
          position: [...pose.position],
          rotation: [...pose.rotation],
          orientation: { ...pose.orientation },
          openvr: this.client.lastSent,
        };
      } catch (error) {
        this._log('warn', `dsh_hmd: hold sendPose failed — ${errorMessage(error)}`);
      }
    };
    holdState.timer = setInterval(tick, interval);
    holdState.timer.unref?.();
    if (holdState.holdMs > 0) {
      holdState.timeout = setTimeout(() => this._stopHold(), holdState.holdMs);
      holdState.timeout.unref?.();
    }
  }

  _stopHold() {
    const holdState = this.holdState;
    if (holdState === null) return;
    if (holdState.timer !== null) clearInterval(holdState.timer);
    if (holdState.timeout !== null) clearTimeout(holdState.timeout);
    this.holdState = null;
  }

  /** 探活（带缓存）。 */
  probeDriver(options = {}) {
    return this.client.probeDriver(options);
  }

  /**
   * 手动校准"当前朝向"（不发包）。插件重载/驱动侧位姿未知时，
   * 用 `vrchat_look({mode:"head", currentYawDeg: ...})` 或 vrchat_head 的绝对 rotation 重新对齐。
   */
  syncOrientation(orientation = {}) {
    const normalized = normalizeOrientation(orientation, this.pose.orientation);
    this.pose.orientation = normalized;
    this.pose.rotation = orientationToQuat(normalized);
    return {
      position: [...this.pose.position],
      rotation: [...this.pose.rotation],
      orientation: { ...this.pose.orientation },
    };
  }

  /**
   * 播放一段头部位姿动作。默认等动作结束；`wait:false` 立即返回、后台继续。
   * 新调用抢占旧动作（旧调用返回 interrupted:true）。
   */
  async animate(options = {}) {
    if (this.closed) throw new Error('vrchat_head: head controller is disposed');
    if (!this.started) this.start();
    const target = resolveHeadTarget(options, this.pose);
    const requestedDurationMs = clampInt(options.durationMs ?? 600, 0, 10_000, 600);
    const easing = normalizeEasing(options.easing);
    const hold = options.hold !== false;
    const wait = options.wait !== false;
    const hz = clampInt(options.hz ?? this.hz, 30, 90, this.hz);
    const humanize = options.humanize === undefined ? this.humanize : options.humanize === true;
    const holdMs = clampInt(options.holdMs ?? 0, 0, 600_000, 0);
    const seed = clampInt(options.seed ?? this.seed, 0, 2 ** 31 - 1, this.seed);
    const humanizer = seed === this.seed
      ? this.humanizer
      : createHumanizer({
        seed,
        drift: { amplitude: this.driftAmplitude, rotationDeg: this.driftRotationDeg, frequency: 0.1 },
      });
    const signal = options.signal;

    if (signal?.aborted === true) {
      return {
        ok: false,
        cancelled: true,
        started: false,
        finished: false,
        interrupted: false,
        frames: 0,
        totalFramesSent: this.framesSent,
      };
    }

    // 探活（A 驱动无回包 → 端口占用启发式；失败只降级不报错）
    const driverProbe = await this.client.probeDriver();
    if (this.closed) throw new Error('vrchat_head: head controller is disposed');

    const from = clonePose(this.pose);
    const to = clonePose(target);
    const effectiveDuration = humanize
      ? humanizer.jitterMs(requestedDurationMs, { relative: 0.08, minMs: 0, maxMs: 10_000 })
      : requestedDurationMs;

    const interruptedPrevious = this._interruptActive();

    const motion = {
      id: ++this.sequences,
      from,
      to,
      requestedDurationMs,
      durationMs: effectiveDuration,
      easing,
      hz,
      hold,
      holdMs,
      humanize,
      driver: this._driverSnapshot(driverProbe),
      warning: this._warning(driverProbe),
      frames: 0,
      startedAt: 0,
      settledAt: 0,
      stopped: false,
      interruptedPrevious,
      timer: null,
      startTimer: null,
      resolve: null,
      signal,
      onAbort: undefined,
    };
    this.motion = motion;
    const promise = new Promise((resolve) => {
      motion.resolve = resolve;
    });

    if (signal !== undefined) {
      motion.onAbort = () => this.cancel({ reason: 'aborted' });
      signal.addEventListener?.('abort', motion.onAbort, { once: true });
    }

    this._runMotion(motion);

    if (wait) return promise;
    return this._buildResult(motion, { finished: false });
  }

  /** 立即停止当前动作（头部不能"交还"给别的追踪源，所以只停流）。 */
  cancel({ reason = 'cancelled' } = {}) {
    const hadMotion = this.motion !== null;
    const sequence = this.motion?.id ?? null;
    if (this.motion !== null) this._interruptMotion(this.motion, { cancelled: true });
    const hadHold = this.holdState !== null;
    this._stopHold();
    this._log('info', `dsh_hmd: head pose cancelled (${reason}) motion=${hadMotion} hold=${hadHold}`);
    return {
      ok: false,
      cancelled: true,
      hadMotion,
      holdActive: hadHold,
      sequence,
      totalFramesSent: this.framesSent,
      state: this.state(),
    };
  }

  state() {
    const activeMotion = this.motion === null
      ? null
      : {
        sequence: this.motion.id,
        durationMs: this.motion.durationMs,
        frames: this.motion.frames,
        startedAt: this.motion.startedAt === 0 ? null : this.motion.startedAt,
        elapsedMs: this.motion.startedAt === 0 ? null : Date.now() - this.motion.startedAt,
      };
    return {
      started: this.started,
      closed: this.closed,
      hz: this.hz,
      holdHz: this.holdHz,
      humanize: this.humanize,
      idleDrift: this.idleDrift,
      pose: {
        position: [...this.pose.position],
        rotation: [...this.pose.rotation],
        orientation: { ...this.pose.orientation },
      },
      lastSent: this.lastSent === null ? null : {
        at: this.lastSent.at,
        position: [...this.lastSent.position],
        rotation: [...this.lastSent.rotation],
        orientation: { ...this.lastSent.orientation },
        openvr: { position: [...this.lastSent.openvr.position], rotation: [...this.lastSent.openvr.rotation] },
      },
      activeMotion,
      holdActive: this.holdState !== null,
      framesSent: this.framesSent,
      sequences: this.sequences,
      lastResult: this.lastResult === null
        ? null
        : {
          sequence: this.lastResult.sequence,
          finished: this.lastResult.finished,
          interrupted: this.lastResult.interrupted,
          cancelled: this.lastResult.cancelled,
          frames: this.lastResult.frames,
        },
      driver: this.client.state(),
    };
  }

  dispose() {
    if (this.closed) return;
    this._stopHold();
    if (this.motion !== null) this._interruptMotion(this.motion, { cancelled: true });
    this.closed = true;
    this.client.stop();
  }
}
