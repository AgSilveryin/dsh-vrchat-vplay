// launch.mjs — Steam / SteamVR / VRChat 一键启动 + 环境探测（dsh-vrchat-vplay 插件模块）
//
// 目标：让小白不用手动按顺序开游戏。启动顺序必须是 **Steam → SteamVR → VRChat**：
//   * Steam 没起时 VRChat 的 SteamAPI 初始化会失败并弹模态（实机验证过的坑）；
//   * SteamVR 没起时 VRChat 不会进 VR 模式。
//
// 设计约束（来自 Lead）：
//   * 纯 ESM、只用 node: 内置模块、零 npm 依赖；
//   * **绝不抛异常**（任何一步失败都进 `failed`/`notes`，调用方拿结构化结果）；
//   * `launch:false`（默认）时只探测环境，不 spawn、不等待（doctor / 单测用这个模式）；
//   * deps 可注入（进程表 / 注册表 / spawn / sleep / exists / readText），便于离线单测。
//
// 导出：
//   detectGameEnv(deps) -> { steam:{found,exe,path}, steamvr:{found,dir,exe}, vrchat:{found,dir,exe}, notes }
//   ensureGameStack(options, deps) -> { ok, started, already, failed, waitedMs, notes, env }
//   （另导出 DEFAULT_TIMEOUTS / GAME_ORDER / 若干纯函数，方便 index.js 与单测复用）
//
// 本机实测路径（2026-11-02，只读核对）：
//   HKCU\Software\Valve\Steam\SteamPath = "d:/path/to/steam"（正斜杠，需归一化）
//   <Steam>\steamapps\common\SteamVR\bin\win64\vrstartup.exe
//   <Steam>\steamapps\common\VRChat\launch.exe
//   <Steam>\steamapps\libraryfolders.vdf 里 "path" 行可能是 "D:\\SteamLibrary" 这种转义形式

import { existsSync, readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export const GAME_ORDER = Object.freeze(['steam', 'steamvr', 'vrchat']);

export const DEFAULT_TIMEOUTS = Object.freeze({
  steamMs: 20_000,
  steamvrMs: 60_000,
  vrchatMs: 45_000,
});

export const DEFAULT_POLL_MS = 500;

export const STEAM_REG_KEY = 'HKCU\\Software\\Valve\\Steam';
export const STEAM_REG_VALUE = 'SteamPath';
export const STEAM_FALLBACK_PATH = 'C:\\Program Files (x86)\\Steam';
export const VRC_CHAT_APP_ID = '438100';

// 进程名（小写比较）。SteamVR 只要 vrserver 或 vrmonitor 任一在跑就算起来了。
const PROCESS_NAMES = Object.freeze({
  steam: ['steam.exe'],
  steamvr: ['vrserver.exe', 'vrmonitor.exe'],
  vrchat: ['vrchat.exe'],
});

const now = () => Date.now();
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 统一路径分隔符为 Windows 反斜杠；去掉首尾空白/多余尾斜杠。返回空串表示无效。 */
export function normalizeWinPath(value) {
  if (typeof value !== 'string') return '';
  let p = value.trim().replace(/^"+|"+$/g, '');
  if (!p) return '';
  p = p.replace(/\//g, '\\');
  // 盘符统一大写（注册表里常见小写 "d:/path/to/steam"，输出/比较时更一致）
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  p = win32.normalize(p);
  if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1);
  return p;
}

/** 从 libraryfolders.vdf 文本里抽出所有 library 的 path（处理 "D:\\game\\steam" 转义）。 */
export function parseLibraryFolders(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let m = re.exec(text);
  while (m) {
    const raw = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    const p = normalizeWinPath(raw);
    if (p && !out.includes(p)) out.push(p);
    m = re.exec(text);
  }
  return out;
}

// ── 默认真实 deps（Windows；每一步都 try/catch，绝不向上抛）────────────────────
function makeDefaultDeps(extra = {}) {
  const exists = (p) => {
    try {
      return typeof p === 'string' && p.length > 0 && existsSync(p);
    } catch {
      return false;
    }
  };
  const readText = (p) => {
    try {
      return typeof p === 'string' && p.length > 0 ? readFileSync(p, 'utf8') : null;
    } catch {
      return null;
    }
  };
  const regQuery = (key, name) => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const re = new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+REG_[A-Z_]+\\s+(.+)', 'i');
      const m = re.exec(out);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  };
  const listProcesses = () => {
    try {
      const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const rows = [];
      for (const line of out.split(/\r?\n/)) {
        // "steam.exe","1234","Console","1","123,456 K"
        const m = /^"([^"]+)"\s*,\s*"?(\d+)"?/.exec(line.trim());
        if (m) rows.push({ name: m[1], pid: Number(m[2]) });
      }
      return rows;
    } catch {
      return [];
    }
  };
  const spawn = (exe, args = []) => {
    try {
      if (typeof exe !== 'string' || exe.length === 0) return { pid: null, error: 'empty exe path' };
      const child = nodeSpawn(exe, Array.isArray(args) ? args : [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: win32.dirname(exe),
      });
      if (typeof child.unref === 'function') child.unref();
      child.on('error', () => {});
      return { pid: Number.isFinite(child.pid) ? child.pid : null, error: null };
    } catch (error) {
      return { pid: null, error: error && error.message ? error.message : String(error) };
    }
  };
  const sleep = (ms) => sleepReal(ms);
  return {
    env: process.env,
    platform: process.platform,
    exists,
    readText,
    regQuery,
    listProcesses,
    spawn,
    sleep,
    ...extra,
  };
}

