/**
 * VMT（Virtual Motion Tracker）位姿通道：把"左手/右手目标位姿"以 30–90Hz 平滑地
 * 发给本机 VMT 驱动（UDP 39570），驱动再把它变成 SteamVR 里的虚拟控制器。
 *
 * 为什么单独一条通道：VRChat 的 OSC `/input/*` 能按键/转视角，但给不了"手停在哪"。
 * 位姿只能走 SteamVR 侧的虚拟设备（VMT），所以这一层和 `lib/bridge.js`（9000/9001）
 * 完全解耦——驱动没装/挂了，输入通道照常工作。
 *
 * 协议（本机实测 + 驱动工具链结论）：
 *   发 → 127.0.0.1:39570   /VMT/Room/Unity (int)idx,(int)enable,(float)timeOffset,
 *                          (float)x,y,z,(float)qx,qy,qz,qw
 *   收 ← 127.0.0.1:39571   /VMT/Out/Alive（驱动 RunFrame 里周期性发，用于探活）、
 *                          /VMT/Out/Unavailable（参数 0 表示 RoomMatrix 已设置 OK）
 *   idx：1 = 左手槽位，2 = 右手槽位（0 是头部 tracker，本插件**不用**：
 *        TrackingOverrides 顶 /user/head 已实测会把 vrserver 搞崩）
 *   enable：0 = 关闭该设备；5/6 = Index 兼容左/右手柄；2/3 = 普通手柄（可配）
 *   坐标：Unity 左手系，米制，Y 向上，+Z 向前；四元数顺序 (x,y,z,w)。
 *   前提：没有 VMT Manager 时必须先发 `/VMT/SetRoomMatrix/Temporary` 单位矩阵，
 *        否则驱动会把位姿判为 invalid（RejectTracking）。
 *
 * 关键设计（对应任务要求）：
 *   - 发送循环是**定时器驱动**的：30–90Hz，按单调时间戳补齐 drift，不阻塞调用方；
 *   - 新动作会**抢占**旧动作（旧调用返回 interrupted:true），不产生"瞬移"；
 *   - 动作结束后可 `hold`：以较低频率继续喂当前位姿 + idle 微动作（拟人层），
 *     也可 `hold:false` 直接交还给真实手柄；
 *   - 无驱动只**降级警告**：仍然发包（UDP 发出去没人收也无害），返回 warning。
 *
 * 本文件不依赖 DSH，可以被 `node tools/test_pose.mjs` 用本地 UDP mock 驱动直接测试。
 */
import dgram from 'node:dgram';
import { encodeMessage, decodePacket } from './osc.js';
import {
  clampInt,
  clampNumber,
  createHumanizer,
  easeProgress,
  normalizeEasing,
} from './humanize.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

export const VMT_DEFAULT = Object.freeze({
  host: '127.0.0.1',
  sendPort: 39570,
  listenPort: 39571,
  enableMode: 'index',       // index = enable 5/6；controller = enable 2/3
  listenerIdleMs: 30_000,    // 这么久没位姿就释放 39571（让别的工具能占）
  probeTimeoutMs: 1_200,     // 探活最长等多久（Alive 由驱动 RunFrame 发，可能被 SteamVR 限频）
  probeCacheMs: 5_000,       // 最近这么短时间内 Alive 过就不再探
  probeBackoffMs: 5_000,     // 探活失败后的退避，避免每次调用都白等
  hz: 60,                    // 发送频率（30–90）
  holdHz: 20,                // hold 阶段的维持频率
  setRoomMatrix: true,       // 首次发位姿前发单位 RoomMatrix
});

/** /VMT/Room/Unity 的 enable 取值（驱动侧设备类型/角色）。 */
export const VMT_ENABLE = Object.freeze({
  disable: 0,
  tracker: 1,
  leftController: 2,
  rightController: 3,
  leftIndex: 5,
  rightIndex: 6,
  viveTracker: 7,
});

/** VMT 设备槽位：1 = 左手，2 = 右手（0 保留给头部，不用）。 */
export const VMT_HAND_SLOTS = Object.freeze({ left: 1, right: 2 });

