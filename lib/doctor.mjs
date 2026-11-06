// doctor.mjs — vrchat_doctor 体检模块（纯 ESM，只用 node: 内置模块，零第三方依赖）
//
// 目标：用户问"为什么连不上 / 能不能玩"时，一次返回 11 项检查、能力结论（chat/pose/player）
// 和最多 3 条中文下一步。所有探测都经由 deps 注入（单测用假实现），默认实现走真实系统
// （fs / tasklist / net / child_process）。**绝不抛异常**：每项检查失败 → unknown/fail 并继续。
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 检查项 id（顺序即 checks 数组顺序，Lead 的 index.js 只依赖这个形状）。 */
export const DOCTOR_CHECK_IDS = Object.freeze([
  'node-version',
  'player-files',
  'vrchat-process',
  'steam-process',
  'steamvr-process',
  'hmd-driver',
  'vmt-driver',
  'osc-ports',
  'headset-window',
  'log-dir',
  'monitor-port',
]);

const LABELS = Object.freeze({
  'node-version': 'Node 版本',
  'player-files': 'player 文件',
  'vrchat-process': 'VRChat 进程',
  'steam-process': 'Steam 进程',
  'steamvr-process': 'SteamVR 进程',
  'hmd-driver': 'A 线 HMD 驱动',
  'vmt-driver': 'VMT 驱动',
  'osc-ports': 'OSC 端口',
  'headset-window': 'Headset Window',
  'log-dir': 'VRChat 日志目录',
  'monitor-port': '监视器端口',
});

const DEFAULTS = Object.freeze({
  sendPort: 9000,
  listenPort: 9001,
  headPort: 39572,
  headDriverAssumed: null,
  vmtListenPort: 39571,
  playerDir: null,
  playerNode: 'node',
  playerMonitorPort: 8765,
  // SteamVR 日志路径：默认从注册表 SteamPath / 常见安装位置自动推导（config 可用 steamVrLogPath / vrserverLog 覆盖）
  steamVrLogPath: '',
  // VRChat 日志目录（config 可用 vrchatLogDir 覆盖）
  vrchatLogDir: join(homedir(), 'AppData', 'LocalLow', 'VRChat', 'VRChat'),
});

const PROBE_TIMEOUT_MS = 2000;
const MAX_NEXT_STEPS = 3;

const STEAM_REG_KEY = 'HKCU\\Software\\Valve\\Steam';
const STEAM_REG_STEAMPATH = 'SteamPath';

/** SteamVR 日志路径自动推导：环境变量 → 注册表 SteamPath → 常见安装位置；找不到返回 ''。 */
function defaultSteamVrLogPath() {
  const fromEnv = process.env.STEAMVR_LOG_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const candidates = [];
  try {
    const out = execFileSync('reg', ['query', STEAM_REG_KEY, '/v', STEAM_REG_STEAMPATH], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(String(out));
    if (match) {
      const steamRoot = match[1].trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\');
      candidates.push(join(steamRoot, 'logs', 'vrserver.txt'));
    }
  } catch { /* 非 Windows / reg 不可用 → 继续用常见路径 */ }
  for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (typeof root === 'string' && root.length > 0) candidates.push(join(root, 'Steam', 'logs', 'vrserver.txt'));
  }
  for (const candidate of candidates) {
    if (defaultExists(candidate)) return candidate;
  }
  return candidates[0] ?? '';
}

