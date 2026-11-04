// screenshot.mjs — 截 SteamVR「Headset Window」（或 VRChat 桌面窗口）给 agent 看。
//
// 为什么单独一层：agent 操作 VRChat 菜单时需要"眼睛"——它必须先看到菜单/世界画面，
// 才能决定把手/激光指向哪、按哪个键。OSC 没有任何 UI 状态回读，所以截图是唯一反馈通道。
//
// 复用配套工程 player/tools/capture_frame.ps1（纯 ASCII，EnumWindows + SetForegroundWindow +
// CopyFromScreen，输出 "ok,<w>,<h>" / "err,<msg>"，exit 0/1/3）。这里只负责：
//   * spawn powershell 带超时（默认 4s），把 PNG 读回内存；
//   * 「Headset Window」找不到时退回 VRChat 桌面窗口（桌面模式下也有用）；
//   * 绝不抛异常，失败返回 { ok:false, error }。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCREENSHOT_DEFAULT = Object.freeze({
  title: 'Headset Window',
  fallbackTitles: ['VRChat'],
  timeoutMs: 4000,
  maxBytes: 12 * 1024 * 1024,
});

/** 在 PNG 头里读宽高（IHDR 固定偏移），读不到返回 null。 */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function runCapture(scriptPath, outFile, title, timeoutMs) {  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-OutFile', outFile, '-Title', title,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, Math.max(500, timeoutMs));
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(error?.message ?? error), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

/**
 * VRChat.exe 是否在跑。用来决定是否允许退回「VRChat」窗口——
 * 不能无脑按标题子串匹配：浏览器标题里带 "VRChat" 时会把整个浏览器截进来（踩过）。
 */
function isProcessRunning(imageName) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${imageName}`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 2000);
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(/\.exe/i.test(out) && !/no tasks/i.test(out));
    });
  });
}

/**
 * 截一张图。
 * @returns {Promise<{ok:boolean, png?:Buffer, width?:number, height?:number, title?:string,
 *                    bytes?:number, capturedAt?:number, error?:string, attempts?:Array}>}
 */
export async function captureHeadsetWindow(options = {}) {
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const scriptPath = typeof opts.scriptPath === 'string' ? opts.scriptPath : '';
  if (scriptPath.length === 0 || !existsSync(scriptPath)) {
    return { ok: false, error: `截图脚本不存在：${scriptPath || '(未配置)'}` };
  }
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs))
    ? Math.min(15_000, Math.max(500, Number(opts.timeoutMs)))
    : SCREENSHOT_DEFAULT.timeoutMs;
  const titles = [String(opts.title ?? SCREENSHOT_DEFAULT.title)];
  if (await isProcessRunning('VRChat.exe')) {
    for (const title of SCREENSHOT_DEFAULT.fallbackTitles) {
      if (!titles.includes(title)) titles.push(title);
    }
  }
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'vplay-shot-'));
  } catch (error) {
    return { ok: false, error: `临时目录创建失败：${String(error?.message ?? error)}` };
  }
  const attempts = [];
  try {
    for (const title of titles) {
      const outFile = join(dir, `shot-${attempts.length}.png`);
      const result = await runCapture(scriptPath, outFile, title, timeoutMs);
      let bytes = null;
      try {
        bytes = statSync(outFile).size;
      } catch {
        bytes = null;
      }
      attempts.push({ title, ok: result.ok, code: result.code, timedOut: result.timedOut, bytes, stdout: result.stdout.slice(0, 120) });
      if (!result.ok || bytes === null || bytes < 64) continue;
      if (bytes > SCREENSHOT_DEFAULT.maxBytes) {
        attempts[attempts.length - 1].error = `图片过大（${bytes} 字节）`;
        continue;
      }
      let png;
      try {
        png = readFileSync(outFile);
      } catch (error) {
        attempts[attempts.length - 1].error = `读取失败：${String(error?.message ?? error)}`;
        continue;
      }
      const size = pngSize(png) ?? { width: null, height: null };
      return {
        ok: true,
        png,
        width: size.width,
        height: size.height,
        title,
        bytes: png.length,
        capturedAt: Date.now(),
        attempts,
      };
    }
    const notFound = attempts.every((attempt) => attempt.code === 3);
    return {
      ok: false,
      error: notFound
        ? '找不到 SteamVR「Headset Window」（SteamVR 没启动，或窗口被隐藏）'
        : `截图失败（${attempts.map((attempt) => `${attempt.title}:${attempt.code ?? '?'}`).join(', ')}）`,
      attempts,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
