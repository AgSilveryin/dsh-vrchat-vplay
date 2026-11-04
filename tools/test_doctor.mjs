// test_doctor.mjs — vrchat_doctor 体检模块单测（纯离线，全部用假 deps，绝不碰真实 SteamVR/VRChat）
//
// 4 个场景：理想全绿 / 没开 VRChat+Steam / 没驱动 / player 文件缺失 + 端口被占。
// 断言 verdict、summary、对应 check 的 level、nextSteps 关键词；另测 deps 全抛异常也不崩。
import assert from 'node:assert/strict';
import { DOCTOR_CHECK_IDS, runDoctor } from '../lib/doctor.mjs';

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

const CONFIG = {
  sendPort: 9000,
  listenPort: 9001,
  headPort: 39572,
  headDriverAssumed: null,
  vmtListenPort: 39571,
  playerDir: 'X:/fake/vrchat-vr-driver',
  playerNode: 'node',
  playerMonitorPort: 8765,
  steamVrLogPath: 'X:/fake/vrserver.txt',
  vrchatLogDir: 'X:/fake/vrchat-logs',
};

function fakeDeps(overrides = {}) {
  return {
    exists: () => true,
    readText: () => null,
    listProcesses: () => [],
    probeUdpBind: () => 'free',
    probeTcp: () => false,
    exec: () => ({ ok: true, stdout: '' }),
    resolvePaths: () => ({ found: true, demoPath: 'X:/fake/vrchat-vr-driver/player/demo.mjs', root: 'X:/fake/vrchat-vr-driver', source: 'config' }),
    listDir: () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function levelOf(report, id) {
  const found = report.checks.find((item) => item.id === id);
  assert.ok(found, `check ${id} missing`);
  return found.level;
}

function assertReportShape(report, expectedVerdict) {
  assert.equal(report.verdict, expectedVerdict);
  assert.ok(Array.isArray(report.checks));
  assert.equal(report.checks.length, DOCTOR_CHECK_IDS.length);
  assert.deepEqual(report.checks.map((item) => item.id), [...DOCTOR_CHECK_IDS]);
  assert.ok(Array.isArray(report.nextSteps));
  assert.ok(report.nextSteps.length <= 3, `nextSteps 超过 3 条: ${report.nextSteps.length}`);
  for (const step of report.nextSteps) assert.ok(typeof step === 'string' && step.length > 0);
  for (const item of report.checks) {
    assert.ok(item.label.length > 0);
    assert.ok(['ok', 'warn', 'fail', 'unknown'].includes(item.level), `bad level ${item.level}`);
    assert.ok(typeof item.detail === 'string' && item.detail.length > 0);
    if (item.hint !== undefined) assert.ok(typeof item.hint === 'string');
  }
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(report.meta.at, new Date(1_700_000_000_000).toISOString());
  assert.equal(report.meta.node, process.version);
  assert.equal(report.meta.platform, process.platform);
}

const ALL_PROCESSES = [
  { name: 'VRChat.exe', pid: 101 },
  { name: 'steam.exe', pid: 102 },
  { name: 'vrserver.exe', pid: 103 },
];

// ── 场景 1：理想路径，全部就绪 ────────────────────────────────────────────
await check('理想全绿 → player-ready，11 项全 ok，nextSteps 为空', async () => {
  const report = await runDoctor(CONFIG, fakeDeps({
    exists: () => true,
    readText: () => [
      'Using existing HMD dsh_hmd',
      "Driver 'vmt' finished adding tracked device",
    ].join('\n'),
    listProcesses: () => ALL_PROCESSES,
    probeUdpBind: (port) => (Number(port) === 9000 ? 'in-use' : 'free'),
    probeTcp: () => false,
    exec: () => ({ ok: true, stdout: 'VRChat - Headset Window\n' }),
    listDir: () => ['output_log_2026-11-01.txt'],
  }));
  assertReportShape(report, 'player-ready');
  assert.deepEqual(report.summary, { chat: true, pose: true, player: true });
  assert.equal(report.ok, true);
  for (const id of DOCTOR_CHECK_IDS) assert.equal(levelOf(report, id), 'ok', `${id} 应为 ok`);
  assert.match(
    report.checks.find((item) => item.id === 'player-files').detail,
    /解析来源：config/,
    'player-files 的 detail 必须写清解析来源',
  );
  assert.deepEqual(report.nextSteps, []);
});

// ── 场景 2：没开 VRChat + Steam（也没有驱动）─────────────────────────────
await check('没开 VRChat+Steam → not-ready（绿灯必须诚实：进程没开就不算 ready），nextSteps 含 Steam/降级', async () => {
  const report = await runDoctor(CONFIG, fakeDeps());
  assertReportShape(report, 'not-ready');
  assert.deepEqual(report.summary, { chat: false, pose: false, player: false });
  assert.equal(levelOf(report, 'vrchat-process'), 'warn');
  assert.equal(levelOf(report, 'steam-process'), 'warn');
  assert.equal(levelOf(report, 'steamvr-process'), 'warn');
  assert.equal(levelOf(report, 'hmd-driver'), 'fail');
  assert.equal(levelOf(report, 'vmt-driver'), 'unknown');
  assert.equal(levelOf(report, 'osc-ports'), 'warn');
  assert.equal(report.ok, false);
  assert.ok(report.nextSteps.some((step) => step.includes('Steam')), `缺少 Steam 提示: ${report.nextSteps.join(' | ')}`);
  assert.ok(report.nextSteps.some((step) => step.includes('降级')), `缺少驱动降级提示: ${report.nextSteps.join(' | ')}`);
});

// ── 场景 3：VRChat/Steam/SteamVR 都在，但 HMD/VMT 驱动没就绪 ─────────────
await check('无驱动 → chat-ready（玩家/位姿都不算就绪）；nextSteps 首条是驱动降级', async () => {
  const report = await runDoctor(CONFIG, fakeDeps({
    readText: () => 'SteamVR log: no tracked devices added yet\n',
    listProcesses: () => ALL_PROCESSES,
    probeUdpBind: (port) => (Number(port) === 9000 ? 'in-use' : 'free'),
    exec: () => ({ ok: true, stdout: 'VRChat - Headset Window\n' }),
    listDir: () => ['output_log_2026-11-01.txt'],
  }));
  assertReportShape(report, 'chat-ready');
  assert.deepEqual(report.summary, { chat: true, pose: false, player: false });
  assert.equal(levelOf(report, 'hmd-driver'), 'fail');
  assert.equal(levelOf(report, 'vmt-driver'), 'unknown');
  assert.ok(report.nextSteps[0].includes('降级'), `首条应是驱动降级: ${report.nextSteps.join(' | ')}`);
});

// ── 场景 4：player 文件缺失 + OSC/监视器端口被占 ─────────────────────────
await check('player 缺失 + 端口被占 → pose-ready；nextSteps 含 playerDir 与端口', async () => {
  const report = await runDoctor(CONFIG, fakeDeps({
    resolvePaths: () => ({
      found: false,
      demoPath: 'D:/中转站API/vrchat-vr-driver/player/demo.mjs',
      root: 'D:/中转站API/vrchat-vr-driver',
      source: 'missing',
    }),
    listProcesses: () => ALL_PROCESSES,
    readText: () => 'Using existing HMD dsh_hmd\n',
    probeUdpBind: (port) => (Number(port) === 9001 ? 'in-use' : Number(port) === 9000 ? 'in-use' : 'free'),
    probeTcp: (host, port) => Number(port) === 8765,
    exec: () => ({ ok: true, stdout: 'VRChat - Headset Window\n' }),
    listDir: () => ['output_log_2026-11-01.txt'],
  }));
  assertReportShape(report, 'pose-ready');
  assert.deepEqual(report.summary, { chat: true, pose: true, player: false });
  assert.equal(levelOf(report, 'player-files'), 'fail');
  assert.match(report.checks.find((item) => item.id === 'player-files').detail, /missing/);
  assert.equal(levelOf(report, 'osc-ports'), 'warn');
  assert.equal(levelOf(report, 'monitor-port'), 'warn');
  assert.equal(report.ok, true);
  assert.ok(report.nextSteps.some((step) => step.includes('playerDir')), `缺少 playerDir 提示: ${report.nextSteps.join(' | ')}`);
  assert.ok(report.nextSteps.some((step) => step.includes('端口')), `缺少端口提示: ${report.nextSteps.join(' | ')}`);
});

// ── 结构 & 健壮性 ─────────────────────────────────────────────────────────
await check('导出契约：DOCTOR_CHECK_IDS 11 项且顺序稳定', () => {
  assert.equal(DOCTOR_CHECK_IDS.length, 11);
  assert.equal(new Set(DOCTOR_CHECK_IDS).size, 11);
  assert.equal(DOCTOR_CHECK_IDS[0], 'node-version');
  assert.equal(DOCTOR_CHECK_IDS[1], 'player-files');
  assert.equal(DOCTOR_CHECK_IDS[10], 'monitor-port');
  assert.equal(typeof runDoctor, 'function');
});

await check('deps 全部抛异常也不抛，返回 unknown/not-ready 且结构完整', async () => {
  const thrower = () => { throw new Error('boom'); };
  const report = await runDoctor({}, {
    exists: thrower,
    readText: thrower,
    listProcesses: thrower,
    probeUdpBind: thrower,
    probeTcp: thrower,
    exec: thrower,
    resolvePaths: thrower,
    listDir: thrower,
    now: thrower,
  });
  assert.equal(report.checks.length, DOCTOR_CHECK_IDS.length);
  assert.ok(['not-ready', 'chat-ready', 'pose-ready', 'player-ready'].includes(report.verdict));
  assert.ok(Array.isArray(report.nextSteps) && report.nextSteps.length <= 3);
  assert.equal(typeof report.meta.at, 'string');
  assert.ok(report.checks.some((item) => item.id === 'hmd-driver' && item.level === 'unknown'));
  assert.equal(typeof report.ok, 'boolean');
});

await check('headDriverAssumed 覆盖优先于日志/端口探测', async () => {
  const forced = await runDoctor(
    { ...CONFIG, headDriverAssumed: true },
    fakeDeps({ listProcesses: () => ALL_PROCESSES, readText: () => null, probeUdpBind: () => 'free' }),
  );
  assert.equal(levelOf(forced, 'hmd-driver'), 'ok');
  assert.equal(forced.summary.pose, true);
  const forcedOff = await runDoctor(
    { ...CONFIG, headDriverAssumed: false },
    fakeDeps({ listProcesses: () => ALL_PROCESSES, readText: () => 'Using existing HMD dsh_hmd\n' }),
  );
  assert.equal(levelOf(forcedOff, 'hmd-driver'), 'fail', 'headDriverAssumed=false 应压过日志证据');
});

console.log(`PASS ${n} checks (doctor)`);
