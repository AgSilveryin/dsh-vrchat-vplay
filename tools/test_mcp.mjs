// tools/test_mcp.mjs — MCP 包装（mcp/server.mjs + mcp/protocol.mjs）的自测。
//
// 不需要 DSH、SteamVR、VRChat：用真实子进程跑 MCP 服务器，走 stdio 换行分隔 JSON-RPC，
// 覆盖握手 / 工具清单 / 错误码 / 离线优雅降级 / 退出码；再用 protocol.mjs 单测纯函数
// （图片 content、参数校验、配置解析等）。
//
// 运行：node tools/test_mcp.mjs
// 端口全部隔离在 1903x/1907x，且 listenEnabled:false，不会碰到 DSH 插件正在用的 9001/8790。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as proto from '../mcp/protocol.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'mcp', 'server.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 隔离端口的测试配置：不监听任何 UDP（listenEnabled:false），面板关闭，玩家目录指向假仓库。
const TEST_CONFIG = {
  sendPort: 19030,
  listenPort: 19031,
  listenEnabled: false,
  vmtSendPort: 19070,
  vmtListenPort: 19071,
  vmtListenEnabled: false,
  headPort: 19072,
  panelEnabled: false,
  playerMonitorPort: 19032,
  doctorTimeoutMs: 5000,
  screenshotTimeoutMs: 2000,
};

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// ── 迷你 MCP 客户端：换行分隔 JSON-RPC，按 id 等响应 ────────────────────────

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.unsolicited = [];
    this.rawLines = [];
    this.parseFailures = [];
    this.stderr = '';
    this.buffer = '';
    this.exit = new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr += chunk; });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (line.trim().length > 0) this.#onLine(line);
    }
  }

  #onLine(line) {
    this.rawLines.push(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.parseFailures.push({ line, error: String(error?.message ?? error) });
      return;
    }
    const id = message?.id;
    if (id !== undefined && id !== null && this.pending.has(id)) {
      const settle = this.pending.get(id);
      this.pending.delete(id);
      settle(message);
      return;
    }
    this.unsolicited.push(message);
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  writeRaw(text) {
    this.child.stdin.write(`${text}\n`);
  }

  async nextUnsolicited(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.unsolicited.length === 0) {
      if (Date.now() > deadline) throw new Error('等待服务端主动消息超时');
      await sleep(10);
    }
    return this.unsolicited.shift();
  }

  /** 断言一段时间内 stdout 没有新消息（用于"通知不回复"）。 */
  async expectSilence(ms = 200) {
    const before = this.rawLines.length;
    await sleep(ms);
    assert.equal(this.rawLines.length, before, `期望 ${ms}ms 内无 stdout 消息，实际多了 ${this.rawLines.length - before} 条`);
  }

  closeStdin() {
    this.child.stdin.end();
  }
}

// ── 纯函数单测：mcp/protocol.mjs ────────────────────────────────────────────

