// player-process.mjs — 把 Phase 1 玩家进程（vrchat-vr-driver/player/demo.mjs）接成插件工具的薄封装。
//
// 设计约束（来自 Lead）：
//   * **不 import player/ 的源码**（跨工程耦合）；只 spawn 子进程 + 读监视器 HTTP。
//   * spawn 的 cwd 用 playerDir（仓库根），命令是 `node player/demo.mjs ...`。
//   * **不硬编码配套工程路径**：resolvePlayerPaths() 按候选顺序自动探测
//     config playerDir（三种写法）→ pluginDir/player（自包含发布包）→
//     pluginDir/../vrchat-vr-driver（开发期 link 的兄弟目录）→ 旧路径兜底（仅当存在）。
//   * stdout/stderr 进内存环形缓冲（默认各 300 行），供 log 工具查看。
//   * status 只读：子进程存活/运行时长 + 监视器 /health 与 /state（超时 800ms，失败降级），
//     并返回 paths { root, source, demoPath } 让用户看到玩家程序从哪找到的。
//   * stop：先温和 child.kill('SIGTERM')，Windows 上没退再 taskkill /PID <pid> /T /F 强杀。
//
// 本文件不依赖 DSH，可以被 tools/test_player.mjs 用假 node 脚本 + 假 monitor 单测。
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PLAYER_DEFAULT = Object.freeze({
  // 空 = 自动探测（config.playerDir 可选覆盖；pluginDir/player → 兄弟 vrchat-vr-driver/player）
  playerDir: '',
  playerNode: 'node',
  monitorPort: 8765,
  lineBufferSize: 300,
  monitorTimeoutMs: 800,
  preflightTimeoutMs: 60_000,
  // 看门狗：玩家进程非主动、非正常到时退出时自动重启（滚动窗口内最多 maxRestarts 次）
  watchdog: Object.freeze({
    enabled: true,
    maxRestarts: 3,
    backoffMs: 2000,
    windowMs: 600_000,
  }),
});

export const PLAYER_PERCEPTION_MODES = Object.freeze(['off', 'vision', 'log', 'hybrid']);
export const PLAYER_ACTIONS = Object.freeze(['start', 'stop', 'status', 'log']);

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clampInt = (value, lo, hi, fallback) => {
  const parsed = num(value, fallback);
  return Math.min(hi, Math.max(lo, Math.round(parsed)));
};
const now = () => Date.now();
const cleanStr = (value) => (typeof value === 'string' ? value.trim() : '');

/** 规范化看门狗配置（默认值见 PLAYER_DEFAULT.watchdog）。 */
function normalizeWatchdog(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    maxRestarts: clampInt(src.maxRestarts, 0, 100, PLAYER_DEFAULT.watchdog.maxRestarts),
    backoffMs: clampInt(src.backoffMs, 0, 600_000, PLAYER_DEFAULT.watchdog.backoffMs),
    windowMs: clampInt(src.windowMs, 100, 86_400_000, PLAYER_DEFAULT.watchdog.windowMs),
  };
}

