// test_panel.mjs — 本地按钮控制台单测（真实 HTTP + 注入回调；纯离线，端口 18791/18792）
import assert from 'node:assert/strict';
import http from 'node:http';
import { PANEL_ACTIONS, PANEL_KEYS, PANEL_PRESETS, PANEL_SIDES, createPanel, isLoopbackHost, isLoopbackOrigin } from '../lib/panel.mjs';

let n = 0;
const check = async (name, fn) => {
  n += 1;
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${n}: ${name}`);
    throw error;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = [];
const actions = {
  async doctor() {
    calls.push(['doctor']);
    return { verdict: 'player-ready', summary: { chat: true, pose: true, player: true }, checks: [] };
  },
  async mode(preset, opts) {
    calls.push(['mode', preset, opts]);
    return { preset };
  },
  async stop() {
    calls.push(['stop']);
    return { stopped: true };
  },
  async status() {
    calls.push(['status']);
    return { running: false, pid: null, monitor: { ok: false } };
  },
  async press(key, side) {
    calls.push(['press', key, side]);
    return { key, side, stats: { pressed: 1 } };
  },
  async stick(side, x, y) {
    calls.push(['stick', side, x, y]);
    return { side, x, y };
  },
  async driversStatus() {
    calls.push(['driversStatus']);
    return { drivers: [] };
  },
  async installDrivers() {
    calls.push(['installDrivers']);
    return { ok: true };
  },
};

const panel = createPanel({
  port: 18791,
  actions,
  config: { playerMonitorPort: 8765, playerDir: 'D:/fake/vrchat-vr-driver' },
});

let baseUrl = null;
let dummy = null;

/** 用原始 http.request 发请求，才能伪造 Host 头（fetch 不允许改 Host）。 */
const rawRequest = (port, { method = 'GET', path = '/', host, headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(host ? { host } : {}), ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  if (body !== null) req.write(body);
  req.end();
});

try {
  await check('start()：监听 127.0.0.1:18791，返回 usable/url/port', async () => {
    const started = await panel.start();
    assert.equal(started.usable, true);
    assert.equal(started.port, 18791);
    baseUrl = started.url;
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:18791\/$/);
    assert.equal(panel.url, baseUrl);
    assert.ok(panel.stats.startedAt);
  });

  await check('GET /：内联 HTML 含全部按钮、无 CDN、返回 text/html', async () => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/html/);
    const html = await response.text();
    for (const text of ['体检', '演练模式', '真机模式', '停止', '开监视器', '摇杆', 'Trigger', 'Grip', '左', '右']) {
      assert.ok(html.includes(text), `HTML 缺少 ${text}`);
    }
    assert.ok(html.includes('/api/action'));
    assert.ok(html.includes('/api/events'));
    assert.ok(html.includes('/api/status'));
    assert.doesNotMatch(html, /https?:\/\/cdn|cdn\.js|unpkg|jsdelivr/i, '页面不能引用 CDN');
    assert.ok(PANEL_PRESETS.includes('demo') && PANEL_PRESETS.includes('player'));
    assert.ok(PANEL_KEYS.includes('trigger') && PANEL_SIDES.includes('right'));
  });

  await check('GET /api/status：返回面板状态 + 注入的 actions.status()', async () => {
    const response = await fetch(`${baseUrl}api/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.panel.port, 18791);
    assert.equal(payload.actions.doctor, true);
    assert.ok(PANEL_ACTIONS.every((name) => payload.actions[name] === undefined || payload.actions[name] === true));
    assert.deepEqual(payload.player, { running: false, pid: null, monitor: { ok: false } });
    assert.equal(payload.config.playerMonitorPort, 8765);
    assert.ok(Array.isArray(payload.recent));
  });

  await check('Host/Origin 校验函数：只认回环地址', async () => {
    assert.equal(isLoopbackHost('127.0.0.1:18791'), true);
    assert.equal(isLoopbackHost('localhost:18791'), true);
    assert.equal(isLoopbackHost('evil.example:18791'), false);
    assert.equal(isLoopbackHost('127.0.0.1.evil.example'), false);
    assert.equal(isLoopbackOrigin('http://127.0.0.1:18791'), true);
    assert.equal(isLoopbackOrigin('https://localhost'), true);
    assert.equal(isLoopbackOrigin('https://evil.example'), false);
    assert.equal(isLoopbackOrigin('null'), false);
  });

  await check('CSRF 防线：外部 Origin 的 GET/POST → 403；本机 Origin → 放行', async () => {
    const evilStatus = await fetch(`${baseUrl}api/status`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evilStatus.status, 403);
    const evilAction = await fetch(`${baseUrl}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'doctor', args: {} }),
    });
    assert.equal(evilAction.status, 403);
    const goodStatus = await fetch(`${baseUrl}api/status`, { headers: { origin: 'http://127.0.0.1:18791' } });
    assert.equal(goodStatus.status, 200);
  });

  await check('DNS rebinding 防线：Host 不是回环地址 → 403', async () => {
    const get = await rawRequest(18791, { path: '/api/status', host: 'evil.example:18791' });
    assert.equal(get.status, 403);
    const post = await rawRequest(18791, {
      method: 'POST',
      path: '/api/action',
      host: 'evil.example:18791',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'doctor', args: {} }),
    });
    assert.equal(post.status, 403);
    const ok = await rawRequest(18791, { path: '/api/status', host: '127.0.0.1:18791' });
    assert.equal(ok.status, 200);
  });

  await check('POST /api/action：未知 action 返回 400', async () => {
    const response = await fetch(`${baseUrl}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'run-shell', args: {} }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /unknown action/);
  });

  await check('POST /api/action：已知 action 调注入回调并返回 200', async () => {
    const before = calls.length;
    const response = await fetch(`${baseUrl}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'doctor', args: {} }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.result.verdict, 'player-ready');
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), ['doctor']);

    const pressed = await fetch(`${baseUrl}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'press', args: { key: 'a', side: 'left' } }),
    });
    assert.equal(pressed.status, 200);
    assert.deepEqual(calls.at(-1), ['press', 'a', 'left']);
  });

  await check('POST /api/action：非法参数返回 400（mode.preset / stick.x）', async () => {
    const badMode = await fetch(`${baseUrl}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mode', args: { preset: 'hack' } }),
    });
    assert.equal(badMode.status, 400);
    assert.match((await badMode.json()).error, /mode\.preset/);

    const badStick = await fetch(`${baseUrl}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'stick', args: { side: 'left', x: 2, y: 0 } }),
    });
    assert.equal(badStick.status, 400);
    assert.match((await badStick.json()).error, /stick\.x/);
  });

  await check('GET /api/events：SSE 推最近操作日志（至少 1 条 data:）', async () => {
    // 先确保有一批日志（前面已调用过 doctor）
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !text.includes('data:')) {
      const chunk = await Promise.race([
        reader.read(),
        sleep(300).then(() => ({ done: true, value: undefined })),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    assert.match(text, /data:/, `SSE 没收到日志: ${JSON.stringify(text.slice(0, 200))}`);
    assert.match(text, /"name":"doctor"/);
  });

  await check('端口占用：start() 返回 usable:false，不抛异常', async () => {
    dummy = http.createServer((_req, res) => res.end('busy'));
    await new Promise((resolve) => dummy.listen(18792, '127.0.0.1', resolve));
    const blocked = createPanel({ port: 18792, actions, config: {} });
    const result = await blocked.start();
    assert.equal(result.usable, false);
    assert.match(String(result.error), /占用|EADDRINUSE/);
    assert.equal(blocked.url, null);
    await blocked.close();
  });
} finally {
  try { await panel.close(); } catch { /* ignore */ }
  if (dummy !== null) {
    try { await new Promise((resolve) => dummy.close(resolve)); } catch { /* ignore */ }
  }
  await sleep(50);
}

console.log(`PASS ${n} checks (panel)`);
