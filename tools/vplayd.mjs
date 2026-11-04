#!/usr/bin/env node
// vplayd.mjs — 独立 daemon：不启动 DSH，也能起本地按钮控制台（默认 http://127.0.0.1:8790/）。
//
// 为什么这么薄：19 个 vrchat_* 工具、12 个面板动作、UDP/HTTP 通道全部在 index.js + lib/ 里；
// lib/host-shim.mjs 用假宿主跑一遍 index.js 的 apply() 就能拿到同一套工具定义，并让面板
// （config.panelEnabled:true 时由 apply() 内部自己启动）随 daemon 一起起来。
// 这一层只负责：解析参数 → 起 toolset → 等面板 HTTP 真的可用 → 打印摘要 → 常驻/优雅退出。
// 不重写面板、不复制 action 接线（面板动作与 DSH 里看到的完全一致）。
//
// 零 npm 依赖；Node ≥ 20（实测 v24）；Windows / POSIX 通用；只绑回环地址。
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { createToolset } from '../lib/host-shim.mjs';

const PANEL_DEFAULT_PORT = 8790;
const PANEL_DEFAULT_HOST = '127.0.0.1';
const PANEL_READY_TIMEOUT_MS = 8000;
const PANEL_READY_POLL_MS = 150;
const STATUS_TIMEOUT_MS = 1500;
const SHUTDOWN_FALLBACK_MS = 500;
const EXPECTED_TOOL_COUNT = 19;
const PANEL_ACTION_TOTAL = 12;

const HELP_TEXT = [
  'vplayd — 独立 daemon：不启动 DSH 也能用 VRChat 虚拟玩家（本地面板 + HTTP 动作接口）',
  '',
  '用法：',
  '  node tools/vplayd.mjs                    # 起面板（默认 127.0.0.1:8790），Ctrl+C 退出',
  '  node tools/vplayd.mjs --self-check       # 只检查工具集与体检结果，然后退出',
  '  node tools/vplayd.mjs --help             # 打印本帮助',
  '',
  '选项：',
  '  --panel-port <端口>       面板 HTTP 端口（默认 8790）',
  '  --panel-host <地址>       面板绑定地址（默认 127.0.0.1；只允许回环：127.0.0.1 / localhost / ::1）',
  '  --send-port <端口>        VRChat OSC 发送端口（默认 9000）',
  '  --listen-port <端口>      VRChat OSC 反向监听端口（默认 9001）',
  '  --listen-enabled          启用 OSC 反向监听（默认开启）',
  '  --no-listen               关闭 OSC 反向监听（只发送；和 DSH 插件同时跑时避免 9001 冲突）',
  '  --player-dir <目录>       玩家工程 player/ 的父目录（默认自动探测：插件自带 player/ → 兄弟工程 → 旧路径）',
  '  --player-node <可执行>    跑玩家进程的 Node（默认 node）',
  '  --monitor-port <端口>     玩家监视器端口（默认 8765）',
  "  --config '<json>'         覆盖 index.js 插件配置（JSON 对象，如 '{\"sendPort\":19030}'）",
  '  --self-check              只建工具集，打印 19 个工具名与 doctor verdict 后退出（不占端口、不留进程）',
  '  --exit-on-stdin-close     测试/脚本用：stdin 关闭时优雅退出（退出码 0）',
  '  -h, --help                打印本帮助并退出 0',
  '',
  '环境变量：',
  '  VPLAY_CONFIG   与 --config 同格式的 JSON。优先级：内置默认值 < VPLAY_CONFIG < --config < 单项参数',
  '',
  '示例：',
  '  node tools/vplayd.mjs',
  '  node tools/vplayd.mjs --panel-port 8791 --no-listen',
  "  node tools/vplayd.mjs --config '{\"playerDir\":\"D:/tmp/vrchat-vr-driver\",\"playerMonitorPort\":18770}'",
  '',
  '面板起来后浏览器打开输出的 URL 即可；所有按钮等价于 POST /api/action {"name":"...","args":{...}}。',
].join('\n');