/** 从 demo.mjs 参数数组里取某个 flag 的值（如 --seconds）。 */
function argValue(args, flag) {
  const index = Array.isArray(args) ? args.indexOf(flag) : -1;
  if (index < 0 || args[index + 1] === undefined) return null;
  return args[index + 1];
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 按顺序生成 demo.mjs 候选（去重，保留第一个来源）。
 * 候选来源：config（三种 playerDir 写法）→ plugin（自包含发布包）→ sibling（开发期兄弟目录）→ legacy。
 * @returns {{demoPath:string, root:string, source:'config'|'plugin'|'sibling'|'legacy'}[]}
 */
function buildDemoCandidates(options) {
  const candidates = [];
  const seen = new Set();
  const push = (demoPath, root, source) => {
    const demo = resolve(demoPath);
    const key = process.platform === 'win32' ? demo.toLowerCase() : demo;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ demoPath: demo, root: resolve(root), source });
  };

  // a. 显式 config.playerDir：仓库根 X（X/player/demo.mjs）/ player 目录 X（X/demo.mjs）/ demo.mjs 文件本身
  const playerDirOption = cleanStr(options.playerDir);
  if (playerDirOption) {
    const p = resolve(playerDirOption);
    if (/\.mjs$/i.test(p)) {
      push(p, dirname(dirname(p)), 'config'); // .../player/demo.mjs → 仓库根
    } else {
      push(join(p, 'player', 'demo.mjs'), p, 'config'); // 仓库根写法
      push(join(p, 'demo.mjs'), dirname(p), 'config');  // player 目录写法
    }
  }

  // b/c. pluginDir：自包含发布包里 player/ 就在插件根下；开发期 link 时配套工程是兄弟目录。
  // 没显式传 pluginDir 时用本模块所在包的根目录（保证候选清单永远非空，报错信息能指路）。
  const pluginDirOption = cleanStr(options.pluginDir) || resolve(import.meta.dirname, '..');
  if (pluginDirOption) {
    const plugin = resolve(pluginDirOption);
    push(join(plugin, 'player', 'demo.mjs'), plugin, 'plugin');
    const siblingRoot = resolve(plugin, '..', 'vrchat-vr-driver');
    push(join(siblingRoot, 'player', 'demo.mjs'), siblingRoot, 'sibling');
  }

  // e. 旧路径兜底：只有在调用方显式传了 legacyDir（测试 / 特殊部署）时才加候选，正常不硬编码任何本机路径
  const legacyOption = cleanStr(options.legacyDir);
  if (legacyOption) {
    const legacyRoot = resolve(legacyOption);
    push(join(legacyRoot, 'player', 'demo.mjs'), legacyRoot, 'legacy');
  }

  return candidates;
}

/**
 * 解析玩家工程路径（自动探测，不硬编码配套工程位置）。
 * 候选顺序：config.playerDir（三种写法）→ pluginDir/player → pluginDir/../vrchat-vr-driver/player
 * → legacyDir（仅测试/特殊部署显式传入）。第一个 demo.mjs 真实存在的候选胜出。
 *
 * @param {{playerDir?:string, pluginDir?:string, playerNode?:string, legacyDir?:string}} options
 *   legacyDir 只用于测试/特殊部署覆盖旧路径兜底，正常不用传。
 * @returns {{playerDir:string, playerNode:string, demoPath:string, preflightPath:string,
 *            source:'config'|'plugin'|'sibling'|'legacy'|'missing', tried:string[]}}
 *   playerDir 是仓库根（spawn 的 cwd）；source='missing' 时 demoPath 指向第一个候选，
 *   tried 是全部候选（报错信息会列出来，方便用户知道往哪放）。
 */
export function resolvePlayerPaths(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const playerNode = cleanStr(opts.playerNode) || PLAYER_DEFAULT.playerNode;
  const candidates = buildDemoCandidates(opts);
  const tried = candidates.map((candidate) => candidate.demoPath);
  const hit = candidates.find((candidate) => isFile(candidate.demoPath));
  if (hit) {
    return {
      playerDir: hit.root,
      playerNode,
      demoPath: hit.demoPath,
      preflightPath: join(hit.root, 'player', 'tools', 'preflight.mjs'),
      source: hit.source,
      tried,
    };
  }
  // 找不到：demoPath 指向第一个候选，tried 全部列出（没有候选时用空串占位，不抛异常）
  const first = candidates[0] ?? { root: '', demoPath: '' };
  return {
    playerDir: first.root,
    playerNode,
    demoPath: first.demoPath,
    preflightPath: join(first.root, 'player', 'tools', 'preflight.mjs'),
    source: 'missing',
    tried,
  };
}