/** 合并 deps：options.deps < 第二参数 deps < 默认真实实现（显式传入的优先）。 */
function resolveDeps(options = {}, deps = {}) {
  const fromOptions = options && typeof options.deps === 'object' && options.deps ? options.deps : {};
  const explicit = deps && typeof deps === 'object' ? deps : {};
  return makeDefaultDeps({ ...fromOptions, ...explicit });
}

/** 进程名 → 小写 basename（兼容 "C:\\x\\steam.exe" 这种）。 */
function processBaseName(name) {
  if (typeof name !== 'string' || name.length === 0) return '';
  const base = win32.basename(name.trim());
  return base.toLowerCase();
}

function isAnyRunning(processes, names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const proc of Array.isArray(processes) ? processes : []) {
    if (proc && wanted.has(processBaseName(proc.name))) return true;
  }
  return false;
}

/** 安全地读进程表（注入的实现抛错也只当空表）。 */
function safeListProcesses(deps) {
  try {
    const rows = deps.listProcesses();
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.name === 'string') : [];
  } catch {
    return [];
  }
}

function isRunning(deps, names) {
  return isAnyRunning(safeListProcesses(deps), names);
}

function secondsLabel(ms) {
  const value = Number.isFinite(Number(ms)) ? Number(ms) : 0;
  if (value >= 1000) return String(Math.round(value / 1000));
  return (value / 1000).toFixed(2);
}

// ── 环境探测 ────────────────────────────────────────────────────────────────
/**
 * 只读探测本机 Steam / SteamVR / VRChat 安装位置。绝不抛异常。
 * @param {object} [deps] 可注入 { regQuery, exists, readText, env, listProcesses, spawn, sleep }
 * @returns {{steam:{found:boolean,exe:string|null,path:string|null},
 *            steamvr:{found:boolean,dir:string|null,exe:string|null},
 *            vrchat:{found:boolean,dir:string|null,exe:string|null},
 *            notes:string[]}}
 */