/** 参数/配置错误：退出码 2（用法问题），与运行期失败（1）区分。 */
class ConfigError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function print(text = '') {
  process.stdout.write(`${text}\n`);
}

function describeError(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}

/** 1..65535 的整数端口；给错误信息带上参数名。 */
function parsePort(key, value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new ConfigError(`${key} 必须是整数端口（1..65535），收到：${JSON.stringify(value)}`);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`${key} 超出范围（1..65535）：${text}`);
  }
  return port;
}

/** 解析一个 JSON 配置层（VPLAY_CONFIG 或 --config）；必须是对象。 */
function loadJsonLayer(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${label} 不是合法 JSON：${describeError(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${label} 必须是 JSON 对象，例如 {"sendPort":19030}`);
  }
  return value;
}

const NUMBER_OPTIONS = new Map([
  ['--panel-port', 'panelPort'],
  ['--send-port', 'sendPort'],
  ['--listen-port', 'listenPort'],
  ['--monitor-port', 'playerMonitorPort'],
]);

const STRING_OPTIONS = new Map([
  ['--panel-host', 'panelHost'],
  ['--player-dir', 'playerDir'],
  ['--player-node', 'playerNode'],
]);

/**
 * 解析命令行。布尔参数不接受 `=值`；字符串/数字参数支持 `--key value` 与 `--key=value`。
 * @returns {{help:boolean, selfCheck:boolean, exitOnStdinClose:boolean,
 *            overrides:object, configLayers:object[], errors:string[]}}
 */
function parseArgv(argv) {
  const parsed = {
    help: false,
    selfCheck: false,
    exitOnStdinClose: false,
    overrides: {},
    configLayers: [],
    errors: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    let token = argv[index];
    if (typeof token !== 'string' || token.length === 0) {
      parsed.errors.push('收到空参数');
      continue;
    }
    if (token === '-h') token = '--help';
    if (!token.startsWith('--')) {
      parsed.errors.push(`未知参数：${token}`);
      continue;
    }
    let key = token;
    let inline;
    const equalsAt = token.indexOf('=');
    if (equalsAt !== -1) {
      key = token.slice(0, equalsAt);
      inline = token.slice(equalsAt + 1);
    }
    const takeValue = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        parsed.errors.push(`${key} 需要一个值`);
        return undefined;
      }
      index += 1;
      return next;
    };
    const requireNoValue = () => {
      if (inline !== undefined) {
        parsed.errors.push(`${key} 是开关参数，不接受值（收到 ${inline}）`);
        return false;
      }
      return true;
    };

    if (key === '--help') {
      if (requireNoValue()) parsed.help = true;
      continue;
    }
    if (key === '--self-check') {
      if (requireNoValue()) parsed.selfCheck = true;
      continue;
    }
    if (key === '--exit-on-stdin-close') {
      if (requireNoValue()) parsed.exitOnStdinClose = true;
      continue;
    }
    if (key === '--listen-enabled') {
      if (requireNoValue()) parsed.overrides.listenEnabled = true;
      continue;
    }
    if (key === '--no-listen') {
      if (requireNoValue()) parsed.overrides.listenEnabled = false;
      continue;
    }
    if (key === '--config') {
      const value = takeValue();
      if (value !== undefined) {
        try {
          parsed.configLayers.push(loadJsonLayer(value, '--config'));
        } catch (error) {
          parsed.errors.push(describeError(error));
        }
      }
      continue;
    }
    if (NUMBER_OPTIONS.has(key)) {
      const value = takeValue();
      if (value !== undefined) {
        try {
          parsed.overrides[NUMBER_OPTIONS.get(key)] = parsePort(key, value);
        } catch (error) {
          parsed.errors.push(describeError(error));
        }
      }
      continue;
    }
    if (STRING_OPTIONS.has(key)) {
      const value = takeValue();
      if (value !== undefined) parsed.overrides[STRING_OPTIONS.get(key)] = value;
      continue;
    }
    parsed.errors.push(`未知参数：${key}`);
  }
  return parsed;
}

/**
 * 合并配置：内置默认（面板开） → VPLAY_CONFIG → --config（按出现顺序） → 单项参数。
 * 只做参数级校验/归一化，业务默认值仍由 index.js 的 resolveOptions() 决定。
 */
function resolveConfig(parsed, env = process.env) {
  let config = { panelEnabled: true };
  const envText = typeof env.VPLAY_CONFIG === 'string' ? env.VPLAY_CONFIG.trim() : '';
  if (envText.length > 0) config = { ...config, ...loadJsonLayer(envText, 'VPLAY_CONFIG') };
  for (const layer of parsed.configLayers) config = { ...config, ...layer };
  config = { ...config, ...parsed.overrides };

  // 面板只允许回环地址（和 lib/panel.mjs 的安全约束一致；localhost 归一成 127.0.0.1 避免 IPv6 歧义）。
  let host = typeof config.panelHost === 'string' ? config.panelHost.trim() : PANEL_DEFAULT_HOST;
  if (host.length === 0 || host === 'localhost') host = PANEL_DEFAULT_HOST;
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new ConfigError(`panelHost 只允许回环地址（127.0.0.1 / localhost / ::1），收到：${host}`);
  }
  config.panelHost = host;
  if (config.panelPort === undefined) config.panelPort = PANEL_DEFAULT_PORT;
  config.panelPort = parsePort('panelPort', config.panelPort);
  for (const key of ['sendPort', 'listenPort', 'playerMonitorPort']) {
    if (config[key] !== undefined) config[key] = parsePort(key, config[key]);
  }
  if (config.playerDir !== undefined && typeof config.playerDir !== 'string') {
    throw new ConfigError('playerDir 必须是字符串路径（可为空 = 自动探测）');
  }
  if (config.playerNode !== undefined && (typeof config.playerNode !== 'string' || config.playerNode.trim().length === 0)) {
    throw new ConfigError('playerNode 必须是非空字符串（可执行名或绝对路径）');
  }
  return config;
}

/** 面板 URL（IPv6 回环要加方括号）。 */
function panelUrlFor(host, port) {
  return host === '::1' ? `http://[::1]:${port}/` : `http://${host}:${port}/`;
}

/** 只读 GET + JSON 解析（带硬超时，不用 fetch 避免 undici 的 keep-alive 残留）。 */
function httpGetJson(url, timeoutMs = STATUS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => finish(reject, Object.assign(new Error(`HTTP 请求超时（>${timeoutMs}ms）`), { code: 'ETIMEDOUT' })), timeoutMs);
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          finish(reject, new Error(`HTTP ${response.statusCode}：${text.slice(0, 200)}`));
          return;
        }
        try {
          finish(resolve, JSON.parse(text));
        } catch (error) {
          finish(reject, error);
        }
      });
      response.on('error', (error) => finish(reject, error));
    });
    request.on('error', (error) => finish(reject, error));
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP 请求超时（>${timeoutMs}ms）`)));
  });
}

/** 用 Promise.race 给任意 promise 加超时（超时抛错，原 promise 的拒绝被吞掉不产生 unhandledRejection）。 */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（>${timeoutMs}ms）`)), timeoutMs);
  });
  const wrapped = Promise.resolve(promise);
  wrapped.catch(() => {});
  return Promise.race([wrapped, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// ── 插件日志：index.js 通过 ctx.logger 说话，这里统一加前缀写 stdout ─────────────────

/** apply()/dispose() 里已知无害的噪音（从未初始化 VMT 时释放手柄会 warn），不打扰用户。 */
function isBenignPluginLog(message) {
  const text = String(message ?? '');
  return /^vmt: failed to release (left|right) — vmt: client is not started/.test(text);
}

function createLogger() {
  return {
    info: (message) => print(`[插件] ${message}`),
    warn: (message) => {
      if (!isBenignPluginLog(message)) print(`[插件警告] ${message}`);
    },
    error: (message) => print(`[插件错误] ${message}`),
    debug: () => {},
  };
}

// ── 网络探测 ────────────────────────────────────────────────────────────────────

/** 试着 bind 一下目标端口，判断是否已被占用（bind 成功立即 close）。 */
function probeTcpBind(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ free: false, code: String(error?.code ?? error) }));
    server.listen(port, host, () => {
      server.close(() => resolve({ free: true }));
    });
  });
}

