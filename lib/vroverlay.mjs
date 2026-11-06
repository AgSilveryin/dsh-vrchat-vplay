// vroverlay.mjs — 控制 SteamVR dashboard 的显示/隐藏。
//
// 背景：SteamVR 的 dashboard/Desktop 视图会在 `startDashboardFromAppLaunch=true` 时随游戏启动
// 自动打开并盖住 VRChat；而驱动合成的 system 键会被 SteamVR 过滤（按了不关）。两条路都用：
//   1) 首选：SteamVR 自带的 `vrcmd.exe --hidedashboard / --showdashboard`（客户端命令，稳、无驱动改动）；
//   2) 兜底：向 `dsh_hmd` 驱动发 `/dsh/dashboard/hide|show`（驱动侧命令为可选能力，没实现时无回包，不影响 1）。
//
// vrcmd 路径：从 `%LOCALAPPDATA%\openvr\openvrpaths.vrpath` 的 runtime 推导 `<runtime>\bin\win64\vrcmd.exe`，
// 再兜底几个常见安装位置。所有调用带超时、绝不抛异常。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import dgram from 'node:dgram';
import { encodeMessage } from './osc.js';

export const DASHBOARD_ADDRESSES = Object.freeze({
  hide: '/dsh/dashboard/hide',
  show: '/dsh/dashboard/show',
  status: '/dsh/dashboard/status',
});

function readRuntimePaths() {
  const local = typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.length > 0
    ? process.env.LOCALAPPDATA
    : '';
  if (local.length === 0) return null;
  const file = win32.join(local, 'openvr', 'openvrpaths.vrpath');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 找 vrcmd.exe：openvrpaths 的 runtime 优先，再环境变量 STEAMVR_PATH，最后兜底常见 Steam 安装位置。 */
export function findVrcmd() {
  const candidates = [];
  const paths = readRuntimePaths();
  const runtimes = Array.isArray(paths?.runtime) ? paths.runtime : [];
  for (const runtime of runtimes) {
    if (typeof runtime === 'string' && runtime.length > 0) {
      candidates.push(win32.join(runtime, 'bin', 'win64', 'vrcmd.exe'));
    }
  }
  const envRoot = process.env.STEAMVR_PATH;
  if (typeof envRoot === 'string' && envRoot.length > 0) {
    candidates.push(win32.join(envRoot, 'bin', 'win64', 'vrcmd.exe'));
  }
  candidates.push(
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SteamVR\\bin\\win64\\vrcmd.exe',
    'C:\\Program Files\\Steam\\steamapps\\common\\SteamVR\\bin\\win64\\vrcmd.exe',
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runVrcmd(exe, flag, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, [flag], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, output: String(error?.message ?? error) });
      return;
    }
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, Math.max(500, timeoutMs));
    const push = (chunk) => {
      output += String(chunk);
      if (output.length > 4000) output = output.slice(-4000);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${String(error?.message ?? error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, timedOut, output: output.trim() });
    });
  });
}

/**
 * @param {{host?:string, port?:number, dryRun?:boolean, timeoutMs?:number, vrcmdPath?:string, logger?:any}} options
 */
