// test_player.mjs — vrchat_player / vrchat_player_preflight 单测
// 运行：node tools/test_player.mjs      成功打印 PASS <n> checks
//
// 做法：
//   1) 纯函数：resolvePlayerPaths 的自动探测（config 三种写法 / plugin 自包含 / sibling /
//      legacy 兜底 / missing 完整 tried）与 buildDemoArgs 的 --nav/--map 参数；
//   2) PlayerProcess：临时目录造假仓库（player/demo.mjs + player/tools/preflight.mjs），
//      用假 node 脚本验证 start/status/log/stop 全链路 + status.paths + 错误信息列 tried；
//   3) 本地 HTTP 假监视器（/health /state）验证 status 读取与不可达降级；
//   4) 插件级（index.js）工具注册/render —— 若 index.js 依赖的兄弟文件（doctor/launch）
//      由别的队友尚未落地导致无法导入，则跳过并打印 WARN，不误伤本文件的 lib 覆盖。
// 全程不碰真实 SteamVR/VRChat，也不启动真实 demo。
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_PLAYER_DIR,
  PLAYER_ACTIONS,
  PLAYER_DEFAULT,
  PLAYER_PERCEPTION_MODES,
  PlayerProcess,
  buildDemoArgs,
  resolvePlayerPaths,
  summarizePlayerState,
} from '../lib/player-process.mjs';

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

// ── 假仓库工具：任意目录造一个含 player/demo.mjs 的"配套工程"──────────────
function makeRepo(dir) {
  mkdirSync(join(dir, 'player', 'tools'), { recursive: true });
  writeFileSync(join(dir, 'player', 'demo.mjs'), "import process from 'node:process';\nconsole.log('FAKE_STUB');\nprocess.exit(0);\n");
  writeFileSync(join(dir, 'player', 'tools', 'preflight.mjs'), 'process.exit(0);\n');
  return dir;
}

const base = mkdtempSync(join(tmpdir(), 'dsh-player-test-'));

// 1) 主假仓库（进程链路测试用，假 demo 会打印 380 行并常驻）
const root = join(base, 'repo');
mkdirSync(join(root, 'player', 'tools'), { recursive: true });
const demoPath = join(root, 'player', 'demo.mjs');
const preflightPath = join(root, 'player', 'tools', 'preflight.mjs');
writeFileSync(demoPath, `import process from 'node:process';
const args = process.argv.slice(2);
console.log('FAKE_DEMO_ARGS ' + JSON.stringify(args));
for (let i = 0; i < 380; i += 1) console.log('bulk ' + i);
console.log('FAKE_DEMO_ARGS_AGAIN ' + JSON.stringify(args));
console.log('FAKE_DEMO_READY pid=' + process.pid);
let ticks = 0;
const timer = setInterval(() => { ticks += 1; console.log('tick ' + ticks); }, 120);
function shutdown(signal) {
  console.log('FAKE_DEMO_BYE ' + signal);
  clearInterval(timer);
  setTimeout(() => process.exit(0), 20);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
`);

const PREFLIGHT_OK = `console.log('preflight: hmd / vmt / vrchat endpoints');
console.log('preflight: OK');
process.exit(0);
`;
const PREFLIGHT_FAIL = `console.log('preflight: hmd driver missing');
process.exit(3);
`;
writeFileSync(preflightPath, PREFLIGHT_OK);

// 2) 各种布局的假仓库
const pluginSelfRepo = makeRepo(join(base, 'plugin-self'));                 // 自包含发布包：plugin/player/demo.mjs
const siblingBase = join(base, 'sibling-base');
const siblingPluginDir = join(siblingBase, 'dsh-vrchat-vplay');
mkdirSync(siblingPluginDir, { recursive: true });                            // 插件源码目录（自身没有 player/）
const siblingRepo = makeRepo(join(siblingBase, 'vrchat-vr-driver'));         // 兄弟配套工程
const bothBase = join(base, 'both-base');
const bothPluginDir = makeRepo(join(bothBase, 'dsh-vrchat-vplay'));          // 同时有自包含 player/
makeRepo(join(bothBase, 'vrchat-vr-driver'));                                // 也有兄弟工程 → plugin 应优先
const legacyRepo = makeRepo(join(base, 'legacy-repo'));                      // legacy 兜底（通过 legacyDir 注入）
const emptyPluginDir = join(base, 'empty-plugin');
mkdirSync(emptyPluginDir, { recursive: true });
const emptyPlayerDir = join(base, 'no-such-repo');
const noLegacy = join(base, 'no-legacy');