/** 没有真实位姿时的默认站姿（米，Unity 左手系）：双手自然放在身前。 */
export const DEFAULT_POSES = Object.freeze({
  left: Object.freeze({ position: Object.freeze([-0.25, 1.2, 0.18]), rotation: Object.freeze([0, 0, 0, 1]) }),
  right: Object.freeze({ position: Object.freeze([0.25, 1.2, 0.18]), rotation: Object.freeze([0, 0, 0, 1]) }),
});

const HANDS = ['left', 'right'];

// ── 数学：四元数 / 向量 ─────────────────────────────────────────────────────

/** 四元数乘法 a*b（先 b 后 a 的旋转合成）。 */
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 归一化四元数；非法输入回落单位四元数。 */
export function normalizeQuat(value) {
  const raw = Array.isArray(value) ? value : [];
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  const w = Number(raw[3]);
  if (![x, y, z, w].every(Number.isFinite)) return [0, 0, 0, 1];
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-9) return [0, 0, 0, 1];
  return [x / length, y / length, z / length, w / length];
}

/** 欧拉角（度，Unity 顺序 yaw*pitch*roll）→ 四元数。 */
export function quatFromEuler(rotation = {}) {
  const yaw = ((Number(rotation.yaw) || 0) * Math.PI) / 180;
  const pitch = ((Number(rotation.pitch) || 0) * Math.PI) / 180;
  const roll = ((Number(rotation.roll) || 0) * Math.PI) / 180;
  const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const qx = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)];
  const qz = [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)];
  // Unity Quaternion.Euler 的合成顺序：先 roll(Z)，再 pitch(X)，最后 yaw(Y)
  return normalizeQuat(quatMultiply(quatMultiply(qy, qx), qz));
}

/** 球面插值（最短路径）；夹角极小时退化为归一化线性插值。 */
export function slerpQuat(a, b, t) {
  const qa = normalizeQuat(a);
  const qb = normalizeQuat(b);
  let [bx, by, bz, bw] = qb;
  let dot = qa[0] * bx + qa[1] * by + qa[2] * bz + qa[3] * bw;
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuat([
      qa[0] + (bx - qa[0]) * t,
      qa[1] + (by - qa[1]) * t,
      qa[2] + (bz - qa[2]) * t,
      qa[3] + (bw - qa[3]) * t,
    ]);
  }
  const theta = Math.acos(Math.min(1, dot));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return normalizeQuat([
    qa[0] * wa + bx * wb,
    qa[1] * wa + by * wb,
    qa[2] * wa + bz * wb,
    qa[3] * wa + bw * wb,
  ]);
}

/** 三维线性插值。 */
export function lerpVec3(from, to, t) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

/** 把工具入参里的 rotation 归一成四元数（支持四元数或 yaw/pitch/roll）。 */
export function rotationToQuat(rotation, fallback = [0, 0, 0, 1]) {
  if (rotation === undefined || rotation === null) return normalizeQuat(fallback);
  if (Array.isArray(rotation)) {
    if (rotation.length === 4) return normalizeQuat(rotation);
    if (rotation.length === 3) return quatFromEuler({ yaw: rotation[0], pitch: rotation[1], roll: rotation[2] });
    throw new Error('vrchat_pose: `rotation` array must have 3 (yaw,pitch,roll) or 4 (qx,qy,qz,qw) numbers');
  }
  if (typeof rotation === 'object') {
    if (['qx', 'qy', 'qz', 'qw'].every((key) => rotation[key] !== undefined)) {
      return normalizeQuat([rotation.qx, rotation.qy, rotation.qz, rotation.qw]);
    }
    if (['x', 'y', 'z', 'w'].every((key) => rotation[key] !== undefined)) {
      return normalizeQuat([rotation.x, rotation.y, rotation.z, rotation.w]);
    }
    return quatFromEuler(rotation);
  }
  throw new Error('vrchat_pose: `rotation` must be an object {yaw,pitch,roll} or {qx,qy,qz,qw}');
}

/**
 * 解析目标位置：`target: {x,y,z}`（可只写部分轴，缺的轴保持当前值），
 * 或数组 [x,y,z]（留给 lib 内部/单测用）。
 */