/** 把 start 参数转成 demo.mjs 的命令行参数（不含 node/demo 路径本身）。 */
export function buildDemoArgs(options = {}) {
  const args = [];
  if (options.live === true) args.push('--live');
  if (options.perception !== undefined && options.perception !== null && options.perception !== '') {
    const perception = String(options.perception);
    if (!PLAYER_PERCEPTION_MODES.includes(perception)) {
      throw new Error(`vrchat_player: \`perception\` must be one of ${PLAYER_PERCEPTION_MODES.join('|')}`);
    }
    args.push('--perception', perception);
  }
  if (options.seconds !== undefined && options.seconds !== null) {
    const seconds = Number(options.seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86_400) {
      throw new Error('vrchat_player: `seconds` must be an integer between 5 and 86400');
    }
    args.push('--seconds', String(seconds));
  }
  if (options.seed !== undefined && options.seed !== null) {
    const seed = Number(options.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) {
      throw new Error('vrchat_player: `seed` must be an integer between 0 and 2147483647');
    }
    args.push('--seed', String(seed));
  }
  if (options.monitorPort !== undefined && options.monitorPort !== null) {
    const port = Number(options.monitorPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('vrchat_player: `monitorPort` must be an integer between 1 and 65535');
    }
    args.push('--port', String(port));
  }
  if (options.nav !== undefined && options.nav !== null && options.nav !== '') {
    const nav = typeof options.nav === 'boolean' ? (options.nav ? 'on' : 'off') : String(options.nav);
    if (nav !== 'on' && nav !== 'off') {
      throw new Error("vrchat_player: `nav` must be one of on|off (or boolean)");
    }
    args.push('--nav', nav);
  }
  if (options.map !== undefined && options.map !== null && options.map !== '') {
    if (typeof options.map !== 'string' || options.map.trim() === '') {
      throw new Error('vrchat_player: `map` must be a non-empty string path');
    }
    args.push('--map', options.map);
  }
  return args;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function vecOrNull(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = [finiteOrNull(value[0]), finiteOrNull(value[1]), finiteOrNull(value[2])];
  return out.every((entry) => entry !== null) ? out : null;
}

/** 精简 /state（一帧）里用户关心的字段。 */
export function summarizePlayerState(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const actionSrc = frame.action && typeof frame.action === 'object' ? frame.action : null;
  const rootSrc = frame.root && typeof frame.root === 'object' ? frame.root : null;
  const headSrc = frame.head && typeof frame.head === 'object' ? frame.head : null;
  const meta = frame.meta && typeof frame.meta === 'object' ? frame.meta : null;
  return {
    mode: typeof frame.mode === 'string' ? frame.mode : null,
    seq: finiteOrNull(frame.seq),
    clock: finiteOrNull(frame.clock),
    action: actionSrc === null ? null : {
      name: typeof actionSrc.name === 'string' ? actionSrc.name : null,
      label: typeof actionSrc.label === 'string' ? actionSrc.label : null,
      phase: finiteOrNull(actionSrc.phase),
    },
    root: rootSrc === null ? null : {
      pos: vecOrNull(rootSrc.pos),
      yaw: finiteOrNull(rootSrc.yaw),
      speed: finiteOrNull(rootSrc.speed),
    },
    head: headSrc === null ? null : {
      pos: vecOrNull(headSrc.pos),
      gaze: headSrc.gaze && typeof headSrc.gaze === 'object'
        ? { yaw: finiteOrNull(headSrc.gaze.yaw), pitch: finiteOrNull(headSrc.gaze.pitch) }
        : null,
    },
    targets: Array.isArray(frame.targets)
      ? frame.targets.slice(0, 16).map((target) => ({
        id: target && typeof target.id === 'string' ? target.id : null,
        label: target && typeof target.label === 'string' ? target.label : null,
        pos: target ? vecOrNull(target.pos) : null,
        bearingDeg: target ? finiteOrNull(target.bearingDeg) : null,
        apparentSize: target ? finiteOrNull(target.apparentSize) : null,
      }))
      : [],
    fps: meta && Number.isFinite(Number(meta.fps)) ? Number(meta.fps) : null,
    humanize: meta && meta.humanize && typeof meta.humanize === 'object' ? { ...meta.humanize } : null,
  };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(50, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function describeMonitorError(error, timeoutMs) {
  const message = String(error?.message ?? error);
  if (error?.name === 'AbortError' || /aborted/i.test(message)) {
    return `监视器请求超时（${timeoutMs}ms）`;
  }
  if (/ECONNREFUSED|ECONNRESET|fetch failed|connect/i.test(message)) {
    return '监视器没起（连接失败）';
  }
  return message;
}

function lineChunks(buffer, chunk) {
  const text = `${buffer}${String(chunk)}`;
  const parts = text.split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

/** 运行一个 node 脚本并收集输出（preflight 用）。 */
export function runNodeCapture(nodePath, scriptPath, options = {}) {
  const timeoutMs = Math.max(200, num(options.timeoutMs, 60_000));
  const maxLines = Math.max(20, num(options.maxLines, 200));
  return new Promise((resolve) => {
    const startedAt = now();
    const lines = [];
    let child;
    try {
      child = spawn(nodePath, [scriptPath], {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, lines, output: String(error?.message ?? error) });
      return;
    }
    let timedOut = false;
    let partial = { stdout: '', stderr: '' };
    const pushLines = (stream, chunk) => {
      const { lines: complete, rest } = lineChunks(partial[stream], chunk);
      partial[stream] = rest;
      for (const line of complete) {
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    };
    child.stdout?.on('data', (chunk) => pushLines('stdout', chunk));
    child.stderr?.on('data', (chunk) => pushLines('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: now() - startedAt,
        lines,
        output: `无法启动 ${nodePath}：${String(error?.message ?? error)}`,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (partial.stdout.length > 0) lines.push(partial.stdout);
      if (partial.stderr.length > 0) lines.push(partial.stderr);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: now() - startedAt,
        lines,
        output: lines.slice(-maxLines).join('\n'),
      });
    });
  });
}

export class PlayerProcess {
  constructor(options = {}) {
    this.paths = resolvePlayerPaths(options);
    this.defaultMonitorPort = clampInt(options.monitorPort, 1, 65_535, PLAYER_DEFAULT.monitorPort);
    this.lineBufferSize = clampInt(options.lineBufferSize, 20, 2000, PLAYER_DEFAULT.lineBufferSize);
    this.monitorTimeoutMs = clampInt(options.monitorTimeoutMs, 50, 5000, PLAYER_DEFAULT.monitorTimeoutMs);
    this.preflightTimeoutMs = clampInt(options.preflightTimeoutMs, 1000, 300_000, PLAYER_DEFAULT.preflightTimeoutMs);
    this.logger = options.logger ?? null;

    this.child = null;
    this.info = null;        // { pid, startedAt, args, monitorPort, cwd, node, demoPath }
    this.lastExit = null;    // { code, signal, at }
    this.lines = [];         // { stream, text, at }
    this.partials = { stdout: '', stderr: '' };
    this.spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;

    // ── 看门狗状态（非主动/非正常到时退出时自动重启）──────────────────────
    this.watchdog = normalizeWatchdog(options.watchdog);
    this._wd = {
      restartTimes: [],   // 窗口内每次自动重启的时间戳（滚动过期）
      lastRestartAt: null,
      exhausted: false,   // 重启预算用尽（或重启失败）
      reason: this.watchdog.enabled ? null : 'disabled',
      suppress: false,    // 用户主动 stop()/dispose() 后置位，禁止误重启
      timer: null,        // 退避中的重启定时器
    };
    this._restarting = false;     // 内部重启中：不要重置看门狗窗口
    this._lastStartOptions = null; // 重启时复用最近一次 start 参数
    this._plannedSeconds = null;   // --seconds 时长，用于判断"正常跑完"
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  _log(level, message) {
    const logger = this.logger;
    if (logger === null || logger === undefined) return;
    const fn = logger[level] ?? logger.info;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  _record(stream, text) {
    this.lines.push({ stream, text: String(text), at: now() });
    while (this.lines.length > this.lineBufferSize) this.lines.shift();
  }

  _attach(child) {
    const onData = (stream) => (chunk) => {
      const { lines, rest } = lineChunks(this.partials[stream], chunk);
      this.partials[stream] = rest;
      for (const line of lines) this._record(stream, line);
    };
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.on('error', (error) => {
      this._record('stderr', `[spawn-error] ${String(error?.message ?? error)}`);
    });
    child.on('exit', (code, signal) => {
      this.partials.stdout = '';
      this.partials.stderr = '';
      this._record('stdout', `[exit] code=${code === null ? 'null' : code} signal=${signal ?? 'null'}`);
      this.lastExit = { code, signal: signal ?? null, at: now() };
      if (this.child === child) this.child = null;
      this._log('info', `vrchat_player: child exited (code=${code}, signal=${signal})`);
      // 只对"确实启动成功过"的子进程跑看门狗（spawn 失败时的临时 child 不算）
      if (child._vpStarted === true) this._onChildExit(code, signal);
    });
  }

  // ── 看门狗 ────────────────────────────────────────────────────────────────
  _cancelWatchdogTimer() {
    if (this._wd.timer !== null) {
      clearTimeout(this._wd.timer);
      this._wd.timer = null;
    }
  }

  /** 丢弃窗口外的重启记录（滚动窗口）。 */
  _purgeRestartWindow() {
    if (this._wd.restartTimes.length === 0) return;
    const cutoff = now() - this.watchdog.windowMs;
    this._wd.restartTimes = this._wd.restartTimes.filter((at) => at > cutoff);
  }

  /** 是否属于"正常跑完 --seconds 时长"（留 3s 余量）。 */
  _isNormalCompletion() {
    const seconds = this._plannedSeconds;
    const startedAt = this.info?.startedAt;
    if (!Number.isFinite(seconds) || !Number.isFinite(startedAt)) return false;
    return now() >= startedAt + seconds * 1000 - 3000;
  }

  /** 子进程退出后的看门狗决策：主动 stop / 正常到时 / 重启 / 用尽。 */
  _onChildExit(code, signal) {
    const wd = this._wd;
    if (wd.suppress) {
      wd.reason = 'stopped';
      return;
    }
    if (!this.watchdog.enabled) {
      wd.reason = 'disabled';
      return;
    }
    if (this._isNormalCompletion()) {
      // 正常跑完 --seconds：不重启
      wd.reason = 'completed';
      this._record('stdout', '[watchdog] 正常到时退出，不重启');
      return;
    }
    this._purgeRestartWindow();
    if (wd.restartTimes.length >= this.watchdog.maxRestarts) {
      wd.exhausted = true;
      wd.reason = 'exhausted';
      this._record('stderr', `[watchdog] 重启预算用尽（${this.watchdog.maxRestarts} 次 / ${Math.round(this.watchdog.windowMs / 1000)}s），不再自动重启`);
      this._log('warn', `vrchat_player: watchdog exhausted after ${this.watchdog.maxRestarts} restarts — giving up`);
      return;
    }
    const attempt = wd.restartTimes.length + 1;
    wd.restartTimes.push(now());
    wd.lastRestartAt = now();
    wd.reason = 'restarted';
    const backoffMs = this.watchdog.backoffMs;
    this._record('stdout', `[watchdog] 非正常退出 code=${code} signal=${signal ?? 'null'}；${backoffMs}ms 后 restart #${attempt}`);
    this._log('warn', `vrchat_player: unexpected exit (code=${code}, signal=${signal}) — restart #${attempt} in ${backoffMs}ms`);
    wd.timer = setTimeout(() => {
      wd.timer = null;
      this._restartFromWatchdog(attempt).catch(() => {});
    }, backoffMs);
  }

  /** 看门狗触发的内部重启：复用最近一次 start 参数，成功后追加日志、更新 info。 */
  async _restartFromWatchdog(attempt) {
    if (this._wd.suppress) return;
    this._restarting = true;
    try {
      await this.start(this._lastStartOptions ?? {});
      this._wd.reason = 'restarted';
      this._wd.lastRestartAt = now();
      this._record('stdout', `[watchdog] restart #${attempt}${this.info?.pid ? ` pid=${this.info.pid}` : ''}`);
      this._log('info', `vrchat_player: watchdog restarted #${attempt} pid=${this.info?.pid ?? '?'}`);
    } catch (error) {
      this._wd.exhausted = true;
      this._wd.reason = 'restart-failed';
      this._record('stderr', `[watchdog] restart #${attempt} failed: ${String(error?.message ?? error)}`);
      this._log('error', `vrchat_player: watchdog restart #${attempt} failed — ${String(error?.message ?? error)}`);
    } finally {
      this._restarting = false;
    }
  }

  /** 启动玩家 demo.mjs；已运行则返回 alreadyRunning（不重复启动）。 */
  async start(options = {}) {
    if (this.running) {
      return {
        action: 'start',
        started: false,
        alreadyRunning: true,
        pid: this.child.pid,
        monitorUrl: `http://127.0.0.1:${this.info.monitorPort}/`,
        args: [...this.info.args],
        cwd: this.info.cwd,
      };
    }
    // 用户手动 start（非看门狗内部重启）：视为新会话，重置看门狗窗口与抑制标记
    if (!this._restarting) {
      this._cancelWatchdogTimer();
      this._wd.suppress = false;
      this._wd.exhausted = false;
      this._wd.reason = this.watchdog.enabled ? null : 'disabled';
      this._wd.restartTimes = [];
      this._wd.lastRestartAt = null;
    }
    const { demoPath, playerNode, playerDir, tried } = this.paths;
    if (!existsSync(demoPath)) {
      throw new Error(
        `vrchat_player: demo not found at ${demoPath}（检查插件配置 playerDir；已尝试：${(tried ?? [demoPath]).join(' | ')}）`,
      );
    }
    // 监视器端口一定要显式传给 demo（--port），否则 demo 用默认 8765、status 却去问配置里的端口，会永远读不到 /state
    const monitorPort = clampInt(options.monitorPort, 1, 65_535, this.defaultMonitorPort);
    const args = buildDemoArgs({ ...options, monitorPort });
    let child;
    try {
      child = this.spawnImpl(playerNode, [demoPath, ...args], {
        cwd: playerDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (error) {
      throw new Error(`vrchat_player: spawn failed — ${String(error?.message ?? error)}`);
    }
    this._attach(child);
    // 等 spawn 成功/失败（ENOENT 之类的错误是异步事件）
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const timer = setTimeout(() => finish(resolve), 1500);
        child.once('spawn', () => { child._vpStarted = true; finish(resolve); });
        child.once('error', (error) => finish(() => reject(error)));
      });
    } catch (error) {
      try { child.kill(); } catch { /* ignore */ }
      throw new Error(`vrchat_player: cannot start ${playerNode} — ${String(error?.message ?? error)}`);
    }
    this.child = child;
    this.lines = [];
    this.lastExit = null;
    this.partials = { stdout: '', stderr: '' };
    this.info = {
      pid: child.pid ?? null,
      startedAt: now(),
      args: [playerNode, demoPath, ...args],
      monitorPort,
      cwd: playerDir,
      node: playerNode,
      demoPath,
    };
    // 看门狗用：重启时复用参数；--seconds 用于判断"正常跑完"
    this._lastStartOptions = { ...options };
    const plannedSeconds = Number(argValue(args, '--seconds'));
    this._plannedSeconds = Number.isFinite(plannedSeconds) && plannedSeconds > 0 ? plannedSeconds : null;
    this._record('stdout', `[start] ${playerNode} ${demoPath} ${args.join(' ')}`);
    this._log('info', `vrchat_player: started pid=${child.pid} args=${args.join(' ')}`);
    return {
      action: 'start',
      started: true,
      pid: child.pid ?? null,
      monitorUrl: `http://127.0.0.1:${monitorPort}/`,
      args: [...this.info.args],
      cwd: playerDir,
      startedAt: this.info.startedAt,
    };
  }

  /** 停止子进程：先 SIGTERM，Windows 上没退再 taskkill /PID /T /F。 */
  async stop(options = {}) {
    // 用户主动停止：置抑制标记，取消退避中的看门狗重启，绝不自动拉起
    this._wd.suppress = true;
    this._wd.reason = 'stopped';
    this._cancelWatchdogTimer();
    const child = this.child;
    if (child === null || !this.running) {
      return {
        action: 'stop',
        stopped: false,
        reason: this.info === null ? 'never-started' : 'not-running',
        exit: this.lastExit,
        lastLines: this.log({ lines: 20 }).lines,
      };
    }
    const pid = child.pid;
    const startedAt = this.info?.startedAt ?? now();
    const waitExit = (timeoutMs) => new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
    let forced = false;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    let exited = await waitExit(Math.max(300, options.graceMs ?? 1200));
    if (!exited && process.platform === 'win32') {
      forced = true;
      try {
        this.spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* ignore */ }
      exited = await waitExit(2500);
    }
    if (!exited) {
      forced = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      exited = await waitExit(1500);
    }
    const exit = this.lastExit ?? { code: null, signal: null, at: now() };
    const uptimeMs = Math.max(0, exit.at - startedAt);
    this._log('info', `vrchat_player: stopped pid=${pid} forced=${forced} code=${exit.code}`);
    return {
      action: 'stop',
      stopped: exited,
      forced,
      pid,
      exitCode: exit.code,
      signal: exit.signal,
      uptimeMs,
      lastLines: this.log({ lines: 20 }).lines,
    };
  }

  /** 只读状态：子进程 + 监视器 /health、/state（超时/失败只降级）。 */
  async status(options = {}) {
    const running = this.running;
    const pid = running ? this.child.pid : (this.info?.pid ?? null);
    const startedAt = this.info?.startedAt ?? null;
    const monitorPort = clampInt(
      options.monitorPort ?? this.info?.monitorPort,
      1,
      65_535,
      this.defaultMonitorPort,
    );
    const monitorUrl = `http://127.0.0.1:${monitorPort}/`;
    const uptimeMs = startedAt === null
      ? 0
      : (running ? now() - startedAt : Math.max(0, (this.lastExit?.at ?? now()) - startedAt));

    let health = null;
    let state = null;
    let monitorError = null;
    try {
      health = await fetchJson(`${monitorUrl}health`, this.monitorTimeoutMs);
    } catch (error) {
      monitorError = describeMonitorError(error, this.monitorTimeoutMs);
    }
    try {
      state = await fetchJson(`${monitorUrl}state`, this.monitorTimeoutMs);
    } catch (error) {
      if (monitorError === null) monitorError = describeMonitorError(error, this.monitorTimeoutMs);
    }
    const summary = summarizePlayerState(state);
    return {
      action: 'status',
      running,
      pid,
      uptimeMs,
      startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
      monitorUrl,
      monitor: {
        ok: health !== null || state !== null,
        url: monitorUrl,
        health,
        state: summary,
        error: monitorError,
      },
      args: this.info?.args ?? [],
      cwd: this.info?.cwd ?? this.paths.playerDir,
      // 看门狗：自动重启预算 / 最近一次重启 / 是否已放弃
      watchdog: (() => {
        this._purgeRestartWindow();
        const wd = this._wd;
        return {
          enabled: this.watchdog.enabled,
          restarts: wd.restartTimes.length,
          maxRestarts: this.watchdog.maxRestarts,
          lastRestartAt: wd.lastRestartAt === null ? null : new Date(wd.lastRestartAt).toISOString(),
          exhausted: wd.exhausted,
          reason: wd.reason,
        };
      })(),
      // 玩家程序装在哪 / 从哪个候选找到的（小白排障用）
      paths: {
        root: this.paths.playerDir,
        source: this.paths.source,
        demoPath: this.paths.demoPath,
      },
      exit: this.lastExit,
      lastLines: this.log({ lines: 20 }).lines,
    };
  }

  /** 最近 N 行输出（stdout/stderr 混合，按时间顺序）。 */
  log(options = {}) {
    const requested = clampInt(options.lines, 1, this.lineBufferSize, 40);
    const tail = this.lines.slice(-requested);
    return {
      action: 'log',
      lines: tail.map((entry) => (entry.stream === 'stderr' ? `[err] ${entry.text}` : entry.text)),
      count: tail.length,
      bufferSize: this.lineBufferSize,
      totalBuffered: this.lines.length,
    };
  }

  /** 实机前体检：spawn preflight.mjs 并返回输出摘要。 */
  async runPreflight(options = {}) {
    const { preflightPath, playerNode, playerDir, tried } = this.paths;
    if (!existsSync(preflightPath)) {
      throw new Error(
        `vrchat_player_preflight: preflight not found at ${preflightPath}（检查插件配置 playerDir；已尝试：${(tried ?? [preflightPath]).join(' | ')}）`,
      );
    }
    const result = await runNodeCapture(playerNode, preflightPath, {
      cwd: playerDir,
      timeoutMs: options.timeoutMs ?? this.preflightTimeoutMs,
      maxLines: options.maxLines ?? 200,
    });
    return {
      action: 'preflight',
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      lines: result.lines.slice(-40),
      output: result.output.length > 6000 ? `${result.output.slice(-6000)}\n…(truncated)` : result.output,
    };
  }

  /** 插件卸载：不等待优雅退出，尽快杀掉子进程（包括进程树）。 */
  dispose() {
    // 用户主动卸载：抑制看门狗，取消待执行的重启
    this._wd.suppress = true;
    this._wd.reason = 'stopped';
    this._cancelWatchdogTimer();
    const child = this.child;
    if (child === null) return;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    if (process.platform === 'win32' && child.pid !== undefined) {
      try {
        // 用注入的 spawnImpl（测试里是假 spawn；真实环境就是 child_process.spawn）
        this.spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* ignore */ }
    }
    this.child = null;
  }
}
