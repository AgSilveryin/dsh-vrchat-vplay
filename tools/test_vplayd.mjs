// test_vplayd.mjs — vplayd 真进程验收（不启动 SteamVR/VRChat；端口全部隔离）。
//
// 测法：spawn 真 `node tools/vplayd.mjs`，用 HTTP 打面板 /api/status 与 /api/action，
//       再验证 SIGTERM / 优雅退出 / 端口占用报错 / --help / --self-check。
// 隔离端口：面板 18792、OSC 发送 19030、OSC 监听 19031、监视器 18770、VMT 19070、头部 19072。
// playerDir 指向临时假仓库（含 player/demo.mjs 与 player/tools/preflight.mjs 桩），
// 避免自动探测到真实兄弟工程。结束会杀子进程、删临时目录、确认端口释放。
//
// 运行：node tools/test_vplayd.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PANEL_ACTIONS } from '../lib/panel.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VPLAYD = join(ROOT, 'tools', 'vplayd.mjs');

const PANEL_PORT = 18792;
const BUSY_PORT = 18793;
const SEND_PORT = 19030;
const LISTEN_PORT = 19031;
const MONITOR_PORT = 18770;
const VMT_SEND_PORT = 19070;
const HEAD_PORT = 19072;

const BASE_URL = `http://127.0.0.1:${PANEL_PORT}/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 临时假玩家仓库（和 tools/plugin-offline-test.mjs 同一做法）────────────────
const fakeRepo = mkdtempSync(join(tmpdir(), 'vplayd-test-'));
mkdirSync(join(fakeRepo, 'player', 'tools'), { recursive: true });
writeFileSync(join(fakeRepo, 'player', 'demo.mjs'), 'setTimeout(() => process.exit(0), 400);\n', 'utf8');
writeFileSync(
  join(fakeRepo, 'player', 'tools', 'preflight.mjs'),
  'console.log("FAKE PREFLIGHT OK"); process.exit(0);\n',
  'utf8',
);

// 隔离配置：所有端口离开默认值，playerNode 用当前 node，playerDir 指临时假仓库。
const ISOLATED_CONFIG = {
  sendPort: SEND_PORT,
  listenPort: LISTEN_PORT,
  listenEnabled: true,
  vmtSendPort: VMT_SEND_PORT,
  headPort: HEAD_PORT,
  playerDir: fakeRepo,
  playerMonitorPort: MONITOR_PORT,
  playerNode: process.execPath,
  doctorTimeoutMs: 9000,
};

const records = [];
let busyServer = null;
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
  passed += 1;
  console.log(`ok   ${name}`);
}

/** spawn vplayd（stdin/stdout/stderr 都是 pipe，便于观察与触发优雅退出）。 */
function startVplayd(args, extraEnv = {}) {
  const child = spawn(process.execPath, [VPLAYD, ...args], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 默认清掉 VPLAY_CONFIG，避免外部环境污染断言；需要测优先级时用 extraEnv 传。
    env: { ...process.env, VPLAY_CONFIG: '', ...extraEnv },
  });
  const record = { child, out: '', err: '', exit: null, exited: false, waiters: [] };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { record.out += chunk; });
  child.stderr.on('data', (chunk) => { record.err += chunk; });
  child.on('error', (error) => {
    record.err += `[spawn error] ${error?.message ?? error}\n`;
    if (!record.exited) {
      record.exited = true;
      record.exit = { code: null, signal: null, error };
      for (const waiter of record.waiters.splice(0)) waiter(record.exit);
    }
  });
  child.on('exit', (code, signal) => {
    if (record.exited && record.exit?.signal === null && record.exit?.code === null) return; // spawn error 已处理
    record.exit = { code, signal };
    record.exited = true;
    for (const waiter of record.waiters.splice(0)) waiter(record.exit);
  });
  records.push(record);
  return record;
}

function waitExit(record, timeoutMs, label) {
  if (record.exited) return Promise.resolve(record.exit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `${label} 在 ${timeoutMs}ms 内没有退出；stdout=${record.out.slice(-1500)}；stderr=${record.err.slice(-800)}`,
      ));
    }, timeoutMs);
    record.waiters.push((exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

async function waitForOutput(record, pattern, timeoutMs = 25_000, label = 'stdout') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(record.out)) return record.out;
    if (record.exited) {
      throw new Error(
        `vplayd 提前退出（code=${record.exit?.code} signal=${record.exit?.signal}）；`
        + `stdout=${record.out.slice(-1500)}；stderr=${record.err.slice(-800)}`,
      );
    }
    await sleep(80);
  }
  throw new Error(`${label} 未在 ${timeoutMs}ms 内匹配 ${pattern}；stdout=${record.out.slice(-1500)}`);
}

function requestJson(url, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => finish(reject, new Error(`HTTP 超时（>${timeoutMs}ms）：${method} ${url}`)), timeoutMs);
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(url, {
      method,
      headers: payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 就留 null */ }
        finish(resolve, { status: response.statusCode, headers: response.headers, text, json });
      });
      response.on('error', (error) => finish(reject, error));
    });
    request.on('error', (error) => finish(reject, error));
    request.setTimeout(timeoutMs, () => request.destroy(new Error('HTTP 超时')));
    if (payload !== null) request.write(payload);
    request.end();
  });
}

async function waitPanelReady(record, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = '无响应';
  while (Date.now() < deadline) {
    if (record.exited) {
      throw new Error(
        `vplayd 面板还没就绪就退出了（code=${record.exit?.code} signal=${record.exit?.signal}）；`
        + `stdout=${record.out.slice(-1500)}；stderr=${record.err.slice(-800)}`,
      );
    }
    try {
      const response = await requestJson(`${BASE_URL}api/status`, { timeoutMs: 1500 });
      if (response.status === 200 && response.json?.ok === true) return response.json;
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = String(error?.code ?? error?.message ?? error);
    }
    await sleep(120);
  }
  throw new Error(
    `面板 ${timeoutMs}ms 内未就绪（${lastReason}）；stdout=${record.out.slice(-1500)}；stderr=${record.err.slice(-800)}`,
  );
}

/** 等端口可再次 bind（子进程退出后 OS 释放）。 */
async function waitPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return true;
    await sleep(100);
  }
  return false;
}

async function httpReachable(url, timeoutMs = 1500) {
  try {
    await requestJson(url, { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** 清理：结束所有还活着的子进程，再删临时仓库。 */
async function cleanup() {
  for (const record of records) {
    if (record.exited) continue;
    try { record.child.stdin?.end(); } catch { /* ignore */ }
    try { record.child.kill('SIGTERM'); } catch { /* ignore */ }
    try {
      await waitExit(record, 3000, '清理子进程');
    } catch {
      try { record.child.kill('SIGKILL'); } catch { /* ignore */ }
      try { await waitExit(record, 3000, '强制清理子进程'); } catch { /* ignore */ }
    }
  }
  if (busyServer !== null) {
    try { await new Promise((resolve) => busyServer.close(resolve)); } catch { /* ignore */ }
  }
  try { rmSync(fakeRepo, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  // ── 1. --help ───────────────────────────────────────────────────────────────
  await check('--help：退出码 0，打印中文用法与全部参数', async () => {
    const record = startVplayd(['--help']);
    const exit = await waitExit(record, 10_000, '--help');
    assert.equal(exit.code, 0);
    for (const text of ['vplayd', '用法', '--panel-port', '--send-port', '--listen-enabled', '--no-listen',
      '--player-dir', '--player-node', '--monitor-port', '--config', '--self-check', '--help', 'VPLAY_CONFIG']) {
      assert.ok(record.out.includes(text), `帮助里缺少 ${text}`);
    }
  });

  // ── 2. --self-check（顺带验证配置优先级：VPLAY_CONFIG < --config < 单项参数）──
  await check('--self-check：退出码 0，19 个工具名 + doctor verdict + 配置优先级', async () => {
    const record = startVplayd(['--self-check', '--panel-port', '18795', '--monitor-port', '19003', '--config', JSON.stringify({
      playerMonitorPort: 19004, // 应被 --monitor-port 覆盖
      sendPort: SEND_PORT,
      listenPort: LISTEN_PORT,
      playerDir: fakeRepo,
      playerNode: process.execPath,
    })]);
    const exit = await waitExit(record, 30_000, '--self-check');
    assert.equal(exit.code, 0);
    assert.match(record.out, /工具\s+19\/19/);
    for (const name of ['vrchat_doctor', 'vrchat_status', 'vrchat_ui', 'vrchat_screenshot', 'vrchat_player', 'vrchat_mode']) {
      assert.ok(record.out.includes(name), `self-check 没打印工具 ${name}`);
    }
    assert.match(record.out, /体检\s+verdict=(player-ready|pose-ready|chat-ready|not-ready)/);
    // 单项参数 > --config；self-check 不启面板/不监听端口，所以端口只打印不 bind。
    assert.match(record.out, new RegExp(`面板 127\\.0\\.0\\.1:18795`));
    assert.match(record.out, new RegExp(`监视器 19003`));
    assert.match(record.out, new RegExp(`反向监听 ${LISTEN_PORT}`));
    assert.match(record.out, /self-check 完成/);
  });

  // ── 3. 正常启动：面板真就绪 + 启动摘要 ──────────────────────────────────────
  const daemon = startVplayd(['--panel-port', String(PANEL_PORT), '--config', JSON.stringify(ISOLATED_CONFIG)]);
  const panelStatus = await waitPanelReady(daemon);

  await check('启动：面板 /api/status 可用（HTTP 轮询确认，不是假成功）', async () => {
    assert.equal(panelStatus.ok, true);
    assert.equal(panelStatus.panel?.port, PANEL_PORT);
    assert.equal(panelStatus.panel?.url, BASE_URL);
    assert.ok(panelStatus.panel?.startedAt, 'panel.startedAt 应有值');
    assert.equal(panelStatus.player?.running, false, '玩家进程不应在跑');
  });

  await check('启动摘要：面板 URL / OSC listening / 工具数 / doctor 摘要都打印', async () => {
    // 等摘要最后一行出现，确保整块都写完（stdout 是流式的，不能只等第一行）。
    await waitForOutput(daemon, /浏览器打开上面的面板地址即可/, 25_000);
    const out = daemon.out;
    assert.match(out, /面板\s+http:\/\/127\.0\.0\.1:18792\//);
    assert.match(out, /action 12\/12/);
    assert.match(out, /listening=true|listening for VRChat OSC output on 127\.0\.0\.1:19031/);
    assert.match(out, new RegExp(`发送 ${SEND_PORT}`));
    assert.match(out, new RegExp(`监听 ${LISTEN_PORT}`));
    assert.match(out, /工具\s+19 个/);
    assert.match(out, /体检\s+verdict=(player-ready|pose-ready|chat-ready|not-ready)/);
  });

  // ── 4. GET / 内联页面 ───────────────────────────────────────────────────────
  await check('GET /：返回 HTML 控制台页面（内联、无 CDN）', async () => {
    const response = await requestJson(BASE_URL);
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /text\/html/);
    for (const text of ['VRChat 虚拟玩家控制台', '体检', '演练模式', '真机模式', '停止', '摇杆', 'Trigger', 'Grip']) {
      assert.ok(response.text.includes(text), `页面缺少 ${text}`);
    }
    assert.ok(response.text.includes('/api/action'));
    assert.doesNotMatch(response.text, /https?:\/\/cdn|unpkg|jsdelivr/i);
  });

  // ── 5. /api/status：面板监听 + 12 个动作（工具/驱动动作）+ 玩家监视器地址 ────
  await check('/api/status：面板监听信息 + 12 个动作（含驱动动作）+ 玩家监视器地址', async () => {
    const response = await requestJson(`${BASE_URL}api/status`);
    assert.equal(response.status, 200);
    const payload = response.json;
    assert.equal(payload.ok, true);
    // 面板本身在监听（URL/端口来自面板真实 listen，不是猜测）
    assert.equal(payload.panel?.url, BASE_URL);
    assert.equal(payload.panel?.port, PANEL_PORT);
    assert.equal(payload.panel?.host, '127.0.0.1');
    // 工具接线：12 个 action 全部可用（driversStatus/installDrivers 即驱动信息/操作入口）
    assert.equal(Object.keys(payload.actions ?? {}).length, PANEL_ACTIONS.length);
    for (const name of PANEL_ACTIONS) assert.equal(payload.actions[name], true, `动作 ${name} 未接线`);
    assert.equal(payload.actions.driversStatus, true);
    assert.equal(payload.actions.installDrivers, true);
    // 玩家监视器地址 = 隔离端口 18770（panel 的 status action 透传 playerProcess.status）
    assert.equal(payload.player?.running, false);
    assert.equal(payload.player?.monitor?.url, `http://127.0.0.1:${MONITOR_PORT}/`);
    assert.ok(Array.isArray(payload.recent));
    assert.equal(typeof payload.config, 'object');
  });

  // ── 6. 面板动作：doctor ─────────────────────────────────────────────────────
  await check('POST /api/action doctor：返回 verdict 与 11 项检查（离线不崩）', async () => {
    const response = await requestJson(`${BASE_URL}api/action`, { method: 'POST', body: { name: 'doctor', args: {} }, timeoutMs: 20_000 });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    const result = response.json.result;
    assert.ok(result !== null && typeof result === 'object');
    assert.ok(['player-ready', 'pose-ready', 'chat-ready', 'not-ready'].includes(result.verdict), `verdict=${result.verdict}`);
    assert.ok(Array.isArray(result.checks));
    assert.equal(result.checks.length, 11);
  });

  // ── 7. 面板动作：press（虚拟手柄，UDP 打隔离端口）────────────────────────────
  await check('POST /api/action press：右手 Trigger 返回 ok（UDP 发隔离端口 19070）', async () => {
    const response = await requestJson(`${BASE_URL}api/action`, {
      method: 'POST',
      body: { name: 'press', args: { key: 'trigger', side: 'right' } },
      timeoutMs: 10_000,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.result, true, 'vmtInput.press 应返回 true');
  });

  // ── 8. 面板动作：screenshot（无 SteamVR 时优雅 ok:false）─────────────────────
  await check('POST /api/action screenshot：无 SteamVR 时优雅返回 ok:false（不 500）', async () => {
    const response = await requestJson(`${BASE_URL}api/action`, { method: 'POST', body: { name: 'screenshot' }, timeoutMs: 15_000 });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.result?.ok, false);
    assert.equal(typeof response.json.result?.error, 'string');
    assert.ok(response.json.result.error.length > 0);
  });

  // ── 9. 面板动作：stop（玩家没跑也不崩）──────────────────────────────────────
  await check('POST /api/action stop：玩家未运行时不崩（stopped=false）', async () => {
    const response = await requestJson(`${BASE_URL}api/action`, { method: 'POST', body: { name: 'stop' }, timeoutMs: 10_000 });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.notEqual(response.json.result?.stopped, true);
  });

  // ── 10. 安全：动作白名单 ────────────────────────────────────────────────────
  await check('POST /api/action 未知动作：400 + unknown action（白名单生效）', async () => {
    const response = await requestJson(`${BASE_URL}api/action`, {
      method: 'POST',
      body: { name: 'run-shell', args: { command: 'whoami' } },
      timeoutMs: 5000,
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.ok, false);
    assert.match(response.json.error, /unknown action/);
  });

  // ── 11. SIGTERM ─────────────────────────────────────────────────────────────
  await check('SIGTERM：进程终止且面板端口释放（Windows 为强制终止；优雅退出码 0 见下一条）', async () => {
    daemon.child.kill('SIGTERM');
    const exit = await waitExit(daemon, 10_000, 'SIGTERM 后');
    if (process.platform === 'win32') {
      // Node/libuv 在 Windows 上把 SIGTERM 实现成 TerminateProcess（无法投递到 JS 处理器），
      // 所以退出码是 null、signal 是 SIGTERM；POSIX 下走 SIGTERM 处理器退出码 0。
      assert.equal(exit.signal, 'SIGTERM');
    } else {
      assert.equal(exit.code, 0);
    }
    assert.equal(await waitPortFree(PANEL_PORT, 5000), true, `面板端口 ${PANEL_PORT} 未释放`);
    assert.equal(await httpReachable(`${BASE_URL}api/status`), false, '进程退出后面板不应再响应');
  });

  // ── 12. 优雅退出（Windows 上验证「退出码 0」走的是同一个 shutdown() 路径）────
  await check('优雅退出：stdin 关闭 → 退出码 0 + 退出摘要 + 端口释放', async () => {
    const graceful = startVplayd([
      '--panel-port', String(PANEL_PORT),
      '--exit-on-stdin-close',
      '--config', JSON.stringify(ISOLATED_CONFIG),
    ]);
    await waitPanelReady(graceful);
    graceful.child.stdin.end();
    const exit = await waitExit(graceful, 10_000, 'stdin 关闭后');
    assert.equal(exit.code, 0, `优雅退出码应为 0，实际 code=${exit.code} signal=${exit.signal}`);
    assert.match(graceful.out, /vplayd 正在退出（stdin 关闭）/);
    assert.match(graceful.out, /vplayd 已退出/);
    assert.equal(await waitPortFree(PANEL_PORT, 5000), true, `优雅退出后面板端口 ${PANEL_PORT} 未释放`);
  });

  // ── 13. 端口被占用：明确报错、退出码 1、不假装成功 ─────────────────────────
  await check('面板端口被占用：明确报错 + 建议换端口，退出码 1', async () => {
    busyServer = http.createServer((_request, response) => response.end('busy'));
    await new Promise((resolve) => busyServer.listen(BUSY_PORT, '127.0.0.1', resolve));
    const blocked = startVplayd(['--panel-port', String(BUSY_PORT), '--config', JSON.stringify(ISOLATED_CONFIG)]);
    const exit = await waitExit(blocked, 15_000, '端口占用实例');
    assert.equal(exit.code, 1);
    assert.match(blocked.out, new RegExp(`端口 127\\.0\\.0\\.1:${BUSY_PORT} 已被占用`));
    assert.match(blocked.out, /--panel-port/);
    assert.doesNotMatch(blocked.out, /启动完成/);
    await new Promise((resolve) => busyServer.close(resolve));
    busyServer = null;
  });

  // ── 14. 参数校验 ────────────────────────────────────────────────────────────
  await check('非法参数：--panel-port abc → 退出码 2，不启动', async () => {
    const record = startVplayd(['--panel-port', 'abc']);
    const exit = await waitExit(record, 10_000, '非法参数实例');
    assert.equal(exit.code, 2);
    assert.match(record.out, /\[错误\]/);
    assert.match(record.out, /--help/);
  });

  // ── 15. VPLAY_CONFIG 环境变量与 --config 优先级 ─────────────────────────────
  await check('配置优先级：VPLAY_CONFIG < --config（--config 覆盖环境变量）', async () => {
    const record = startVplayd(['--self-check', '--config', JSON.stringify({
      sendPort: SEND_PORT, // 覆盖环境变量里的 19001
      listenPort: LISTEN_PORT,
      playerMonitorPort: MONITOR_PORT,
      playerDir: fakeRepo,
      playerNode: process.execPath,
    })], {
      VPLAY_CONFIG: JSON.stringify({ sendPort: 19001, playerMonitorPort: 19002, playerDir: 'D:/should-be-overridden' }),
    });
    const exit = await waitExit(record, 30_000, '优先级实例');
    assert.equal(exit.code, 0);
    assert.match(record.out, new RegExp(`发送 ${SEND_PORT}`));
    assert.match(record.out, new RegExp(`监视器 ${MONITOR_PORT}`));
  });
} finally {
  await cleanup();
}

console.log(`PASS ${passed} checks (vplayd)`);