export function positionFrom(target, current, label = 'target') {
  if (target === undefined) return [...current];
  if (Array.isArray(target)) {
    if (target.length < 3) throw new Error(`vrchat_pose: \`${label}\` array must have 3 numbers`);
    const values = target.slice(0, 3).map(Number);
    if (!values.every(Number.isFinite)) throw new Error(`vrchat_pose: \`${label}\` must contain finite numbers`);
    return values;
  }
  if (target === null || typeof target !== 'object') {
    throw new Error(`vrchat_pose: \`${label}\` must be an object {x,y,z}`);
  }
  const keys = ['x', 'y', 'z'];
  const provided = keys.filter((key) => target[key] !== undefined);
  if (provided.length === 0) {
    throw new Error(`vrchat_pose: \`${label}\` must provide at least one of x/y/z`);
  }
  const out = [...current];
  for (const key of provided) {
    const value = Number(target[key]);
    if (!Number.isFinite(value)) throw new Error(`vrchat_pose: \`${label}.${key}\` must be a finite number`);
    out[keys.indexOf(key)] = value;
  }
  return out;
}

/**
 * 把工具参数解析成"每只手的目标位姿"。
 * 优先级：`left`/`right` 里的 target/rotation > 顶层 `target`/`rotation`。
 * @returns {{hand:'left'|'right'|'both', sides:string[], targets:object}}
 */
export function resolvePoseTargets(options = {}, currentPoses = DEFAULT_POSES) {
  let hand = options.hand;
  if (hand === undefined) {
    // 只给了一只手时自动推断，避免"left 给了但 hand 默认 both 导致 right 没目标"的报错
    const hasLeft = options.left !== undefined && options.left !== null;
    const hasRight = options.right !== undefined && options.right !== null;
    hand = hasLeft && !hasRight ? 'left' : hasRight && !hasLeft ? 'right' : 'both';
  }
  if (!['left', 'right', 'both'].includes(hand)) {
    throw new Error('vrchat_pose: `hand` must be "left", "right" or "both"');
  }
  const sides = hand === 'both' ? HANDS : [hand];
  const targets = {};
  for (const side of sides) {
    const perHand = options[side];
    if (perHand !== undefined && (perHand === null || typeof perHand !== 'object' || Array.isArray(perHand))) {
      throw new Error(`vrchat_pose: \`${side}\` must be an object {target:{x,y,z}, rotation:{...}}`);
    }
    // 宽松一点：直接写 {x,y,z} 也当成 target
    const directTarget = perHand !== undefined && ['x', 'y', 'z'].some((key) => perHand[key] !== undefined)
      ? perHand
      : undefined;
    const handTarget = perHand?.target ?? directTarget;
    const hasTopTarget = options.target !== undefined;
    const hasHandTarget = handTarget !== undefined;
    const rotation = perHand?.rotation ?? options.rotation;
    if (!hasTopTarget && !hasHandTarget && rotation === undefined) {
      throw new Error(`vrchat_pose: no target for ${side} — pass \`target\` or \`${side}.target\``);
    }
    const current = currentPoses[side] ?? DEFAULT_POSES[side];
    // 顶层 target 先按轴覆盖当前值，per-hand target 再按轴覆盖一次（方便"同高度、不同 x"）
    let position = [...current.position];
    if (hasTopTarget) position = positionFrom(options.target, position, 'target');
    if (hasHandTarget) position = positionFrom(handTarget, position, `${side}.target`);
    targets[side] = {
      position,
      rotation: rotationToQuat(rotation, current.rotation),
    };
  }
  return { hand, sides, targets };
}

const clonePose = (pose) => ({
  position: [...pose.position],
  rotation: [...pose.rotation],
});

const pickPoses = (poses, sides) => {
  const out = {};
  for (const side of sides) out[side] = clonePose(poses[side]);
  return out;
};

const errorMessage = (error) => String(error?.message ?? error);

// ── VMT UDP 客户端（只管收发与探活） ───────────────────────────────────────