// ── 假监视器（/health /state）─────────────────────────────────────────────
const monitorRequests = { health: 0, state: 0 };
const fakeFrame = {
  mode: 'vr',
  seq: 42,
  clock: 12.3,
  action: { name: 'walkTo', label: '走向目标', phase: 0.48 },
  root: { pos: [2.2, 0.94, 4.3], yaw: 90, speed: 1.1, vel: [1.1, 0, 0] },
  head: { pos: [2.2, 1.57, 4.3], rot: [0, 0.7, 0, 0.7], gaze: { yaw: 90, pitch: -3 } },
  targets: [{ id: 'npc-1', pos: [3.4, 0, 5.2], label: '目标玩家' }],
  meta: { fps: 60, humanize: { fatigue: 0.12, note: 'walking' } },
  joints: {},
};
const monitorServer = http.createServer((req, res) => {
  const json = (payload) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (req.url === '/health') {
    monitorRequests.health += 1;
    json({ ok: true, frames: 123, fps: 60, clients: 1 });
    return;
  }
  if (req.url === '/state') {
    monitorRequests.state += 1;
    json(fakeFrame);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve) => monitorServer.listen(0, '127.0.0.1', resolve));
const monitorPort = monitorServer.address().port;

async function freePort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const processes = [];
const disposers = [];
const makeProcess = (overrides = {}) => {
  const proc = new PlayerProcess({
    playerDir: root,
    playerNode: process.execPath,
    monitorPort,
    lineBufferSize: 300,
    monitorTimeoutMs: 800,
    legacyDir: noLegacy,
    ...overrides,
  });
  processes.push(proc);
  return proc;
};

// ── 假 spawn（看门狗单测：完全可控、绝不真正起 demo）──────────────────────
function makeFakeSpawn() {
  const spawned = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.pid = 40_000 + spawned.length;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    child.crash = (code = 1) => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.exitCode = code;
      queueMicrotask(() => child.emit('exit', code, null));
      return true;
    };
    child.finish = (code = 0) => child.crash(code);
    spawned.push({ command, args, child });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  return { spawnImpl, spawned };
}
/** 只统计玩家进程（排除 dispose 时可能调用的 taskkill）。 */
const playerSpawns = (fake) => fake.spawned.filter((item) => item.command !== 'taskkill');
const waitUntil = async (fn, timeoutMs = 2000, stepMs = 10) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
};

let plugin = null;
let pluginImportError = null;
try {
  plugin = await import('../index.js');
} catch (error) {
  pluginImportError = error;
}