function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const port = (key, fallback) => {
    const value = Number(input[key]);
    return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
  };
  const text = (key, fallback) => (
    typeof input[key] === 'string' && input[key].length > 0 ? input[key] : fallback
  );
  return {
    sendPort: port('sendPort', DEFAULTS.sendPort),
    listenPort: port('listenPort', DEFAULTS.listenPort),
    headPort: port('headPort', DEFAULTS.headPort),
    headDriverAssumed: input.headDriverAssumed === true ? true : input.headDriverAssumed === false ? false : null,
    vmtListenPort: port('vmtListenPort', DEFAULTS.vmtListenPort),
    playerDir: text('playerDir', DEFAULTS.playerDir),
    playerNode: text('playerNode', DEFAULTS.playerNode),
    playerMonitorPort: port('playerMonitorPort', DEFAULTS.playerMonitorPort),
    steamVrLogPath: text('steamVrLogPath', text('vrserverLog', DEFAULTS.steamVrLogPath)) || defaultSteamVrLogPath(),
    vrchatLogDir: text('vrchatLogDir', DEFAULTS.vrchatLogDir),
    // true = 本插件自己正在 listenPort 上监听（传入后不再把"自己的监听"误报成别人占用）
    listenSelf: input.listenSelf === true,
  };
}

// ── 默认真实实现（全部 try/catch，绝不抛）─────────────────────────────────

function defaultExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 读文本；大文件只读末尾 512KB（vrserver.txt 可能很大）。失败 → null。 */
function defaultReadText(path) {
  try {
    const info = statSync(path);
    if (!info.isFile()) return null;
    const maxBytes = 512 * 1024;
    if (info.size <= maxBytes) return readFileSync(path, 'utf8');
    const start = info.size - maxBytes;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = readSync(fd, buffer, 0, maxBytes, start);
      return buffer.toString('utf8', 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function defaultListDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** spawn 一个命令并收集 stdout；超时强杀；返回 { ok, code, stdout, error?, timedOut? }。 */
function defaultExec(command, args = [], timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, Array.isArray(args) ? args : [], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env },
      });
    } catch (error) {
      resolve({ ok: false, stdout: '', error: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, stdout, timedOut: true });
    }, Math.max(100, Math.min(PROBE_TIMEOUT_MS, Number(timeoutMs) || PROBE_TIMEOUT_MS)));
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 32_000) stdout = stdout.slice(-32_000);
    });
    child.once('error', (error) => finish({ ok: false, stdout, error: String(error?.message ?? error) }));
    child.once('close', (code) => finish({ ok: code === 0, code, stdout }));
  });
}

/** tasklist（Windows）/ ps（其它平台）→ [{name,pid}]；失败 → null。 */
async function defaultListProcesses() {
  if (process.platform === 'win32') {
    const result = await defaultExec('tasklist', ['/FO', 'CSV', '/NH'], PROBE_TIMEOUT_MS);
    if (result === null || result.ok !== true) return null;
    const processes = [];
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (match) processes.push({ name: match[1], pid: Number(match[2]) });
    }
    return processes;
  }
  const result = await defaultExec('ps', ['-eo', 'comm=,pid='], PROBE_TIMEOUT_MS);
  if (result === null || result.ok !== true) return null;
  const processes = [];
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?)\s+(\d+)$/);
    if (match) processes.push({ name: match[1], pid: Number(match[2]) });
  }
  return processes;
}

/** 尝试绑定 127.0.0.1:port；返回 'in-use' | 'free' | 'unknown'（未知 = 探测出错）。 */
function defaultProbeUdpBind(port) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch {
      resolve('unknown');
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish('unknown'), PROBE_TIMEOUT_MS);
    socket.once('error', (error) => finish(error?.code === 'EADDRINUSE' ? 'in-use' : 'unknown'));
    try {
      socket.bind(Number(port), '127.0.0.1', () => finish('free'));
    } catch {
      finish('unknown');
    }
  });
}

/** TCP 连接探测；true = 有程序在听，false = 空闲/拒绝，null = 不确定。 */
function defaultProbeTcp(host, port) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ host: String(host), port: Number(port) });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
  });
}