export class VmtClient {
  constructor(options = {}) {
    this.host = typeof options.host === 'string' && options.host.length > 0 ? options.host : VMT_DEFAULT.host;
    this.sendPort = clampInt(options.sendPort ?? VMT_DEFAULT.sendPort, 1, 65535, VMT_DEFAULT.sendPort);
    this.listenPort = clampInt(options.listenPort ?? VMT_DEFAULT.listenPort, 1, 65535, VMT_DEFAULT.listenPort);
    this.enableMode = options.enableMode === 'controller' ? 'controller' : 'index';
    this.listenerIdleMs = clampInt(options.listenerIdleMs ?? VMT_DEFAULT.listenerIdleMs, 0, 600_000, VMT_DEFAULT.listenerIdleMs);
    this.probeTimeoutMs = clampInt(options.probeTimeoutMs ?? VMT_DEFAULT.probeTimeoutMs, 50, 10_000, VMT_DEFAULT.probeTimeoutMs);
    this.probeCacheMs = clampInt(options.probeCacheMs ?? VMT_DEFAULT.probeCacheMs, 0, 60_000, VMT_DEFAULT.probeCacheMs);
    this.probeBackoffMs = clampInt(options.probeBackoffMs ?? VMT_DEFAULT.probeBackoffMs, 0, 60_000, VMT_DEFAULT.probeBackoffMs);
    this.logger = options.logger ?? null;

    this.sender = null;
    this.listener = null;
    this.listening = false;
    this.listenError = null;
    this.listenerIdleTimer = null;
    this.waiters = new Set();

    this.packetsSent = 0;
    this.packetsReceived = 0;
    this.sendErrors = 0;
    this.lastAliveAt = 0;
    this.lastAliveArgs = null;
    this.lastDriverMessageAt = 0;
    this.lastUnavailable = null;
    this.lastUnavailableAt = 0;
    this.roomMatrixSentAt = 0;
    this.lastProbeAt = 0;
    this.lastProbeAlive = null;   // null = 未知；true/false = 上次探活结论
    this.probeBackoffUntil = 0;
    this.startedAt = 0;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new Error('vmt: client is closed');
    if (this.sender !== null) return;
    this.sender = dgram.createSocket('udp4');
    this.sender.unref?.();
    this.sender.on('error', (error) => {
      this.sendErrors += 1;
      this._log('warn', `vmt: send socket error — ${errorMessage(error)}`);
    });
    this.startedAt = Date.now();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this._releaseListener();
    const sender = this.sender;
    this.sender = null;
    if (sender !== null) {
      try { sender.close(); } catch { /* already closed */ }
    }
  }