function describeNetError(error) {
  const code = String(error?.code ?? '');
  if (code === 'ECONNREFUSED') return '连接被拒绝（该端口没有进程监听）';
  if (code === 'ECONNRESET') return '连接被重置';
  if (code === 'ETIMEDOUT') return '连接超时';
  return describeError(error);
}

/** 轮询 GET /api/status 直到 ok=true 且端口一致（面板由 apply() 异步启动，必须真探测而不是假设成功）。 */
async function waitPanelReady(baseUrl, port, timeoutMs, isAborting) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = '还没有响应';
  while (Date.now() < deadline) {
    if (isAborting()) return { ok: false, aborted: true, error: lastReason };
    try {
      const payload = await httpGetJson(`${baseUrl}api/status`, STATUS_TIMEOUT_MS);
      if (payload !== null && payload.ok === true) {
        const actualPort = payload.panel?.port;
        if (actualPort === port) return { ok: true, payload };
        lastReason = `面板报告端口 ${actualPort}，和期望的 ${port} 不一致`;
      } else {
        lastReason = '/api/status 返回 ok=false';
      }
    } catch (error) {
      lastReason = describeNetError(error);
    }
    await sleep(PANEL_READY_POLL_MS);
  }
  return { ok: false, error: lastReason };
}

function printPanelFailure(host, port, ready) {
  const url = panelUrlFor(host, port);
  print('');
  print(`[错误] 面板在 ${PANEL_READY_TIMEOUT_MS / 1000} 秒内没有就绪：${url}api/status`);
  print(`        最后一次探测结果：${ready.error ?? '无响应'}`);
  print('  可能原因：');
  print(`    · 端口 ${host}:${port} 在这几秒里被别的进程抢占了（启动预检时还是空闲的）`);
  print('    · index.js 的 apply() 内部异常，面板没能起来（看上面的插件日志）');
  print('  建议：');
  print(`    1) 换一个端口：node tools/vplayd.mjs --panel-port ${port + 1}`);
  print(`    2) 查占用者（PowerShell）：Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess`);
  print('    3) DSH 插件自带的面板也绑 8790；同一端口只能留一方，见 docs/DAEMON.md「和 DSH 插件同时跑」');
}

