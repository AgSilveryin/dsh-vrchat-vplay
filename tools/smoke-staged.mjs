// smoke-staged.mjs — 验收"装到新机器"：从一个没有兄弟工程目录的位置装载插件并跑一遍。
//
// 用法：node tools/smoke-staged.mjs [<包根目录>] [<config JSON>]
//   例：node tools/smoke-staged.mjs "C:\temp\pkg" '{"playerMonitorPort":18765}'
//
// 它做四件事，任何一步失败都退出码 1：
//   1. 用假 DSH ctx 挂载 <包根>/index.js，断言 16 个工具都注册了（含 vrchat_doctor / vrchat_mode）；
//   2. 跑 vrchat_doctor（真实探测，但没有副作用）；
//   3. 跑 vrchat_mode preset=demo（演练挡：只喂监视器，不碰 VR），断言进程起来且监视器 HTTP 可达；
//   4. 停掉并断言没有残留。
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
const config = JSON.parse(process.argv[3] ?? process.env.SMOKE_CONFIG ?? '{}');
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(150);
  }
  throw new Error(`超时：${label}`);
};

const registry = new Map();
const disposers = [];
const ctx = {
  logger: {
    info: () => {},
    warn: () => {},
    error: (...args) => console.error('[plugin]', ...args),
    debug: () => {},
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => dispose?.();
  },
  get(service) {
    if (service !== 'tools') return undefined;
    return {
      register(definition) {
        assert.ok(!registry.has(definition.name), `重复注册工具 ${definition.name}`);
        registry.set(definition.name, definition);
        return () => registry.delete(definition.name);
      },
    };
  },
};

const plugin = await import(pathToFileURL(join(root, 'index.js')).href);
assert.equal(typeof plugin.apply, 'function', 'index.js 没有导出 apply');
plugin.apply(ctx, { sendPort: 19010, listenPort: 19011, vmtListenPort: 19071, headPort: 19072, ...config });
await waitFor(() => registry.size > 0, 2000, '工具注册');

const expected = [
  'vrchat_status', 'vrchat_say', 'vrchat_list_params', 'vrchat_set_param', 'vrchat_input', 'vrchat_move',
  'vrchat_events', 'vrchat_wait', 'vrchat_pose', 'vrchat_head', 'vrchat_look',
  'vrchat_player', 'vrchat_player_preflight', 'vrchat_doctor', 'vrchat_mode', 'vrchat_osc_send',
];
for (const name of expected) assert.ok(registry.has(name), `缺工具 ${name}`);

try {
  // 2. 体检
  const doctor = await registry.get('vrchat_doctor').execute({}, {});
  assert.ok(typeof doctor.verdict === 'string', 'doctor.verdict 不是字符串');
  assert.ok(Array.isArray(doctor.checks) && doctor.checks.length >= 8, 'doctor.checks 少于 8 项');
  assert.ok(checkedEvery(doctor.checks), 'doctor 有 check 缺 id/level');
  console.log(`ok   doctor  ${doctor.verdict} · ${doctor.checks.length} 项检查`);

  // 3. 演练挡
  const mode = await registry.get('vrchat_mode').execute({ preset: 'demo', seconds: 8 }, {});
  assert.equal(mode.running, true, `mode 没启动：${mode.reason ?? '?'}`);
  assert.ok(String(mode.monitorUrl).startsWith('http://127.0.0.1:'), 'monitorUrl 不对');
  await waitFor(async () => {
    try {
      const response = await fetch(`${mode.monitorUrl}health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 8000, '监视器 /health');
  const status = await registry.get('vrchat_player').execute({ action: 'status' }, {});
  assert.equal(status.running, true, 'status 显示没在跑');
  assert.ok(status.monitor.ok === true, '监视器读不到 /state');
  console.log(`ok   demo    pid=${mode.pid} · ${mode.monitorUrl} · 感知 ${mode.perception} · 导航 ${mode.nav}`);

  // 4. 停
  const stopped = await registry.get('vrchat_mode').execute({ preset: 'stop' }, {});
  assert.equal(stopped.running, false, 'stop 后仍 running');
  console.log('ok   stop    已停止');

  // 5. 挡位语义（chat 不需要 VR）
  const chat = await registry.get('vrchat_mode').execute({ preset: 'chat' }, {});
  assert.equal(chat.running, false, 'chat 挡仍在跑');
  console.log('ok   chat    对话挡就绪');
} finally {
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch { /* ignore */ }
  }
}

function checkedEvery(checks) {
  return checks.every((check) => typeof check?.id === 'string' && typeof check?.level === 'string'
    && ['ok', 'warn', 'fail', 'unknown'].includes(check.level));
}

console.log('\nsmoke-staged: 全部通过');
process.exit(0);