  _log(level, message) {
    const logger = this.logger;
    if (logger === null || logger === undefined) return;
    const fn = logger[level] ?? logger.info;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  send(address, args = []) {
    if (this.sender === null) throw new Error('vmt: client is not started');
    const packet = encodeMessage(address, args);
    this.packetsSent += 1;
    this.sender.send(packet, this.sendPort, this.host, (error) => {
      if (error !== null && error !== undefined) {
        this.sendErrors += 1;
        this._log('warn', `vmt: send failed — ${errorMessage(error)}`);
      }
    });
    return packet.length;
  }

  /** 发一帧 `/VMT/Room/Unity`；disable=true 时 enable 置 0（交还真实手柄）。 */
  sendPose(hand, pose, options = {}) {
    const slot = VMT_HAND_SLOTS[hand];
    if (slot === undefined) throw new Error(`vmt: unknown hand '${hand}'`);
    const fallback = DEFAULT_POSES[hand];
    const position = pose?.position ?? fallback.position;
    const rotation = normalizeQuat(pose?.rotation ?? fallback.rotation);
    const enable = options.disable === true
      ? VMT_ENABLE.disable
      : this.enableMode === 'controller'
        ? (hand === 'left' ? VMT_ENABLE.leftController : VMT_ENABLE.rightController)
        : (hand === 'left' ? VMT_ENABLE.leftIndex : VMT_ENABLE.rightIndex);
    const timeOffset = Number.isFinite(options.timeOffset) ? Number(options.timeOffset) : 0;
    const args = [
      { type: 'i', value: slot },
      { type: 'i', value: enable },
      { type: 'f', value: timeOffset },
      { type: 'f', value: position[0] },
      { type: 'f', value: position[1] },
      { type: 'f', value: position[2] },
      { type: 'f', value: rotation[0] },
      { type: 'f', value: rotation[1] },
      { type: 'f', value: rotation[2] },
      { type: 'f', value: rotation[3] },
    ];
    return this.send('/VMT/Room/Unity', args);
  }

  /** 发单位 RoomMatrix（不装 VMT Manager 时必需；低频，不要每帧发）。 */
  sendRoomMatrixIdentity() {
    const values = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const bytes = this.send('/VMT/SetRoomMatrix/Temporary', values.map((value) => ({ type: 'f', value })));
    this.roomMatrixSentAt = Date.now();
    return bytes;
  }

  async _ensureListener() {
    if (this.listening) return true;
    if (this.closed) return false;
    this._releaseListener();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.listener = socket;
    const bound = await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      socket.on('message', (packet) => this._handlePacket(packet));
      socket.once('error', (error) => {
        this.listenError = errorMessage(error);
        this.listening = false;
        this._log('warn', `vmt: cannot listen on ${this.host}:${this.listenPort} — ${this.listenError}`);
        try { socket.close(); } catch { /* ignore */ }
        if (this.listener === socket) this.listener = null;
        finish(false);
      });
      socket.bind(this.listenPort, this.host, () => {
        this.listening = true;
        this.listenError = null;
        this._scheduleListenerIdle();
        finish(true);
      });
    });
    return bound;
  }

  _scheduleListenerIdle() {
    if (this.listenerIdleTimer !== null) {
      clearTimeout(this.listenerIdleTimer);
      this.listenerIdleTimer = null;
    }
    if (this.listenerIdleMs <= 0) return;
    this.listenerIdleTimer = setTimeout(() => {
      this.listenerIdleTimer = null;
      if (this.listening) this._releaseListener();
    }, this.listenerIdleMs);
    this.listenerIdleTimer.unref?.();
  }

  _releaseListener() {
    if (this.listenerIdleTimer !== null) {
      clearTimeout(this.listenerIdleTimer);
      this.listenerIdleTimer = null;
    }
    const socket = this.listener;
    this.listener = null;
    this.listening = false;
    if (socket !== null) {
      try { socket.close(); } catch { /* ignore */ }
    }
    for (const waiter of [...this.waiters]) waiter(false);
  }

  _handlePacket(packet) {
    let messages;
    try {
      messages = decodePacket(packet);
    } catch (error) {
      this._log('debug', `vmt: undecodable packet — ${errorMessage(error)}`);
      return;
    }
    const now = Date.now();
    this.packetsReceived += 1;
    this.lastDriverMessageAt = now;
    for (const message of messages) {
      if (message.address === '/VMT/Out/Alive') {
        this.lastAliveAt = now;
        // 归一成可 JSON 化的值（OSC 的 N/I 等无载荷标签 value 是 undefined）
        this.lastAliveArgs = message.args.map((arg) => (arg.value === undefined ? null : arg.value));
        for (const waiter of [...this.waiters]) waiter(true);
      } else if (message.address === '/VMT/Out/Unavailable') {
        this.lastUnavailable = message.args[0]?.value ?? null;
        this.lastUnavailableAt = now;
      }
    }
  }

  /** 等一次 Alive；timeoutMs 内收到返回 true。 */
  waitForAlive(timeoutMs) {
    const start = Date.now();
    if (this.lastAliveAt >= start) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref?.();
      this.waiters.add(finish);
    });
  }

  /**
   * 探活：监听 39571 等 `/VMT/Out/Alive`。
   * @returns {Promise<{alive: boolean|null, reason: string}>} alive=null 表示"不知道"（端口被占）
   */
  async probeDriver(timeoutMs = this.probeTimeoutMs) {
    const now = Date.now();
    if (this.lastAliveAt !== 0 && now - this.lastAliveAt <= this.probeCacheMs) {
      return { alive: true, reason: 'alive' };
    }
    if (this.lastProbeAlive === false && now < this.probeBackoffUntil) {
      return { alive: false, reason: 'no-alive-recent' };
    }
    this.lastProbeAt = now;
    const bound = await this._ensureListener();
    if (!bound) {
      this.lastProbeAlive = null;
      return { alive: null, reason: this.listenError === null ? 'not-listening' : 'listen-unavailable' };
    }
    if (this.lastAliveAt !== 0 && Date.now() - this.lastAliveAt <= this.probeCacheMs) {
      this.lastProbeAlive = true;
      return { alive: true, reason: 'alive' };
    }
    const alive = await this.waitForAlive(Math.max(50, timeoutMs));
    this.lastProbeAlive = alive;
    if (!alive) this.probeBackoffUntil = Date.now() + this.probeBackoffMs;
    return { alive, reason: alive ? 'alive' : 'no-alive' };
  }

  state() {
    const now = Date.now();
    return {
      host: this.host,
      sendPort: this.sendPort,
      listenPort: this.listenPort,
      listening: this.listening,
      listenError: this.listenError,
      enableMode: this.enableMode,
      driverAlive: this.lastAliveAt !== 0 && now - this.lastAliveAt <= this.probeCacheMs,
      lastAliveMsAgo: this.lastAliveAt === 0 ? null : now - this.lastAliveAt,
      lastDriverMessageMsAgo: this.lastDriverMessageAt === 0 ? null : now - this.lastDriverMessageAt,
      lastAliveArgs: this.lastAliveArgs,
      lastUnavailable: this.lastUnavailable,
      lastUnavailableMsAgo: this.lastUnavailableAt === 0 ? null : now - this.lastUnavailableAt,
      roomMatrixSentAt: this.roomMatrixSentAt === 0 ? null : this.roomMatrixSentAt,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      sendErrors: this.sendErrors,
      probe: {
        lastProbeMsAgo: this.lastProbeAt === 0 ? null : now - this.lastProbeAt,
        lastResult: this.lastProbeAlive,
      },
    };
  }
}

