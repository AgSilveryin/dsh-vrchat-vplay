// live-acceptance.mjs — A/B 线的真机验收（需要 SteamVR + VRChat 已启动、驱动已安装）。
//
// 它做两件事（可分开跑）：
//   1. --mcp    : spawn mcp/server.mjs，按 MCP 协议实测：握手、19 工具、doctor、status、
//                 screenshot 回真图（PNG 落盘）、vrchat_ui 开快捷菜单（再截图取证）。
//   2. --daemon : spawn tools/vplayd.mjs（隔离面板端口 8791、--no-listen），实测面板
//                 /api/status、POST doctor、screenshot（dataUrl 落盘）。
//
// 证据写到 <repo>/../vrchat-vr-driver/shots/live/（默认），并打印 JSON 摘要。
// 用法：
//   node tools/live-acceptance.mjs --mcp
//   node tools/live-acceptance.mjs --daemon
//   node tools/live-acceptance.mjs --all
// 只读/只发控制消息，不改任何配置；不负责启动 SteamVR/VRChat。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EVIDENCE_DIR = resolve(PLUGIN_DIR, '..', 'vrchat-vr-driver', 'shots', 'live');
const argv = process.argv.slice(2);
const runMcp = argv.includes('--mcp') || argv.includes('--all');
const runDaemon = argv.includes('--daemon') || argv.includes('--all');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), mcp: null, daemon: null, passed: 0, failed: 0 };

function check(name, condition, detail = '') {
  if (condition) {
    evidence.passed += 1;
    console.log(`ok   ${name}`);
  } else {
    evidence.failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return condition;
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function decodePngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

/** 找零依赖 PNG 解码器：发布包里在 player/，开发期在兄弟工程。 */
async function loadPngDecoder() {
  const candidates = [
    join(PLUGIN_DIR, 'player', 'src', 'perception', 'png.mjs'),
    resolve(PLUGIN_DIR, '..', 'vrchat-vr-driver', 'player', 'src', 'perception', 'png.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  return null;
}

/** 极简 MCP 客户端（换行分隔 JSON-RPC 2.0）。 */
function createMcpClient(config) {
  const child = spawn(process.execPath, [join(PLUGIN_DIR, 'mcp', 'server.mjs'), '--config', JSON.stringify(config)], {
    cwd: PLUGIN_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });
  const request = (method, params) => new Promise((resolvePromise, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }
    }, 60_000);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return {
    child,
    request,
    notify,
    stderr: () => stderr.join(''),
    async close() {
      child.stdin.end();
      await new Promise((resolvePromise) => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise(); }, 8000);
        child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
      });
    },
  };
}

async function saveImageContent(content, name) {
  const image = (Array.isArray(content) ? content : []).find((entry) => entry?.type === 'image');
  if (!image?.data) return null;
  const buffer = Buffer.from(image.data, 'base64');
  const size = decodePngSize(buffer);
  if (!size) return null;
  const path = join(EVIDENCE_DIR, `${name}-${stamp}.png`);
  writeFileSync(path, buffer);
  return { path, ...size };
}