try {
  // ── 1. 纯函数：resolvePlayerPaths 自动探测 ─────────────────────────────
  await check('PLAYER_DEFAULT：playerDir 空 = 自动探测，playerNode 默认 node，导出常量齐全', () => {
    assert.equal(PLAYER_DEFAULT.playerDir, '');
    assert.equal(PLAYER_DEFAULT.playerNode, 'node');
    assert.ok(Array.isArray(PLAYER_PERCEPTION_MODES) && PLAYER_PERCEPTION_MODES.includes('vision'));
    assert.deepEqual([...PLAYER_ACTIONS], ['start', 'stop', 'status', 'log']);
    assert.equal(typeof LEGACY_PLAYER_DIR, 'string');
    assert.ok(LEGACY_PLAYER_DIR.length > 0);
  });

  await check('playerDir 写法一：仓库根 X（X/player/demo.mjs）', () => {
    const paths = resolvePlayerPaths({ playerDir: root, legacyDir: noLegacy });
    assert.equal(paths.source, 'config');
    assert.equal(paths.playerDir, root);
    assert.equal(paths.demoPath, demoPath);
    assert.equal(paths.preflightPath, preflightPath);
    assert.equal(paths.playerNode, 'node');
    assert.ok(Array.isArray(paths.tried) && paths.tried.includes(demoPath));
  });

  await check('playerDir 写法二：直接传 player 目录（X/demo.mjs）', () => {
    const paths = resolvePlayerPaths({ playerDir: join(root, 'player'), legacyDir: noLegacy });
    assert.equal(paths.source, 'config');
    assert.equal(paths.playerDir, root);
    assert.equal(paths.demoPath, demoPath);
  });

  await check('playerDir 写法三：直接传 demo.mjs 文件路径', () => {
    const paths = resolvePlayerPaths({ playerDir: demoPath, legacyDir: noLegacy });
    assert.equal(paths.source, 'config');
    assert.equal(paths.playerDir, root);
    assert.equal(paths.demoPath, demoPath);
  });

  await check('config.playerDir 优先于 plugin / sibling / legacy', () => {
    const paths = resolvePlayerPaths({
      playerDir: root,
      pluginDir: pluginSelfRepo,
      legacyDir: legacyRepo,
    });
    assert.equal(paths.source, 'config');
    assert.equal(paths.demoPath, demoPath);
  });

  await check('plugin/player 自包含发布包探测（source=plugin）', () => {
    const paths = resolvePlayerPaths({ pluginDir: pluginSelfRepo, legacyDir: noLegacy });
    assert.equal(paths.source, 'plugin');
    assert.equal(paths.playerDir, pluginSelfRepo);
    assert.equal(paths.demoPath, join(pluginSelfRepo, 'player', 'demo.mjs'));
    assert.equal(paths.preflightPath, join(pluginSelfRepo, 'player', 'tools', 'preflight.mjs'));
    assert.ok(paths.tried.includes(paths.demoPath));
  });

  await check('pluginDir/../vrchat-vr-driver 兄弟目录探测（source=sibling）', () => {
    const paths = resolvePlayerPaths({ pluginDir: siblingPluginDir, legacyDir: noLegacy });
    assert.equal(paths.source, 'sibling');
    assert.equal(paths.playerDir, siblingRepo);
    assert.equal(paths.demoPath, join(siblingRepo, 'player', 'demo.mjs'));
  });

  await check('plugin 与 sibling 同时存在时 plugin 优先', () => {
    const paths = resolvePlayerPaths({ pluginDir: bothPluginDir, legacyDir: noLegacy });
    assert.equal(paths.source, 'plugin');
    assert.equal(paths.playerDir, bothPluginDir);
  });

  await check('旧路径兜底：仅当存在时生效（source=legacy）', () => {
    const paths = resolvePlayerPaths({
      playerDir: emptyPlayerDir,
      pluginDir: emptyPluginDir,
      legacyDir: legacyRepo,
    });
    assert.equal(paths.source, 'legacy');
    assert.equal(paths.playerDir, legacyRepo);
    assert.equal(paths.demoPath, join(legacyRepo, 'player', 'demo.mjs'));
  });

  await check('全部找不到：source=missing、demoPath=第一个候选、tried 列出全部候选', () => {
    const paths = resolvePlayerPaths({
      playerDir: emptyPlayerDir,
      pluginDir: emptyPluginDir,
      legacyDir: noLegacy,
    });
    assert.equal(paths.source, 'missing');
    assert.equal(paths.demoPath, paths.tried[0]);
    const expected = [
      join(emptyPlayerDir, 'player', 'demo.mjs'),                 // config 仓库根写法
      join(emptyPlayerDir, 'demo.mjs'),                          // config player 目录写法
      join(emptyPluginDir, 'player', 'demo.mjs'),                // plugin 自包含
      join(emptyPluginDir, '..', 'vrchat-vr-driver', 'player', 'demo.mjs'), // sibling
      join(noLegacy, 'player', 'demo.mjs'),                      // legacy
    ];
    assert.deepEqual(paths.tried, expected);
    assert.equal(paths.playerDir, emptyPlayerDir);
    assert.equal(existsSync(paths.demoPath), false);
  });

  await check('config 传 demo.mjs 文件路径但不存在：tried[0] 就是该文件', () => {
    const missingDemo = join(emptyPlayerDir, 'player', 'demo.mjs');
    const paths = resolvePlayerPaths({
      playerDir: missingDemo,
      pluginDir: emptyPluginDir,
      legacyDir: noLegacy,
    });
    assert.equal(paths.source, 'missing');
    assert.equal(paths.tried[0], missingDemo);
    assert.equal(paths.demoPath, missingDemo);
  });

  await check('playerNode 可覆盖；空 options/null 不抛异常', () => {
    const custom = resolvePlayerPaths({ playerDir: root, playerNode: 'C:\\custom\\node.exe', legacyDir: noLegacy });
    assert.equal(custom.playerNode, 'C:\\custom\\node.exe');
    const fallback = resolvePlayerPaths({ playerDir: root, playerNode: '   ', legacyDir: noLegacy });
    assert.equal(fallback.playerNode, 'node');
    assert.equal(typeof resolvePlayerPaths().source, 'string');
    assert.ok(Array.isArray(resolvePlayerPaths(null).tried));
    assert.ok(resolvePlayerPaths(null).tried.length >= 1);
  });

  // ── 2. 纯函数：buildDemoArgs（含 --nav / --map）──────────────────────────
  await check('buildDemoArgs：原有参数（live/perception/seconds/seed/port）不变', () => {
    assert.deepEqual(buildDemoArgs({}), []);
    assert.deepEqual(buildDemoArgs({ live: true }), ['--live']);
    assert.deepEqual(
      buildDemoArgs({ live: true, perception: 'hybrid', seconds: 20, seed: 7, monitorPort: 8765 }),
      ['--live', '--perception', 'hybrid', '--seconds', '20', '--seed', '7', '--port', '8765'],
    );
    assert.throws(() => buildDemoArgs({ perception: 'bogus' }), /perception/);
    assert.throws(() => buildDemoArgs({ seconds: 3 }), /seconds/);
    assert.throws(() => buildDemoArgs({ seed: -1 }), /seed/);
    assert.throws(() => buildDemoArgs({ monitorPort: 70000 }), /monitorPort/);
  });

  await check('buildDemoArgs：--nav on|off，也接受 boolean；空值跳过', () => {
    assert.deepEqual(buildDemoArgs({ nav: 'on' }), ['--nav', 'on']);
    assert.deepEqual(buildDemoArgs({ nav: 'off' }), ['--nav', 'off']);
    assert.deepEqual(buildDemoArgs({ nav: true }), ['--nav', 'on']);
    assert.deepEqual(buildDemoArgs({ nav: false }), ['--nav', 'off']);
    assert.deepEqual(buildDemoArgs({ nav: undefined }), []);
    assert.deepEqual(buildDemoArgs({ nav: null }), []);
    assert.deepEqual(buildDemoArgs({ nav: '' }), []);
    assert.throws(() => buildDemoArgs({ nav: 'auto' }), /`nav` must be one of on\|off/);
    assert.throws(() => buildDemoArgs({ nav: 1 }), /`nav`/);
  });

  await check('buildDemoArgs：--map 非空字符串才加；非法值抛错', () => {
    assert.deepEqual(buildDemoArgs({ map: 'player/maps/home.json' }), ['--map', 'player/maps/home.json']);
    assert.deepEqual(buildDemoArgs({ map: 'C:\\tmp\\my map.json' }), ['--map', 'C:\\tmp\\my map.json']);
    assert.deepEqual(buildDemoArgs({ map: undefined }), []);
    assert.deepEqual(buildDemoArgs({ map: null }), []);
    assert.deepEqual(buildDemoArgs({ map: '' }), []);
    assert.throws(() => buildDemoArgs({ map: 123 }), /`map` must be a non-empty string path/);
    assert.throws(() => buildDemoArgs({ map: '   ' }), /`map`/);
  });

  await check('buildDemoArgs：nav/map 与其它参数组合顺序稳定', () => {
    assert.deepEqual(
      buildDemoArgs({
        live: true, perception: 'vision', seconds: 20, seed: 7, monitorPort: 8765,
        nav: 'off', map: 'player/maps/home.json',
      }),
      [
        '--live', '--perception', 'vision', '--seconds', '20', '--seed', '7', '--port', '8765',
        '--nav', 'off', '--map', 'player/maps/home.json',
      ],
    );
  });

  await check('summarizePlayerState 精简 /state 且缺字段安全', () => {
    const summary = summarizePlayerState(fakeFrame);
    assert.equal(summary.mode, 'vr');
    assert.equal(summary.action.name, 'walkTo');
    assert.ok(Math.abs(summary.action.phase - 0.48) < 1e-9);
    assert.deepEqual(summary.root.pos, [2.2, 0.94, 4.3]);
    assert.equal(summary.root.yaw, 90);
    assert.equal(summary.targets.length, 1);
    assert.equal(summary.targets[0].id, 'npc-1');
    assert.equal(summary.fps, 60);
    assert.equal(summarizePlayerState(null), null);
    assert.equal(summarizePlayerState('nope'), null);
    const sparse = summarizePlayerState({ action: { name: 'idle' } });
    assert.equal(sparse.root, null);
    assert.deepEqual(sparse.targets, []);
  });

  // ── 3. PlayerProcess：start / status / log / stop ───────────────────────
  const proc = makeProcess();
  await check('PlayerProcess 构造：paths 自动探测到 config 仓库', () => {
    assert.equal(proc.paths.source, 'config');
    assert.equal(proc.paths.playerDir, root);
    assert.equal(proc.paths.demoPath, demoPath);
    assert.ok(Array.isArray(proc.paths.tried));
  });

  await check('start：spawn 成功，返回 pid/monitorUrl/args/cwd（含 --nav/--map）', async () => {
    const started = await proc.start({
      live: true,
      perception: 'hybrid',
      seconds: 20,
      seed: 7,
      monitorPort,
      nav: 'off',
      map: 'player/maps/home.json',
    });
    assert.equal(started.action, 'start');
    assert.equal(started.started, true);
    assert.ok(Number.isInteger(started.pid) && started.pid > 0);
    assert.equal(started.monitorUrl, `http://127.0.0.1:${monitorPort}/`);
    assert.equal(started.cwd, root);
    assert.deepEqual(started.args, [
      process.execPath, demoPath,
      '--live', '--perception', 'hybrid', '--seconds', '20', '--seed', '7', '--port', String(monitorPort),
      '--nav', 'off', '--map', 'player/maps/home.json',
    ]);
    assert.equal(proc.running, true);
  });

  await check('log：环形缓冲按时间顺序返回，行数可配且有 300 行上限', async () => {
    await sleep(350);
    const tail = proc.log({ lines: 40 });
    assert.equal(tail.action, 'log');
    assert.equal(tail.lines.length, 40);
    assert.ok(tail.lines.some((line) => line.includes('tick ') || line.includes('FAKE_DEMO_READY')));
    const capped = proc.log({ lines: 9999 });
    assert.equal(capped.lines.length, 300, '环形缓冲上限应为 300');
    assert.equal(capped.bufferSize, 300);
    assert.equal(proc.log({ lines: 1 }).lines.length, 1);
  });

  await check('start 幂等：已在运行时不重复启动', async () => {
    const again = await proc.start({ live: false });
    assert.equal(again.started, false);
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.pid, proc.info.pid);
  });

  await check('status：子进程存活 + 监视器 /health /state + paths 三字段', async () => {
    const status = await proc.status();
    assert.equal(status.action, 'status');
    assert.equal(status.running, true);
    assert.equal(status.pid, proc.info.pid);
    assert.ok(status.uptimeMs > 0);
    assert.equal(status.monitorUrl, `http://127.0.0.1:${monitorPort}/`);
    assert.equal(status.monitor.ok, true);
    assert.equal(status.monitor.health.frames, 123);
    const state = status.monitor.state;
    assert.equal(state.action.name, 'walkTo');
    assert.ok(Math.abs(state.action.phase - 0.48) < 1e-9);
    assert.deepEqual(state.root.pos, [2.2, 0.94, 4.3]);
    assert.equal(state.root.yaw, 90);
    assert.equal(state.targets.length, 1);
    assert.equal(state.targets[0].label, '目标玩家');
    assert.equal(state.fps, 60);
    assert.ok(monitorRequests.health >= 1 && monitorRequests.state >= 1);
    assert.deepEqual(status.paths, { root, source: 'config', demoPath });
  });

  await check('stop：结束子进程并返回退出信息；重复 stop 优雅返回', async () => {
    const stopped = await proc.stop();
    assert.equal(stopped.action, 'stop');
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.pid !== null, true);
    assert.ok(Number.isFinite(stopped.uptimeMs) && stopped.uptimeMs > 0);
    assert.ok(Array.isArray(stopped.lastLines));
    assert.equal(proc.running, false);
    await sleep(120);
    const status = await proc.status();
    assert.equal(status.running, false);
    assert.ok(status.exit !== null);
    assert.equal(status.paths.source, 'config');
    const again = await proc.stop();
    assert.equal(again.stopped, false);
    assert.equal(again.reason, 'not-running');
  });

  await check('status：监视器不可达时优雅降级（不抛错）', async () => {
    const deadPort = await freePort();
    const proc2 = makeProcess();
    const started = await proc2.start({ seconds: 10, monitorPort: deadPort });
    assert.equal(started.started, true);
    const status = await proc2.status();
    assert.equal(status.running, true);
    assert.equal(status.monitor.ok, false);
    assert.match(String(status.monitor.error), /监视器|连接|失败|超时|ECONNREFUSED|fetch/i);
    assert.equal(status.monitor.state, null);
    await proc2.stop();
  });

  await check('错误路径：demo 不存在时错误信息列出全部 tried 候选', async () => {
    const missingDemo = makeProcess({
      playerDir: emptyPlayerDir,
      pluginDir: emptyPluginDir,
      legacyDir: noLegacy,
    });
    assert.equal(missingDemo.paths.source, 'missing');
    await assert.rejects(
      () => missingDemo.start({}),
      (error) => {
        const message = String(error?.message ?? error);
        assert.match(message, /demo not found|检查插件配置 playerDir/);
        assert.match(message, /已尝试/);
        for (const candidate of missingDemo.paths.tried) {
          assert.ok(message.includes(candidate), `错误信息应列出候选：${candidate}`);
        }
        return true;
      },
    );
    await assert.rejects(
      () => missingDemo.runPreflight(),
      (error) => {
        const message = String(error?.message ?? error);
        assert.match(message, /preflight not found|检查插件配置/);
        assert.match(message, /已尝试/);
        return true;
      },
    );
  });

  await check('错误路径：node 不存在给出清晰错误', async () => {
    const badNode = makeProcess({ playerNode: join(root, 'no-such-node.exe') });
    await assert.rejects(() => badNode.start({}), /cannot start|spawn failed/);
  });

  // ── 4. preflight / dispose ──────────────────────────────────────────────
  await check('preflight：spawn 脚本并汇总输出（成功/失败两种退出码）', async () => {
    const proc3 = makeProcess();
    const ok = await proc3.runPreflight();
    assert.equal(ok.action, 'preflight');
    assert.equal(ok.ok, true);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.output, /preflight: OK/);

    writeFileSync(preflightPath, PREFLIGHT_FAIL);
    const failed = await proc3.runPreflight();
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.match(failed.output, /driver missing/);
    writeFileSync(preflightPath, PREFLIGHT_OK);
  });

  await check('dispose：插件卸载时杀掉玩家子进程', async () => {
    const proc4 = makeProcess();
    await proc4.start({ seconds: 10, monitorPort });
    assert.equal(proc4.running, true);
    proc4.dispose();
    await sleep(350);
    assert.equal(proc4.running, false);
  });

  // ── 4.5 看门狗（假 spawn：完全可控、不真正起 demo）──────────────────────
  await check('watchdog：默认参数 + status.watchdog 初始字段', async () => {
    assert.deepEqual(PLAYER_DEFAULT.watchdog, {
      enabled: true, maxRestarts: 3, backoffMs: 2000, windowMs: 600_000,
    });
    const proc = makeProcess();
    assert.deepEqual(proc.watchdog, {
      enabled: true, maxRestarts: 3, backoffMs: 2000, windowMs: 600_000,
    });
    const status = await proc.status();
    assert.deepEqual(status.watchdog, {
      enabled: true, restarts: 0, maxRestarts: 3, lastRestartAt: null, exhausted: false, reason: null,
    });
  });

  await check('watchdog：非主动退出 → 自动重启 1 次（info/日志/status 更新）', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: true, maxRestarts: 3, backoffMs: 10, windowMs: 60_000 },
    });
    await proc.start({ seconds: 20 });
    assert.equal(playerSpawns(fake).length, 1);
    const firstPid = playerSpawns(fake)[0].child.pid;
    playerSpawns(fake)[0].child.crash(1);
    const restarted = await waitUntil(() => playerSpawns(fake).length >= 2, 2000);
    assert.ok(restarted, '非主动退出后应按 backoff 自动重启');
    const status = await proc.status();
    assert.equal(proc.running, true);
    assert.equal(status.watchdog.enabled, true);
    assert.equal(status.watchdog.restarts, 1);
    assert.equal(status.watchdog.maxRestarts, 3);
    assert.equal(status.watchdog.exhausted, false);
    assert.equal(status.watchdog.reason, 'restarted');
    assert.equal(typeof status.watchdog.lastRestartAt, 'string');
    assert.notEqual(playerSpawns(fake)[1].child.pid, firstPid, '重启后 info/pid 应更新');
    assert.equal(proc.info.pid, playerSpawns(fake)[1].child.pid);
    assert.ok(proc.log({ lines: 100 }).lines.some((line) => line.includes('[watchdog] restart #1')),
      proc.log({ lines: 100 }).lines.slice(-5).join(' | '));
    await proc.stop();
  });

  await check('watchdog：maxRestarts 用尽 → 不再重启且 exhausted=true', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: true, maxRestarts: 2, backoffMs: 10, windowMs: 60_000 },
    });
    await proc.start({});
    for (let i = 0; i < 3; i += 1) {
      const kids = playerSpawns(fake);
      kids[kids.length - 1].child.crash(1);
      await waitUntil(() => playerSpawns(fake).length > kids.length || proc._wd.exhausted, 2000);
    }
    await waitUntil(() => proc._wd.exhausted, 1000);
    const status = await proc.status();
    assert.equal(playerSpawns(fake).length, 3, '初始 1 + 重启 2，第 3 次崩溃不再拉起');
    assert.equal(status.watchdog.restarts, 2);
    assert.equal(status.watchdog.exhausted, true);
    assert.equal(status.watchdog.reason, 'exhausted');
    assert.equal(status.running, false);
  });

  await check('watchdog：主动 stop() 不重启（suppress 生效）', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: true, maxRestarts: 3, backoffMs: 10, windowMs: 60_000 },
    });
    await proc.start({});
    await proc.stop();
    await sleep(80);
    const status = await proc.status();
    assert.equal(playerSpawns(fake).length, 1, '主动 stop 后不得自动拉起');
    assert.equal(status.running, false);
    assert.equal(status.watchdog.restarts, 0);
    assert.equal(status.watchdog.reason, 'stopped');
    assert.equal(status.watchdog.exhausted, false);
  });

  await check('watchdog：dispose() 不重启', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: true, maxRestarts: 3, backoffMs: 10, windowMs: 60_000 },
    });
    await proc.start({});
    proc.dispose();
    await sleep(80);
    const status = await proc.status();
    assert.equal(playerSpawns(fake).length, 1, 'dispose 后不得自动拉起');
    assert.equal(status.watchdog.reason, 'stopped');
    assert.equal(status.running, false);
  });

  await check('watchdog：--seconds 正常到时退出不重启（留 3s 余量）', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: true, maxRestarts: 3, backoffMs: 10, windowMs: 60_000 },
    });
    await proc.start({ seconds: 5 });
    proc.info.startedAt = Date.now() - 6000; // 模拟已跑满 --seconds 5s
    playerSpawns(fake)[0].child.finish(0);
    await sleep(80);
    const status = await proc.status();
    assert.equal(playerSpawns(fake).length, 1, '正常到时退出不应重启');
    assert.equal(status.watchdog.reason, 'completed');
    assert.equal(status.watchdog.restarts, 0);
    assert.equal(status.running, false);
  });

  await check('watchdog：滚动窗口过期后重启配额恢复', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: true, maxRestarts: 1, backoffMs: 5, windowMs: 120 },
    });
    await proc.start({});
    playerSpawns(fake)[0].child.crash(1);
    assert.ok(await waitUntil(() => playerSpawns(fake).length === 2, 2000), '第一次应重启');
    let status = await proc.status();
    assert.equal(status.watchdog.restarts, 1);
    await sleep(240); // 让第一次重启滑出 120ms 窗口
    playerSpawns(fake)[1].child.crash(1);
    assert.ok(await waitUntil(() => playerSpawns(fake).length === 3, 2000), '窗口过期后应允许再次重启');
    status = await proc.status();
    assert.equal(status.watchdog.restarts, 1, '窗口内只算最近一次');
    assert.equal(status.watchdog.exhausted, false);
    assert.equal(status.watchdog.reason, 'restarted');
    await proc.stop();
  });

  await check('watchdog：enabled=false 时退出不重启', async () => {
    const fake = makeFakeSpawn();
    const proc = makeProcess({
      spawnImpl: fake.spawnImpl,
      watchdog: { enabled: false, maxRestarts: 3, backoffMs: 10, windowMs: 60_000 },
    });
    await proc.start({});
    playerSpawns(fake)[0].child.crash(1);
    await sleep(80);
    const status = await proc.status();
    assert.equal(playerSpawns(fake).length, 1);
    assert.equal(status.watchdog.enabled, false);
    assert.equal(status.watchdog.reason, 'disabled');
    assert.equal(status.watchdog.restarts, 0);
  });

  // ── 5. 插件级：工具注册 / 参数 / render（index.js 可导入时才跑）─────────
  if (plugin === null) {
    console.warn(`WARN 跳过插件级检查：index.js 暂不可导入（${pluginImportError?.message ?? pluginImportError}）`);
  } else {
    const registry = new Map();
    const pluginCtx = {
      logger: { info() {}, warn() {}, error(...args) { console.error('[plugin]', ...args); }, debug() {} },
      effect(fn) {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
        return () => dispose?.();
      },
      get(service) {
        if (service === 'tools') {
          return {
            register(definition) {
              assert.ok(!registry.has(definition.name), `duplicate tool ${definition.name}`);
              registry.set(definition.name, definition);
              return () => registry.delete(definition.name);
            },
          };
        }
        return undefined;
      },
    };
    plugin.apply(pluginCtx, {
      sendPort: 19110,
      listenPort: 19111,
      chatboxMinIntervalMs: 20,
      vmtSendPort: 19170,
      vmtListenPort: 19171,
      vmtListenerIdleMs: 0,
      headPort: 19172,
      playerDir: root,
      playerNode: process.execPath,
      playerMonitorPort: monitorPort,
      debug: false,
    });
    await sleep(120);
    const call = async (name, args) => {
      const definition = registry.get(name);
      assert.ok(definition, `tool ${name} not registered`);
      return definition.execute(args ?? {}, { signal: new AbortController().signal });
    };

    await check('插件注册 vrchat_player / vrchat_player_preflight（含 schema + render）', () => {
      assert.ok(registry.has('vrchat_player'));
      assert.ok(registry.has('vrchat_player_preflight'));
      const definition = registry.get('vrchat_player');
      assert.deepEqual(definition.parameters.required, ['action']);
      assert.deepEqual(definition.parameters.properties.action.enum, ['start', 'stop', 'status', 'log']);
      assert.deepEqual(definition.parameters.properties.nav.enum, ['on', 'off']);
      assert.equal(definition.parameters.properties.map.type, 'string');
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof registry.get('vrchat_player_preflight').execute, 'function');
    });

    await check('插件工具链路：status → start(含 --nav/--map) → status → log → stop（render 中文摘要）', async () => {
      const notRunning = await call('vrchat_player', { action: 'status', monitorPort });
      assert.equal(notRunning.running, false);
      assert.equal(notRunning.monitor.ok, true, '假监视器应在线（即便玩家没起）');
      assert.equal(notRunning.paths.source, 'config');
      const notRunningRender = registry.get('vrchat_player').output.render({ action: 'status' }, notRunning);
      assert.match(notRunningRender[0].text, /玩家未运行/);

      const started = await call('vrchat_player', {
        action: 'start', live: false, perception: 'vision', seconds: 10, seed: 3,
        nav: 'off', map: 'player/maps/home.json', monitorPort,
      });
      assert.equal(started.started, true);
      assert.ok(started.args.includes('--nav') && started.args.includes('off'));
      assert.ok(started.args.includes('--map') && started.args.includes('player/maps/home.json'));
      const startRender = registry.get('vrchat_player').output.render({ action: 'start' }, started);
      assert.match(startRender[0].text, /玩家已启动/);
      assert.match(startRender[0].text, new RegExp(`:${monitorPort}/`));

      const status = await call('vrchat_player', { action: 'status', monitorPort });
      assert.equal(status.running, true);
      const statusRender = registry.get('vrchat_player').output.render({ action: 'status' }, status);
      assert.match(statusRender[0].text, /玩家运行中/);
      assert.match(statusRender[0].text, /walkTo/);
      assert.match(statusRender[0].text, /位置 \(2\.20, 4\.30\)/);
      assert.match(statusRender[0].text, /感知目标 1/);

      await sleep(200);
      const log = await call('vrchat_player', { action: 'log', lines: 20 });
      assert.ok(log.lines.length > 0);
      const logRender = registry.get('vrchat_player').output.render({ action: 'log' }, log);
      assert.match(logRender[0].text, /玩家最近 \d+ 行/);

      const stopped = await call('vrchat_player', { action: 'stop' });
      assert.equal(stopped.stopped, true);
      const stopRender = registry.get('vrchat_player').output.render({ action: 'stop' }, stopped);
      assert.match(stopRender[0].text, /玩家已停止/);
    });

    await check('插件 vrchat_player_preflight：走假 preflight 脚本并渲染', async () => {
      const value = await call('vrchat_player_preflight');
      assert.equal(value.ok, true);
      const render = registry.get('vrchat_player_preflight').output.render({}, value);
      assert.match(render[0].text, /体检通过/);
      assert.match(render[0].text, /preflight: OK/);
    });
  }
} finally {
  for (const proc of processes) {
    try { proc.dispose(); } catch { /* ignore */ }
  }
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch { /* ignore */ }
  }
  await new Promise((resolve) => monitorServer.close(resolve));
  await sleep(200);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`PASS ${n} checks (player orchestration)`);