/** 默认路径解析：config → plugin（自包含包内 player/）→ sibling（../vrchat-vr-driver）。 */
function defaultResolvePaths(config) {
  const attempts = [];
  if (config.playerDir !== null) {
    attempts.push({ source: 'config', root: config.playerDir, demoPath: join(config.playerDir, 'player', 'demo.mjs') });
  }
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  attempts.push({ source: 'plugin', root: pluginRoot, demoPath: join(pluginRoot, 'player', 'demo.mjs') });
  const siblingRoot = join(pluginRoot, '..', 'vrchat-vr-driver');
  attempts.push({ source: 'sibling', root: siblingRoot, demoPath: join(siblingRoot, 'player', 'demo.mjs') });
  for (const attempt of attempts) {
    if (defaultExists(attempt.demoPath)) return { found: true, ...attempt };
  }
  return {
    found: false,
    demoPath: attempts[0]?.demoPath ?? null,
    root: attempts[0]?.root ?? null,
    source: 'missing',
  };
}

// ── 小工具：超时/异常兜底 ─────────────────────────────────────────────────

/** 对一个 promise 限时（<=2s），超时或异常都返回 fallback，绝不抛。 */
function guard(promise, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), PROBE_TIMEOUT_MS);
    Promise.resolve(promise).then((value) => finish(value), () => finish(fallback));
  });
}

/** 调用注入的 deps 函数（允许同步抛），带超时与 fallback。 */
function guardCall(fn, fallback = null) {
  return guard(Promise.resolve().then(() => fn()), fallback);
}

function normalizeLevel(level) {
  return ['ok', 'warn', 'fail', 'unknown'].includes(level) ? level : 'unknown';
}

function safeMessage(error) {
  return String(error?.message ?? error ?? 'unknown error');
}

// ── 11 项检查 ─────────────────────────────────────────────────────────────

async function safeCheck(id, fn) {
  const label = LABELS[id];
  try {
    const result = await guardCall(fn, null);
    if (result === null || typeof result !== 'object') {
      return { id, label, level: 'unknown', detail: '探测超时（>2s）或没有结果', hint: '重试一次或手动确认' };
    }
    const check = {
      id,
      label,
      level: normalizeLevel(result.level),
      detail: String(result.detail ?? ''),
    };
    if (typeof result.hint === 'string' && result.hint.length > 0) check.hint = result.hint;
    return check;
  } catch (error) {
    return {
      id,
      label,
      level: 'unknown',
      detail: `探测异常：${safeMessage(error)}`,
      hint: '重试一次或查看插件日志',
    };
  }
}