// ── 位姿控制器（定时器驱动的平滑发送循环） ─────────────────────────────────

export class PoseController {
  constructor(options = {}) {
    this.client = options.client ?? new VmtClient({
      host: options.host,
      sendPort: options.sendPort,
      listenPort: options.listenPort,
      enableMode: options.enableMode,
      listenerIdleMs: options.listenerIdleMs,
      probeTimeoutMs: options.probeTimeoutMs,
      probeCacheMs: options.probeCacheMs,
      probeBackoffMs: options.probeBackoffMs,
      logger: options.logger,
    });
    this.hz = clampInt(options.hz ?? VMT_DEFAULT.hz, 30, 90, VMT_DEFAULT.hz);
    this.holdHz = clampInt(options.holdHz ?? VMT_DEFAULT.holdHz, 5, 60, VMT_DEFAULT.holdHz);
    this.humanize = options.humanize !== false;
    this.idleDrift = options.idleDrift !== false;
    this.driftAmplitude = clampNumber(options.driftAmplitude ?? 0.012, 0, 0.05, 0.012);
    this.driftRotationDeg = clampNumber(options.driftRotationDeg ?? 0.4, 0, 3, 0.4);
    this.setRoomMatrix = options.setRoomMatrix !== false;
    this.seed = clampInt(options.seed ?? 1, 0, 2 ** 31 - 1, 1);
    this.logger = options.logger ?? null;
    this.humanizer = createHumanizer({
      seed: this.seed,
      drift: { amplitude: this.driftAmplitude, rotationDeg: this.driftRotationDeg },
    });

    this.poses = { left: clonePose(DEFAULT_POSES.left), right: clonePose(DEFAULT_POSES.right) };
    this.motion = null;        // 正在播放的动作（未 settle）
    this.holdState = null;     // 动作结束后维持位姿的状态
    this.framesSent = 0;
    this.sequences = 0;
    this.lastResult = null;
    this.started = false;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new Error('vmt: pose controller is closed');
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
      return 'VMT driver state unknown (39571 is already in use by another program). Pose packets are sent '
        + 'best-effort; hands may not move.';
    }
    return 'VMT driver not detected on 127.0.0.1:39571 (/VMT/Out/Alive). Pose packets are sent best-effort '
      + '(degraded): install/start the self-compiled VMT driver, or keep using the OSC-only path.';
  }

  _driverSnapshot(driver) {
    const state = this.client.state();
    return {
      alive: driver.alive,
      reason: driver.reason,
      listenError: state.listenError,
      lastAliveMsAgo: state.lastAliveMsAgo,
      lastUnavailable: state.lastUnavailable,
    };
  }

  _buildResult(motion, extra = {}) {
    const now = Date.now();
    const settledAt = motion.settledAt ?? now;
    return {
      ok: extra.cancelled !== true,
      hand: motion.hand,
      sides: [...motion.sides],
      from: pickPoses(motion.from, motion.sides),
      to: pickPoses(motion.to, motion.sides),
      durationMs: motion.requestedDurationMs,
      effectiveDurationMs: motion.durationMs,
      easing: motion.easing,
      hz: motion.hz,
      frames: motion.frames,
      sequence: motion.id,
      hold: motion.hold,
      holdMs: motion.holdMs,
      humanize: motion.humanize,
      reactionMs: motion.reactionMs,
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

  _settleMotion(motion) {
    if (this.motion !== motion) return;
    this.motion = null;
    motion.settledAt = Date.now();
    this._cleanupMotion(motion);
    const holdActive = motion.hold === true;
    const result = this._buildResult(motion, { finished: true, holdActive });
    if (motion.resolve !== null) {
      const resolve = motion.resolve;
      motion.resolve = null;
      resolve(result);
    }
    this.lastResult = result;
    if (holdActive) {
      this._startHold(motion);
    } else {
      this._releaseHands(motion.sides);
    }
  }

  _interruptMotion(motion, extra = {}) {
    this._cleanupMotion(motion);
    if (this.motion === motion) this.motion = null;
    motion.settledAt = Date.now();
    const result = this._buildResult(motion, { interrupted: extra.interrupted === true, cancelled: extra.cancelled === true });
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

  _releaseHands(sides) {
    for (const side of sides) {
      try {
        this.client.sendPose(side, this.poses[side], { disable: true });
        this.framesSent += 1;
      } catch (error) {
        this._log('warn', `vmt: failed to release ${side} — ${errorMessage(error)}`);
      }
    }
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
      for (const side of motion.sides) {
        const from = motion.from[side] ?? this.poses[side];
        const to = motion.to[side];
        const pose = {
          position: lerpVec3(from.position, to.position, eased),
          rotation: slerpQuat(from.rotation, to.rotation, eased),
        };
        this.poses[side] = pose;
        try {
          this.client.sendPose(side, pose);
          this.framesSent += 1;
        } catch (error) {
          this._log('warn', `vmt: sendPose failed — ${errorMessage(error)}`);
        }
      }
      motion.frames += 1; // 一帧 = 一次 tick（同时给所有目标手各发一包）
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
    const base = {};
    for (const side of motion.sides) base[side] = clonePose(motion.to[side]);
    const holdState = {
      motion,
      sides: [...motion.sides],
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
      for (const side of holdState.sides) {
        const anchor = holdState.base[side];
        const pose = {
          position: [
            anchor.position[0] + drift.x,
            anchor.position[1] + drift.y,
            anchor.position[2] + drift.z,
          ],
          rotation: quatMultiply(
            anchor.rotation,
            quatFromEuler({ yaw: drift.yawDeg, pitch: drift.pitchDeg, roll: drift.rollDeg }),
          ),
        };
        this.poses[side] = pose;
        try {
          this.client.sendPose(side, pose);
          this.framesSent += 1;
        } catch (error) {
          this._log('warn', `vmt: hold sendPose failed — ${errorMessage(error)}`);
        }
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

  /**
   * 播放一段位姿动作。返回结果（默认等动作结束；`wait:false` 立即返回，动作在后台继续）。
   * 新调用会抢占旧动作：旧调用以 interrupted:true 结束。
   */
  async animate(options = {}) {
    if (this.closed) throw new Error('vrchat_pose: pose controller is disposed');
    if (!this.started) this.start();
    const { hand, sides, targets } = resolvePoseTargets(options, this.poses);
    const requestedDurationMs = clampInt(options.durationMs ?? 600, 0, 10_000, 600);
    const easing = normalizeEasing(options.easing);
    const hold = options.hold !== false;
    const wait = options.wait !== false;
    const hz = clampInt(options.hz ?? this.hz, 30, 90, this.hz);
    const humanize = options.humanize === undefined ? this.humanize : options.humanize === true;
    const reaction = options.reaction === true;
    const holdMs = clampInt(options.holdMs ?? 0, 0, 600_000, 0);
    const seed = clampInt(options.seed ?? this.seed, 0, 2 ** 31 - 1, this.seed);
    const humanizer = seed === this.seed
      ? this.humanizer
      : createHumanizer({ seed, drift: { amplitude: this.driftAmplitude, rotationDeg: this.driftRotationDeg } });
    const signal = options.signal;

    if (signal?.aborted === true) {
      return {
        ok: false,
        cancelled: true,
        started: false,
        finished: false,
        interrupted: false,
        hand,
        sides,
        frames: 0,
        totalFramesSent: this.framesSent,
      };
    }

    // 探活（同时确保 39571 已绑定）；无驱动不报错，只降级。
    const probe = await this.client.probeDriver(options.probeTimeoutMs ?? this.client.probeTimeoutMs);
    if (this.closed) throw new Error('vrchat_pose: pose controller is disposed');

    const from = pickPoses(this.poses, sides);
    const to = {};
    for (const side of sides) to[side] = clonePose(targets[side]);
    const effectiveDuration = humanize
      ? humanizer.jitterMs(requestedDurationMs, { relative: 0.08, minMs: 0, maxMs: 10_000 })
      : requestedDurationMs;
    const reactionMs = reaction ? humanizer.reactionDelay() : 0;

    const interruptedPrevious = this._interruptActive();
    if (this.setRoomMatrix && (this.client.roomMatrixSentAt === 0 || options.roomMatrix === true)) {
      try {
        this.client.sendRoomMatrixIdentity();
      } catch (error) {
        this._log('warn', `vmt: room matrix send failed — ${errorMessage(error)}`);
      }
    }

    const motion = {
      id: ++this.sequences,
      hand,
      sides,
      from,
      to,
      requestedDurationMs,
      durationMs: effectiveDuration,
      easing,
      hz,
      hold,
      holdMs,
      humanize,
      reactionMs,
      driver: this._driverSnapshot(probe),
      warning: this._warning(probe),
      frames: 0,
      startedAt: 0,
      settledAt: 0,
      settled: false,
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
      motion.onAbort = () => this.cancel({ disable: false, reason: 'aborted' });
      signal.addEventListener?.('abort', motion.onAbort, { once: true });
    }

    if (reactionMs > 0) {
      motion.startTimer = setTimeout(() => {
        motion.startTimer = null;
        if (this.motion === motion) this._runMotion(motion);
      }, reactionMs);
    } else {
      this._runMotion(motion);
    }

    if (wait) return promise;
    return this._buildResult(motion, { finished: false });
  }

  /** 立即停止当前动作（可选把双手交还给真实手柄）。 */
  cancel({ disable = true, reason = 'cancelled' } = {}) {
    const hadMotion = this.motion !== null;
    const sequence = this.motion?.id ?? null;
    if (this.motion !== null) {
      this._interruptMotion(this.motion, { cancelled: true });
    }
    const hadHold = this.holdState !== null;
    this._stopHold();
    let disabled = false;
    if (disable === true) {
      this._releaseHands(HANDS);
      disabled = true;
    }
    this._log('info', `vmt: pose cancelled (${reason}) motion=${hadMotion} hold=${hadHold} disable=${disabled}`);
    return {
      ok: false,
      cancelled: true,
      disabled,
      hadMotion,
      holdActive: hadHold,
      sequence,
      totalFramesSent: this.framesSent,
      driver: this.client.state(),
    };
  }

  /** 交还双手（enable=0），不改变保持的姿态数据。 */
  disable() {
    this._stopHold();
    if (this.motion !== null) this._interruptMotion(this.motion, { cancelled: true });
    this._releaseHands(HANDS);
    return {
      ok: true,
      disabled: true,
      totalFramesSent: this.framesSent,
      driver: this.client.state(),
    };
  }

  state() {
    const activeMotion = this.motion === null
      ? null
      : {
        sequence: this.motion.id,
        hand: this.motion.hand,
        sides: [...this.motion.sides],
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
      setRoomMatrix: this.setRoomMatrix,
      humanize: this.humanize,
      idleDrift: this.idleDrift,
      hands: {
        left: clonePose(this.poses.left),
        right: clonePose(this.poses.right),
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
    try { this._releaseHands(HANDS); } catch { /* ignore */ }
    this.closed = true;
    this.client.stop();
  }
}
