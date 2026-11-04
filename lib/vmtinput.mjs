// vmtinput.mjs — 虚拟手柄输入通道（发到 VMT 驱动 UDP 39570）
//
// 协议参考 VMT 源码 CommunicationManager.cpp（Index 兼容分支）：
//   /VMT/Input/Button        (int idx, int buttonIndex, float timeoffset, int value)
//   /VMT/Input/Button/Touch  (int idx, int buttonIndex, float timeoffset, int value)
//   /VMT/Input/Trigger       (int idx, int triggerIndex, float timeoffset, float value)
//   /VMT/Input/Trigger/Touch (int idx, int triggerIndex, float timeoffset, int value)
//   /VMT/Input/Trigger/Click (int idx, int triggerIndex, float timeoffset, int value)
//   /VMT/Input/Joystick      (int idx, int joystickIndex, float timeoffset, float x, float y)
//   /VMT/Input/Joystick/Touch|Click (int idx, int joystickIndex, float timeoffset, int value)
//
// idx 与位姿通道一致：1 = 左手，2 = 右手；timeoffset 恒为 0（立即生效）。
// buttonIndex / component 取自 VMT 源码 Index 分支；不确认处已在注释里标注。
//
// 设计：纯 node 内置模块（dgram + 本地 osc 编解码），零第三方依赖；UDP 发送失败只计入
// stats.errors，绝不向外抛。按键/轴会自动归零（定时器），releaseAll() 可立即全部归零。
import dgram from 'node:dgram';
import { encodeMessage } from './osc.js';

export const SIDE_INDEX = Object.freeze({ left: 1, right: 2 });

/**
 * "人类按键名" → VMT 协议通道与组件下标（按 VMT 源码 Index 分支）。
 *   button  : /VMT/Input/Button        component 即 buttonIndex
 *   trigger : /VMT/Input/Trigger       component 0=Trigger、1=Grip
 *   joystick: /VMT/Input/Joystick      component 0=Trackpad、1=Thumbstick（Click/Touch 用于按键）
 */
export const BUTTON_MAP = Object.freeze({
  system: Object.freeze({
    kind: 'button', component: 0,
    clickAddress: '/VMT/Input/Button', touchAddress: '/VMT/Input/Button/Touch',
    label: 'System',
  }),
  a: Object.freeze({
    kind: 'button', component: 1,
    clickAddress: '/VMT/Input/Button', touchAddress: '/VMT/Input/Button/Touch',
    label: 'A',
  }),
  b: Object.freeze({
    kind: 'button', component: 3,
    clickAddress: '/VMT/Input/Button', touchAddress: '/VMT/Input/Button/Touch',
    label: 'B',
  }),
  trigger: Object.freeze({
    kind: 'trigger', component: 0,
    clickAddress: '/VMT/Input/Trigger', touchAddress: '/VMT/Input/Trigger/Touch',
    label: 'Trigger',
  }),
  grip: Object.freeze({
    kind: 'trigger', component: 1,
    clickAddress: '/VMT/Input/Trigger', touchAddress: '/VMT/Input/Trigger/Touch',
    label: 'Grip',
  }),
  thumbstick: Object.freeze({
    kind: 'joystick', component: 1,
    clickAddress: '/VMT/Input/Joystick/Click', touchAddress: '/VMT/Input/Joystick/Touch',
    label: 'Thumbstick',
  }),
  trackpad: Object.freeze({
    kind: 'joystick', component: 0,
    clickAddress: '/VMT/Input/Joystick/Click', touchAddress: '/VMT/Input/Joystick/Touch',
    label: 'Trackpad',
  }),
});

export const BUTTON_NAMES = Object.freeze(Object.keys(BUTTON_MAP));
export const INPUT_ADDRESSES = Object.freeze([
  '/VMT/Input/Button', '/VMT/Input/Button/Touch',
  '/VMT/Input/Trigger', '/VMT/Input/Trigger/Touch', '/VMT/Input/Trigger/Click',
  '/VMT/Input/Joystick', '/VMT/Input/Joystick/Touch', '/VMT/Input/Joystick/Click',
]);

const intArg = (value) => ({ type: 'i', value: Math.trunc(Number(value)) || 0 });
const floatArg = (value) => ({ type: 'f', value: Number.isFinite(Number(value)) ? Number(value) : 0 });
const TIME_OFFSET = floatArg(0);
const MAX_DURATION_MS = 10_000;

function clampNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeDuration(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(number)));
}

/** 解出 press() 的 side/options（兼容 press(name, side, opts) 与 press(name, {side, ...opts})）。 */
function parsePressArgs(sideOrOptions, maybeOptions) {
  if (sideOrOptions !== null && typeof sideOrOptions === 'object') {
    return { side: sideOrOptions.side, options: sideOrOptions };
  }
  return { side: sideOrOptions, options: maybeOptions !== null && typeof maybeOptions === 'object' ? maybeOptions : {} };
}

