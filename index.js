/**
 * dsh-VRChat-vplay — a DeepSeek Harness Host plugin that connects this agent to a
 * locally running VRChat client through VRChat's OSC interface.
 *
 * Directions:
 *   agent -> VRChat : /chatbox/input (speak), /avatar/parameters/*, /input/* (control)
 *   VRChat -> agent : /avatar/parameters/*, /avatar/change, /tracking/* (buffered
 *                     into an event feed the agent can poll or wait on)
 *
 * Everything is plain Node.js (dgram + a small OSC codec in ./lib/osc.js), so the
 * bundle has no npm dependencies. Ports follow VRChat's defaults (9000 in, 9001 out)
 * and can be overridden in the bundle row's `config` or VRChat's --osc argument.
 */
import { VRChatBridge } from './lib/bridge.js';
import { PoseController } from './lib/vmt.js';
import { HeadController } from './lib/head.js';
import { SnapTurner, normalizeLookMode, normalizeAngle, normalizeSnapMode } from './lib/look.js';
import { PlayerProcess, PLAYER_PERCEPTION_MODES } from './lib/player-process.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { ensureGameStack } from './lib/launch.mjs';
import { createVmtInput } from './lib/vmtinput.mjs';
import { createDashboardControl } from './lib/vroverlay.mjs';
import { createPanel } from './lib/panel.mjs';
import { captureHeadsetWindow } from './lib/screenshot.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'vrchat-vplay';
export const inject = ['tools', 'attachments'];

const DEFAULT_OPTIONS = {
  host: '127.0.0.1',
  sendPort: 9000,
  listenPort: 9001,
  listenEnabled: true,
  chatboxMaxChars: 140,
  chatboxMinIntervalMs: 1500,
  notificationSound: false,
  showTyping: true,
  eventBufferSize: 600,
  noisyParams: ['Viseme', 'Voice', 'VelocityX', 'VelocityY', 'VelocityZ'],
  // ── 位姿通道（VMT，UDP 39570/39571）──
  vmtHost: '127.0.0.1',
  vmtSendPort: 39570,
  vmtListenPort: 39571,
  vmtListenEnabled: true,
  vmtListenerIdleMs: 30_000,
  vmtEnableMode: 'index',      // index = enable 5/6；controller = enable 2/3
  vmtProbeTimeoutMs: 1_200,
  vmtProbeCacheMs: 5_000,
  vmtProbeBackoffMs: 5_000,
  vmtSetRoomMatrix: true,
  poseHz: 60,
  poseHoldHz: 20,
  poseHumanize: true,
  poseIdleDrift: true,
  poseSeed: 1,
  // ── 头部通道（A 线自研 HMD 驱动 dsh_hmd，UDP 39572）──
  headHost: '127.0.0.1',
  headPort: 39572,
  headHz: 90,
  headHoldHz: 30,
  headProbeCacheMs: 5_000,
  headDriverAssumed: null,     // null = 用端口占用探测；true/false = 强制认为驱动在/不在
  headHumanize: true,
  headIdleDrift: true,
  headDriftAmplitude: 0.004,   // hold 时呼吸/微动（米）
  headDriftRotationDeg: 0.3,
  headSeed: 1,
  // ── 转头（默认 auto：A 线 HMD 可用就真转头，否则 snap turn）──
  lookMode: 'auto',            // auto|head|snap；兼容旧值 axis/comfort = snap 子模式
  lookStepDeg: 45,
  // ── Phase 1 玩家进程（player/demo.mjs；只 spawn，不 import 源码）──
  // playerDir 留空 = 自动探测（插件自带的 player/ → 兄弟目录 vrchat-vr-driver/player → 旧路径）
  playerDir: '',
  playerNode: 'node',
  playerMonitorPort: 8765,
  playerLogLines: 300,
  // ── 挡位预设（vrchat_mode 用；都可在 cordis.patch.yml 改）──
  playerPerception: 'vision',   // off|vision|log|hybrid；实机默认纯视觉
  playerNav: 'on',              // on|off；碰撞导航
  playerMapPath: '',            // 空 = 用 player/maps/home.json
  playerDefaultSeconds: 300,    // player 挡默认时长
  demoDefaultSeconds: 60,       // demo 挡默认时长
  playerAutoLaunch: false,      // true = player 挡缺 Steam/SteamVR/VRChat 时自动按顺序启动
  doctorTimeoutMs: 9000,        // vrchat_doctor 总预算
  steamVrLogPath: '',           // SteamVR 日志（驱动探活证据）；空 = 让 doctor 自己找
  // ── 虚拟手柄输入（vrchat_ui）：走 VMT 的 /VMT/Input/* 通道 ──
  vmtInputEnabled: true,
  uiPressMs: 140,               // 默认按键按住时长
  uiReleaseAllOnUnload: true,   // 插件卸载时把按下的键全部归零
  // ── 截图（vrchat_screenshot，给 agent 当眼睛）──
  screenshotTimeoutMs: 4000,
  screenshotFallbackProcess: 'VRChat.exe',
  // ── 本地按钮控制台（不敲命令行）──
  panelEnabled: true,
  panelHost: '127.0.0.1',
  panelPort: 8790,
  // ── 驱动随包安装（drivers/）──
  driversDir: '',               // 空 = <插件根>/drivers
  driversInstallTimeoutMs: 120_000,
  debug: false,
};