// ── 启动摘要用到的两条只读信息 ──────────────────────────────────────────────────

/** 通过 vrchat_status 工具读 bridge 状态（含 listening / listenError / 端口）。 */
async function readBridgeState(toolset, config) {
  const listenEnabled = config.listenEnabled !== false;
  const deadline = Date.now() + (listenEnabled ? 2000 : 0);
  let state = null;
  let lastError = null;
  for (;;) {
    try {
      state = await withTimeout(toolset.call('vrchat_status', {}), 3000, 'vrchat_status');
    } catch (error) {
      lastError = describeError(error);
      state = null;
    }
    if (state !== null && (!listenEnabled || state.listening === true || state.listenError !== null)) break;
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  return { state, error: lastError };
}

/** 跑一次只读体检（有超时兜底；失败不阻止 daemon 启动，只在摘要里说明）。 */
async function readDoctor(toolset, config) {
  const budget = Number(config.doctorTimeoutMs) > 0 ? Number(config.doctorTimeoutMs) : 9000;
  const timeoutMs = Math.min(60_000, Math.max(3000, budget + 3000));
  try {
    const result = await withTimeout(toolset.call('vrchat_doctor', {}), timeoutMs, 'vrchat_doctor');
    if (result === null || typeof result !== 'object') return { ok: false, verdict: 'unknown', summary: {}, nextSteps: ['doctor 返回空结果'] };
    return result;
  } catch (error) {
    return {
      ok: false,
      verdict: 'unknown',
      summary: { chat: false, pose: false, player: false },
      nextSteps: [`体检失败：${describeError(error)}`],
    };
  }
}

function printStartupSummary({ config, toolset, panelPayload, panelUrl, bridge, doctor }) {
  const actions = panelPayload?.actions !== null && typeof panelPayload?.actions === 'object' ? panelPayload.actions : {};
  const actionCount = Object.keys(actions).length;
  const state = bridge?.state ?? null;
  const sendPort = state?.sendPort ?? config.sendPort ?? 9000;
  const listenPort = state?.listenPort ?? config.listenPort ?? 9001;
  const listenEnabled = config.listenEnabled !== false;
  const monitorPort = config.playerMonitorPort ?? 8765;
  const playerDir = typeof config.playerDir === 'string' && config.playerDir.length > 0 ? config.playerDir : '(自动探测)';
  const summary = doctor?.summary !== null && typeof doctor?.summary === 'object' ? doctor.summary : {};

  const listeningText = listenEnabled
    ? (state !== null && state.listening === true ? 'listening=true' : (state?.listenError ? '监听失败' : 'listening=false'))
    : '已关闭';
  const toolCount = toolset.tools.size;

  print('');
  print('vplayd 启动完成（独立 daemon · 不依赖 DSH）');
  print(`  面板      ${panelUrl} · action ${actionCount}/${PANEL_ACTION_TOTAL}`);
  print(`  OSC       ${state?.host ?? '127.0.0.1'} · 发送 ${sendPort} · 监听 ${listenEnabled ? `${listenPort}（${listeningText}）` : `已关闭（--no-listen）`}`);
  print(`  工具      ${toolCount} 个（vrchat_*）· playerDir=${playerDir}`);
  print(`  玩家      未运行 · 监视器 http://127.0.0.1:${monitorPort}/`);
  print(`  体检      verdict=${doctor?.verdict ?? 'unknown'}（chat=${Boolean(summary.chat)} pose=${Boolean(summary.pose)} player=${Boolean(summary.player)}）`);
  const nextStep = Array.isArray(doctor?.nextSteps) ? doctor.nextSteps[0] : null;
  if (typeof nextStep === 'string' && nextStep.length > 0) print(`            下一步：${nextStep}`);
  if (state?.listenError) {
    print(`  [提示] OSC 反向监听失败：${state.listenError}（发送仍可用；换 --listen-port 或别和 DSH 插件同时监听）`);
  }
  if (actionCount !== PANEL_ACTION_TOTAL) {
    print(`  [警告] 面板只接了 ${actionCount}/${PANEL_ACTION_TOTAL} 个动作，可能插件版本不一致`);
  }
  if (toolCount !== EXPECTED_TOOL_COUNT) {
    print(`  [警告] 工具数 ${toolCount}，期望 ${EXPECTED_TOOL_COUNT}；可能插件版本不一致`);
  }
  print('');
  print('  浏览器打开上面的面板地址即可（所有按钮都走 POST /api/action）。');
  print('  退出：本窗口 Ctrl+C；脚本拉起时可用 --exit-on-stdin-close（stdin 关闭 = 优雅退出）。');
  print('        POSIX 上 SIGTERM 也会优雅退出；Windows 上 SIGTERM 是强制终止（Node/libuv 限制，见 docs/DAEMON.md）。');
}

// ── 退出路径 ────────────────────────────────────────────────────────────────────

async function finishShutdown(state, exitCode) {
  // 先趁面板还活着拿一次统计（拿不到就跳过）。
  try {
    const payload = await withTimeout(httpGetJson(`${state.panelUrl}api/status`, 600), 800, '面板统计');
    const stats = payload?.panel?.stats;
    if (stats !== null && typeof stats === 'object') {
      print(`  面板请求 ${stats.requests} · 动作 ${stats.actions} · 错误 ${stats.errors}`);
    }
  } catch {
    // 面板已关/无响应都正常，退出路径不抛。
  }
  print('  已释放：面板 HTTP / OSC socket / VMT·头追 socket / 手柄 / 玩家子进程（如有）');
  try {
    state.toolset?.dispose();
  } catch (error) {
    print(`  [警告] dispose 出错：${describeError(error)}`);
  }
  print('vplayd 已退出');
  process.exitCode = exitCode;
  // dispose() 里的异步关闭（面板 server.close）通常几毫秒就完；兜底 500ms 强制退出，保证不会挂住。
  const fallback = setTimeout(() => process.exit(exitCode), SHUTDOWN_FALLBACK_MS);
  fallback.unref?.();
}

function shutdown(state, reason, exitCode = 0) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  const uptimeSeconds = (Date.now() - state.startedAt) / 1000;
  print('');
  print(`vplayd 正在退出（${reason}）`);
  print(`  运行 ${uptimeSeconds.toFixed(1)} 秒`);
  void finishShutdown(state, exitCode);
}