/**
 * 创建虚拟手柄输入通道。
 * @param {{host?:string, port?:number, dryRun?:boolean, sendImpl?:Function, now?:Function}} options
 */
export function createVmtInput(options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {};
  const host = typeof input.host === 'string' && input.host.length > 0 ? input.host : '127.0.0.1';
  const port = clampNumber(input.port, 1, 65_535, 39_570);
  const dryRun = input.dryRun === true;
  const sendImpl = typeof input.sendImpl === 'function' ? input.sendImpl : null;
  void input.now; // 预留给需要固定时钟的调用方；本模块只用 setTimeout

  const stats = {
    pressed: 0,
    releases: 0,
    errors: 0,
    bytes: 0,
    messages: 0,
    lastError: null,
  };
  const timers = new Set();
  const held = new Map(); // key -> { timer, sendZero, resolve }
  let socket = null;
  let closed = false;
  let closing = false;
  let pendingSends = 0;

  function setError(error) {
    stats.errors += 1;
    stats.lastError = String(error?.message ?? error);
  }

  function ensureSocket() {
    if (closed) throw new Error('vmtinput: channel closed');
    if (socket !== null) return socket;
    socket = dgram.createSocket('udp4');
    socket.on('error', (error) => setError(error));
    return socket;
  }

  function send(address, args) {
    if (closed) return false;
    let buffer;
    try {
      buffer = encodeMessage(address, args);
    } catch (error) {
      setError(error);
      return false;
    }
    stats.bytes += buffer.length;
    stats.messages += 1;
    if (dryRun) return true;
    try {
      if (sendImpl !== null) {
        sendImpl(buffer, { host, port });
      } else {
        pendingSends += 1;
        ensureSocket().send(buffer, port, host, (error) => {
          pendingSends = Math.max(0, pendingSends - 1);
          if (error) setError(error);
          if (closing && pendingSends === 0) closeSocketNow();
        });
      }
      return true;
    } catch (error) {
      setError(error);
      return false;
    }
  }

  function schedule(fn, durationMs) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, durationMs);
    timers.add(timer);
    return timer;
  }

  function requireButton(name) {
    const key = String(name ?? '').trim().toLowerCase();
    const spec = BUTTON_MAP[key];
    if (spec === undefined) {
      throw new Error(`vmtinput: unknown button "${String(name)}"（可用：${BUTTON_NAMES.join('/')}）`);
    }
    return { key, spec };
  }

  function requireSide(side) {
    const key = String(side ?? '').trim().toLowerCase();
    const index = SIDE_INDEX[key];
    if (index === undefined) {
      throw new Error(`vmtinput: unknown side "${String(side)}"（可用：left/right）`);
    }
    return index;
  }

  /** 生成一次 Channel 消息的 args 与归零 args。 */
  function buildArgs(spec, index, touch, value) {
    const intValue = Number(value) >= 0.5 ? 1 : 0;
    if (spec.kind === 'button' || spec.kind === 'joystick' || touch) {
      // Button / Button·Touch / Joystick·Click / Joystick·Touch：4 个参数，末位是 int
      return [intArg(index), intArg(spec.component), TIME_OFFSET, intArg(intValue)];
    }
    return [intArg(index), intArg(spec.component), TIME_OFFSET, floatArg(value)];
  }

  function buildZeroArgs(spec, index, touch) {
    if (spec.kind === 'button' || spec.kind === 'joystick' || touch) {
      return [intArg(index), intArg(spec.component), TIME_OFFSET, intArg(0)];
    }
    return [intArg(index), intArg(spec.component), TIME_OFFSET, floatArg(0)];
  }

  /** 登记一个"按下后定时归零"的输入；重复按同一键会先释放旧的。 */
  function hold(key, address, args, zeroArgs, durationMs) {
    const previous = held.get(key);
    if (previous !== undefined) cancelEntry(previous);
    const ok = send(address, args);
    stats.pressed += 1;
    return new Promise((resolve) => {
      const entry = {
        timer: null,
        release() {
          if (entry.timer !== null) {
            clearTimeout(entry.timer);
            timers.delete(entry.timer);
            entry.timer = null;
          }
          if (send(address, zeroArgs)) stats.releases += 1;
          held.delete(key);
          resolve(ok);
        },
      };
      held.set(key, entry);
      entry.timer = schedule(() => entry.release(), durationMs);
    });
  }

  function cancelEntry(entry) {
    entry.release();
  }

  /** press(name, side, {durationMs=120, value=1, touch=false}) 或 press(name, {side, ...})。 */
  function press(name, sideOrOptions, maybeOptions) {
    const { key, spec } = requireButton(name);
    const { side, options } = parsePressArgs(sideOrOptions, maybeOptions);
    const index = requireSide(side);
    const durationMs = normalizeDuration(options.durationMs, 120);
    const value = clampNumber(options.value, 0, 1, 1);
    const touch = options.touch === true;
    const address = touch ? spec.touchAddress : spec.clickAddress;
    const args = buildArgs(spec, index, touch, value);
    const zeroArgs = buildZeroArgs(spec, index, touch);
    const holdKey = `${spec.kind}:${spec.component}:${index}:${touch ? 'touch' : 'press'}`;
    // touch 不是"按住"语义：只发一次，不登记归零
    if (touch) {
      const ok = send(address, args);
      stats.pressed += 1;
      return Promise.resolve(ok);
    }
    return hold(holdKey, address, args, zeroArgs, durationMs);
  }

  /** trigger(side, value, {component='trigger'|'grip', durationMs=0, touch=false})（默认保持，releaseAll 归零）。 */
  function trigger(side, value, options = {}) {
    const index = requireSide(side);
    const component = String(options.component ?? 'trigger').toLowerCase() === 'grip' ? 1 : 0;
    const spec = component === 1 ? BUTTON_MAP.grip : BUTTON_MAP.trigger;
    const numeric = clampNumber(value, 0, 1, 0);
    const durationMs = normalizeDuration(options.durationMs, 0);
    const touch = options.touch === true;
    const address = touch ? spec.touchAddress : spec.clickAddress;
    const args = touch
      ? [intArg(index), intArg(component), TIME_OFFSET, intArg(numeric >= 0.5 ? 1 : 0)]
      : [intArg(index), intArg(component), TIME_OFFSET, floatArg(numeric)];
    const zeroArgs = touch
      ? [intArg(index), intArg(component), TIME_OFFSET, intArg(0)]
      : [intArg(index), intArg(component), TIME_OFFSET, floatArg(0)];
    if (touch) {
      const ok = send(address, args);
      stats.pressed += 1;
      return Promise.resolve(ok);
    }
    const holdKey = `trigger:${component}:${index}:press`;
    if (durationMs === 0) {
      // 持续按住：登记为 held（无 timer），releaseAll() 归零
      const previous = held.get(holdKey);
      if (previous !== undefined) cancelEntry(previous);
      const ok = send(address, args);
      stats.pressed += 1;
      return new Promise((resolve) => {
        held.set(holdKey, {
          timer: null,
          release() {
            if (send(address, zeroArgs)) stats.releases += 1;
            held.delete(holdKey);
            resolve(ok);
          },
        });
      });
    }
    return hold(holdKey, address, args, zeroArgs, durationMs);
  }

  /** stick(side, x, y, {durationMs=120}) 或 stick(side, {x,y}, {durationMs})。 */
  function stick(side, xOrOptions, maybeY, maybeOptions) {
    const index = requireSide(side);
    let x;
    let y;
    let options;
    if (xOrOptions !== null && typeof xOrOptions === 'object') {
      x = clampNumber(xOrOptions.x, -1, 1, 0);
      y = clampNumber(xOrOptions.y, -1, 1, 0);
      options = maybeY !== null && typeof maybeY === 'object' ? maybeY : {};
    } else {
      x = clampNumber(xOrOptions, -1, 1, 0);
      y = clampNumber(maybeY, -1, 1, 0);
      options = maybeOptions !== null && typeof maybeOptions === 'object' ? maybeOptions : {};
    }
    const durationMs = normalizeDuration(options.durationMs, 120);
    const component = 1; // JoystickComponent[1] = thumbstick（按 VMT 源码 Index 分支）
    const address = '/VMT/Input/Joystick';
    const args = [intArg(index), intArg(component), TIME_OFFSET, floatArg(x), floatArg(y)];
    const zeroArgs = [intArg(index), intArg(component), TIME_OFFSET, floatArg(0), floatArg(0)];
    const holdKey = `joystick:${component}:${index}:axes`;
    return hold(holdKey, address, args, zeroArgs, durationMs);
  }

  /** 把本通道按住的键/轴全部归零（同步发送，返回释放数量）。 */
  function releaseAll() {
    let released = 0;
    for (const entry of [...held.values()]) {
      entry.release();
      released += 1;
    }
    held.clear();
    return { released, held: held.size };
  }

  /** 关闭通道：先归零，再等 UDP 发送队列清空后关 socket；幂等。 */
  function closeSocketNow() {
    if (socket === null) return;
    const current = socket;
    socket = null;
    try { current.close(); } catch { /* ignore */ }
  }

  function close() {
    if (closed) return;
    try { releaseAll(); } catch { /* 归零失败也不阻塞关闭 */ }
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (socket === null) return;
    closing = true;
    if (pendingSends === 0) {
      closeSocketNow();
      return;
    }
    // 给已排队的归零包一点时间发出去；最多等 500ms。
    const timer = setTimeout(() => {
      timers.delete(timer);
      closeSocketNow();
    }, 500);
    timer.unref?.();
  }

  return {
    press,
    trigger,
    stick,
    releaseAll,
    close,
    get stats() {
      return {
        pressed: stats.pressed,
        releases: stats.releases,
        errors: stats.errors,
        bytes: stats.bytes,
        messages: stats.messages,
        lastError: stats.lastError,
        dryRun,
        closed,
        held: held.size,
      };
    },
    get url() {
      return `udp://${host}:${port}`;
    },
  };
}
