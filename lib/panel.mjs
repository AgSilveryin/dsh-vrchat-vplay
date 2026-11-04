// panel.mjs — 本地 127.0.0.1 按钮控制台（零依赖 HTTP，内联 HTML/CSS/JS，无 CDN）
//
// 给"不敲命令行"用：体检 / 演练模式 / 真机模式 / 停止 / 开监视器 / 按键 A·B·Trigger·Grip /
// 摇杆四向。页面只做参数校验并调用注入的 actions 回调，再把 JSON 结果回给页面；SSE 推操作日志。
//
// 安全：默认只绑 127.0.0.1；action 白名单（且必须注入）；不读文件、不执行 shell、不回文件内容。
import http from 'node:http';

export const PANEL_ACTIONS = Object.freeze([
  'doctor',
  'mode',
  'stop',
  'status',
  'press',
  'stick',
  'release',
  'screenshot',
  'dashboardHide',
  'dashboardShow',
  'driversStatus',
  'installDrivers',
]);

export const PANEL_PRESETS = Object.freeze(['demo', 'dry', 'player', 'live']);
export const PANEL_KEYS = Object.freeze(['a', 'b', 'trigger', 'grip', 'system', 'thumbstick', 'trackpad']);
export const PANEL_SIDES = Object.freeze(['left', 'right']);

const DEFAULT_PORT = 8790;
const MAX_BODY_BYTES = 64 * 1024;
const ACTION_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 3_000;
const LOG_LIMIT = 50;