/** 捕获信号/未处理异常；Ctrl+C 在 Windows 控制台会走 SIGINT。 */
function installLifecycleHandlers(state) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => shutdown(state, signal, 0));
    } catch {
      // 某些平台没有该信号，忽略。
    }
  }
  process.on('uncaughtException', (error) => {
    print(`[错误] 未捕获异常：${error?.stack ?? describeError(error)}`);
    shutdown(state, 'uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    print(`[错误] 未处理的 Promise 拒绝：${reason?.stack ?? describeError(reason)}`);
    shutdown(state, 'unhandledRejection', 1);
  });
  if (state.exitOnStdinClose) {
    // 测试/脚本拉起时的优雅退出通道：父进程关闭 stdin → 'end' → 和 SIGINT 走同一个 shutdown()。
    try {
      process.stdin.resume();
      process.stdin.on('end', () => shutdown(state, 'stdin 关闭', 0));
      process.stdin.on('error', () => {});
    } catch {
      // stdin 不可读时忽略。
    }
  }
}

async function disposeToolsetQuietly(toolset) {
  try {
    toolset?.dispose();
  } catch {
    // 退出路径不抛。
  }
}

// ── 两种运行模式 ────────────────────────────────────────────────────────────────

/** --self-check：只建工具集，打印 19 个工具名 + doctor verdict；不占端口、不留进程。 */
async function runSelfCheck({ config }) {
  // 刻意禁掉面板与反向监听：self-check 不碰任何端口，避免和 DSH 插件/vplayd 实例抢 8790/9001。
  const checkConfig = { ...config, panelEnabled: false, listenEnabled: false };
  let toolset = null;
  try {
    toolset = createToolset({ config: checkConfig, logger: createLogger() });
  } catch (error) {
    print(`[错误] 创建工具集失败：${describeError(error)}`);
    return 1;
  }
  try {
    const names = [...toolset.tools.keys()].sort();
    print('vplayd self-check（只建工具集；不启面板、不监听端口）');
    print(`  配置      面板 ${checkConfig.panelHost}:${checkConfig.panelPort}（self-check 不启动）· OSC 发送 ${checkConfig.sendPort ?? 9000} · 反向监听 ${checkConfig.listenPort ?? 9001}（self-check 不启动）· 监视器 ${checkConfig.playerMonitorPort ?? 8765} · playerDir=${checkConfig.playerDir || '(自动探测)'}`);
    print(`  工具      ${names.length}/${EXPECTED_TOOL_COUNT}`);
    for (const name of names) print(`    · ${name}`);
    const doctor = await readDoctor(toolset, checkConfig);
    const summary = doctor.summary !== null && typeof doctor.summary === 'object' ? doctor.summary : {};
    print(`  体检      verdict=${doctor.verdict ?? 'unknown'}（chat=${Boolean(summary.chat)} pose=${Boolean(summary.pose)} player=${Boolean(summary.player)}）`);
    if (Array.isArray(doctor.nextSteps)) {
      for (const step of doctor.nextSteps.slice(0, 3)) print(`    → ${step}`);
    }
    print('self-check 完成：退出 0（未留下监听端口 / 子进程）');
    return names.length === EXPECTED_TOOL_COUNT ? 0 : 1;
  } catch (error) {
    print(`[错误] self-check 失败：${describeError(error)}`);
    return 1;
  } finally {
    await disposeToolsetQuietly(toolset);
  }
}