async function protocolTests() {
  await check('协议版本协商（3 个支持版本 + 未知回最新）', () => {
    for (const version of ['2024-11-05', '2025-03-26', '2025-06-18']) {
      assert.equal(proto.negotiateProtocolVersion(version), version);
    }
    assert.equal(proto.negotiateProtocolVersion('1999-01-01'), '2025-06-18');
    assert.equal(proto.negotiateProtocolVersion(undefined), '2025-06-18');
  });

  await check('initialize 结果结构（name/version/capabilities.tools）', () => {
    const result = proto.buildInitializeResult('2024-11-05');
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.capabilities.tools.listChanged, false);
    assert.deepEqual(result.serverInfo, { name: 'dsh-vrchat-vplay-mcp', version: '0.7.0' });
    assert.equal(typeof result.instructions, 'string');
  });

  await check('JSON-RPC 信封构造 / 错误映射', () => {
    assert.deepEqual(proto.createJsonRpcResult(7, { ok: true }), {
      jsonrpc: '2.0', id: 7, result: { ok: true },
    });
    const error = proto.createJsonRpcError('abc', proto.ERROR_CODES.METHOD_NOT_FOUND, '未知方法', { hint: 'x' });
    assert.equal(error.jsonrpc, '2.0');
    assert.equal(error.id, 'abc');
    assert.equal(error.error.code, -32601);
    assert.equal(error.error.message, '未知方法');
    assert.deepEqual(error.error.data, { hint: 'x' });
    assert.deepEqual(proto.toolErrorResult('坏了').isError, true);
    assert.equal(proto.toolErrorResult('坏了').content[0].text, '坏了');
  });

  await check('单行 JSON 解析（含 \\r 与空行）', () => {
    assert.equal(proto.parseJsonRpcLine('{"jsonrpc":"2.0","id":1}').ok, true);
    assert.equal(proto.parseJsonRpcLine('{"jsonrpc":"2.0"}\r').ok, true);
    assert.equal(proto.parseJsonRpcLine('   ').empty, true);
    const bad = proto.parseJsonRpcLine('{oops');
    assert.equal(bad.ok, false);
    assert.equal(bad.empty, false);
    assert.equal(typeof bad.error, 'string');
  });

  await check('工具定义 → MCP tool 条目（inputSchema=def.parameters）', () => {
    const definition = {
      name: 'vrchat_demo',
      description: '演示用',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    };
    const tool = proto.toMcpTool(definition);
    assert.equal(tool.name, 'vrchat_demo');
    assert.equal(tool.description, '演示用');
    assert.deepEqual(tool.inputSchema, definition.parameters);
    assert.ok(tool.inputSchema !== definition.parameters, '应返回副本，不能把 index.js 的 schema 对象直接交给客户端');
    assert.deepEqual(tool.outputSchema, { type: 'object', additionalProperties: true });
    assert.equal(proto.toMcpTool({ name: 'x' }).description, '');
    assert.equal(proto.toolsListResult([definition]).tools.length, 1);
  });

  await check('图片 content：附件 → {type:image,data,mimeType}', () => {
    const base64 = Buffer.from('fake-png').toString('base64');
    assert.deepEqual(proto.attachmentToImageContent({ data: base64, mediaType: 'image/png' }), {
      type: 'image', data: base64, mimeType: 'image/png',
    });
    assert.equal(proto.attachmentToImageContent({ data: '' }), null);
    assert.equal(proto.attachmentToImageContent(null), null);
  });

  await check('工具结果图片：文本 JSON 不重复塞 base64', () => {
    const base64 = Buffer.from('a-fake-png-payload-for-the-test').toString('base64');
    const content = proto.valueToContent({
      ok: true,
      width: 1280,
      height: 720,
      image: { data: base64, mediaType: 'image/png', bytes: 32, name: 'shot.png' },
    });
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].text.includes(base64), false, '文本 JSON 里不能出现 base64');
    assert.match(content[0].text, /base64Chars/);
    assert.deepEqual(content[1], { type: 'image', data: base64, mimeType: 'image/png' });
  });

  await check('render 的 image block 正常转换（screenshot 路径）', () => {
    const base64 = Buffer.from('fake').toString('base64');
    const definition = {
      name: 'vrchat_screenshot',
      output: {
        render: () => [
          { type: 'text', text: '截图 1280×720' },
          { type: 'image', attachment: { data: base64, mediaType: 'image/png' } },
        ],
      },
    };
    const result = proto.buildToolCallResult(definition, {}, { ok: true, image: { data: base64, mediaType: 'image/png' } });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, '截图 1280×720');
    assert.deepEqual(result.content[1], { type: 'image', data: base64, mimeType: 'image/png' });
    // structuredContent 里同样不能出现 base64（MCP 客户端只看 image block）
    assert.equal(JSON.stringify(result.structuredContent).includes(base64), false);
  });

  await check('render 抛错时回退到 JSON 文本', () => {
    const definition = { name: 'x', output: { render: () => { throw new Error('render boom'); } } };
    const content = proto.renderToolContent(definition, {}, { ok: true, verdict: 'not-ready' });
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /"verdict": "not-ready"/);
  });

  await check('参数校验：必填 / 类型 / 未知键 / oneOf / enum', () => {
    const say = {
      name: 'vrchat_say',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    };
    assert.equal(proto.validateToolArgs(say, { text: 'hi' }).ok, true);
    assert.equal(proto.validateToolArgs(say, {}).ok, false);
    assert.match(proto.validateToolArgs(say, {}).problems.join(' '), /缺少必填参数 text/);
    assert.equal(proto.validateToolArgs(say, { text: 123 }).ok, false);
    assert.match(proto.validateToolArgs(say, { text: 123 }).problems.join(' '), /应为 字符串/);
    assert.equal(proto.validateToolArgs(say, { text: 'hi', extra: 1 }).ok, false);
    assert.match(proto.validateToolArgs(say, { text: 'hi', extra: 1 }).problems.join(' '), /未知参数 extra/);
    const setParam = {
      name: 'vrchat_set_param',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { oneOf: [{ type: 'number' }, { type: 'boolean' }] },
        },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    };
    assert.equal(proto.validateToolArgs(setParam, { name: 'Voice', value: true }).ok, true);
    assert.equal(proto.validateToolArgs(setParam, { name: 'Voice', value: 0.5 }).ok, true);
    assert.equal(proto.validateToolArgs(setParam, { name: 'Voice', value: 'x' }).ok, false);
    const ui = {
      name: 'vrchat_ui',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['press', 'stick'] } },
        required: ['action'],
        additionalProperties: false,
      },
    };
    assert.equal(proto.validateToolArgs(ui, { action: 'jump' }).ok, false);
    assert.equal(proto.validateToolArgs(ui, { action: 'press' }).ok, true);
  });

  await check('配置解析：默认 panel 关闭 / env / CLI 优先 / 非法 JSON', () => {
    const plain = proto.resolveMcpConfig({ argv: [], env: {} });
    assert.equal(plain.ok, true);
    assert.equal(plain.config.panelEnabled, false);
    const fromEnv = proto.resolveMcpConfig({
      argv: [],
      env: { VPLAY_CONFIG: '{"listenEnabled":false,"playerDir":"D:/tmp/p"}' },
    });
    assert.equal(fromEnv.ok, true);
    assert.equal(fromEnv.config.listenEnabled, false);
    assert.equal(fromEnv.config.playerDir, 'D:/tmp/p');
    const cliWins = proto.resolveMcpConfig({
      argv: ['--config', '{"sendPort":19030}'],
      env: { VPLAY_CONFIG: '{"sendPort":9000,"listenEnabled":false}' },
    });
    assert.equal(cliWins.ok, true);
    assert.equal(cliWins.config.sendPort, 19030);
    assert.equal(cliWins.config.listenEnabled, false);
    const bad = proto.resolveMcpConfig({ argv: ['--config', '{oops'], env: {} });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /不是合法 JSON/);
    const badEnv = proto.resolveMcpConfig({ argv: [], env: { VPLAY_CONFIG: '[]' } });
    assert.equal(badEnv.ok, false);
    assert.match(badEnv.error, /JSON 对象/);
    const help = proto.resolveMcpConfig({ argv: ['--help'], env: {} });
    assert.equal(help.ok, true);
    assert.equal(help.help, true);
    const unknown = proto.resolveMcpConfig({ argv: ['--nope'], env: {} });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.warnings.length, 1);
  });
}