function withTimeout(promise, timeoutMs, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    Promise.resolve(promise).then((value) => finish(value), () => finish(fallback));
  });
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** 内联页面（一排大按钮 + 体检结果 + 最近操作日志）；无 CDN、无外部资源。 */
function renderHtml(config = {}) {
  const boot = { monitorPort: Number(config?.playerMonitorPort) || 8765 };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VRChat 虚拟玩家控制台</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; font: 15px/1.5 system-ui, "Segoe UI", sans-serif; background: #14161a; color: #e8eaed; }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  .group { margin: 14px 0; padding: 12px; background: #1c1f24; border: 1px solid #2b3038; border-radius: 10px; }
  .group h2 { font-size: 13px; margin: 0 0 8px; color: #9aa4b2; font-weight: 500; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  button { min-height: 44px; padding: 0 16px; font: inherit; font-weight: 600; color: #e8eaed; background: #2a3038; border: 1px solid #3a4250; border-radius: 8px; cursor: pointer; }
  button:hover { background: #343c47; }
  button:active { transform: translateY(1px); }
  button.primary { background: #2563eb; border-color: #3b82f6; }
  button.danger { background: #7f1d1d; border-color: #b91c1c; }
  button.side.active { background: #2563eb; border-color: #3b82f6; }
  pre { margin: 0; padding: 10px; background: #0f1115; border: 1px solid #2b3038; border-radius: 8px; min-height: 40px; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, Consolas, monospace; color: #b8c0cc; }
  .muted { color: #8b95a5; font-size: 12px; }
</style>
</head>
<body>
<h1>VRChat 虚拟玩家控制台</h1>

<div class="group">
  <h2>常用</h2>
  <div class="row">
    <button class="primary" data-action="doctor">体检</button>
    <button data-action="mode" data-preset="demo">演练模式</button>
    <button data-action="mode" data-preset="player">真机模式</button>
    <button class="danger" data-action="stop">停止</button>
    <button data-action="dashboardHide">关掉 SteamVR 面板</button>
    <button data-action="dashboardShow">显示 SteamVR 面板</button>
    <button data-action="release">松开所有键</button>
    <button data-action="screenshot">截图</button>
    <button data-action="installDrivers">安装驱动</button>
    <button id="monitor">开监视器</button>
  </div>
</div>

<div class="group">
  <h2>按键测试（先选左/右）</h2>
  <div class="row">
    <button class="side" data-side="left">左</button>
    <button class="side" data-side="right">右</button>
  </div>
  <div class="row" style="margin-top:8px">
    <button data-action="press" data-key="a">A</button>
    <button data-action="press" data-key="b">B</button>
    <button data-action="press" data-key="trigger">Trigger</button>
    <button data-action="press" data-key="grip">Grip</button>
  </div>
</div>

<div class="group">
  <h2>摇杆四向</h2>
  <div class="row">
    <button data-stick="0,1">↑</button>
    <button data-stick="0,-1">↓</button>
    <button data-stick="-1,0">←</button>
    <button data-stick="1,0">→</button>
  </div>
</div>

<div class="group">
  <h2>体检结果</h2>
  <pre id="doctor">（还没体检）</pre>
</div>

<div class="group">
  <h2>最近操作日志</h2>
  <pre id="log">（等待操作）</pre>
  <div class="muted" id="status">连接中…</div>
</div>

<script>
const BOOT = ${escapeJsonForHtml(boot)};
let side = 'left';
const logEl = document.getElementById('log');
const doctorEl = document.getElementById('doctor');
const statusEl = document.getElementById('status');
const lines = [];

function append(kind, payload) {
  let text;
  try { text = typeof payload === 'string' ? payload : JSON.stringify(payload); } catch { text = String(payload); }
  lines.push('[' + kind + '] ' + text);
  while (lines.length > 50) lines.shift();
  logEl.textContent = lines.join('\\n');
}

async function act(name, args) {
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, args: args || {} }),
    });
    const payload = await response.json();
    append(response.ok ? 'ok' : 'err', payload);
    if (name === 'doctor' && payload.ok) doctorEl.textContent = JSON.stringify(payload.result, null, 2);
    if (name === 'status' && payload.ok) append('status', payload.result);
    // 截图按钮：把 dataUrl 直接开成新标签页（面板本身不渲染大图，省内存）
    if (name === 'screenshot') {
      const shot = payload && payload.result;
      if (shot && shot.ok && shot.dataUrl) {
        const tab = window.open('about:blank', '_blank');
        if (tab) {
          tab.document.write('<title>VRChat 截图 ' + Math.round(shot.width || 0) + 'x' + Math.round(shot.height || 0)
            + '</title><body style="margin:0;background:#111"><img style="width:100%" src="' + shot.dataUrl + '"></body>');
          tab.document.close();
        }
      } else if (shot && shot.error) {
        append('err', '截图失败：' + shot.error);
      }
    }
    if (name === 'installDrivers' && payload && payload.ok) {
      append('ok', '驱动安装脚本已执行，重启 SteamVR 后生效');
    }
    return payload;
  } catch (error) {
    append('err', String(error && error.message ? error.message : error));
  }
}

function updateStatus() {
  fetch('/api/status').then(function (response) { return response.json(); }).then(function (payload) {
    const actionNames = Object.keys(payload.actions || {});
    statusEl.textContent = '面板 ' + (payload.panel ? payload.panel.url : '?') + ' · action: ' + actionNames.join(', ');
  }).catch(function () { statusEl.textContent = '面板状态读取失败'; });
}

document.querySelectorAll('button[data-side]').forEach(function (button) {
  button.addEventListener('click', function () {
    side = button.dataset.side;
    document.querySelectorAll('button[data-side]').forEach(function (other) {
      other.classList.toggle('active', other.dataset.side === side);
    });
    append('side', side);
  });
});
document.querySelector('button[data-side="left"]').classList.add('active');

document.querySelectorAll('button[data-action]').forEach(function (button) {
  button.addEventListener('click', function () {
    const name = button.dataset.action;
    const args = {};
    if (name === 'mode') args.preset = button.dataset.preset;
    if (name === 'press') { args.key = button.dataset.key; args.side = side; }
    act(name, args);
  });
});

document.querySelectorAll('button[data-stick]').forEach(function (button) {
  button.addEventListener('click', function () {
    const parts = button.dataset.stick.split(',');
    act('stick', { side: side, x: Number(parts[0]), y: Number(parts[1]) });
  });
});

document.getElementById('monitor').addEventListener('click', function () {
  window.open('http://127.0.0.1:' + BOOT.monitorPort + '/', '_blank');
});

const events = new EventSource('/api/events');
events.onmessage = function (event) {
  try { append('event', JSON.parse(event.data)); } catch { append('event', event.data); }
};
events.onerror = function () { statusEl.textContent = 'SSE 连接断开（面板可能已关闭）'; };

updateStatus();
</script>
</body>
</html>`;
}

/**
 * 创建本地按钮控制台。
 * @param {{port?:number, host?:string, actions?:object, config?:object}} options
 * @returns {{start:Function, close:Function, url:string|null, port:number|null, stats:object}}
 */
export function createPanel(options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {};
  const actions = input.actions !== null && typeof input.actions === 'object' ? input.actions : {};
  const config = input.config !== null && typeof input.config === 'object' ? input.config : {};
  const desiredPort = Number.isInteger(Number(input.port)) && Number(input.port) > 0
    ? Number(input.port)
    : DEFAULT_PORT;
  const requestedHost = typeof input.host === 'string' && input.host.length > 0 ? input.host : '127.0.0.1';
  // 安全：只允许回环地址，防止误传 0.0.0.0 把控制台暴露到局域网。
  const host = ['127.0.0.1', 'localhost', '::1'].includes(requestedHost) ? requestedHost : '127.0.0.1';

  const stats = {
    requests: 0,
    actions: 0,
    errors: 0,
    sseClients: 0,
    startedAt: null,
    lastError: null,
  };
  const logs = [];
  const clients = new Set();
  let server = null;
  let started = false;
  let closed = false;
  let actualPort = null;
  let panelUrl = null;

  function pushLog(entry) {
    logs.push(entry);
    while (logs.length > LOG_LIMIT) logs.shift();
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of [...clients]) {
      try { res.write(payload); } catch {
        clients.delete(res);
        stats.sseClients = clients.size;
      }
    }
  }

  function availableActions() {
    const available = {};
    for (const name of PANEL_ACTIONS) {
      if (typeof actions[name] === 'function') available[name] = true;
    }
    return available;
  }

  function validateAction(name, args) {
    if (typeof name !== 'string' || name.length === 0) return 'name is required';
    if (!PANEL_ACTIONS.includes(name)) return `unknown action: ${name}`;
    if (typeof actions[name] !== 'function') return `action not available: ${name}`;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      return 'args must be an object';
    }
    const value = args ?? {};
    if (name === 'mode') {
      if (typeof value.preset !== 'string' || !PANEL_PRESETS.includes(value.preset)) {
        return `mode.preset must be one of ${PANEL_PRESETS.join('|')}`;
      }
      if (value.opts !== undefined && (value.opts === null || typeof value.opts !== 'object' || Array.isArray(value.opts))) {
        return 'mode.opts must be an object';
      }
    }
    if (name === 'press') {
      if (typeof value.key !== 'string' || !PANEL_KEYS.includes(value.key)) {
        return `press.key must be one of ${PANEL_KEYS.join('|')}`;
      }
      if (typeof value.side !== 'string' || !PANEL_SIDES.includes(value.side)) {
        return `press.side must be one of ${PANEL_SIDES.join('|')}`;
      }
    }
    if (name === 'stick') {
      if (typeof value.side !== 'string' || !PANEL_SIDES.includes(value.side)) {
        return `stick.side must be one of ${PANEL_SIDES.join('|')}`;
      }
      for (const axis of ['x', 'y']) {
        const number = Number(value[axis]);
        if (!Number.isFinite(number) || number < -1 || number > 1) return `stick.${axis} must be a number in -1..1`;
      }
    }
    return null;
  }

  async function runAction(name, args) {
    const value = args ?? {};
    switch (name) {
      case 'mode':
        return actions.mode(value.preset, value.opts ?? {});
      case 'press':
        return actions.press(value.key, value.side);
      case 'stick':
        return actions.stick(value.side, Number(value.x), Number(value.y));
      default:
        return actions[name]();
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('request body too large'), { code: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (error) => reject(error));
    });
  }

  async function handleAction(req, res) {
    let text;
    try {
      text = await readBody(req);
    } catch (error) {
      stats.errors += 1;
      jsonResponse(res, error?.code === 413 ? 413 : 400, { ok: false, error: String(error?.message ?? error) });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text || '{}');
    } catch {
      stats.errors += 1;
      jsonResponse(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const name = payload?.name;
    const args = payload?.args;
    const invalid = validateAction(name, args);
    if (invalid !== null) {
      stats.errors += 1;
      jsonResponse(res, 400, { ok: false, error: invalid });
      return;
    }
    const startedAt = Date.now();
    let result;
    let error = null;
    try {
      result = await withTimeout(runAction(name, args), ACTION_TIMEOUT_MS, undefined);
      if (result === undefined) throw new Error(`action timed out (>${ACTION_TIMEOUT_MS}ms)`);
    } catch (cause) {
      error = String(cause?.message ?? cause);
      stats.errors += 1;
    }
    const ms = Date.now() - startedAt;
    stats.actions += 1;
    pushLog({ at: new Date().toISOString(), name, args: args ?? {}, ok: error === null, ms, ...(error ? { error } : {}) });
    if (error !== null) {
      jsonResponse(res, 500, { ok: false, name, error, ms });
      return;
    }
    jsonResponse(res, 200, { ok: true, name, ms, result: result ?? null });
  }

  async function handleStatus(req, res) {
    const status = {
      ok: true,
      panel: {
        url: panelUrl,
        port: actualPort,
        host,
        startedAt: stats.startedAt,
        stats: { requests: stats.requests, actions: stats.actions, errors: stats.errors, sseClients: clients.size },
      },
      actions: availableActions(),
      config: {
        playerMonitorPort: Number(config.playerMonitorPort) || null,
        playerDir: typeof config.playerDir === 'string' ? config.playerDir : null,
      },
      recent: logs.slice(-10),
    };
    if (typeof actions.status === 'function') {
      const player = await withTimeout(
        Promise.resolve().then(() => actions.status()),
        STATUS_TIMEOUT_MS,
        undefined,
      );
      if (player === undefined) status.playerError = `status timed out (>${STATUS_TIMEOUT_MS}ms)`;
      else status.player = player;
    }
    jsonResponse(res, 200, status);
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    for (const entry of logs.slice(-LOG_LIMIT)) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    clients.add(res);
    stats.sseClients = clients.size;
    const cleanup = () => {
      clients.delete(res);
      stats.sseClients = clients.size;
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function handleRequest(req, res) {
    stats.requests += 1;
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'bad request url' });
      return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = renderHtml(config);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      try {
        await handleStatus(req, res);
      } catch (error) {
        stats.errors += 1;
        jsonResponse(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      handleEvents(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/action') {
      try {
        await handleAction(req, res);
      } catch (error) {
        stats.errors += 1;
        if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: String(error?.message ?? error) });
        else res.end();
      }
      return;
    }
    jsonResponse(res, 404, { ok: false, error: 'not found' });
  }

  async function start() {
    if (closed) return { usable: false, url: null, port: null, error: 'panel is closed' };
    if (started === true) return { usable: true, url: panelUrl, port: actualPort };
    if (server !== null) {
      return { usable: true, url: panelUrl, port: actualPort };
    }
    const result = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          stats.errors += 1;
          if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: String(error?.message ?? error) });
          else res.end();
        });
      });
      server = srv;
      const onError = (error) => {
        stats.errors += 1;
        stats.lastError = String(error?.message ?? error);
        server = null;
        try { srv.close(); } catch { /* ignore */ }
        resolve({
          usable: false,
          url: null,
          port: desiredPort,
          error: error?.code === 'EADDRINUSE' ? `端口 ${desiredPort} 已被占用` : `面板启动失败：${stats.lastError}`,
        });
      };
      srv.once('error', onError);
      srv.listen(desiredPort, host, () => {
        srv.removeListener('error', onError);
        srv.on('error', (error) => {
          stats.errors += 1;
          stats.lastError = String(error?.message ?? error);
        });
        actualPort = srv.address()?.port ?? desiredPort;
        panelUrl = `http://${host}:${actualPort}/`;
        started = true;
        stats.startedAt = new Date().toISOString();
        resolve({ usable: true, url: panelUrl, port: actualPort, host });
      });
    });
    return result;
  }

  async function close() {
    if (closed) return { closed: true };
    closed = true;
    for (const res of [...clients]) {
      try { res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    stats.sseClients = 0;
    if (server !== null) {
      const srv = server;
      server = null;
      await new Promise((resolve) => {
        srv.close(() => resolve());
        try { srv.closeAllConnections?.(); } catch { /* ignore */ }
      });
    }
    started = false;
    return { closed: true };
  }

  return {
    start,
    close,
    get url() { return panelUrl; },
    get port() { return actualPort; },
    get stats() {
      return { ...stats, sseClients: clients.size, logs: logs.length };
    },
  };
}