/** 正常 daemon：预检端口 → createToolset（面板由 apply() 起）→ 等 HTTP 就绪 → 摘要 → 常驻。 */
async function runDaemon({ config, parsed }) {
  const logger = createLogger();
  const panelPort = config.panelPort ?? PANEL_DEFAULT_PORT;
  const panelHost = config.panelHost ?? PANEL_DEFAULT_HOST;
  const panelUrl = panelUrlFor(panelHost, panelPort);
  const state = {
    startedAt: Date.now(),
    shuttingDown: false,
    toolset: null,
    panelUrl,
    exitOnStdinClose: parsed.exitOnStdinClose === true,
  };

  // vplayd 的存在意义就是面板；显式关掉面板等于没有控制台，这里忽略并说明（无面板场景用 --self-check）。
  if (config.panelEnabled !== true) {
    print('[提示] vplayd 依赖面板，已忽略 panelEnabled=false（不需要面板请用 --self-check）');
  }
  config.panelEnabled = true;

  if (typeof config.playerDir === 'string' && config.playerDir.length > 0 && !existsSync(config.playerDir)) {
    print(`[提示] playerDir 不存在：${config.playerDir}（面板与 OSC 仍可用；玩家监视器/体检会降级）`);
  }

  // 1) 端口预检：抢先给出明确错误（apply() 内部面板失败只会 warn，不能让它"静默成功"）。
  const probe = await probeTcpBind(panelHost, panelPort);
  if (probe.free !== true) {
    print('');
    print(`[错误] 面板端口 ${panelHost}:${panelPort} 已被占用（${probe.code}）`);
    print('  可能原因：');
    print('    · DSH 插件自带的面板正在跑（插件启用时自动开 8790）');
    print('    · 已经有一个 vplayd 实例');
    print('  建议：');
    print(`    1) 换端口：node tools/vplayd.mjs --panel-port ${panelPort + 1}`);
    print(`    2) 查占用者（PowerShell）：Get-NetTCPConnection -LocalPort ${panelPort} | Select-Object OwningProcess`);
    print('    3) 只想用 vplayd：在 DSH 的 cordis.patch.yml 里把 panelEnabled 设为 false 后重载插件');
    return 1;
  }

  // 2) 建工具集；index.js 的 apply() 在 panelEnabled:true 时会自己把面板起起来。
  try {
    state.toolset = createToolset({ config, logger });
  } catch (error) {
    print(`[错误] 创建工具集失败：${describeError(error)}`);
    return 1;
  }
  installLifecycleHandlers(state);

  // 3) 等面板真的可用（最多 ~8s）。以 HTTP 探测为准，不信任 apply() 内部的异步启动。
  const ready = await waitPanelReady(panelUrl, panelPort, PANEL_READY_TIMEOUT_MS, () => state.shuttingDown);
  if (state.shuttingDown) {
    await disposeToolsetQuietly(state.toolset);
    return 0;
  }
  if (ready.ok !== true) {
    printPanelFailure(panelHost, panelPort, ready);
    await disposeToolsetQuietly(state.toolset);
    return 1;
  }
  state.panelUrl = ready.payload?.panel?.url ?? panelUrl;

  // 4) 只读状态 + 体检，拼启动摘要。
  const bridge = await readBridgeState(state.toolset, config);
  if (state.shuttingDown) return 0;
  if (bridge.error !== null) print(`[提示] 读取 bridge 状态失败：${bridge.error}`);
  const doctor = await readDoctor(state.toolset, config);
  if (state.shuttingDown) return 0;

  printStartupSummary({
    config,
    toolset: state.toolset,
    panelPayload: ready.payload,
    panelUrl: state.panelUrl,
    bridge,
    doctor,
  });
  return 0;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) print(`[错误] ${error}`);
    print('用 --help 查看用法。');
    return 2;
  }
  if (parsed.help) {
    print(HELP_TEXT);
    return 0;
  }
  let config;
  try {
    config = resolveConfig(parsed);
  } catch (error) {
    if (error instanceof ConfigError) {
      print(`[错误] ${error.message}`);
      return 2;
    }
    throw error;
  }
  return parsed.selfCheck ? runSelfCheck({ config }) : runDaemon({ config, parsed });
}

process.exitCode = await main();