/** 进程名匹配（大小写不敏感，兼容带路径的 ps 输出）。 */
function findProcess(processes, names) {
  if (!Array.isArray(processes)) return null;
  const wanted = names.map((name) => name.toLowerCase());
  for (const entry of processes) {
    const name = String(entry?.name ?? '').toLowerCase();
    const base = name.includes('\\') ? name.slice(name.lastIndexOf('\\') + 1) : name;
    if (wanted.includes(base) || wanted.includes(name)) return entry;
  }
  return null;
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 运行体检。config = 插件已解析配置；deps 全部可注入（测试用假实现）。
 * @returns {Promise<{ok:boolean, verdict:string, summary:{chat:boolean,pose:boolean,player:boolean},
 *   checks:object[], nextSteps:string[], meta:{at:string,node:string,platform:string}}>}
 */
export async function runDoctor(config = {}, deps = {}) {
  const cfg = normalizeConfig(config);
  const input = deps !== null && typeof deps === 'object' ? deps : {};
  const dep = (name, fallback) => (typeof input[name] === 'function' ? input[name] : fallback);
  const d = {
    exists: dep('exists', defaultExists),
    readText: dep('readText', defaultReadText),
    listProcesses: dep('listProcesses', defaultListProcesses),
    probeUdpBind: dep('probeUdpBind', defaultProbeUdpBind),
    probeTcp: dep('probeTcp', (host, port) => defaultProbeTcp(host, port)),
    exec: dep('exec', defaultExec),
    resolvePaths: dep('resolvePaths', () => defaultResolvePaths(cfg)),
    listDir: dep('listDir', defaultListDir),
    now: dep('now', () => Date.now()),
  };

  // 进程列表 / SteamVR 日志只取一次，多个检查共享。
  let processPromise = null;
  let logTextPromise = null;
  const getProcesses = () => {
    if (processPromise === null) processPromise = guardCall(() => d.listProcesses(), null);
    return processPromise;
  };
  const getLogText = () => {
    if (logTextPromise === null) logTextPromise = guardCall(() => d.readText(cfg.steamVrLogPath), null);
    return logTextPromise;
  };

  const checksFns = {
    'node-version': async () => {
      const version = process.versions.node;
      const major = Number.parseInt(String(version).split('.')[0], 10) || 0;
      if (major < 18) {
        return { level: 'fail', detail: `Node ${version} 太旧（要求 ≥18）`, hint: '升级到 Node 20 LTS 后重新体检' };
      }
      if (major < 20) {
        return { level: 'warn', detail: `Node ${version} 可用，但建议 ≥20 LTS`, hint: '升级到 Node 20 LTS 更稳' };
      }
      return { level: 'ok', detail: `Node ${version}（≥20 LTS）` };
    },

    'player-files': async () => {
      const paths = await guardCall(() => d.resolvePaths(), null);
      if (paths === null) {
        return {
          level: 'unknown',
          detail: `player 路径解析失败（playerDir=${cfg.playerDir ?? '(空)'}）`,
          hint: '检查 playerDir 配置是否可读',
        };
      }
      if (paths.found !== true) {
        const source = paths.source ?? 'missing';
        const expected = cfg.playerDir !== null ? cfg.playerDir : (paths.root ?? '(未知)');
        return {
          level: 'fail',
          detail: `未找到 player/demo.mjs（解析来源：${source}；playerDir=${expected}）`,
          hint: 'player 目录没找到：在 cordis.patch.yml 设 playerDir 或重新安装自包含包',
        };
      }
      const source = paths.source ?? 'config';
      return {
        level: 'ok',
        detail: `找到 player/demo.mjs（解析来源：${source}）：${paths.demoPath}`,
        hint: source === 'config' ? '' : '可通过 playerDir 固定路径',
      };
    },

    'vrchat-process': async () => {
      const processes = await getProcesses();
      if (processes === null) {
        return { level: 'unknown', detail: '无法读取进程列表（tasklist 失败或超时）', hint: '手动看任务管理器确认 VRChat 是否在跑' };
      }
      const process = findProcess(processes, ['vrchat.exe', 'vrchat']);
      if (process !== null) {
        return { level: 'ok', detail: `检测到 VRChat 进程（${process.name}，pid ${process.pid ?? '?'}）` };
      }
      return {
        level: 'warn',
        detail: '未检测到 VRChat 进程',
        hint: '启动 VRChat 后再体检；对话档可以先装 OSC 工具，不影响安装',
      };
    },

    'steam-process': async () => {
      const processes = await getProcesses();
      if (processes === null) {
        return { level: 'unknown', detail: '无法读取进程列表（tasklist 失败或超时）', hint: '手动看任务管理器确认 Steam 是否在跑' };
      }
      const process = findProcess(processes, ['steam.exe', 'steam']);
      if (process !== null) {
        return { level: 'ok', detail: `检测到 Steam 进程（${process.name}，pid ${process.pid ?? '?'}）` };
      }
      return {
        level: 'warn',
        detail: '未检测到 Steam 进程',
        hint: '没有 Steam，VRChat 会弹 Steam 无法启动',
      };
    },

    'steamvr-process': async () => {
      const processes = await getProcesses();
      if (processes === null) {
        return { level: 'unknown', detail: '无法读取进程列表（tasklist 失败或超时）', hint: '手动看任务管理器确认 SteamVR 是否在跑' };
      }
      const process = findProcess(processes, ['vrserver.exe', 'vrmonitor.exe', 'vrdashboard.exe', 'vrserver', 'vrmonitor']);
      if (process !== null) {
        return { level: 'ok', detail: `检测到 SteamVR 进程（${process.name}，pid ${process.pid ?? '?'}）` };
      }
      return {
        level: 'warn',
        detail: '未检测到 SteamVR 进程（vrserver.exe / vrmonitor.exe）',
        hint: '启动 SteamVR（或先开 Steam → SteamVR）',
      };
    },

    'hmd-driver': async () => {
      if (cfg.headDriverAssumed === true) {
        return { level: 'ok', detail: 'config.headDriverAssumed=true：按人工配置认为 dsh_hmd 在线', hint: '如实际没装驱动，请去掉该覆盖' };
      }
      if (cfg.headDriverAssumed === false) {
        return {
          level: 'fail',
          detail: 'config.headDriverAssumed=false：配置强制认为 dsh_hmd 不在线',
          hint: '装好 A 线 HMD 驱动后去掉 headDriverAssumed 或设为 true',
        };
      }
      const logText = await getLogText();
      if (typeof logText === 'string' && logText.includes('Using existing HMD dsh_hmd')) {
        return { level: 'ok', detail: `SteamVR 日志（${cfg.steamVrLogPath}）显示 dsh_hmd 已加载` };
      }
      const bind = await guardCall(() => d.probeUdpBind(cfg.headPort), 'unknown');
      if (bind === 'in-use') {
        return {
          level: 'ok',
          detail: `UDP ${cfg.headPort} 已被占用，疑似 dsh_hmd 在听（端口探测可能误判，可 headDriverAssumed 强制）`,
          hint: '端口探测可能误判，可 headDriverAssumed 强制',
        };
      }
      if (bind === 'free') {
        return {
          level: 'fail',
          detail: `SteamVR 日志无 dsh_hmd 记录，且 UDP ${cfg.headPort} 空闲（端口探测可能误判，可 headDriverAssumed 强制）`,
          hint: '启动带 dsh_hmd 的 SteamVR（A 线）；没有它 pose 会自动降级为 snap turn',
        };
      }
      return {
        level: 'unknown',
        detail: '无法判断 HMD 驱动状态（SteamVR 日志不可读且端口探测出错；端口探测可能误判，可 headDriverAssumed 强制）',
        hint: '端口探测可能误判，可 headDriverAssumed 强制',
      };
    },

    'vmt-driver': async () => {
      const logText = await getLogText();
      if (typeof logText === 'string'
        && (logText.includes("Driver 'vmt' finished adding tracked device") || logText.includes('/VMT/Out/Alive'))) {
        return { level: 'ok', detail: 'SteamVR 日志显示 VMT 驱动已加载（Driver \'vmt\' finished adding tracked device）' };
      }
      const bind = await guardCall(() => d.probeUdpBind(cfg.vmtListenPort), 'unknown');
      if (bind === 'in-use') {
        return {
          level: 'unknown',
          detail: `UDP ${cfg.vmtListenPort} 被占用（可能是 VMT Manager），但日志无 VMT 加载记录，无法确认`,
          hint: '没驱动时 pose 自动降级为 snap turn，功能不受影响',
        };
      }
      if (bind === 'free') {
        return {
          level: 'unknown',
          detail: '无 VMT 驱动证据（SteamVR 日志无加载记录，/VMT/Out/Alive 未验证）',
          hint: '没驱动时 pose 自动降级为 snap turn，功能不受影响',
        };
      }
      return {
        level: 'unknown',
        detail: '无 VMT 驱动证据（日志不可读、端口探测也失败；未知 = unknown）',
        hint: '没驱动时 pose 自动降级为 snap turn，功能不受影响',
      };
    },

    'osc-ports': async () => {
      const [sendBind, listenBind] = await Promise.all([
        guardCall(() => d.probeUdpBind(cfg.sendPort), 'unknown'),
        guardCall(() => d.probeUdpBind(cfg.listenPort), 'unknown'),
      ]);
      const parts = [];
      let level = 'ok';
      if (sendBind === 'in-use') {
        parts.push(`UDP ${cfg.sendPort} 已有程序在听（通常是 VRChat）`);
      } else if (sendBind === 'free') {
        level = 'warn';
        parts.push(`UDP ${cfg.sendPort} 空闲（VRChat 可能没启动，或改了 OSC 端口）`);
      } else {
        level = 'warn';
        parts.push(`UDP ${cfg.sendPort} 探测失败`);
      }
      if (listenBind === 'in-use') {
        if (cfg.listenSelf === true) {
          parts.push(`UDP ${cfg.listenPort} 由本插件监听（正常）`);
        } else {
          level = 'warn';
          parts.push(`UDP ${cfg.listenPort} 被其它程序占用，插件收不到 VRChat 参数`);
        }
      } else if (listenBind === 'free') {
        parts.push(`UDP ${cfg.listenPort} 可用`);
      } else {
        level = 'warn';
        parts.push(`UDP ${cfg.listenPort} 探测失败`);
      }
      return {
        level,
        detail: parts.join('；'),
        hint: level === 'ok'
          ? ''
          : '被占用就改端口：在 cordis.patch.yml 改 listenPort/sendPort，并同步 VRChat 的 osc.json',
      };
    },

    'headset-window': async () => {
      const script = "Get-Process | Where-Object { $_.MainWindowTitle -match 'Headset' } | Select-Object -First 1 -ExpandProperty MainWindowTitle";
      const result = await guardCall(
        () => d.exec('powershell', ['-NoProfile', '-Command', script], PROBE_TIMEOUT_MS),
        null,
      );
      if (result === null || result.ok !== true) {
        return {
          level: 'unknown',
          detail: '无法查询窗口标题（PowerShell 调用失败或超时）',
          hint: '在桌面确认 SteamVR 的 Headset Window 是否已打开',
        };
      }
      const title = String(result.stdout ?? '').trim();
      if (title.toLowerCase().includes('headset')) {
        return { level: 'ok', detail: `检测到窗口：${title}（视觉感知可用）` };
      }
      return {
        level: 'warn',
        detail: '未检测到含 "Headset" 的窗口（视觉感知不可用）',
        hint: '启动 SteamVR 后才有 Headset Window；log/hybrid 感知仍可用',
      };
    },

    'log-dir': async () => {
      const dir = cfg.vrchatLogDir;
      const exists = await guardCall(() => d.exists(dir), false);
      if (exists !== true) {
        return {
          level: 'warn',
          detail: `VRChat 日志目录不存在：${dir}`,
          hint: '启动 VRChat 进一次世界后才有日志；log/hybrid 感知需要它',
        };
      }
      const entries = await guardCall(() => d.listDir(dir), []);
      const files = (Array.isArray(entries) ? entries : [])
        .map((name) => String(name))
        .filter((name) => /^output_log_.*\.txt$/i.test(name));
      if (files.length > 0) {
        return { level: 'ok', detail: `找到日志：${join(dir, files[files.length - 1])}` };
      }
      return {
        level: 'warn',
        detail: '日志目录存在，但没有 output_log_*.txt',
        hint: '启动 VRChat 进一次世界后再试',
      };
    },

    'monitor-port': async () => {
      const occupied = await guardCall(() => d.probeTcp('127.0.0.1', cfg.playerMonitorPort), null);
      if (occupied === true) {
        return {
          level: 'warn',
          detail: `TCP ${cfg.playerMonitorPort} 被占用：可能有上一个玩家进程还在跑`,
          hint: '先 vrchat_player stop，或 start 时换 monitorPort',
        };
      }
      if (occupied === false) {
        return { level: 'ok', detail: `监视器端口 ${cfg.playerMonitorPort} 空闲` };
      }
      return {
        level: 'unknown',
        detail: `监视器端口 ${cfg.playerMonitorPort} 探测失败`,
        hint: '可用 vrchat_player status 手动确认',
      };
    },
  };

  let checks;
  try {
    checks = await Promise.all(DOCTOR_CHECK_IDS.map((id) => safeCheck(id, checksFns[id])));
  } catch (error) {
    return fallbackResult(cfg, d, error);
  }

  // 取 now 也走 deps，永不抛。
  const nowMs = await guardCall(() => d.now(), Date.now());
  return finalize(cfg, checks, Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
}

function buildNextSteps(byId) {
  const level = (id) => byId[id]?.level ?? 'unknown';
  const steps = [];

  if (level('node-version') === 'fail' || level('node-version') === 'warn') {
    steps.push('Node 版本偏低：升级到 Node 20 LTS 后重新体检');
  }
  if (level('player-files') !== 'ok') {
    steps.push('player 目录没找到：在 cordis.patch.yml 设 playerDir 或重新安装自包含包');
  }
  const steamWarn = level('steam-process') !== 'ok';
  const steamVrWarn = level('steamvr-process') !== 'ok';
  const vrchatWarn = level('vrchat-process') !== 'ok';
  if (steamWarn) {
    steps.push('先启动 Steam → 再启动 SteamVR → 再启动 VRChat');
  } else if (steamVrWarn) {
    steps.push('启动 SteamVR 后再启动 VRChat');
  } else if (vrchatWarn) {
    steps.push('启动 VRChat 并进入世界');
  }
  const poseReady = level('hmd-driver') === 'ok' || level('vmt-driver') === 'ok';
  if (!poseReady) {
    steps.push('vmt/hmd 驱动没就绪：pose 自动降级为 OSC snap turn，功能不受影响');
  }
  if (level('osc-ports') !== 'ok') {
    steps.push('OSC 端口异常：改 listenPort/sendPort 并同步 VRChat osc.json，或关掉占用程序');
  }
  if (level('monitor-port') !== 'ok') {
    steps.push('监视器端口被占：先 vrchat_player stop，或启动时换 monitorPort');
  }
  if (level('headset-window') !== 'ok') {
    steps.push('视觉感知需要 SteamVR 的 Headset Window：启动 SteamVR 后可用');
  }
  if (level('log-dir') !== 'ok') {
    steps.push('log 感知需要 VRChat 日志：启动 VRChat 进一次世界后再试');
  }
  return steps.slice(0, MAX_NEXT_STEPS);
}

function finalize(cfg, checks, nowMs) {
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const level = (id) => byId[id]?.level ?? 'unknown';
  const nodeOk = level('node-version') !== 'fail';
  // 口径（0.6.0 修正）：verdict 必须能直接当"现在能不能用"的绿灯，所以进程没开就不能算 ready。
  // 旧口径只看 fail、把"没开"当 warn，导致 Steam/VRChat/SteamVR 全关着也报 player-ready，会误导。
  const vrchatOk = level('vrchat-process') === 'ok';
  const steamOk = level('steam-process') === 'ok';
  const steamVrOk = level('steamvr-process') === 'ok';
  const hmdOk = level('hmd-driver') === 'ok';
  const vmtOk = level('vmt-driver') === 'ok';
  const chat = nodeOk && vrchatOk && level('osc-ports') !== 'fail';
  const pose = steamVrOk && (hmdOk || vmtOk);
  const player = level('player-files') === 'ok'
    && nodeOk
    && steamOk && steamVrOk && vrchatOk
    && hmdOk && vmtOk;
  const summary = { chat, pose, player };
  const verdict = player ? 'player-ready' : pose ? 'pose-ready' : chat ? 'chat-ready' : 'not-ready';
  let at;
  try {
    at = new Date(Number(nowMs)).toISOString();
  } catch {
    at = new Date().toISOString();
  }
  return {
    ok: verdict !== 'not-ready',
    verdict,
    summary,
    checks,
    nextSteps: buildNextSteps(byId),
    meta: {
      at,
      node: process.version,
      platform: process.platform,
    },
  };
}

function fallbackResult(cfg, d, error) {
  const checks = DOCTOR_CHECK_IDS.map((id) => ({
    id,
    label: LABELS[id],
    level: 'unknown',
    detail: `体检模块内部异常：${safeMessage(error)}`,
    hint: '查看插件日志后重试',
  }));
  const nowMs = Date.now();
  void cfg;
  void d;
  return {
    ok: false,
    verdict: 'not-ready',
    summary: { chat: false, pose: false, player: false },
    checks,
    nextSteps: ['体检模块内部异常：查看插件日志后重试'],
    meta: { at: new Date(nowMs).toISOString(), node: process.version, platform: process.platform },
  };
}