async function testMcp() {
  console.log('\n=== MCP 真机验收 ===');
  const result = { ok: false, checks: [] };
  // listenEnabled=false：避免和本机 DSH 插件抢 9001（VRChat 的 OSC 输出端口是单播 9001，
  // 同一台机器上 DSH 插件与 MCP 只能有一方收到参数事件）；截图/按键/doctor 只需要发。
  const client = createMcpClient({ listenEnabled: false, panelEnabled: false, screenshotTimeoutMs: 8000 });
  /** MCP 结果：优先用 structuredContent（原始 JSON），没有再尝试把文本当 JSON 解析。 */
  const structured = (callResult) => {
    if (callResult?.result?.structuredContent !== undefined) return callResult.result.structuredContent;
    const text = callResult?.result?.content?.[0]?.text;
    if (typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'live-acceptance', version: '1.0.0' },
    });
    check('initialize 返回 serverInfo', initialized.result?.serverInfo?.name === 'dsh-vrchat-vplay-mcp', JSON.stringify(initialized).slice(0, 160));
    client.notify('notifications/initialized', {});

    const tools = await client.request('tools/list', {});
    const names = (tools.result?.tools ?? []).map((tool) => tool.name);
    check('tools/list = 19 个工具', names.length === 19, names.join(','));

    const status = await client.request('tools/call', { name: 'vrchat_status', arguments: {} });
    const statusJson = structured(status) ?? {};
    result.status = { connected: statusJson.connected, sendPort: statusJson.sendPort, listenPort: statusJson.listenPort, listenError: statusJson.listenError };
    check('MCP 工具集连到 VRChat OSC 发送口 9000', Number(statusJson.sendPort) === 9000 && statusJson.startError == null, JSON.stringify(result.status));
    // 本进程没开 9001 监听（与 DSH 插件互斥），connected 预期 false；真机收包能力由 DSH 插件侧另外验证。
    console.log(`info connected=${statusJson.connected}（MCP 测试进程 listenEnabled=false，收包由 DSH 插件独占 9001，属预期）`);

    const doctor = await client.request('tools/call', { name: 'vrchat_doctor', arguments: {} });
    const doctorJson = structured(doctor) ?? {};
    result.doctor = { verdict: doctorJson.verdict, summary: doctorJson.summary, nextSteps: doctorJson.nextSteps };
    // doctor 的 verdict 是分级绿灯：not-ready < chat-ready < pose-ready < player-ready（player-ready 即最高级）。
    const VERDICT_RANK = { 'not-ready': 0, 'chat-ready': 1, 'pose-ready': 2, 'player-ready': 3 };
    check('doctor 返回 verdict（真机）', typeof doctorJson.verdict === 'string' && doctorJson.verdict.length > 0, JSON.stringify(doctorJson).slice(0, 160));
    check('doctor verdict = player-ready（真机最高级绿灯）', (VERDICT_RANK[doctorJson.verdict] ?? -1) >= 3, `${doctorJson.verdict} / ${JSON.stringify(doctorJson.nextSteps ?? []).slice(0, 200)}`);

    const shot = await client.request('tools/call', { name: 'vrchat_screenshot', arguments: {} });
    check('截图返回 image content block', Array.isArray(shot.result?.content) && shot.result.content.some((entry) => entry?.type === 'image'));
    const shotText = structured(shot) ?? {};
    result.screenshot = { ok: shotText.ok, width: shotText.width, height: shotText.height, capturedAt: shotText.capturedAt };
    check('截图不是 isError', shot.result?.isError !== true);
    const saved = await saveImageContent(shot.result?.content, 'mcp-screenshot');
    result.screenshot.file = saved?.path ?? null;
    check('image base64 是合法 PNG 且尺寸可信', saved !== null && saved.width >= 640 && saved.height >= 360, JSON.stringify(saved));

    const menu = await client.request('tools/call', { name: 'vrchat_ui', arguments: { action: 'openQuickMenu' } });
    const menuText = menu.result?.content?.[0]?.text ?? '';
    check('vrchat_ui openQuickMenu 执行成功', menu.result?.isError !== true && /ok|按键|手柄/i.test(menuText), menuText.slice(0, 120));
    result.menu = menuText.slice(0, 200);

    await sleep(1500);
    const shot2 = await client.request('tools/call', { name: 'vrchat_screenshot', arguments: {} });
    const saved2 = await saveImageContent(shot2.result?.content, 'mcp-after-open-menu');
    result.screenshotAfterMenu = saved2;
    check('开菜单后补一张截图（取证）', saved2 !== null);
    if (saved && saved2) {
      const { framesDiffer } = await import('../lib/aim.mjs');
      const decoder = await loadPngDecoder();
      if (decoder === null) {
        check('开菜单前后画面确实变化（说明按键真的生效）', false, '找不到 PNG 解码器');
      } else {
        const before = decoder.decodePng(readFileSync(saved.path));
        const after = decoder.decodePng(readFileSync(saved2.path));
        const differ = framesDiffer(
          { data: before.data, width: before.width, height: before.height },
          { data: after.data, width: after.width, height: after.height },
          { threshold: 0.001 },
        );
        result.menuDiff = differ;
        check('开菜单前后画面确实变化（说明按键真的生效）', differ?.differ === true && differ.diffRatio > 0.002, JSON.stringify(differ));
      }
    }

    result.ok = true;
    result.stderrTail = client.stderr().split('\n').filter(Boolean).slice(-5);
  } catch (error) {
    result.error = String(error?.message ?? error);
    result.stderrTail = client.stderr().split('\n').filter(Boolean).slice(-10);
  } finally {
    await client.close();
  }
  evidence.mcp = result;
}

function jsonFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
}

async function waitHttp(url, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch { /* retry */ }
    if (Date.now() - started > timeoutMs) return false;
    await sleep(300);
  }
}

async function testDaemon() {
  console.log('\n=== 独立 daemon 真机验收 ===');
  const result = { ok: false };
  const port = 8791;
  const child = spawn(process.execPath, [
    join(PLUGIN_DIR, 'tools', 'vplayd.mjs'),
    '--panel-port', String(port),
    '--no-listen',
  ], { cwd: PLUGIN_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  try {
    const up = await waitHttp(`${base}/api/status`);
    check('vplayd 面板 HTTP 就绪', up);
    if (up) {
      const status = await (await jsonFetch(`${base}/api/status`)).json();
      result.status = status;
      check('面板 /api/status 可读', status !== null && typeof status === 'object');

      const doctor = await (await jsonFetch(`${base}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'doctor', args: {} }),
      })).json();
      const verdict = doctor?.result?.verdict ?? doctor?.verdict;
      result.doctor = { verdict };
      check('面板 doctor 返回 verdict', typeof verdict === 'string', JSON.stringify(doctor).slice(0, 200));

      const screenshot = await (await jsonFetch(`${base}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'screenshot', args: {} }),
      })).json();
      const dataUrl = screenshot?.result?.dataUrl;
      const png = typeof dataUrl === 'string' ? Buffer.from(dataUrl.split(',')[1] ?? '', 'base64') : null;
      const size = png ? decodePngSize(png) : null;
      if (size) {
        const path = join(EVIDENCE_DIR, `daemon-screenshot-${stamp}.png`);
        writeFileSync(path, png);
        result.screenshot = { path, ...size };
      }
      check('面板截图回 dataUrl 真图', size !== null, JSON.stringify({ ok: screenshot?.result?.ok, error: screenshot?.result?.error }).slice(0, 200));

      const press = await (await jsonFetch(`${base}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'press', args: { key: 'b', side: 'left' } }),
      })).json();
      result.press = { ok: press?.result?.ok ?? press?.ok };
      check('面板按下 B 键', (press?.result?.ok ?? press?.ok) !== false, JSON.stringify(press).slice(0, 160));
      result.ok = true;
    }
  } catch (error) {
    result.error = String(error?.message ?? error);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    result.logTail = output.join('').split('\n').filter(Boolean).slice(-8);
  }
  evidence.daemon = result;
}

async function main() {
  if (!runMcp && !runDaemon) {
    console.error('用法：node tools/live-acceptance.mjs --mcp | --daemon | --all');
    process.exit(2);
  }
  if (runMcp) await testMcp();
  if (runDaemon) await testDaemon();
  evidence.finishedAt = new Date().toISOString();
  const evidencePath = join(EVIDENCE_DIR, `acceptance-${stamp}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`\n证据：${evidencePath}`);
  console.log(`结果：${evidence.passed} passed / ${evidence.failed} failed`);
  process.exit(evidence.failed === 0 ? 0 : 1);
}

main();