export function detectGameEnv(deps = {}) {
  const notes = [];
  const injected = deps && typeof deps === 'object' ? deps : {};
  // 缺省用真实实现（reg query / 文件系统）；测试注入的 deps 优先。
  let d;
  try {
    d = makeDefaultDeps(injected);
  } catch {
    d = { exists: () => false, readText: () => null, regQuery: () => null };
  }
  const call = (fn, ...args) => {
    try {
      return fn(...args);
    } catch {
      return null;
    }
  };
  const exists = (p) => {
    try {
      return Boolean(p) && Boolean(call(d.exists, p));
    } catch {
      return false;
    }
  };
  const readText = (p) => {
    try {
      const value = call(d.readText, p);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  const result = {
    steam: { found: false, exe: null, path: null },
    steamvr: { found: false, dir: null, exe: null },
    vrchat: { found: false, dir: null, exe: null },
    notes,
  };

  try {
    // 1) Steam 安装路径：注册表 SteamPath → 兜底默认路径
    let steamPath = '';
    const regValue = call(d.regQuery, STEAM_REG_KEY, STEAM_REG_VALUE);
    if (typeof regValue === 'string' && regValue.trim()) {
      steamPath = normalizeWinPath(regValue.trim());
      if (steamPath) notes.push(`SteamPath 来自注册表: ${steamPath}`);
    }
    if (!steamPath) {
      steamPath = normalizeWinPath(STEAM_FALLBACK_PATH);
      notes.push(`注册表未读到 SteamPath，改用兜底路径: ${steamPath}`);
    }
    const steamExe = win32.join(steamPath, 'steam.exe');
    if (exists(steamExe)) {
      result.steam = { found: true, exe: steamExe, path: steamPath };
    } else {
      result.steam = { found: false, exe: steamExe, path: steamPath };
      notes.push(`Steam 未找到（${steamExe} 不存在），请确认 Steam 已安装`);
    }

    // 2) 库列表：主库 + libraryfolders.vdf 里的其它库
    const libraries = [];
    const addLibrary = (p) => {
      const n = normalizeWinPath(p);
      if (n && !libraries.includes(n)) libraries.push(n);
    };
    addLibrary(steamPath);
    const vdf = readText(win32.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) {
      const parsed = parseLibraryFolders(vdf);
      for (const lib of parsed) addLibrary(lib);
      if (parsed.length > 0) notes.push(`libraryfolders.vdf 解析到 ${parsed.length} 个库: ${parsed.join(' ; ')}`);
    } else {
      notes.push('未读到 libraryfolders.vdf（只扫主库）');
    }

    // 3) SteamVR：<lib>/steamapps/common/SteamVR/bin/win64/vrstartup.exe
    for (const lib of libraries) {
      const dir = win32.join(lib, 'steamapps', 'common', 'SteamVR');
      const exe = win32.join(dir, 'bin', 'win64', 'vrstartup.exe');
      if (exists(exe)) {
        result.steamvr = { found: true, dir, exe };
        if (lib !== steamPath) notes.push(`SteamVR 在非主库: ${dir}`);
        break;
      }
    }
    if (!result.steamvr.found) {
      notes.push('未找到 SteamVR（<库>/steamapps/common/SteamVR/bin/win64/vrstartup.exe），请先安装 SteamVR');
    }

    // 4) VRChat：<lib>/steamapps/common/VRChat/launch.exe（appid 438100）
    for (const lib of libraries) {
      const dir = win32.join(lib, 'steamapps', 'common', 'VRChat');
      const exe = win32.join(dir, 'launch.exe');
      if (exists(exe)) {
        result.vrchat = { found: true, dir, exe };
        if (lib !== steamPath) notes.push(`VRChat 在非主库: ${dir}`);
        break;
      }
    }
    if (!result.vrchat.found) {
      notes.push('未找到 VRChat（steamapps/common/VRChat/launch.exe，appid 438100），请先在 Steam 安装 VRChat');
      result.vrchat = { found: false, dir: null, exe: null };
    }
  } catch (error) {
    notes.push(`探测环境时发生异常（已忽略）: ${error && error.message ? error.message : String(error)}`);
  }
  return result;
}

// ── 启动编排 ────────────────────────────────────────────────────────────────
async function waitForRunning(deps, names, timeoutMs) {
  const pollMs = num(deps.pollMs, DEFAULT_POLL_MS);
  const limit = Math.max(0, num(timeoutMs, 0));
  if (isRunning(deps, names)) return { ok: true, waitedMs: 0 };
  let waited = 0;
  while (waited < limit) {
    const step = Math.min(Math.max(1, pollMs), limit - waited);
    try {
      await (typeof deps.sleep === 'function' ? deps.sleep(step) : sleepReal(step));
    } catch {
      /* 注入的 sleep 抛错也不中断，按已等待处理 */
    }
    waited += step;
    if (isRunning(deps, names)) return { ok: true, waitedMs: waited };
  }
  return { ok: false, waitedMs: waited };
}

function safeSpawn(deps, exe, args) {
  try {
    if (typeof deps.spawn !== 'function') return { pid: null, error: 'spawn 不可用' };
    const ret = deps.spawn(exe, Array.isArray(args) ? args : []);
    if (!ret || typeof ret !== 'object') return { pid: null, error: 'spawn 返回值无效' };
    if (ret.error) return { pid: null, error: String(ret.error) };
    return { pid: Number.isFinite(Number(ret.pid)) ? Number(ret.pid) : null, error: null };
  } catch (error) {
    return { pid: null, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * 确保 Steam → SteamVR → VRChat 依次就绪；launch:true 时缺什么启动什么并等待。
 * 绝不抛异常；任何失败进 failed/notes。
 *
 * @param {object} [options]
 * @param {boolean} [options.launch=false] false 时只探测，不启动不等待
 * @param {object} [options.timeouts] { steamMs, steamvrMs, vrchatMs }
 * @param {object} [options.deps] 与第二参数相同（第二参数优先）
 * @param {number} [options.pollMs] 轮询间隔，默认 500
 * @param {object} [deps] 可注入 { listProcesses, spawn, sleep, exists, readText, regQuery, env }
 */
export async function ensureGameStack(options = {}, deps = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const result = {
    ok: false,
    started: [],
    already: [],
    failed: [],
    waitedMs: 0,
    notes: [],
    env: null,
  };
  let resolved = null;
  try {
    resolved = resolveDeps(opts, deps);
    resolved.pollMs = num(opts.pollMs, DEFAULT_POLL_MS);
    const env = detectGameEnv(resolved);
    result.env = env;
    result.notes.push(...(env.notes || []));

    const launch = opts.launch === true;
    if (!launch) {
      result.ok = true;
      result.notes.push('launch=false：只探测环境，未启动任何程序');
      return result;
    }

    const timeouts = {
      steamMs: num(opts.timeouts && opts.timeouts.steamMs, DEFAULT_TIMEOUTS.steamMs),
      steamvrMs: num(opts.timeouts && opts.timeouts.steamvrMs, DEFAULT_TIMEOUTS.steamvrMs),
      vrchatMs: num(opts.timeouts && opts.timeouts.vrchatMs, DEFAULT_TIMEOUTS.vrchatMs),
    };
    const t0 = now();

    const steps = [
      {
        name: 'steam',
        label: 'Steam',
        names: PROCESS_NAMES.steam,
        timeoutMs: timeouts.steamMs,
        env: env.steam,
        exe: env.steam.exe,
        args: [],
        missing: '未找到 Steam（steam.exe），请确认 Steam 已安装',
      },
      {
        name: 'steamvr',
        label: 'SteamVR',
        names: PROCESS_NAMES.steamvr,
        timeoutMs: timeouts.steamvrMs,
        env: env.steamvr,
        exe: env.steamvr.exe,
        args: [],
        missing: '未找到 SteamVR（vrstartup.exe），请先安装 SteamVR',
      },
      {
        name: 'vrchat',
        label: 'VRChat',
        names: PROCESS_NAMES.vrchat,
        timeoutMs: timeouts.vrchatMs,
        env: env.vrchat,
        exe: env.vrchat.exe,
        args: [],
        missing: '未找到 VRChat（launch.exe，appid 438100），请先在 Steam 安装 VRChat',
      },
    ];

    let fatal = false;
    for (const step of steps) {
      if (fatal) {
        result.notes.push(`跳过 ${step.label}：上一步未就绪`);
        result.failed.push({ name: step.name, reason: `跳过：前置步骤未就绪，无法启动 ${step.label}` });
        continue;
      }
      if (isRunning(resolved, step.names)) {
        result.already.push(step.name);
        result.notes.push(`${step.label} 已在运行`);
        continue;
      }
      if (!step.env || step.env.found !== true || !step.exe) {
        result.failed.push({ name: step.name, reason: step.missing });
        result.notes.push(step.missing);
        fatal = true;
        continue;
      }
      const spawned = safeSpawn(resolved, step.exe, step.args);
      if (spawned.error) {
        result.failed.push({ name: step.name, reason: `启动 ${step.label} 失败: ${spawned.error}` });
        result.notes.push(`启动 ${step.label} 失败（${spawned.error}），可手动打开一次`);
        fatal = true;
        continue;
      }
      const wait = await waitForRunning(resolved, step.names, step.timeoutMs);
      if (!wait.ok) {
        result.failed.push({
          name: step.name,
          reason: `等 ${step.label} ${secondsLabel(step.timeoutMs)}s 没起来，可手动开一次`,
        });
        result.notes.push(`等 ${step.label} ${secondsLabel(step.timeoutMs)}s 没起来，可手动开一次（检查是否被弹窗/更新挡住）`);
        fatal = true;
        continue;
      }
      result.started.push({ name: step.name, exe: step.exe, pid: spawned.pid });
      result.notes.push(`${step.label} 已启动${spawned.pid ? `（pid ${spawned.pid}）` : ''}`);
    }

    result.waitedMs = Math.max(0, now() - t0);
    result.ok = result.failed.length === 0;
    if (!result.ok) result.notes.push('游戏栈未完全就绪：按失败项手动处理后重试（或再运行一次本工具）');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    result.ok = false;
    if (!Array.isArray(result.failed)) result.failed = [];
    result.failed.push({ name: 'internal', reason: `内部异常（已兜底）: ${message}` });
    if (!Array.isArray(result.notes)) result.notes = [];
    result.notes.push(`内部异常（已兜底）: ${message}`);
    if (!result.env) {
      try {
        result.env = detectGameEnv(resolved || {});
      } catch {
        result.env = { steam: { found: false, exe: null, path: null }, steamvr: { found: false, dir: null, exe: null }, vrchat: { found: false, dir: null, exe: null }, notes: [] };
      }
    }
  }
  return result;
}