export function createDashboardControl(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const host = typeof opts.host === 'string' && opts.host.length > 0 ? opts.host : '127.0.0.1';
  const port = Number.isFinite(Number(opts.port)) ? Math.round(Number(opts.port)) : 39572;
  const dryRun = opts.dryRun === true;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(500, Number(opts.timeoutMs)) : 4000;
  const logger = opts.logger ?? null;
  const vrcmd = typeof opts.vrcmdPath === 'string' && opts.vrcmdPath.length > 0 ? opts.vrcmdPath : findVrcmd();

  const stats = { sent: 0, ok: 0, errors: 0, viaVrcmd: 0, viaOsc: 0, lastError: null, vrcmdPath: vrcmd, closed: false };
  let socket = null;
  let pending = null; // { resolve, timer }

  const ensureSocket = () => {
    if (socket !== null || dryRun) return socket;
    socket = dgram.createSocket('udp4');
    socket.on('message', (buf) => {
      const text = buf.toString('latin1', 0, Math.min(buf.length, 64));
      if (!text.startsWith('/dsh/dashboard/visible')) return;
      let visible = null;
      try {
        visible = buf.readInt32BE(buf.length - 4) !== 0;
      } catch {
        visible = null;
      }
      if (pending !== null) {
        const { resolve, timer } = pending;
        pending = null;
        clearTimeout(timer);
        resolve({ ok: true, visible });
      }
    });
    socket.on('error', (error) => {
      stats.errors += 1;
      stats.lastError = String(error?.message ?? error);
      if (pending !== null) {
        const { resolve, timer } = pending;
        pending = null;
        clearTimeout(timer);
        resolve({ ok: false, error: stats.lastError });
      }
    });
    socket.unref?.();
    return socket;
  };

  /** 驱动通道（可选能力，没实现时只会超时，不影响 vrcmd 主路径）。 */
  const sendOsc = (address) => new Promise((resolve) => {
    if (dryRun) {
      stats.sent += 1;
      resolve({ ok: true, dryRun: true, address });
      return;
    }
    let sock;
    try {
      sock = ensureSocket();
    } catch (error) {
      stats.errors += 1;
      stats.lastError = String(error?.message ?? error);
      resolve({ ok: false, error: stats.lastError });
      return;
    }
    let packet;
    try {
      packet = encodeMessage(address, []);
    } catch (error) {
      stats.errors += 1;
      stats.lastError = String(error?.message ?? error);
      resolve({ ok: false, error: stats.lastError });
      return;
    }
    try {
      sock.send(packet, port, host, (error) => {
        if (error !== undefined && error !== null) {
          stats.errors += 1;
          stats.lastError = String(error?.message ?? error);
          resolve({ ok: false, error: stats.lastError });
          return;
        }
        stats.sent += 1;
        stats.viaOsc += 1;
        resolve({ ok: true, address, via: 'osc' });
      });
    } catch (error) {
      stats.errors += 1;
      stats.lastError = String(error?.message ?? error);
      resolve({ ok: false, error: stats.lastError });
    }
  });

  const command = async (flag, oscAddress) => {
    if (dryRun) {
      stats.ok += 1;
      return { ok: true, dryRun: true, flag };
    }
    if (vrcmd !== null) {
      const result = await runVrcmd(vrcmd, flag, timeoutMs);
      if (result.ok) {
        stats.ok += 1;
        stats.viaVrcmd += 1;
        return { ok: true, via: 'vrcmd', flag, output: result.output };
      }
      stats.errors += 1;
      stats.lastError = result.output || `vrcmd ${flag} failed`;
    }
    // vrcmd 不可用/失败：再试驱动通道（best-effort）
    const fallback = await sendOsc(oscAddress);
    return { ...fallback, via: fallback.ok === true ? 'osc' : undefined, note: vrcmd === null ? 'vrcmd 未找到' : 'vrcmd 失败' };
  };

  return {
    dryRun,
    host,
    port,
    stats,
    get vrcmdPath() {
      return vrcmd;
    },
    async hide() {
      const result = await command('--hidedashboard', DASHBOARD_ADDRESSES.hide);
      if (logger !== null && result.ok !== true) logger.warn?.(`vroverlay: hide failed — ${result.error ?? result.note}`);
      return result;
    },
    async show() {
      const result = await command('--showdashboard', DASHBOARD_ADDRESSES.show);
      if (logger !== null && result.ok !== true) logger.warn?.(`vroverlay: show failed — ${result.error ?? result.note}`);
      return result;
    },
    /**
     * vrcmd 没有查询命令：先问驱动（如果它实现了 /dsh/dashboard/status），否则返回 unknown。
     * 调用方（面板/工具）别把 unknown 当成"可见"。
     */
    async status() {
      if (dryRun) return { ok: true, dryRun: true, visible: null };
      const wait = new Promise((resolve) => {
        if (pending !== null) {
          resolve({ ok: false, error: 'previous status still pending' });
          return;
        }
        const timer = setTimeout(() => {
          pending = null;
          resolve({ ok: false, timeout: true, visible: null });
        }, Math.min(700, timeoutMs));
        pending = { resolve, timer };
      });
      const sent = await sendOsc(DASHBOARD_ADDRESSES.status);
      if (sent.ok !== true) {
        if (pending !== null) {
          clearTimeout(pending.timer);
          pending = null;
        }
        return sent;
      }
      return wait;
    },
    close() {
      stats.closed = true;
      if (pending !== null) {
        clearTimeout(pending.timer);
        pending = null;
      }
      if (socket !== null) {
        try { socket.close(); } catch { /* ignore */ }
        socket = null;
      }
    },
  };
}