// ── 集成测试：真实子进程 + stdio JSON-RPC ──────────────────────────────────

async function integrationTests(fakeRepo) {
  const env = { ...process.env };
  delete env.VPLAY_CONFIG;
  const config = { ...TEST_CONFIG, playerDir: fakeRepo };
  const child = spawn(process.execPath, [SERVER, '--config', JSON.stringify(config)], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = new McpClient(child);
  try {
    await check('initialize 握手（协议版本回显 / serverInfo / capabilities）', async () => {
      const response = await client.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-mcp', version: '0.0.0' },
      });
      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.result.protocolVersion, '2025-03-26');
      assert.deepEqual(response.result.serverInfo, { name: 'dsh-vrchat-vplay-mcp', version: '0.7.0' });
      assert.equal(response.result.capabilities.tools.listChanged, false);
    });

    await check('initialize 未知协议版本 → 回最新支持版本 2025-06-18', async () => {
      const response = await client.request('initialize', { protocolVersion: '1999-01-01' });
      assert.equal(response.result.protocolVersion, '2025-06-18');
    });

    await check('notifications/initialized 不产生响应', async () => {
      client.notify('notifications/initialized');
      await client.expectSilence(200);
    });

    await check('ping 返回空对象', async () => {
      const response = await client.request('ping');
      assert.deepEqual(response.result, {});
    });

    await check('tools/list = 19 个，名称与 index.js 注册名完全一致', async () => {
      const response = await client.request('tools/list');
      const tools = response.result.tools;
      assert.equal(tools.length, 19, `tools/list 应有 19 个工具，实际 ${tools.length}`);
      for (const tool of tools) {
        assert.equal(typeof tool.name, 'string');
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.description.length > 0, `${tool.name} 缺少 description`);
        assert.equal(tool.inputSchema.type, 'object');
      }
      const indexSource = readFileSync(join(ROOT, 'index.js'), 'utf8');
      const expected = [...indexSource.matchAll(/name:\s*'(vrchat_[a-z_]+)'/g)].map((match) => match[1]);
      assert.equal(new Set(expected).size, 19, `index.js 里应有 19 个 vrchat_* 工具，实际 ${new Set(expected).size}`);
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...new Set(expected)].sort());
      const screenshot = tools.find((tool) => tool.name === 'vrchat_screenshot');
      assert.deepEqual(screenshot.inputSchema.properties, {});
      assert.deepEqual(screenshot.inputSchema.required ?? [], []);
    });

    await check('解析失败 → JSON-RPC -32700（stdout 单行）', async () => {
      client.writeRaw('{ this is not json');
      const message = await client.nextUnsolicited();
      assert.equal(message.error.code, -32700);
      assert.equal(message.id, null);
      assert.match(message.error.message, /解析/);
    });

    await check('未知方法 → JSON-RPC -32601', async () => {
      const response = await client.request('tools/nope');
      assert.equal(response.error.code, -32601);
      assert.match(response.error.message, /未知方法/);
    });

    await check('未知工具 → tools/call 结果 isError=true（不是 JSON-RPC error）', async () => {
      const response = await client.request('tools/call', { name: 'vrchat_nope', arguments: {} });
      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /未知工具/);
      assert.match(response.result.content[0].text, /vrchat_doctor/);
    });

    await check('参数问题 → isError=true 并指出缺哪个参数', async () => {
      const response = await client.request('tools/call', { name: 'vrchat_say', arguments: {} });
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /参数错误/);
      assert.match(response.result.content[0].text, /缺少必填参数 text/);
    });

    await check('vrchat_doctor 离线：verdict=not-ready 且不崩', async () => {
      const response = await client.request('tools/call', { name: 'vrchat_doctor', arguments: {} }, 20000);
      assert.equal(response.result.isError, false);
      assert.equal(response.result.structuredContent.verdict, 'not-ready');
      assert.equal(response.result.structuredContent.summary.player, false);
      assert.equal(response.result.content[0].type, 'text');
      assert.ok(response.result.content[0].text.length > 0);
    });

    await check('vrchat_screenshot 离线：isError=false、文本说明、无 image block', async () => {
      const response = await client.request('tools/call', { name: 'vrchat_screenshot', arguments: {} }, 20000);
      assert.equal(response.result.isError, false);
      assert.equal(response.result.structuredContent.ok, false);
      assert.equal(response.result.content[0].type, 'text');
      assert.match(response.result.content[0].text, /截图失败/);
      assert.equal(response.result.content.some((block) => block.type === 'image'), false);
    });

    await check('stdout 只含 JSON-RPC 消息（无 Content-Length / 无日志污染）', () => {
      assert.equal(client.parseFailures.length, 0, `stdout 有非 JSON 行：${JSON.stringify(client.parseFailures.slice(0, 2))}`);
      for (const line of client.rawLines) {
        assert.ok(line.startsWith('{"jsonrpc":"2.0"'), `stdout 行不是 JSON-RPC：${line.slice(0, 120)}`);
        assert.equal(line.toLowerCase().includes('content-length'), false);
      }
    });

    await check('关闭 stdin → 退出码 0 且 dispose() 日志进 stderr', async () => {
      client.closeStdin();
      const exit = await Promise.race([
        client.exit,
        sleep(15000).then(() => { throw new Error('关闭 stdin 后 15s 内没有退出'); }),
      ]);
      assert.equal(exit.code, 0, `退出码应为 0，实际 ${exit.code}（signal=${exit.signal ?? 'null'}）`);
      assert.match(client.stderr, /toolset\.dispose\(\) 完成/);
      assert.match(client.stderr, /stdin 已关闭/);
    });

    await check('最后一行没有换行 + EOF：仍处理该请求再退出 0', async () => {
      const env2 = { ...process.env };
      delete env2.VPLAY_CONFIG;
      const child2 = spawn(process.execPath, [SERVER, '--config', JSON.stringify(config)], {
        cwd: ROOT,
        env: env2,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child2.stdout.setEncoding('utf8');
      child2.stdout.on('data', (chunk) => { out += chunk; });
      child2.stderr.setEncoding('utf8');
      child2.stderr.on('data', (chunk) => { err += chunk; });
      const exitPromise = new Promise((resolve) => child2.on('close', (code, signal) => resolve({ code, signal })));
      // 故意不写结尾换行：模拟宽松宿主最后一条消息少个 \n。
      child2.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}');
      child2.stdin.end();
      const exit = await Promise.race([
        exitPromise,
        sleep(15000).then(() => { throw new Error('无换行 EOF 场景 15s 内没有退出'); }),
      ]);
      const lines = out.split('\n').filter((line) => line.trim().length > 0);
      assert.equal(lines.length, 1, `期望 1 条响应，实际 ${lines.length} 条`);
      const message = JSON.parse(lines[0]);
      assert.equal(message.id, 1);
      assert.equal(message.result.protocolVersion, '2025-03-26');
      assert.equal(exit.code, 0);
      assert.match(err, /stdin 已关闭/);
    });
  } catch (error) {
    if (client.stderr.length > 0) {
      console.error('--- MCP 服务器 stderr（最后 4000 字）---');
      console.error(client.stderr.slice(-4000));
    }
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const fakeRepo = mkdtempSync(join(tmpdir(), 'vplay-mcp-test-'));
mkdirSync(join(fakeRepo, 'player', 'tools'), { recursive: true });
// 假 demo/preflight：保证 playerDir 解析到临时仓库，绝不 spawn 真实玩家进程。
// 故意不放 player/tools/capture_frame.ps1，让截图在离线环境里稳定走"脚本不存在"的降级路径。
writeFileSync(join(fakeRepo, 'player', 'demo.mjs'), 'setTimeout(() => process.exit(0), 400);\n', 'utf8');
writeFileSync(join(fakeRepo, 'player', 'tools', 'preflight.mjs'), 'console.log("FAKE PREFLIGHT OK"); process.exit(0);\n', 'utf8');

try {
  await protocolTests();
  await integrationTests(fakeRepo);
  console.log(`\n${passed} MCP checks passed`);
} finally {
  rmSync(fakeRepo, { recursive: true, force: true });
}