function resolveOptions(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const number = (key, fallback, min, max) => {
    const value = Number(input[key]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  const float = (key, fallback, min, max) => {
    const value = Number(input[key]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  const bool = (key, fallback) => (input[key] === undefined ? fallback : Boolean(input[key]));
  const list = (key, fallback) => {
    if (!Array.isArray(input[key])) return fallback;
    return input[key].filter((item) => typeof item === 'string');
  };
  return {
    host: typeof input.host === 'string' && input.host.length > 0 ? input.host : DEFAULT_OPTIONS.host,
    sendPort: number('sendPort', DEFAULT_OPTIONS.sendPort, 1, 65535),
    listenPort: number('listenPort', DEFAULT_OPTIONS.listenPort, 1, 65535),
    listenEnabled: input.listenEnabled === undefined ? DEFAULT_OPTIONS.listenEnabled : Boolean(input.listenEnabled),
    chatboxMaxChars: number('chatboxMaxChars', DEFAULT_OPTIONS.chatboxMaxChars, 20, 144),
    chatboxMinIntervalMs: number('chatboxMinIntervalMs', DEFAULT_OPTIONS.chatboxMinIntervalMs, 0, 60_000),
    notificationSound: input.notificationSound === undefined ? DEFAULT_OPTIONS.notificationSound : Boolean(input.notificationSound),
    showTyping: input.showTyping === undefined ? DEFAULT_OPTIONS.showTyping : Boolean(input.showTyping),
    eventBufferSize: number('eventBufferSize', DEFAULT_OPTIONS.eventBufferSize, 10, 10_000),
    noisyParams: list('noisyParams', DEFAULT_OPTIONS.noisyParams),
    // 位姿通道
    vmtHost: typeof input.vmtHost === 'string' && input.vmtHost.length > 0 ? input.vmtHost : DEFAULT_OPTIONS.vmtHost,
    vmtSendPort: number('vmtSendPort', DEFAULT_OPTIONS.vmtSendPort, 1, 65535),
    vmtListenPort: number('vmtListenPort', DEFAULT_OPTIONS.vmtListenPort, 1, 65535),
    vmtListenEnabled: bool('vmtListenEnabled', DEFAULT_OPTIONS.vmtListenEnabled),
    vmtListenerIdleMs: number('vmtListenerIdleMs', DEFAULT_OPTIONS.vmtListenerIdleMs, 0, 600_000),
    vmtEnableMode: input.vmtEnableMode === 'controller' ? 'controller' : 'index',
    vmtProbeTimeoutMs: number('vmtProbeTimeoutMs', DEFAULT_OPTIONS.vmtProbeTimeoutMs, 50, 10_000),
    vmtProbeCacheMs: number('vmtProbeCacheMs', DEFAULT_OPTIONS.vmtProbeCacheMs, 0, 60_000),
    vmtProbeBackoffMs: number('vmtProbeBackoffMs', DEFAULT_OPTIONS.vmtProbeBackoffMs, 0, 60_000),
    vmtSetRoomMatrix: bool('vmtSetRoomMatrix', DEFAULT_OPTIONS.vmtSetRoomMatrix),
    poseHz: number('poseHz', DEFAULT_OPTIONS.poseHz, 30, 90),
    poseHoldHz: number('poseHoldHz', DEFAULT_OPTIONS.poseHoldHz, 5, 60),
    poseHumanize: bool('poseHumanize', DEFAULT_OPTIONS.poseHumanize),
    poseIdleDrift: bool('poseIdleDrift', DEFAULT_OPTIONS.poseIdleDrift),
    poseSeed: number('poseSeed', DEFAULT_OPTIONS.poseSeed, 0, 2 ** 31 - 1),
    // 头部通道（A 线 HMD）
    headHost: typeof input.headHost === 'string' && input.headHost.length > 0 ? input.headHost : DEFAULT_OPTIONS.headHost,
    headPort: number('headPort', DEFAULT_OPTIONS.headPort, 1, 65535),
    headHz: number('headHz', DEFAULT_OPTIONS.headHz, 30, 90),
    headHoldHz: number('headHoldHz', DEFAULT_OPTIONS.headHoldHz, 5, 90),
    headProbeCacheMs: number('headProbeCacheMs', DEFAULT_OPTIONS.headProbeCacheMs, 0, 60_000),
    headDriverAssumed: input.headDriverAssumed === true
      ? true
      : input.headDriverAssumed === false
        ? false
        : null,
    headHumanize: bool('headHumanize', DEFAULT_OPTIONS.headHumanize),
    headIdleDrift: bool('headIdleDrift', DEFAULT_OPTIONS.headIdleDrift),
    headDriftAmplitude: float('headDriftAmplitude', DEFAULT_OPTIONS.headDriftAmplitude, 0, 0.05),
    headDriftRotationDeg: float('headDriftRotationDeg', DEFAULT_OPTIONS.headDriftRotationDeg, 0, 3),
    headSeed: number('headSeed', DEFAULT_OPTIONS.headSeed, 0, 2 ** 31 - 1),
    // 转头
    lookMode: typeof input.lookMode === 'string' ? input.lookMode : DEFAULT_OPTIONS.lookMode,
    lookStepDeg: float('lookStepDeg', DEFAULT_OPTIONS.lookStepDeg, 1, 180),
    // Phase 1 玩家进程
    playerDir: typeof input.playerDir === 'string' ? input.playerDir.trim() : DEFAULT_OPTIONS.playerDir,
    playerNode: typeof input.playerNode === 'string' && input.playerNode.length > 0 ? input.playerNode : DEFAULT_OPTIONS.playerNode,
    playerMonitorPort: number('playerMonitorPort', DEFAULT_OPTIONS.playerMonitorPort, 1, 65535),
    playerLogLines: number('playerLogLines', DEFAULT_OPTIONS.playerLogLines, 20, 2000),
    // 挡位预设
    playerPerception: PLAYER_PERCEPTION_MODES.includes(input.playerPerception)
      ? input.playerPerception
      : DEFAULT_OPTIONS.playerPerception,
    playerNav: input.playerNav === 'off' ? 'off' : (input.playerNav === 'on' ? 'on' : DEFAULT_OPTIONS.playerNav),
    playerMapPath: typeof input.playerMapPath === 'string' ? input.playerMapPath.trim() : DEFAULT_OPTIONS.playerMapPath,
    playerDefaultSeconds: number('playerDefaultSeconds', DEFAULT_OPTIONS.playerDefaultSeconds, 5, 86_400),
    demoDefaultSeconds: number('demoDefaultSeconds', DEFAULT_OPTIONS.demoDefaultSeconds, 5, 86_400),
    playerAutoLaunch: bool('playerAutoLaunch', DEFAULT_OPTIONS.playerAutoLaunch),
    doctorTimeoutMs: number('doctorTimeoutMs', DEFAULT_OPTIONS.doctorTimeoutMs, 1_500, 60_000),
    steamVrLogPath: typeof input.steamVrLogPath === 'string' ? input.steamVrLogPath.trim() : DEFAULT_OPTIONS.steamVrLogPath,
    // 虚拟手柄输入
    vmtInputEnabled: bool('vmtInputEnabled', DEFAULT_OPTIONS.vmtInputEnabled),
    uiPressMs: number('uiPressMs', DEFAULT_OPTIONS.uiPressMs, 20, 5000),
    uiReleaseAllOnUnload: bool('uiReleaseAllOnUnload', DEFAULT_OPTIONS.uiReleaseAllOnUnload),
    // 截图
    screenshotTimeoutMs: number('screenshotTimeoutMs', DEFAULT_OPTIONS.screenshotTimeoutMs, 500, 15_000),
    screenshotFallbackProcess: typeof input.screenshotFallbackProcess === 'string'
      ? input.screenshotFallbackProcess.trim()
      : DEFAULT_OPTIONS.screenshotFallbackProcess,
    // 控制台面板
    panelEnabled: bool('panelEnabled', DEFAULT_OPTIONS.panelEnabled),
    panelHost: typeof input.panelHost === 'string' && input.panelHost.length > 0 ? input.panelHost : DEFAULT_OPTIONS.panelHost,
    panelPort: number('panelPort', DEFAULT_OPTIONS.panelPort, 1, 65_535),
    // 驱动
    driversDir: typeof input.driversDir === 'string' ? input.driversDir.trim() : DEFAULT_OPTIONS.driversDir,
    driversInstallTimeoutMs: number('driversInstallTimeoutMs', DEFAULT_OPTIONS.driversInstallTimeoutMs, 5_000, 600_000),
    debug: Boolean(input.debug),
  };
}

const OUTPUT_OBJECT = { type: 'object', additionalProperties: true };
const json = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
const sentence = (text) => [{ type: 'text', text }];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value);
const fmtVec = (values) => (Array.isArray(values) ? values.map((value) => fmt(value)).join(', ') : String(values));
const fmtSeconds = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '?');
const fmt1 = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '?');

/**
 * vrchat_player 结果的中文摘要（start/stop/status/log/preflight 共用一个 render）。
 */
function renderPlayerResult(value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  const action = result.action;
  if (action === 'start') {
    if (result.alreadyRunning === true) {
      return sentence(`玩家已在运行（pid=${result.pid ?? '?'}）· 监视器 ${result.monitorUrl ?? '?'}`);
    }
    return sentence(`玩家已启动 pid=${result.pid ?? '?'} · 监视器 ${result.monitorUrl ?? '?'} · 参数：${(result.args ?? []).join(' ')}`);
  }
  if (action === 'stop') {
    if (result.stopped !== true) {
      return sentence(`玩家未在运行（${result.reason === 'never-started' ? '从未启动' : '已退出'}）`);
    }
    return sentence(`玩家已停止（退出码 ${result.exitCode === null || result.exitCode === undefined ? 'null' : result.exitCode}`
      + `${result.forced === true ? '，强制' : ''}）· 运行 ${fmtSeconds(result.uptimeMs)}s`);
  }
  if (action === 'status') {
    const monitor = result.monitor ?? {};
    const state = monitor.state ?? null;
    const parts = [];
    parts.push(result.running === true ? `玩家运行中 ${fmtSeconds(result.uptimeMs)}s` : '玩家未运行');
    if (state !== null) {
      if (state.action) {
        const phase = Number.isFinite(state.action.phase) ? ` ${Math.round(state.action.phase * 100)}%` : '';
        parts.push(`动作 ${state.action.name ?? 'idle'}${phase}`);
      }
      if (Array.isArray(state.root?.pos)) parts.push(`位置 (${fmt1(state.root.pos[0])}, ${fmt1(state.root.pos[2])})`);
      if (Number.isFinite(state.root?.yaw)) parts.push(`朝向 ${Math.round(state.root.yaw)}°`);
      parts.push(`感知目标 ${Array.isArray(state.targets) ? state.targets.length : 0}`);
      if (Number.isFinite(state.fps)) parts.push(`fps ${state.fps}`);
    } else {
      parts.push('暂无 /state');
    }
    parts.push(monitor.ok === true
      ? `监视器在线 ${result.monitorUrl ?? ''}`
      : `监视器没起（${monitor.error ?? '不可达'}）`);
    if (result.running !== true && result.exit) parts.push(`上次退出 code=${result.exit.code ?? 'null'}`);
    return sentence(parts.join(' · '));
  }
  if (action === 'log') {
    const lines = Array.isArray(result.lines) ? result.lines : [];
    if (lines.length === 0) return sentence('玩家日志为空（进程未启动或还没有输出）');
    const text = lines.slice(-200).join('\n');
    return sentence(`玩家最近 ${lines.length} 行：\n${text.length > 8000 ? `${text.slice(-8000)}\n…(truncated)` : text}`);
  }
  if (action === 'preflight') {
    const tail = (Array.isArray(result.lines) ? result.lines : []).slice(-12).join('\n');
    return sentence(`体检${result.ok === true ? '通过' : '失败'}（exit=${result.exitCode ?? '?'}${result.timedOut === true ? '，超时' : ''}）`
      + `${tail.length > 0 ? `\n${tail}` : ''}`);
  }
  return json(result);
}

// ── 驱动随包（drivers/）：状态检查 + 安装/卸载 ────────────────────────────────

const DRIVER_NAMES = Object.freeze(['dsh_hmd', 'vmt']);

function openVrPathsFile() {
  const local = typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.length > 0
    ? process.env.LOCALAPPDATA
    : '';
  return local.length > 0 ? join(local, 'openvr', 'openvrpaths.vrpath') : '';
}

function readExternalDrivers() {
  const file = openVrPathsFile();
  if (file.length === 0 || !existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.external_drivers)
      ? parsed.external_drivers.filter((item) => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

const normPath = (value) => String(value ?? '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();

function driverStatus(config, pluginDir) {
  const driversRoot = config.driversDir.length > 0 ? config.driversDir : join(pluginDir, 'drivers');
  const external = readExternalDrivers();
  const externalKeys = external.map(normPath);
  const drivers = DRIVER_NAMES.map((driverName) => {
    const dir = join(driversRoot, driverName);
    const manifest = join(dir, 'driver.vrdrivermanifest');
    const present = existsSync(manifest);
    const registered = externalKeys.includes(normPath(dir));
    let dll = null;
    for (const candidate of [join(dir, 'bin', 'win64', 'driver_dsh_hmd.dll'), join(dir, 'bin', 'win64', 'driver_vmt.dll')]) {
      if (existsSync(candidate)) {
        dll = candidate;
        break;
      }
    }
    return { name: driverName, dir, present, registered, dll };
  });
  const installScript = join(driversRoot, 'install-drivers.ps1');
  const uninstallScript = join(driversRoot, 'uninstall-drivers.ps1');
  return {
    driversRoot,
    drivers,
    externalDrivers: external,
    installScript,
    uninstallScript,
    ready: drivers.every((driver) => driver.present && driver.registered),
    filesPresent: drivers.every((driver) => driver.present),
    registered: drivers.every((driver) => driver.registered),
  };
}

/** 跑一个 PowerShell 脚本（安装/卸载驱动用），带超时、捕获输出、绝不抛异常。 */
function runPowerShellScript(scriptPath, timeoutMs) {
  return new Promise((resolve) => {
    if (!existsSync(scriptPath)) {
      resolve({ ok: false, code: null, timedOut: false, output: `脚本不存在：${scriptPath}` });
      return;
    }
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: null, timedOut: false, output: String(error?.message ?? error) });
      return;
    }
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, Math.max(1000, timeoutMs));
    const push = (chunk) => {
      output += String(chunk);
      if (output.length > 12_000) output = output.slice(-12_000);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut, output: `${output}\n${String(error?.message ?? error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, timedOut, output: output.trim() });
    });
  });
}

const UI_PRESS_BUTTONS = Object.freeze(['system', 'a', 'b', 'grip', 'trigger', 'thumbstick', 'trackpad']);
const UI_SIDES = Object.freeze(['left', 'right']);
const UI_ACTIONS = Object.freeze([
  'press', 'stick', 'release',
  'openQuickMenu', 'openActionMenu', 'select', 'grab', 'use',
  'hideDashboard', 'showDashboard', 'dashboardStatus',
]);

const PARAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

// ── vrchat_doctor / vrchat_mode 的小工具 ─────────────────────────────────────

const MODE_PRESETS = Object.freeze(['player', 'demo', 'chat', 'stop']);
const DOCTOR_ICON = { ok: '✅', warn: '⚠️', fail: '❌', unknown: '❔' };

/** 给 doctor 的配置切片（只给探测需要的字段，别把整个 config 漏出去）。 */
function doctorConfig(config) {
  return {
    sendPort: config.sendPort,
    listenPort: config.listenPort,
    headPort: config.headPort,
    vmtListenPort: config.vmtListenPort,
    headDriverAssumed: config.headDriverAssumed,
    playerDir: config.playerDir,
    playerNode: config.playerNode,
    playerMonitorPort: config.playerMonitorPort,
    steamVrLogPath: config.steamVrLogPath,
    timeoutMs: config.doctorTimeoutMs,
    // 插件的 bridge 自己就在 listenPort 上听；不传这个会把"自己"误报成"其它程序占用"
    listenSelf: true,
  };
}

function renderDoctorResult(value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  const verdict = typeof result.verdict === 'string' ? result.verdict : 'not-ready';
  const head = verdict === 'player-ready'
    ? '体检通过：虚拟玩家挡可用 ✅'
    : verdict === 'pose-ready'
      ? '体检通过一半：能转头/抬手，虚拟玩家还缺东西 ⚠️'
      : verdict === 'chat-ready'
        ? '当前只能走对话挡：chatbox / 参数 / 按键 ✅（转头、抬手、虚拟玩家还缺驱动或游戏）'
        : '现在还不能用 ❌';
  const lines = [head];
  for (const check of Array.isArray(result.checks) ? result.checks : []) {
    if (!check || check.level === 'ok') continue;
    lines.push(`${DOCTOR_ICON[check.level] ?? '•'} ${check.label ?? check.id}：${check.detail ?? ''}`);
  }
  const steps = Array.isArray(result.nextSteps) ? result.nextSteps.filter((step) => typeof step === 'string') : [];
  if (steps.length > 0) lines.push(`下一步：\n- ${steps.slice(0, 3).join('\n- ')}`);
  return sentence(lines.join('\n'));
}

function renderModeResult(value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  const preset = typeof result.preset === 'string' ? result.preset : '?';
  const presetName = { chat: '对话', demo: '演练（不碰 VR）', player: '虚拟玩家', stop: '关闭' }[preset] ?? preset;
  const lines = [`挡位：${presetName}`];
  if (result.running === true) {
    const perception = result.perception ? ` · 感知 ${result.perception}` : '';
    const nav = result.nav ? ` · 导航 ${result.nav}` : '';
    lines.push(`玩家运行中 pid=${result.pid ?? '?'} · 监视器 ${result.monitorUrl ?? '?'}${perception}${nav}`);
  } else if (typeof result.reason === 'string') {
    lines.push(`没有启动：${result.reason}`);
  }
  if (result.doctor && typeof result.doctor === 'object' && typeof result.doctor.verdict === 'string') {
    lines.push(`体检：${result.doctor.verdict}`);
  }
  for (const note of Array.isArray(result.notes) ? result.notes : []) {
    if (typeof note === 'string') lines.push(note);
  }
  const steps = Array.isArray(result.nextSteps) ? result.nextSteps.filter((step) => typeof step === 'string') : [];
  if (steps.length > 0) lines.push(`下一步：\n- ${steps.slice(0, 3).join('\n- ')}`);
  return sentence(lines.join('\n'));
}

/** 当前玩家进程命令行里某个 flag 的值（没在跑返回 null）。 */
function playerFlagValue(processHandle, flag) {
  const args = Array.isArray(processHandle?.info?.args) ? processHandle.info.args : [];
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function renderUiResult(value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  if (result.ok !== true) return sentence(`手柄输入失败：${result.error ?? '未知错误'}`);
  if (result.released === true) return sentence('已松开所有虚拟手柄按键/摇杆');
  if (result.action === 'dashboardStatus') {
    if (result.ok !== true) return sentence('SteamVR 面板状态：无法查询（vrcmd 没有查询命令；按一下"关掉 SteamVR 面板"即可）');
    return sentence(`SteamVR 面板当前${result.visible === true ? '可见（盖住了画面）' : '已隐藏'}`);
  }
  if (result.action === 'hideDashboard' || result.action === 'showDashboard') {
    const verb = result.action === 'hideDashboard' ? '隐藏' : '显示';
    return sentence(result.ok === true
      ? `已通过 vrcmd 让 SteamVR ${verb}面板`
      : `SteamVR 面板${verb}失败：${result.error ?? result.note ?? 'vrcmd 不可用'}`);
  }
  const sideName = result.side === 'left' ? '左手' : '右手';
  if (result.action === 'stick') {
    return sentence(`摇杆：${sideName} x=${fmt(result.x)} y=${fmt(result.y)} · 按住 ${result.durationMs ?? '?'}ms 后归零`);
  }
  return sentence(`按键：${sideName} ${result.button} 按下 ${result.durationMs ?? '?'}ms（值 ${fmt(result.value)}）`);
}

function renderScreenshotResult(value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  if (result.ok !== true) {
    return sentence(`截图失败：${result.error ?? '未知错误'}（SteamVR 的 Headset Window 只有 SteamVR 运行时才有）`);
  }
  const head = `截图 ${result.width ?? '?'}×${result.height ?? '?'} · ${Math.round((result.bytes ?? 0) / 1024)} KB · ${new Date(result.capturedAt ?? Date.now()).toLocaleTimeString('zh-CN')}`;
  if (result.image === null || result.image === undefined) {
    const probe = result.attachmentsProbe ? `\n诊断：${JSON.stringify(result.attachmentsProbe)}` : '';
    return sentence(`${head}\n（宿主没给 attachments 服务，图片没能附上）${probe}`);
  }
  return [
    { type: 'text', text: head },
    { type: 'image', attachment: result.image },
  ];
}

function renderDriversResult(value) {
  const result = value !== null && typeof value === 'object' ? value : {};
  const drivers = Array.isArray(result.drivers) ? result.drivers : [];
  const rows = drivers.map((driver) => {
    const state = driver.present !== true ? '缺文件' : (driver.registered === true ? '已装' : '未注册');
    return `${state} ${driver.name}`;
  });
  const head = `驱动：${rows.join(' · ') || '（无）'} · 目录 ${result.driversRoot ?? '?'}`;
  if (result.action === 'install' || result.action === 'uninstall') {
    const verb = result.action === 'install' ? '安装' : '卸载';
    return sentence(`${head}\n${verb}${result.ok === true ? '成功' : '失败'}（exit=${result.code ?? '?'}${result.timedOut === true ? '，超时' : ''}）\n${String(result.output ?? '').slice(-2000)}`);
  }
  return sentence(`${head}\n${result.ready === true ? '两个驱动都已装好（改完驱动要重启 SteamVR 才生效）' : '还差驱动：先用面板/工具安装，再重启 SteamVR'}`);
}const INPUT_ACTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// 位姿参数里复用的 JSON Schema 片段（DSH 只支持 JSON Schema 子集，不要加 minimum/pattern）
const POSE_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Metres, + = right.' },
    y: { type: 'number', description: 'Metres, + = up (eye level is usually ~1.6).' },
    z: { type: 'number', description: 'Metres, + = forward.' },
  },
  additionalProperties: false,
  description: 'Target position in metres, Unity left-handed space (X right, Y up, Z forward); omitted axes keep the current value.',
};

const POSE_ROTATION_SCHEMA = {
  type: 'object',
  properties: {
    yaw: { type: 'number', description: 'Degrees around Y (+ = turn right).' },
    pitch: { type: 'number', description: 'Degrees around X (+ = tilt up).' },
    roll: { type: 'number', description: 'Degrees around Z.' },
    qx: { type: 'number', description: 'Quaternion X (use qx/qy/qz/qw instead of yaw/pitch/roll).' },
    qy: { type: 'number', description: 'Quaternion Y.' },
    qz: { type: 'number', description: 'Quaternion Z.' },
    qw: { type: 'number', description: 'Quaternion W.' },
  },
  additionalProperties: false,
  description: 'Optional orientation: Euler degrees (yaw/pitch/roll) or a quaternion (qx/qy/qz/qw).',
};

const POSE_HAND_OVERRIDE_SCHEMA = {
  type: 'object',
  properties: {
    target: POSE_TARGET_SCHEMA,
    rotation: POSE_ROTATION_SCHEMA,
  },
  additionalProperties: false,
  description: 'Per-hand target used with hand="both": its target overrides the top-level target axis-by-axis, '
    + 'and its rotation overrides the top-level rotation.',
};

// 头部参数：位置与 vrchat_pose 同为 Unity 左手系；rotation 的欧拉语义更直观（pitch + = 抬头）
const HEAD_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Metres, + = right.' },
    y: { type: 'number', description: 'Metres, + = up (standing eye level is usually ~1.6).' },
    z: { type: 'number', description: 'Metres, + = forward.' },
  },
  additionalProperties: false,
  description: 'Head position in metres, Unity left-handed space (X right, Y up, Z forward); omitted axes keep the '
    + 'current value. Internally converted to the OpenVR right-handed pose the A-line driver expects.',
};

const HEAD_ROTATION_SCHEMA = {
  type: 'object',
  properties: {
    yaw: { type: 'number', description: 'Degrees around Y (+ = turn right).' },
    pitch: { type: 'number', description: 'Degrees around X (+ = look up; clamped to ±89).' },
    roll: { type: 'number', description: 'Degrees around Z (+ = tilt head right).' },
    qx: { type: 'number', description: 'Quaternion X (Unity left-handed; use qx/qy/qz/qw instead of yaw/pitch/roll).' },
    qy: { type: 'number', description: 'Quaternion Y.' },
    qz: { type: 'number', description: 'Quaternion Z.' },
    qw: { type: 'number', description: 'Quaternion W.' },
  },
  additionalProperties: false,
  description: 'Head orientation: Euler degrees (yaw/pitch/roll, +pitch = look up) or a Unity left-handed quaternion.',
};

/**
 * 把 vrchat_look 的 angleDeg/target/pitchDeg 换算成头部的绝对目标朝向（Unity 直觉欧拉角）。
 * 只在 A 线 HMD 可用（head 模式）时使用；snap 模式仍由 SnapTurner 处理。
 */
function resolveHeadLookTarget(headPose, args) {
  const current = headPose.orientation;
  const hasTarget = args?.target !== undefined && args?.target !== null;
  const angle = Number(args?.angleDeg);
  if (!hasTarget && !Number.isFinite(angle)) {
    throw new Error('vrchat_look: pass `angleDeg` or `target`');
  }
  let targetYaw;
  let targetPitch;
  if (hasTarget) {
    const x = Number(args.target?.x);
    const y = args.target?.y === undefined ? NaN : Number(args.target.y);
    const z = Number(args.target?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('vrchat_look: `target` must be a world point {x,z} (or {x,y,z})');
    }
    const dx = x - headPose.position[0];
    const dz = z - headPose.position[2];
    const horizontal = Math.hypot(dx, dz);
    targetYaw = (Math.atan2(dx, dz) * 180) / Math.PI;
    targetPitch = Number.isFinite(y)
      ? (Math.atan2(y - headPose.position[1], Math.max(1e-6, horizontal)) * 180) / Math.PI
      : current.pitch;
  } else {
    const pitchDelta = Number(args?.pitchDeg);
    targetYaw = current.yaw + angle;
    targetPitch = current.pitch + (Number.isFinite(pitchDelta) ? pitchDelta : 0);
  }
  targetPitch = Math.max(-85, Math.min(85, targetPitch));
  const deltaYaw = normalizeAngle(targetYaw - current.yaw);
  const endYaw = normalizeAngle(current.yaw + deltaYaw);
  const durationMs = Number.isInteger(args?.durationMs)
    ? Math.max(0, Math.min(10_000, args.durationMs))
    : Math.max(200, Math.min(1500, Math.round(Math.abs(deltaYaw) * 7 + Math.abs(targetPitch - current.pitch) * 7)));
  return {
    startYawDeg: current.yaw,
    endYawDeg: endYaw,
    startPitchDeg: current.pitch,
    endPitchDeg: targetPitch,
    deltaYawDeg: deltaYaw,
    deltaPitchDeg: targetPitch - current.pitch,
    durationMs,
    targetOrientation: {
      yaw: current.yaw + deltaYaw,
      pitch: targetPitch,
      roll: current.roll,
    },
  };
}

export function apply(ctx, rawConfig) {
  const config = resolveOptions(rawConfig);
  const logger = ctx.logger ?? console;
  // 插件自己的根目录：自包含发布的包里 player/ 就在它下面；开发期是 link 的源码目录。
  const pluginDir = fileURLToPath(new URL('.', import.meta.url));

  const bridge = new VRChatBridge({
    host: config.host,
    sendPort: config.sendPort,
    listenPort: config.listenPort,
    listenEnabled: config.listenEnabled,
    chatbox: {
      maxChars: config.chatboxMaxChars,
      minIntervalMs: config.chatboxMinIntervalMs,
      notificationSound: config.notificationSound,
      showTyping: config.showTyping,
    },
    events: {
      bufferSize: config.eventBufferSize,
      ignoreParams: config.noisyParams,
    },
  });

  /** Last agent that called one of our tools; a hook for future proactive wake. */
  const runtime = { lastAgent: null, startError: null };

  // 位姿通道（VMT 39570/39571）。构造是纯内存的；socket 在第一次 vrchat_pose 时才开，
  // 这样没装驱动的机器上插件启动/空闲都零副作用。
  const poseController = new PoseController({
    host: config.vmtHost,
    sendPort: config.vmtSendPort,
    listenPort: config.vmtListenPort,
    enableMode: config.vmtEnableMode,
    listenerIdleMs: config.vmtListenEnabled ? config.vmtListenerIdleMs : 0,
    probeTimeoutMs: config.vmtProbeTimeoutMs,
    probeCacheMs: config.vmtProbeCacheMs,
    probeBackoffMs: config.vmtProbeBackoffMs,
    setRoomMatrix: config.vmtSetRoomMatrix,
    hz: config.poseHz,
    holdHz: config.poseHoldHz,
    humanize: config.poseHumanize,
    idleDrift: config.poseIdleDrift,
    seed: config.poseSeed,
    logger,
  });

  // 降级版头部：snap turn 走 VRChat 的 /input/*（复用同一个 bridge 发送 socket）。
  const snapTurner = new SnapTurner({
    send: (address, args) => bridge.send(address, args),
    logger,
    mode: 'axis',
  });

  // A 线头部通道（dsh_hmd，39572）。构造纯内存；socket 在第一次 vrchat_head / head 模式转头时才开，
  // 探活用"端口是否被占用"的启发式（A 驱动没有回包）。
  const headController = new HeadController({
    host: config.headHost,
    port: config.headPort,
    hz: config.headHz,
    holdHz: config.headHoldHz,
    probeCacheMs: config.headProbeCacheMs,
    assumed: config.headDriverAssumed,
    humanize: config.headHumanize,
    idleDrift: config.headIdleDrift,
    driftAmplitude: config.headDriftAmplitude,
    driftRotationDeg: config.headDriftRotationDeg,
    seed: config.headSeed,
    logger,
  });

  // Phase 1 玩家进程（vrchat-vr-driver/player/demo.mjs）：**不 import 玩家源码**，
  // 只 spawn 子进程 + 读监视器 HTTP。构造纯内存；监听/子进程都等用户调工具才发生。
  const playerProcess = new PlayerProcess({
    playerDir: config.playerDir,
    pluginDir,
    playerNode: config.playerNode,
    monitorPort: config.playerMonitorPort,
    lineBufferSize: config.playerLogLines,
    logger,
  });

  // 虚拟手柄输入通道（/VMT/Input/*）：操控 VRChat 菜单/交互的唯一手段。
  // 未装驱动时发包无副作用（UDP 发到没人听），所以不探测、不阻塞。
  const vmtInput = createVmtInput({
    host: config.vmtHost,
    port: config.vmtSendPort,
    dryRun: config.vmtInputEnabled !== true,
    pressMs: config.uiPressMs,
    logger,
  });

  // SteamVR dashboard 控制：由 dsh_hmd 驱动调 IVROverlay 隐藏/显示（驱动合成的 system 键会被 SteamVR 过滤）。
  const dashboard = createDashboardControl({
    host: config.headHost,
    port: config.headPort,
    logger,
  });

  /** 截一张 SteamVR 画面给 agent 看（脚本来自包内 player/tools/capture_frame.ps1）。 */
  const takeScreenshot = () => captureHeadsetWindow({
    scriptPath: join(dirname(playerProcess.paths.demoPath), 'tools', 'capture_frame.ps1'),
    timeoutMs: config.screenshotTimeoutMs,
    fallbackProcess: config.screenshotFallbackProcess,
  });

  // 图片要交给宿主的 attachments 服务落盘，才能作为 image content block 回给模型。
  const attachments = ctx.get('attachments') ?? ctx.attachments ?? null;
  let lastAttachmentError = null;
  async function saveScreenshotAttachment(shot) {
    if (attachments === null || attachments === undefined || typeof attachments.saveImage !== 'function') return null;
    try {
      return await attachments.saveImage({ data: shot.png, mediaType: 'image/png', name: `vrchat-${shot.capturedAt}.png` });
    } catch (error) {
      logger.warn(`vrchat-vplay: saveImage failed — ${String(error?.message ?? error)}`);
      lastAttachmentError = String(error?.message ?? error);
      return null;
    }
  }

  ctx.effect(() => {
    // 插件卸载/重载时：先把手柄按键归零（否则 VRChat 里会有键一直按着），再关 socket。
    return () => {
      try {
        if (config.uiReleaseAllOnUnload) vmtInput.releaseAll();
      } catch { /* ignore */ }
      try {
        vmtInput.close();
      } catch { /* ignore */ }
      try {
        dashboard.close();
      } catch { /* ignore */ }
    };
  }, 'vrchat-vplay vmt input');

  ctx.effect(() => {
    bridge.on('listening', (port) => logger.info(`vrchat-vplay: listening for VRChat OSC output on ${config.host}:${port}`));
    bridge.on('listen-error', (error) => {
      runtime.startError = String(error?.message ?? error);
      logger.warn(`vrchat-vplay: cannot listen on ${config.host}:${config.listenPort} — ${runtime.startError}. `
        + 'Sending still works; check the port or VRChat\'s --osc sender port.');
    });
    bridge.on('avatar', (avatarId) => logger.info(`vrchat-vplay: avatar changed -> ${avatarId ?? 'unknown'}`));
    if (config.debug) {
      bridge.on('param', (paramName, value) => logger.info(`vrchat-vplay: ${paramName} = ${String(value)}`));
    }
    void bridge.start().catch((error) => {
      runtime.startError = String(error?.message ?? error);
      logger.error(`vrchat-vplay: bridge start failed — ${runtime.startError}`);
    });
    return () => bridge.stop();
  });

  ctx.effect(() => {
    // 插件卸载/重载时：停发送循环、把双手交还真实手柄、关掉 VMT/头追 socket。
    // dispose() 幂等；从没用过位姿工具时也安全。
    return () => {
      try {
        poseController.dispose();
      } catch (error) {
        logger.warn(`vrchat-vplay: pose controller dispose failed — ${String(error?.message ?? error)}`);
      }
      try {
        headController.dispose();
      } catch (error) {
        logger.warn(`vrchat-vplay: head controller dispose failed — ${String(error?.message ?? error)}`);
      }
    };
  }, 'vrchat-vplay pose channels');

  ctx.effect(() => {
    // 插件卸载/重载时：把玩家子进程一起停掉，避免孤儿进程继续驱动 SteamVR/VRChat。
    return () => {
      try {
        playerProcess.dispose();
      } catch (error) {
        logger.warn(`vrchat-vplay: player process dispose failed — ${String(error?.message ?? error)}`);
      }
    };
  }, 'vrchat-vplay player process');

  const tools = ctx.get('tools');
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    logger.warn('vrchat-vplay: tools service unavailable; VRChat tools were not registered');
    return;
  }

  ctx.effect(() => {
    const disposers = [];
    const register = (definition) => disposers.push(tools.register(definition));
    const touchAgent = (exec) => {
      if (exec?.agent !== undefined) runtime.lastAgent = exec.agent;
    };

    register({
      name: 'vrchat_status',
      description:
        'Show the VRChat OSC bridge state: whether the plugin is listening for VRChat output, '
        + 'the configured UDP ports, current avatar id, how recently VRChat was heard, held inputs, '
        + 'and the current values of all avatar parameters. Use this first to check the link is alive.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => json(value) },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        touchAgent(exec);
        const state = bridge.state();
        return {
          ...state,
          startError: runtime.startError,
          avatarParameters: Object.fromEntries(bridge.listParams().map((p) => [p.name, p.value])),
          bufferedEvents: bridge.events.length,
          pose: poseController.state(),
          head: headController.state(),
          look: snapTurner.state(),
          hint: state.listening
            ? 'Bridge is listening. Chatbox text goes to the VRChat chatbox; inbound parameters arrive as events.'
            : 'Not listening: check listenPort vs VRChat sender port and whether another OSC app owns the port.',
        };
      },
    });

    register({
      name: 'vrchat_say',
      description:
        'Speak in VRChat through the chatbox (the speech bubble above the avatar). Text lines become a single '
        + 'chatbox message separated by vertical tabs; messages longer than the limit are split into several '
        + 'messages and rate-limited (VRChat allows roughly 5 messages per 5 seconds). The call waits until '
        + 'every chunk was sent. Keep it short — this is how the avatar "talks" in-game.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to display in the VRChat chatbox. Newlines are supported.' },
          immediate: { type: 'boolean', description: 'Send immediately (default true). False only fills the chatbox input box.' },
          sound: { type: 'boolean', description: 'Play the chatbox notification sound (default false).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => sentence(`Sent to VRChat chatbox (${value.chunks} chunk(s), ${value.chars} chars).`) },
      isConcurrencySafe: () => false,
      timeoutMs: 60_000,
      async execute(args, exec) {
        touchAgent(exec);
        const text = typeof args?.text === 'string' ? args.text : '';
        if (text.trim().length === 0) throw new Error('vrchat_say: `text` must be a non-empty string');
        const result = await bridge.say(text, { immediate: args?.immediate, sound: args?.sound });
        return { sent: true, chunks: result.chunks ?? 1, chars: text.length, text };
      },
    });

    register({
      name: 'vrchat_list_params',
      description:
        'List the current VRChat avatar parameters the bridge has heard (name, latest value, OSC type, '
        + 'age in ms). Use it to sense what the player is doing: hand gestures, voice activity, movement, '
        + 'jumping, emotes, and any custom parameters the avatar exposes.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Case-insensitive substring filter on parameter names.' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => json(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        touchAgent(exec);
        const filter = typeof args?.filter === 'string' ? args.filter : '';
        return { params: bridge.listParams(filter), avatarId: bridge.avatarId, count: bridge.params.size };
      },
    });

    register({
      name: 'vrchat_events',
      description:
        'Read the buffered feed of OSC messages VRChat sent (avatar parameter changes, avatar change, '
        + 'tracking, other endpoints). Returns events newer than `since` plus the newest sequence number to '
        + 'pass to the next call. Noisy continuously-changing parameters (visemes, voice level, velocity) are '
        + 'filtered out unless includeNoisy is true.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'integer', description: 'Return events with seq greater than this. Default 0 = all buffered.' },
          limit: { type: 'integer', description: 'Max events to return (default 50, max 200).' },
          prefix: { type: 'string', description: 'Only parameter names starting with this prefix.' },
          kind: { type: 'string', enum: ['param', 'avatar', 'osc', 'any'], description: 'Event kind filter (default any).' },
          includeNoisy: { type: 'boolean', description: 'Include noisy params such as Voice/Viseme/Velocity (default false).' },
          latestOnly: { type: 'boolean', description: 'Collapse to the newest event per parameter (default false).' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => json(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        touchAgent(exec);
        const since = Number.isInteger(args?.since) ? args.since : 0;
        const limit = Math.min(200, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 50));
        const prefix = typeof args?.prefix === 'string' ? args.prefix : '';
        const kind = typeof args?.kind === 'string' ? args.kind : 'any';
        const includeNoisy = args?.includeNoisy === true;
        const noisy = new Set(config.noisyParams);
        let events = bridge.events.filter((event) => event.seq > since);
        if (kind !== 'any') events = events.filter((event) => event.kind === kind);
        if (prefix.length > 0) events = events.filter((event) => (event.name ?? event.address ?? '').startsWith(prefix));
        if (!includeNoisy) events = events.filter((event) => !(event.kind === 'param' && noisy.has(event.name)));
        if (args?.latestOnly === true) {
          const byName = new Map();
          for (const event of events) byName.set(event.name ?? event.address, event);
          events = [...byName.values()];
        }
        const lastSeq = bridge.seq;
        return {
          events: events.slice(-limit),
          lastSeq,
          total: events.length,
          truncated: events.length > limit,
        };
      },
    });

    register({
      name: 'vrchat_wait',
      description:
        'Block until VRChat sends a matching OSC event, or until the timeout. This is how the agent "listens" '
        + 'in-game: wait for a hand pose (GestureLeft/GestureRight), a jump (Grounded false), movement '
        + '(VelocityZ, noisy), a voice burst (Voice, noisy), a custom avatar parameter, or any endpoint. '
        + 'Returns the event, the current parameter snapshot, and the next cursor. Call it repeatedly to play.',
      parameters: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'integer', description: 'Max wait in ms (default 20000, range 1000-120000).' },
          param: { type: 'string', description: 'Wait for this exact parameter name (e.g. GestureLeft).' },
          prefix: { type: 'string', description: 'Wait for any parameter whose name starts with this prefix.' },
          kind: { type: 'string', enum: ['param', 'avatar', 'osc', 'any'], description: 'Event kind filter (default param).' },
          includeNoisy: { type: 'boolean', description: 'Allow Voice/Viseme/Velocity events to match (default false).' },
          since: { type: 'integer', description: 'Ignore events with seq <= this (default: current newest).' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => json(value) },
      isConcurrencySafe: () => true,
      timeoutMs: 130_000,
      async execute(args, exec) {
        touchAgent(exec);
        const timeoutMs = Math.min(120_000, Math.max(1_000, Number.isInteger(args?.timeoutMs) ? args.timeoutMs : 20_000));
        const param = typeof args?.param === 'string' ? args.param : '';
        const prefix = typeof args?.prefix === 'string' ? args.prefix : '';
        const kind = typeof args?.kind === 'string' ? args.kind : 'param';
        const includeNoisy = args?.includeNoisy === true;
        const from = Number.isInteger(args?.since) ? args.since : bridge.seq;
        const noisy = new Set(config.noisyParams);
        const predicate = (event) => {
          if (event.seq <= from) return false;
          if (kind !== 'any' && event.kind !== kind) return false;
          if (event.kind === 'param') {
            if (!includeNoisy && noisy.has(event.name)) return false;
            if (param.length > 0 && event.name !== param) return false;
            if (prefix.length > 0 && !String(event.name).startsWith(prefix)) return false;
          }
          return true;
        };
        const startedAt = Date.now();
        const result = await bridge.waitForEvent(predicate, timeoutMs, exec.signal);
        return {
          event: result.timeout === true || result.cancelled === true ? null : result,
          timeout: result.timeout === true,
          cancelled: result.cancelled === true,
          waitedMs: Date.now() - startedAt,
          cursor: bridge.seq,
          avatarId: bridge.avatarId,
          params: Object.fromEntries(bridge.listParams().map((p) => [p.name, p.value])),
        };
      },
    });

    register({
      name: 'vrchat_set_param',
      description:
        'Write one VRChat avatar parameter (/avatar/parameters/<name>). VRChat built-in animator parameters '
        + '(GestureLeft, Voice, Velocity...) are read-only over OSC; writable ones are the avatar\'s custom '
        + 'Expression parameters plus VRCEmote (int 1-16). Unknown names are ignored silently by VRChat.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Parameter name without the /avatar/parameters/ prefix.' },
          value: {
            oneOf: [{ type: 'number' }, { type: 'boolean' }],
            description: 'Number (int or float in -1..1) or boolean.',
          },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => sentence(`Set ${value.name} = ${String(value.value)} (${value.type}).`) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        touchAgent(exec);
        const paramName = typeof args?.name === 'string' ? args.name : '';
        if (!PARAM_NAME.test(paramName)) throw new Error(`vrchat_set_param: invalid parameter name '${paramName}'`);
        const value = args?.value;
        if (!(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
          throw new Error('vrchat_set_param: `value` must be a boolean or a finite number');
        }
        bridge.setParam(paramName, value);
        return { name: paramName, value, type: typeof value === 'boolean' ? 'bool' : Number.isInteger(value) ? 'int' : 'float' };
      },
    });

    register({
      name: 'vrchat_input',
      description:
        'Press one official VRChat OSC input action. Buttons (int 1/0): Jump, Run, MoveForward, MoveBackward, '
        + 'MoveLeft, MoveRight, LookLeft, LookRight, GrabLeft/Right, UseLeft/Right, DropLeft/Right, '
        + 'QuickMenuToggleLeft/Right, ComfortLeft/Right, Voice, PanicButton. Axes (float -1..1, auto-released '
        + 'to 0): Vertical, Horizontal, LookHorizontal, MoveHoldFB, SpinHoldCwCcw/UD/LR, UseAxisRight, '
        + 'GrabAxisRight. A press is held for holdMs, then released. While Quick Menu/Action Menu is open some '
        + 'actions are swallowed by VRChat.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action name, e.g. Jump, Run, MoveForward.' },
          holdMs: { type: 'integer', description: 'Hold time in ms before release (default 120 for buttons, 300 for axes; max 10000).' },
          value: { type: 'number', description: 'Axis value -1..1 (axes only, default 1).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => sentence(`Sent ${value.action} (${value.kind}${value.holdMs > 0 ? `, ${value.holdMs}ms` : ''}).`) },
      isConcurrencySafe: () => false,
      timeoutMs: 20_000,
      async execute(args, exec) {
        touchAgent(exec);
        const action = typeof args?.action === 'string' ? args.action : '';
        if (!INPUT_ACTION.test(action)) throw new Error(`vrchat_input: invalid action name '${action}'`);
        const axis = VRChatBridge.isAxis(action);
        const holdMs = Math.min(10_000, Math.max(0, Number.isInteger(args?.holdMs) ? args.holdMs : axis ? 300 : 120));
        if (axis) {
          const raw = typeof args?.value === 'number' && Number.isFinite(args.value) ? args.value : 1;
          const value = Math.max(-1, Math.min(1, raw));
          bridge.setAxis(action, value);
          await sleep(holdMs);
          bridge.setAxis(action, 0);
          return { action, kind: 'axis', value, holdMs };
        }
        bridge.pressButton(action, holdMs);
        return { action, kind: 'button', holdMs, official: VRChatBridge.isButton(action) };
      },
    });

    register({
      name: 'vrchat_move',
      description:
        'Walk/turn the avatar like a player holding a controller: sets the Vertical (forward/back), '
        + 'Horizontal (strafe) and LookHorizontal (turn) axes for durationMs, then releases all axes to 0. '
        + 'forward/right/look are -1..1. The call blocks for the duration (max 10s). During VR play movement '
        + 'may still be dominated by the hand controllers — verify in-client.',
      parameters: {
        type: 'object',
        properties: {
          forward: { type: 'number', description: 'Vertical axis -1..1 (positive = forward).' },
          right: { type: 'number', description: 'Horizontal axis -1..1 (positive = strafe right).' },
          look: { type: 'number', description: 'LookHorizontal axis -1..1 (positive = turn right).' },
          durationMs: { type: 'integer', description: 'How long to hold the axes (default 400, 50-10000).' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => sentence(`Moved (forward=${value.forward}, right=${value.right}, look=${value.look}) for ${value.durationMs}ms.`) },
      isConcurrencySafe: () => false,
      timeoutMs: 20_000,
      async execute(args, exec) {
        touchAgent(exec);
        const forward = Math.max(-1, Math.min(1, Number(args?.forward) || 0));
        const right = Math.max(-1, Math.min(1, Number(args?.right) || 0));
        const look = Math.max(-1, Math.min(1, Number(args?.look) || 0));
        const durationMs = Math.min(10_000, Math.max(50, Number.isInteger(args?.durationMs) ? args.durationMs : 400));
        return bridge.move({ forward, right, look, durationMs });
      },
    });

    register({
      name: 'vrchat_pose',
      description:
        'Drive the avatar\'s left/right hand pose through a local VMT (Virtual Motion Tracker) driver: sends '
        + '/VMT/Room/Unity to UDP 39570 at 30-90 Hz so the hands move smoothly (interpolated over durationMs, '
        + 'not teleported). Positions are metres in Unity left-handed space (X right, Y up, Z forward, room '
        + 'origin); eye level is usually y≈1.6. Optional rotation is Euler degrees (yaw/pitch/roll) or a '
        + 'quaternion. Motion runs in an internal timer loop and is interruptible: a later call takes over and '
        + 'the earlier call returns interrupted:true. hold=true (default) keeps streaming the final pose with '
        + 'tiny human idle drift; hold=false releases the hands back to real controller tracking. Without the '
        + 'self-compiled VMT driver the call still succeeds but reports driver.alive=false and a warning '
        + '(graceful degradation; all OSC-only tools keep working). This tool only moves hands — head/HMD pose '
        + 'is handled by the separate vrchat_head tool through the A-line HMD driver. Requires VR mode + VMT '
        + 'driver for visible effect.',
      parameters: {
        type: 'object',
        properties: {
          hand: {
            type: 'string',
            enum: ['left', 'right', 'both'],
            description: 'Which hand(s) to move (default both).',
          },
          target: POSE_TARGET_SCHEMA,
          rotation: POSE_ROTATION_SCHEMA,
          left: POSE_HAND_OVERRIDE_SCHEMA,
          right: POSE_HAND_OVERRIDE_SCHEMA,
          durationMs: {
            type: 'integer',
            description: 'Interpolation time in ms (default 600; 0 = instant; range 0-10000).',
          },
          easing: {
            type: 'string',
            enum: ['linear', 'easeOut', 'easeInOut'],
            description: 'Motion curve (default linear).',
          },
          hold: {
            type: 'boolean',
            description: 'Keep streaming the final pose with idle micro-motion after arrival (default true). '
              + 'false releases the hands to real tracking.',
          },
          holdMs: {
            type: 'integer',
            description: 'Auto-stop holding after this many ms (0 = until next call/cancel; default 0).',
          },
          hz: { type: 'integer', description: 'Send rate in Hz, 30-90 (default plugin config: 60).' },
          humanize: {
            type: 'boolean',
            description: 'Add human-like duration jitter + idle drift (default true).',
          },
          reaction: {
            type: 'boolean',
            description: 'Add a log-normal reaction delay (120-1600ms) before starting (default false).',
          },
          seed: { type: 'integer', description: 'Seed for the humanize RNG (default plugin seed).' },
          wait: {
            type: 'boolean',
            description: 'true (default) waits until the motion finishes; false returns immediately and keeps '
              + 'animating in the background (a later call interrupts it).',
          },
          roomMatrix: {
            type: 'boolean',
            description: 'Force re-sending an identity /VMT/SetRoomMatrix/Temporary before moving '
              + '(auto-sent once per session).',
          },
          cancel: {
            type: 'boolean',
            description: 'Stop the current motion instead of moving; combine with disable to hand control back.',
          },
          disable: {
            type: 'boolean',
            description: 'With cancel: send enable=0 for both hands so real controllers take over.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_OBJECT,
        render(_args, value) {
          if (value.cancelled === true) {
            return sentence(`Pose motion cancelled${value.disabled === true ? ' (hands released to real tracking)' : ''}.`);
          }
          const parts = [
            `Pose ${Array.isArray(value.sides) ? value.sides.join('+') : value.hand}`,
            `${value.effectiveDurationMs}ms ${value.easing}`,
            `${value.frames} frames @${value.hz}Hz`,
          ];
          const alive = value.driver?.alive;
          parts.push(alive === true
            ? 'VMT driver alive'
            : alive === false
              ? 'VMT driver NOT detected (degraded: packets sent best-effort)'
              : 'VMT driver state unknown');
          if (value.holdActive === true) parts.push('holding');
          if (value.interrupted === true) parts.push('interrupted by a newer motion');
          return sentence(`${parts.join(' · ')}.`);
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: 30_000,
      async execute(args, exec) {
        touchAgent(exec);
        const a = args ?? {};
        if (a.cancel === true) {
          return poseController.cancel({ disable: a.disable === true });
        }
        if (a.disable === true) {
          // 单独的 disable：等价于"放开双手"，比 cancel(disable) 更直白
          return poseController.disable();
        }
        return poseController.animate({
          hand: a.hand,
          target: a.target,
          rotation: a.rotation,
          left: a.left,
          right: a.right,
          durationMs: a.durationMs,
          easing: a.easing,
          hold: a.hold,
          holdMs: a.holdMs,
          hz: a.hz,
          humanize: a.humanize,
          reaction: a.reaction,
          seed: a.seed,
          wait: a.wait,
          roomMatrix: a.roomMatrix,
          signal: exec?.signal,
        });
      },
    });

    register({
      name: 'vrchat_head',
      description:
        'Move the avatar head/HMD with the A-line self-built HMD driver (dsh_hmd): sends /dsh/head/pose to UDP '
        + '39572 at 30-90 Hz, so the head moves smoothly (interpolated over durationMs, not teleported) and can '
        + 'look up/down as well as turn. Positions are metres in Unity left-handed space (X right, Y up, Z '
        + 'forward; standing eye level is usually ~1.6) — the same convention as vrchat_pose — and are converted '
        + 'internally to the OpenVR right-handed pose the driver expects. rotation accepts Euler degrees '
        + '(yaw + = turn right, pitch + = look up, roll + = tilt head right) or a Unity left-handed quaternion. '
        + 'The motion is interruptible: a later call takes over and the earlier one returns interrupted:true. '
        + 'hold=true (default) keeps a low-rate stream with gentle breathing/drift after arrival. The driver has '
        + 'no reply packet, so availability is inferred from whether UDP 39572 is in use; without the driver the '
        + 'call still succeeds but reports driver.alive=false/unknown and a warning (graceful degradation). '
        + 'Requires SteamVR + the dsh_hmd driver + VRChat in VR mode for a visible effect.',
      parameters: {
        type: 'object',
        properties: {
          target: HEAD_TARGET_SCHEMA,
          rotation: HEAD_ROTATION_SCHEMA,
          durationMs: {
            type: 'integer',
            description: 'Interpolation time in ms (default 600; 0 = instant; range 0-10000).',
          },
          easing: {
            type: 'string',
            enum: ['linear', 'easeOut', 'easeInOut'],
            description: 'Motion curve (default linear).',
          },
          hold: {
            type: 'boolean',
            description: 'Keep streaming the final pose with breathing/idle micro-motion after arrival (default true).',
          },
          holdMs: {
            type: 'integer',
            description: 'Auto-stop holding after this many ms (0 = until next call/cancel; default 0).',
          },
          hz: { type: 'integer', description: 'Send rate in Hz, 30-90 (default plugin config: 90).' },
          humanize: {
            type: 'boolean',
            description: 'Add human-like duration jitter + idle breathing (default true).',
          },
          seed: { type: 'integer', description: 'Seed for the humanize RNG (default plugin seed).' },
          wait: {
            type: 'boolean',
            description: 'true (default) waits until the motion finishes; false returns immediately and keeps '
              + 'animating in the background (a later call interrupts it).',
          },
          cancel: {
            type: 'boolean',
            description: 'Stop the current head motion instead of moving (the driver keeps the last commanded pose).',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_OBJECT,
        render(_args, value) {
          if (value.cancelled === true) {
            return sentence('Head motion cancelled (the driver keeps the last commanded pose).');
          }
          const orientation = value.to?.orientation ?? {};
          const parts = [
            `Head ${value.effectiveDurationMs}ms ${value.easing}`,
            `→ (${fmtVec(value.to?.position)}) yaw ${fmt(value.to?.orientation?.yaw)}° pitch ${fmt(value.to?.orientation?.pitch)}°`,
            `${value.frames} frames @${value.hz}Hz`,
          ];
          const alive = value.driver?.alive;
          parts.push(alive === true
            ? 'dsh_hmd alive'
            : alive === false
              ? 'dsh_hmd NOT detected (degraded: packets sent best-effort)'
              : 'dsh_hmd state unknown');
          if (value.holdActive === true) parts.push('breathing');
          if (value.interrupted === true) parts.push('interrupted by a newer motion');
          return sentence(`${parts.join(' · ')}.`);
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: 30_000,
      async execute(args, exec) {
        touchAgent(exec);
        const a = args ?? {};
        if (a.cancel === true) return headController.cancel();
        return headController.animate({
          target: a.target,
          rotation: a.rotation,
          durationMs: a.durationMs,
          easing: a.easing,
          hold: a.hold,
          holdMs: a.holdMs,
          hz: a.hz,
          humanize: a.humanize,
          seed: a.seed,
          wait: a.wait,
          signal: exec?.signal,
        });
      },
    });

    register({
      name: 'vrchat_look',
      description:
        'Turn the avatar to a relative angle or toward a world point. Default mode="auto": if the A-line HMD '
        + 'driver (dsh_hmd) is running it does a real, precise head turn via vrchat_head (yaw + pitch, smooth '
        + 'interpolation); otherwise it falls back to VRChat OSC snap turns (N × stepDeg, 45° by default, with '
        + 'human-like 180-320ms gaps). mode="head" forces the head channel (falls back to snap with a warning '
        + 'when the driver is missing); mode="snap" forces snap turns; legacy mode="axis"/"comfort" mean snap '
        + 'with that input. angleDeg is relative (+ = right); target {x,z} or {x,y,z} faces that world point; '
        + 'pitchDeg (head mode) adds up/down. planOnly computes the plan without sending. Head mode needs '
        + 'SteamVR + dsh_hmd + VRChat VR; snap mode also works in desktop mode.',
      parameters: {
        type: 'object',
        properties: {
          angleDeg: {
            type: 'number',
            description: 'Relative yaw turn in degrees (+ = right). Ignored when target is given.',
          },
          target: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'World X (metres).' },
              y: { type: 'number', description: 'World Y (metres; used for pitch in head mode).' },
              z: { type: 'number', description: 'World Z (metres).' },
            },
            additionalProperties: false,
            description: 'World point to face: yaw = atan2(dx, dz) from the head, pitch from the height difference.',
          },
          pitchDeg: {
            type: 'number',
            description: 'Relative pitch in degrees (+ = look up), head mode only (default 0).',
          },
          durationMs: {
            type: 'integer',
            description: 'Head-mode turn duration in ms (default derived from the angle; max 10000).',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'head', 'snap', 'axis', 'comfort'],
            description: 'auto (default) = head if the A-line driver is up, else snap; head = force head; '
              + 'snap = force snap turns; axis/comfort = legacy snap sub-modes.',
          },
          snapMode: {
            type: 'string',
            enum: ['axis', 'comfort'],
            description: 'Snap sub-mode when snapping: axis = /input/LookHorizontal (default), comfort = ComfortLeft/Right buttons (VR only).',
          },
          stepDeg: { type: 'number', description: 'Snap step in degrees (default 45, range 1-180).' },
          gapMinMs: { type: 'integer', description: 'Min gap between snaps in ms (default 180).' },
          gapMaxMs: { type: 'integer', description: 'Max gap between snaps in ms (default 320).' },
          holdMs: { type: 'integer', description: 'How long each snap input is held in ms (default 90).' },
          maxSnaps: { type: 'integer', description: 'Safety cap on snaps per call (default 16).' },
          currentYawDeg: {
            type: 'number',
            description: 'Optional calibration of the current yaw (degrees); head mode syncs the estimated head yaw to it.',
          },
          seed: { type: 'integer', description: 'Seed for gap/motion jitter.' },
          planOnly: {
            type: 'boolean',
            description: 'Only compute the plan; send nothing.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_OBJECT,
        render(_args, value) {
          if (value.planOnly === true) {
            if (value.mode === 'head') {
              return sentence(`Head look plan: yaw ${fmt(value.requestedDeg)}°, pitch ${fmt(value.pitchDeg)}° in ${value.durationMs}ms (no packets sent).`);
            }
            const side = value.direction > 0 ? 'right' : value.direction < 0 ? 'left' : 'no direction';
            return sentence(`Snap turn plan: ${Math.abs(value.snaps)} × ${value.stepDeg}° = ${Math.abs(value.achievedDeg)}° (${side}), no packets sent.`);
          }
          if (value.mode === 'head') {
            if (value.cancelled === true) {
              return sentence(`Head turn cancelled after yaw ${fmt(value.actualDeg)}°.`);
            }
            const parts = [
              `Head turned yaw ${fmt(value.actualDeg)}° pitch ${fmt(value.pitchDeg)}°`,
              `${value.effectiveDurationMs}ms`,
              `${value.frames} frames @${value.hz}Hz`,
            ];
            if (value.holdActive === true) parts.push('breathing');
            if (value.fallback === true) parts.push('snap fallback');
            return sentence(`${parts.join(' · ')}.`);
          }
          const side = value.direction > 0 ? 'right' : value.direction < 0 ? 'left' : 'no direction';
          if (value.cancelled === true) {
            return sentence(`Snap turn cancelled after ${Math.abs(value.snaps)} snap(s) (~${value.actualDeg}°).`);
          }
          if (value.snaps === 0) {
            return sentence(`No snap turn: requested ${value.requestedDeg}° is below half a step (${value.stepDeg}°).`);
          }
          const fallback = value.fallback === true ? ' (head driver unavailable → snap turn)' : '';
          return sentence(`Turned ${value.actualDeg}° (${side}) via ${Math.abs(value.snaps)} snap(s) of ${value.stepDeg}°${fallback}; estimated yaw ~${value.endYawDeg}°.`);
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: 30_000,
      async execute(args, exec) {
        touchAgent(exec);
        const a = args ?? {};
        const requested = normalizeLookMode(a.mode ?? config.lookMode);
        const mode = requested.mode;
        const snapMode = normalizeSnapMode(a.snapMode ?? requested.snapMode);
        const signal = exec?.signal;
        const planOnly = a.planOnly === true;

        const headProbe = await headController.probeDriver();
        const headAvailable = headProbe.alive === true;
        const useHead = (mode === 'head' || mode === 'auto') && headAvailable;

        if (useHead) {
          // 可选校准：agent 说"我现在朝 X°"，把头部估计朝向对齐（不发包）
          const calibration = Number(a.currentYawDeg);
          if (Number.isFinite(calibration)) {
            headController.syncOrientation({ ...headController.pose.orientation, yaw: calibration });
          }
          const look = resolveHeadLookTarget(headController.pose, a);
          if (planOnly) {
            return {
              planOnly: true,
              mode: 'head',
              snapMode: null,
              headAvailable: true,
              driver: headProbe,
              requestedDeg: look.deltaYawDeg,
              pitchDeg: look.deltaPitchDeg,
              startYawDeg: look.startYawDeg,
              endYawDeg: look.endYawDeg,
              startPitchDeg: look.startPitchDeg,
              endPitchDeg: look.endPitchDeg,
              durationMs: look.durationMs,
              targetOrientation: look.targetOrientation,
            };
          }
          if (Math.abs(look.deltaYawDeg) < 0.5 && Math.abs(look.deltaPitchDeg) < 0.5) {
            return {
              ok: true,
              mode: 'head',
              snapMode: null,
              headAvailable: true,
              cancelled: false,
              finished: true,
              requestedDeg: look.deltaYawDeg,
              actualDeg: 0,
              pitchDeg: 0,
              startYawDeg: look.startYawDeg,
              endYawDeg: look.endYawDeg,
              startPitchDeg: look.startPitchDeg,
              endPitchDeg: look.endPitchDeg,
              durationMs: look.durationMs,
              effectiveDurationMs: 0,
              easing: 'linear',
              hz: headController.hz,
              frames: 0,
              hold: false,
              holdActive: false,
              packetsSent: 0,
              elapsedMs: 0,
              driver: headProbe,
              warning: '角度/俯仰不足 0.5°，没有发送头部动作。',
            };
          }
          const result = await headController.animate({
            orientation: look.targetOrientation,
            durationMs: look.durationMs,
            easing: a.easing,
            hold: a.hold,
            holdMs: a.holdMs,
            hz: a.hz,
            humanize: a.humanize,
            seed: a.seed,
            wait: a.wait === undefined ? true : a.wait,
            signal,
          });
          const endOrientation = headController.pose.orientation;
          // 让 snap 回退时 yaw 估计能接续
          snapTurner.yawDeg = endOrientation.yaw;
          return {
            ...result,
            mode: 'head',
            snapMode: null,
            headAvailable: true,
            fallback: false,
            requestedDeg: look.deltaYawDeg,
            actualDeg: normalizeAngle(endOrientation.yaw - look.startYawDeg),
            pitchDeg: endOrientation.pitch - look.startPitchDeg,
            startYawDeg: look.startYawDeg,
            endYawDeg: normalizeAngle(endOrientation.yaw),
            startPitchDeg: look.startPitchDeg,
            endPitchDeg: endOrientation.pitch,
            driver: headProbe,
            warning: result.warning ?? null,
          };
        }

        // ── snap turn（auto 在头部不可用时走这里；head 不可用 = 降级）──
        const fallbackWarning = mode === 'head'
          ? `A-line head driver not available (${headProbe.reason}); fell back to snap turn.`
          : null;
        const snapInput = {
          angleDeg: a.angleDeg,
          target: a.target,
          stepDeg: a.stepDeg,
          mode: snapMode,
          gapMinMs: a.gapMinMs,
          gapMaxMs: a.gapMaxMs,
          holdMs: a.holdMs,
          maxSnaps: a.maxSnaps,
          currentYawDeg: a.currentYawDeg,
          seed: a.seed,
        };
        if (planOnly) {
          return {
            ...snapTurner.plan(snapInput),
            planOnly: true,
            mode: 'snap',
            snapMode,
            headAvailable,
            driver: headProbe,
          };
        }
        const result = await snapTurner.turn({ ...snapInput, signal });
        return {
          ...result,
          mode: 'snap',
          snapMode,
          headAvailable,
          fallback: mode === 'head',
          driver: headProbe,
          warning: result.warning ?? fallbackWarning,
        };
      },
    });

    register({
      name: 'vrchat_player',
      description:
        'Start/stop/inspect the Phase 1 virtual-player process (vrchat-vr-driver/player/demo.mjs) without a terminal. '
        + 'action="start" spawns `node <playerDir>/player/demo.mjs` with optional flags --live (real VR: dsh_hmd/VMT/'
        + 'VRChat), --perception off|vision|log|hybrid, --seconds, --seed, --port (monitor HTTP), captures stdout/'
        + 'stderr into a 300-line ring buffer, and returns pid + monitor URL. action="stop" terminates the child '
        + '(SIGTERM, then taskkill /T /F on Windows) and returns its exit code. action="status" reports whether the '
        + 'child is alive + uptime and reads the monitor /health and /state (action/position/yaw/targets/fps; a '
        + 'monitor that is not running is reported gracefully, never an error). action="log" returns the last N '
        + 'output lines. Only one player process is managed at a time. Safe to call from chat; no terminal needed.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status', 'log'],
            description: 'start = spawn demo.mjs; stop = terminate it; status = alive + monitor /health + /state; log = tail output.',
          },
          live: {
            type: 'boolean',
            description: 'start only: true = real VR (drives dsh_hmd/VMT/VRChat); false/omitted = dry-run (monitor only).',
          },
          perception: {
            type: 'string',
            enum: ['off', 'vision', 'log', 'hybrid'],
            description: 'start only: perception mode (demo default: dry-run off / live vision).',
          },
          seconds: {
            type: 'integer',
            description: 'start only: demo duration in seconds (>=5); omit to use the demo default (35).',
          },
          seed: { type: 'integer', description: 'start only: RNG seed (0..2147483647) for replayable demos.' },
          nav: {
            type: 'string',
            enum: ['on', 'off'],
            description: 'start only: collision navigation (A* over the map) on/off; demo default off.',
          },
          map: {
            type: 'string',
            description: 'start only: occupancy map file passed to demo.mjs --map (default player/maps/home.json).',
          },
          monitorPort: {
            type: 'integer',
            description: 'start/status: monitor HTTP port (start passes --port; status queries 127.0.0.1:<port>).',
          },
          lines: { type: 'integer', description: 'log only: how many trailing output lines to return (default 40, max 300).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderPlayerResult(value) },
      isConcurrencySafe: () => false,
      timeoutMs: 30_000,
      async execute(args, exec) {
        touchAgent(exec);
        const action = typeof args?.action === 'string' ? args.action : '';
        if (action === 'start') {
          return playerProcess.start({
            live: args?.live === true,
            perception: args?.perception,
            nav: args?.nav,
            map: args?.map,
            seconds: args?.seconds,
            seed: args?.seed,
            monitorPort: args?.monitorPort,
          });
        }
        if (action === 'stop') return playerProcess.stop();
        if (action === 'status') return playerProcess.status({ monitorPort: args?.monitorPort });
        if (action === 'log') return playerProcess.log({ lines: args?.lines });
        throw new Error('vrchat_player: `action` must be start|stop|status|log');
      },
    });

    register({
      name: 'vrchat_player_preflight',
      description:
        'Run the Phase 1 player preflight health check (vrchat-vr-driver/player/tools/preflight.mjs): checks that the '
        + 'HMD/VMT/VRChat driver endpoints and processes look sane before a real (--live) session. Spawns the script '
        + 'with node and returns its exit code plus a short output summary. Read-only: it does not start VRChat or '
        + 'send poses. Use it before vrchat_player({action:"start", live:true}).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderPlayerResult(value) },
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      async execute(_args, exec) {
        touchAgent(exec);
        return playerProcess.runPreflight();
      },
    });

    const doctorTool = {
      name: 'vrchat_doctor',
      description:
        'Read-only health check of the whole local stack (about 2s, no side effects). Reports which level is usable — '
        + 'chat-only (OSC), head+hands (dsh_hmd/VMT drivers), or full virtual player (Steam + SteamVR + VRChat + '
        + 'monitor) — and the single next thing to fix, in plain language. Call this first after install or when a tool '
        + 'does not work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderDoctorResult(value) },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(_args, exec) {
        touchAgent(exec);
        return runDoctor(doctorConfig(config), {});
      },
    };
    register(doctorTool);

    const modeTool = {
      name: 'vrchat_mode',
      description:
        'One-knob gear shifter for the virtual player (built for humans who do not want to remember flags). '
        + 'preset="player" = live VR virtual player (needs Steam/SteamVR/VRChat; checks health first and refuses with '
        + 'the exact next step); preset="demo" = safe dry-run that only feeds the 3D skeleton monitor and never touches '
        + 'VR; preset="chat" = stop the player and stay in chat-only mode; preset="stop" = stop the player. '
        + 'perception picks how it senses the world (off/vision/log/hybrid), nav turns A* collision navigation on/off, '
        + 'launch=true will start Steam -> SteamVR -> VRChat in that order when they are missing. Changing these while a '
        + 'player is running restarts it with the new gear automatically.',
      parameters: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            enum: ['player', 'demo', 'chat', 'stop'],
            description: 'player = live VR; demo = dry-run on the 3D monitor; chat = stop player; stop = stop player.',
          },
          perception: {
            type: 'string',
            enum: ['off', 'vision', 'log', 'hybrid'],
            description: 'How the player senses others: off = no IO; vision = screenshots only (never reads logs, the '
              + 'live default); log = VRChat log only (never screenshots); hybrid = both.',
          },
          nav: { type: 'string', enum: ['on', 'off'], description: 'A* collision navigation (default on for live, off for demo).' },
          seconds: { type: 'integer', description: 'Run duration in seconds (default 300 live / 60 demo).' },
          seed: { type: 'integer', description: 'RNG seed for reproducible motion.' },
          launch: {
            type: 'boolean',
            description: 'true = when Steam/SteamVR/VRChat are missing, start them in order and wait (up to ~2 minutes).',
          },
          force: { type: 'boolean', description: 'true = start even when the health check says the player is not ready (debug only).' },
          map: { type: 'string', description: 'Optional occupancy map path (default player/maps/home.json).' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderModeResult(value) },
      isConcurrencySafe: () => false,
      timeoutMs: 180_000,
      async execute(args, exec) {
        touchAgent(exec);
        const preset = MODE_PRESETS.includes(args?.preset) ? args.preset : 'player';
        const notes = [];

        // 关闭 / 回到对话挡：都只需要把玩家进程停掉
        if (preset === 'stop' || preset === 'chat') {
          const stopResult = await playerProcess.stop();
          return {
            preset,
            running: false,
            stopped: stopResult.stopped === true,
            forced: stopResult.forced === true,
            reason: preset === 'chat'
              ? '已切到对话挡：只走 OSC（chatbox / 参数 / 按键），不再发位姿、不启动玩家'
              : '已关闭虚拟玩家：位姿与头显交还真实设备',
            notes: stopResult.stopped === true ? [`玩家已停止（pid=${stopResult.pid ?? '?'}，运行 ${fmtSeconds(stopResult.uptimeMs)}s）`] : [],
            nextSteps: preset === 'chat'
              ? ['用 vrchat_say 说第一句', '用 vrchat_list_params 看对方的动作/姿态参数']
              : ['需要时再调用 vrchat_mode({preset:"player"}) 重新开'],
          };
        }

        const live = preset === 'player';
        const perception = PLAYER_PERCEPTION_MODES.includes(args?.perception)
          ? args.perception
          : (live ? config.playerPerception : 'off');
        const nav = args?.nav === 'on' || args?.nav === 'off'
          ? args.nav
          : (live ? config.playerNav : 'off');
        const mapPath = typeof args?.map === 'string' && args.map.trim().length > 0
          ? args.map.trim()
          : (config.playerMapPath.length > 0 ? config.playerMapPath : undefined);
        const seconds = Number.isInteger(args?.seconds)
          ? args.seconds
          : (live ? config.playerDefaultSeconds : config.demoDefaultSeconds);

        let doctor = null;
        let launchResult = null;
        if (live) {
          doctor = await runDoctor(doctorConfig(config), {});
          const notReady = doctor?.summary?.player !== true;
          if (notReady && args?.force !== true) {
            if (args?.launch === true || config.playerAutoLaunch) {
              launchResult = await ensureGameStack({ launch: true }, {});
              const startedNames = (Array.isArray(launchResult?.started) ? launchResult.started : [])
                .map((item) => item?.name)
                .filter((name) => typeof name === 'string');
              notes.push(startedNames.length > 0
                ? `已按顺序启动：${startedNames.join(' → ')}`
                : 'Steam / SteamVR / VRChat 都已在运行，没有需要启动的');
              if (Array.isArray(launchResult?.failed) && launchResult.failed.length > 0) {
                notes.push(`启动失败：${launchResult.failed.map((item) => item?.name).filter(Boolean).join('、')}（可以手动开一次）`);
              }
              doctor = await runDoctor(doctorConfig(config), {});
            }
            if (doctor?.summary?.player !== true) {
              const nextSteps = Array.isArray(doctor?.nextSteps) ? doctor.nextSteps : [];
              return {
                preset,
                running: false,
                reason: nextSteps[0] ?? '体检没过，先别启动（运行 vrchat_doctor 看详细）',
                doctor,
                launch: launchResult === null ? null : { ok: launchResult.ok, started: launchResult.started, failed: launchResult.failed },
                notes,
                nextSteps,
              };
            }
          } else if (notReady) {
            notes.push('体检没过，按 force=true 强行启动（只建议调试时用）');
          }
        } else {
          notes.push('演练挡：只把三维骨架喂给监视器，不给 SteamVR / VRChat 发任何包');
        }

        // 已经在跑但挡位参数变了 → 自动重启，别让用户自己 stop 再 start
        let restarted = false;
        if (playerProcess.running) {
          const liveMatches = (playerProcess.info?.args ?? []).includes('--live') === live;
          const perceptionMatches = playerFlagValue(playerProcess, '--perception') === perception;
          const navMatches = playerFlagValue(playerProcess, '--nav') === nav;
          if (!liveMatches || !perceptionMatches || !navMatches) {
            await playerProcess.stop();
            restarted = true;
            notes.push('挡位参数变了，已自动重启玩家进程');
          }
        }

        const started = await playerProcess.start({ live, perception, nav, map: mapPath, seconds, seed: args?.seed });
        if (live) {
          // 真机挡：顺手把 SteamVR dashboard 收起来（它自动打开时会盖住 VRChat 画面）
          const hideResult = await dashboard.hide();
          if (hideResult.ok === true) notes.push('已隐藏 SteamVR 面板（vrcmd --hidedashboard）');
        }
        const nextSteps = live
          ? [`打开 ${started.monitorUrl} 看三维骨架和实时轨迹`, '说「停下」或调用 vrchat_mode({preset:"stop"}) 关掉']
          : [`打开 ${started.monitorUrl} 看三维骨架（演练不碰游戏）`, '满意了再调用 vrchat_mode({preset:"player"}) 进游戏'];
        return {
          preset,
          running: true,
          started: started.started === true,
          restarted,
          alreadyRunning: started.alreadyRunning === true,
          pid: started.pid ?? null,
          monitorUrl: started.monitorUrl ?? null,
          args: started.args ?? [],
          live,
          perception,
          nav,
          seconds,
          doctor: doctor === null ? null : { verdict: doctor.verdict, summary: doctor.summary, nextSteps: doctor.nextSteps },
          launch: launchResult === null ? null : { ok: launchResult.ok, started: launchResult.started, failed: launchResult.failed },
          notes,
          nextSteps,
        };
      },
    };
    register(modeTool);

    // ── 虚拟手柄输入：像人一样点菜单/抓东西（VMT 现在是 knuckles 类型，VRChat 自带 binding 生效）──
    const uiTool = {
      name: 'vrchat_ui',
      description:
        'Drive the virtual hand controllers like a human: press A/B/system/grip, pull the trigger, push the thumbstick. '
        + 'This is how the agent actually clicks VRChat menus and grabs/uses objects (the virtual controllers identify as '
        + 'knuckles, so VRChat\'s own SteamVR binding applies). Typical loop: vrchat_screenshot to see the screen -> '
        + 'vrchat_pose to aim the hand -> vrchat_ui({action:"select"}) to click -> vrchat_screenshot to confirm. '
        + 'action="openQuickMenu" = left B, "openActionMenu" = left A, "select"/"use" = right trigger, "grab" = right grip; '
        + 'press/stick take explicit button/side.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...UI_ACTIONS],
            description: 'press = one button; stick = thumbstick (needs x/y); release = let go of everything; '
              + 'the rest are one-call combos (openQuickMenu/openActionMenu/select/grab/use).',
          },
          button: {
            type: 'string',
            enum: [...UI_PRESS_BUTTONS],
            description: 'press only: system | a | b | grip | trigger | thumbstick | trackpad.',
          },
          side: { type: 'string', enum: [...UI_SIDES], description: 'Which hand (default right).' },
          durationMs: { type: 'integer', description: 'How long to hold the button (default from config uiPressMs=140).' },
          value: { type: 'number', description: 'Analog value 0..1 for trigger/grip (default 1 = full pull).' },
          x: { type: 'number', description: 'stick only: X axis -1..1.' },
          y: { type: 'number', description: 'stick only: Y axis -1..1.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderUiResult(value) },
      isConcurrencySafe: () => false,
      timeoutMs: 20_000,
      async execute(args, exec) {
        touchAgent(exec);
        const action = UI_ACTIONS.includes(args?.action) ? args.action : 'press';
        const side = UI_SIDES.includes(args?.side) ? args.side : 'right';
        const button = UI_PRESS_BUTTONS.includes(args?.button) ? args.button : 'trigger';
        const durationMs = Number.isFinite(Number(args?.durationMs))
          ? Math.min(5000, Math.max(20, Math.round(Number(args.durationMs))))
          : config.uiPressMs;
        if (action === 'release') {
          vmtInput.releaseAll();
          return { ok: true, action, released: true, stats: vmtInput.stats };
        }
        // SteamVR dashboard 控制（由 dsh_hmd 驱动调 IVROverlay；合成的 system 键会被过滤）
        if (action === 'hideDashboard' || action === 'showDashboard' || action === 'dashboardStatus') {
          if (action === 'dashboardStatus') {
            const status = await dashboard.status();
            return { ok: status.ok === true, action, ...status, stats: dashboard.stats };
          }
          const result = action === 'hideDashboard' ? await dashboard.hide() : await dashboard.show();
          return { ok: result.ok === true, action, result, stats: dashboard.stats };
        }
        if (action === 'stick') {
          const x = Number.isFinite(Number(args?.x)) ? Math.min(1, Math.max(-1, Number(args.x))) : 0;
          const y = Number.isFinite(Number(args?.y)) ? Math.min(1, Math.max(-1, Number(args.y))) : 0;
          const result = await vmtInput.stick(side, x, y, { durationMs });
          return { ok: true, action, side, x, y, durationMs, result, stats: vmtInput.stats };
        }
        const combos = {
          // VRChat 自带 bindings_knuckles.json：左右手 b → /actions/global/in/menu "Menu (Combined)"；
          // 短按=Quick Menu、长按≈Action Menu（游戏内部分流，长按 600ms 是推断值）。
          openQuickMenu: { button: 'b', side: 'left', durationMs: 140 },
          openActionMenu: { button: 'b', side: 'left', durationMs: 600 },
          select: { button: 'trigger', side: 'right' },
          grab: { button: 'grip', side: 'right' },
          use: { button: 'trigger', side: 'right' },
        };
        const pressed = action === 'press' ? { button, side } : (combos[action] ?? { button: 'trigger', side: 'right' });
        const holdMs = action === 'press' ? durationMs : (combos[action]?.durationMs ?? durationMs);
        const value = Number.isFinite(Number(args?.value)) ? Math.min(1, Math.max(0, Number(args.value))) : 1;
        // 扳机/握把支持模拟量：value<1 走 `/VMT/Input/Trigger`（带数值），否则就是一次完整按键
        const analog = (pressed.button === 'trigger' || pressed.button === 'grip') && value < 1;
        const result = analog
          ? await vmtInput.trigger(pressed.side, value, { durationMs: holdMs, component: pressed.button })
          : await vmtInput.press(pressed.button, pressed.side, { durationMs: holdMs });
        return {
          ok: true,
          action,
          button: pressed.button,
          side: pressed.side,
          durationMs: holdMs,
          value,
          result,
          stats: vmtInput.stats,
        };
      },
    };
    register(uiTool);

    // ── 截图：agent 的"眼睛"（OSC 没有 UI 状态回读，只能靠看）──
    const screenshotTool = {
      name: 'vrchat_screenshot',
      description:
        'Capture what the headset currently shows, as an image (SteamVR "Headset Window"; falls back to the VRChat '
        + 'window when VRChat runs in desktop mode). Read-only, sends no input. Use it to see VRChat menus/worlds '
        + 'before aiming with vrchat_pose and clicking with vrchat_ui.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderScreenshotResult(value) },
      isConcurrencySafe: () => true,
      timeoutMs: 25_000,
      async execute(_args, exec) {
        touchAgent(exec);
        const shot = await takeScreenshot();
        if (shot.ok !== true) {
          return { ok: false, error: shot.error, attempts: shot.attempts ?? [] };
        }
        const image = await saveScreenshotAttachment(shot);
        return {
          ok: true,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          title: shot.title,
          capturedAt: shot.capturedAt,
          image,
          attachmentsProbe: {
            byGet: typeof ctx.get === 'function' ? String(typeof ctx.get('attachments')) : 'no-get',
            byProp: String(typeof (ctx.attachments ?? 'undefined')),
            serviceSaveImage: String(typeof (ctx.attachments?.saveImage ?? ctx.get?.('attachments')?.saveImage)),
            lastError: lastAttachmentError,
          },
        };
      },
    };
    register(screenshotTool);

    // ── 驱动随包：体检 / 一键安装（不敲命令行）──
    const driversTool = {
      name: 'vrchat_drivers',
      description:
        'Check or install the two bundled SteamVR drivers that make head/hand poses and the virtual player real: '
        + 'dsh_hmd (virtual HMD) and vmt (virtual controllers, now identifying as knuckles so VRChat menus can be '
        + 'clicked). status = pure read; install/uninstall = run drivers/install-drivers.ps1 (vrpathreg); SteamVR must '
        + 'be restarted afterwards.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'install', 'uninstall'], description: 'Default status.' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => renderDriversResult(value) },
      isConcurrencySafe: () => false,
      timeoutMs: 150_000,
      async execute(args, exec) {
        touchAgent(exec);
        const action = args?.action === 'install' || args?.action === 'uninstall' ? args.action : 'status';
        const before = driverStatus(config, pluginDir);
        if (action === 'status') return { action, ok: before.ready, ...before };
        const script = action === 'install' ? before.installScript : before.uninstallScript;
        const run = await runPowerShellScript(script, config.driversInstallTimeoutMs);
        return {
          action,
          ok: run.ok,
          code: run.code,
          timedOut: run.timedOut,
          output: run.output,
          status: driverStatus(config, pluginDir),
        };
      },
    };
    register(driversTool);

    // ── 本地按钮控制台：不敲命令行也能体检/切挡/按键 ──
    ctx.effect(() => {
      if (config.panelEnabled !== true) return () => {};
      const panel = createPanel({
        host: config.panelHost,
        port: config.panelPort,
        config: { pluginDir, monitorUrl: () => `http://127.0.0.1:${playerProcess.info?.monitorPort ?? config.playerMonitorPort}/` },
        actions: {
          doctor: () => runDoctor(doctorConfig(config), {}),
          mode: (preset, opts) => modeTool.execute({ ...(opts !== null && typeof opts === 'object' ? opts : {}), preset }, {}),
          stop: () => playerProcess.stop(),
          status: () => playerProcess.status({}),
          press: (button, side, opts) => vmtInput.press(
            UI_PRESS_BUTTONS.includes(button) ? button : 'trigger',
            UI_SIDES.includes(side) ? side : 'right',
            opts !== null && typeof opts === 'object' ? opts : {},
          ),
          stick: (side, x, y, opts) => vmtInput.stick(
            UI_SIDES.includes(side) ? side : 'right',
            Number.isFinite(Number(x)) ? Math.min(1, Math.max(-1, Number(x))) : 0,
            Number.isFinite(Number(y)) ? Math.min(1, Math.max(-1, Number(y))) : 0,
            opts !== null && typeof opts === 'object' ? opts : {},
          ),
          release: () => {
            vmtInput.releaseAll();
            return { ok: true };
          },
          dashboardHide: async () => {
            const result = await dashboard.hide();
            return { ok: result.ok === true, ...result };
          },
          dashboardShow: async () => {
            const result = await dashboard.show();
            return { ok: result.ok === true, ...result };
          },
          screenshot: async () => {
            const shot = await takeScreenshot();
            if (shot.ok !== true) return { ok: false, error: shot.error };
            return {
              ok: true,
              width: shot.width,
              height: shot.height,
              capturedAt: shot.capturedAt,
              dataUrl: `data:image/png;base64,${shot.png.toString('base64')}`,
            };
          },
          driversStatus: () => driverStatus(config, pluginDir),
          installDrivers: () => runPowerShellScript(driverStatus(config, pluginDir).installScript, config.driversInstallTimeoutMs),
        },
      });
      void (async () => {
        try {
          const started = await panel.start();
          if (started !== null && typeof started === 'object' && started.usable === true) {
            logger.info(`vrchat-vplay: control panel at ${started.url ?? panel.url}`);
          } else {
            logger.warn(`vrchat-vplay: control panel not available — ${started?.error ?? 'unknown'}`);
          }
        } catch (error) {
          logger.warn(`vrchat-vplay: control panel failed — ${String(error?.message ?? error)}`);
        }
      })();
      return () => {
        try { panel.close(); } catch { /* ignore */ }
      };
    }, 'vrchat-vplay control panel');

    register({
      name: 'vrchat_osc_send',
      description:
        'Advanced escape hatch: send one raw OSC message to VRChat. Address must start with "/" and arguments '
        + 'are OSC-typed objects ({type:"s"|"i"|"f"|"b", value}) or plain strings/booleans/numbers (int detected '
        + 'from the value). Prefer the dedicated tools unless an endpoint is not covered.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'OSC address, e.g. /chatbox/input.' },
          args: {
            type: 'array',
            description: 'OSC arguments; each is a typed object or a plain JSON scalar.',
            items: {},
          },
        },
        required: ['address'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => sentence(`Sent ${value.address} (${value.bytes} bytes).`) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        touchAgent(exec);
        const address = typeof args?.address === 'string' ? args.address : '';
        if (!address.startsWith('/') || address.length < 2) throw new Error('vrchat_osc_send: `address` must start with "/"');
        const rawArgs = Array.isArray(args?.args) ? args.args : [];
        const bytes = bridge.send(address, rawArgs);
        return { address, bytes };
      },
    });

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}
