// Offline end-to-end test: mounts the real plugin apply() on a fake DSH context,
// with a mock VRChat peer on the other side of UDP. No DSH install needed.
// Run: node tools/plugin-offline-test.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeMessage, decodePacket } from '../lib/osc.js';
import * as plugin from '../index.js';

const VRCHAT_IN = 19010;
const VRCHAT_OUT = 19011;
const VMT_IN = 19070;    // mock VMT 驱动收位姿（插件 -> 驱动）
const VMT_OUT = 19071;   // 插件在这里听 /VMT/Out/Alive（驱动 -> 插件）
const HEAD_IN = 19072;   // mock A 线 HMD 驱动（插件 -> 驱动，无回包）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 假玩家仓库：playerDir 会真解析到它，保证离线测试永远不 spawn 真实 demo ----
const fakeRepo = mkdtempSync(join(tmpdir(), 'vplay-offline-'));
mkdirSync(join(fakeRepo, 'player', 'tools'), { recursive: true });
writeFileSync(
  join(fakeRepo, 'player', 'demo.mjs'),
  'setTimeout(() => process.exit(0), 400);\n',
  'utf8',
);
writeFileSync(
  join(fakeRepo, 'player', 'tools', 'preflight.mjs'),
  'console.log("FAKE PREFLIGHT OK"); process.exit(0);\n',
  'utf8',
);
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

// ---- mock VRChat: listens on VRCHAT_IN, can send from VRCHAT_OUT ----
const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const received = [];
receiver.on('message', (buf) => received.push(...decodePacket(buf)));
await new Promise((resolve) => receiver.bind(VRCHAT_IN, '127.0.0.1', resolve));
const sender = dgram.createSocket('udp4');
const vrchatSend = (address, args) => sender.send(encodeMessage(address, args), VRCHAT_OUT, '127.0.0.1');

// ---- mock VMT driver: listens on VMT_IN, periodically answers /VMT/Out/Alive ----
const vmtDriver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const vmtReceived = [];
vmtDriver.on('message', (buf) => vmtReceived.push(...decodePacket(buf)));
await new Promise((resolve) => vmtDriver.bind(VMT_IN, '127.0.0.1', resolve));
const alivePacket = encodeMessage('/VMT/Out/Alive', [
  { type: 's', value: 'Virtual Motion Tracker' },
  { type: 's', value: '0.15-offline-test' },
]);
const aliveTimer = setInterval(() => vmtDriver.send(alivePacket, VMT_OUT, '127.0.0.1'), 100);
aliveTimer.unref?.();

// ---- mock A 线 HMD 驱动: listens on HEAD_IN, never replies (真实驱动也没有回包) ----
const headDriver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const headReceived = [];
headDriver.on('message', (buf) => headReceived.push(...decodePacket(buf)));
await new Promise((resolve) => headDriver.bind(HEAD_IN, '127.0.0.1', resolve));
let headDriverClosed = false;
const closeHeadDriver = () => {
  if (headDriverClosed) return;
  headDriverClosed = true;
  try { headDriver.close(); } catch { /* ignore */ }
};

// ---- fake DSH host context ----
const registry = new Map();
const disposers = [];
const ctx = {
  logger: {
    info: () => {}, warn: () => {}, error: (...a) => console.error('[plugin]', ...a), debug: () => {},
  },
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

plugin.apply(ctx, {
  sendPort: VRCHAT_IN,
  listenPort: VRCHAT_OUT,
  chatboxMinIntervalMs: 20,
  vmtSendPort: VMT_IN,
  vmtListenPort: VMT_OUT,
  vmtListenerIdleMs: 0,
  vmtProbeTimeoutMs: 300,
  poseHz: 60,
  poseHoldHz: 20,
  poseHumanize: false,
  poseIdleDrift: false,
  headPort: HEAD_IN,
  headProbeCacheMs: 0,
  headHz: 90,
  headHoldHz: 30,
  headHumanize: false,
  headIdleDrift: false,
  // 玩家进程：指向临时假仓库（自动探测会真解析到它），离线测试永远不 spawn 真实 demo
  playerDir: fakeRepo,
  playerNode: process.execPath,
  playerMonitorPort: 19999,
  debug: false,
});
await sleep(80);

const signal = new AbortController().signal;
const exec = { signal, agent: undefined };
const call = async (name, args) => {
  const definition = registry.get(name);
  assert.ok(definition, `tool ${name} not registered`);
  return definition.execute(args ?? {}, exec);
};

await check('apply() registers all tools', () => {
  assert.deepEqual([...registry.keys()].sort(), [
    'vrchat_doctor', 'vrchat_drivers', 'vrchat_events', 'vrchat_head', 'vrchat_input', 'vrchat_list_params',
    'vrchat_look', 'vrchat_mode', 'vrchat_move', 'vrchat_osc_send', 'vrchat_player', 'vrchat_player_preflight',
    'vrchat_pose', 'vrchat_say', 'vrchat_screenshot', 'vrchat_set_param', 'vrchat_status', 'vrchat_ui', 'vrchat_wait',
  ]);
});

await check('vrchat_player：未启动时 status/log 优雅降级（不 spawn、不抛）', async () => {
  const status = await call('vrchat_player', { action: 'status', monitorPort: 19999 });
  assert.equal(status.action, 'status');
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.equal(status.monitor.ok, false);
  assert.ok(String(status.monitor.error).length > 0);
  const render = registry.get('vrchat_player').output.render({ action: 'status' }, status);
  assert.match(render[0].text, /玩家未运行/);
  assert.match(render[0].text, /监视器/);

  const log = await call('vrchat_player', { action: 'log', lines: 10 });
  assert.equal(log.action, 'log');
  assert.deepEqual(log.lines, []);
  const logRender = registry.get('vrchat_player').output.render({ action: 'log' }, log);
  assert.match(logRender[0].text, /日志为空/);

  await assert.rejects(() => call('vrchat_player', { action: 'bogus' }), /action/);

  const preflight = await call('vrchat_player_preflight');
  assert.equal(preflight.ok, true);
  assert.match(preflight.output, /FAKE PREFLIGHT OK/);
  const preflightRender = registry.get('vrchat_player_preflight').output.render({}, preflight);
  assert.match(preflightRender[0].text, /体检通过/);

  // 新工具：doctor 只读探测（真机缺什么就报什么，但结构必须齐）；mode 的 chat 挡不 spawn
  const doctor = await call('vrchat_doctor');
  assert.ok(['not-ready', 'chat-ready', 'pose-ready', 'player-ready'].includes(doctor.verdict));
  assert.ok(Array.isArray(doctor.checks) && doctor.checks.length >= 8);
  assert.ok(doctor.checks.every((item) => typeof item.id === 'string' && typeof item.level === 'string'));
  assert.equal(typeof doctor.summary.chat, 'boolean');
  const doctorRender = registry.get('vrchat_doctor').output.render({}, doctor);
  assert.match(doctorRender[0].text, /体检|还不能用|就绪/);

  const chat = await call('vrchat_mode', { preset: 'chat' });
  assert.equal(chat.preset, 'chat');
  assert.equal(chat.running, false);
  assert.match(registry.get('vrchat_mode').output.render({ preset: 'chat' }, chat)[0].text, /对话/);
});

await check('vrchat_status reports listening', async () => {
  const status = await call('vrchat_status');
  assert.equal(status.listening, true);
  assert.equal(status.listenPort, VRCHAT_OUT);
  assert.equal(status.sendPort, VRCHAT_IN);
  assert.equal(status.startError, null);
  assert.deepEqual(status.heldInputs, { buttons: [], axes: [] });
  // 位姿通道状态：未调用前不启动、不占端口
  assert.equal(status.pose.driver.sendPort, VMT_IN);
  assert.equal(status.pose.driver.listenPort, VMT_OUT);
  assert.equal(status.pose.driver.listening, false);
  // 头部通道状态：未调用前不探测、不建 socket
  assert.equal(status.head.driver.port, HEAD_IN);
  assert.equal(status.head.driver.driverAlive, null);
  assert.equal(status.head.driver.lastProbeMsAgo, null);
  assert.equal(status.head.pose.orientation.yaw, 0);
  assert.equal(status.look.mode, 'axis');
  assert.equal(status.look.yawDeg, 0);
});

await check('vrchat_say reaches the VRChat side with one chatbox message', async () => {
  received.length = 0;
  const text = 'hello from the agent';
  const result = await call('vrchat_say', { text });
  await sleep(50);
  const chats = received.filter((m) => m.address === '/chatbox/input');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].args[0].value, text);
  assert.equal(result.chars, text.length);
  const render = registry.get('vrchat_say').output.render({}, result);
  assert.match(render[0].text, /chunk/);
});

await check('vrchat_set_param emits a typed avatar parameter', async () => {
  received.length = 0;
  await call('vrchat_set_param', { name: 'VRCEmote', value: 4 });
  await sleep(50);
  assert.ok(received.some((m) => m.address === '/avatar/parameters/VRCEmote' && m.args[0].type === 'i' && m.args[0].value === 4));
});

await check('vrchat_input presses a button as int 1 then 0', async () => {
  received.length = 0;
  await call('vrchat_input', { action: 'Jump', holdMs: 40 });
  await sleep(120);
  const jump = received.filter((m) => m.address === '/input/Jump');
  assert.equal(jump.length, 2);
  assert.equal(jump[0].args[0].type, 'i');
  assert.equal(jump[0].args[0].value, 1);
  assert.equal(jump[1].args[0].value, 0);
});

await check('vrchat_input drives an axis as float and releases it', async () => {
  received.length = 0;
  await call('vrchat_input', { action: 'LookHorizontal', value: -0.5, holdMs: 40 });
  await sleep(80);
  const axis = received.filter((m) => m.address === '/input/LookHorizontal');
  assert.equal(axis.length, 2);
  assert.equal(axis[0].args[0].type, 'f');
  assert.equal(axis[0].args[0].value, -0.5);
  assert.equal(axis[1].args[0].value, 0);
});

await check('vrchat_move holds and releases all movement axes', async () => {
  received.length = 0;
  const result = await call('vrchat_move', { forward: 0.6, right: 0.2, look: -0.1, durationMs: 60 });
  await sleep(30);
  assert.equal(result.durationMs, 60);
  for (const [action, first, last] of [
    ['Vertical', 0.6, 0],
    ['Horizontal', 0.2, 0],
    ['LookHorizontal', -0.1, 0],
  ]) {
    const packets = received.filter((m) => m.address === `/input/${action}`);
    assert.equal(packets.length, 2, `${action} should be set then reset`);
    assert.equal(packets[0].args[0].type, 'f');
    assert.ok(Math.abs(packets[0].args[0].value - first) < 1e-6, `${action} first value`);
    assert.equal(packets[1].args[0].value, last);
  }
});

await check('inbound params appear in vrchat_list_params and vrchat_events', async () => {
  vrchatSend('/avatar/change', [{ type: 's', value: 'avtr_offline-1' }]);
  vrchatSend('/avatar/parameters/GestureLeft', [{ type: 'i', value: 2 }]);
  vrchatSend('/avatar/parameters/Grounded', [{ type: 'b', value: true }]);
  vrchatSend('/avatar/parameters/Voice', [{ type: 'f', value: 0.5 }]);
  await sleep(80);
  const list = await call('vrchat_list_params', { filter: 'Gesture' });
  assert.equal(list.avatarId, 'avtr_offline-1');
  assert.deepEqual(list.params.map((p) => p.name), ['GestureLeft']);
  assert.equal(list.params[0].value, 2);
  const events = await call('vrchat_events', { since: 0 });
  const names = events.events.map((e) => e.name ?? e.address);
  assert.ok(names.includes('/avatar/change'));
  assert.ok(names.includes('GestureLeft'));
  assert.ok(!names.includes('Voice'), 'noisy Voice should be filtered by default');
  const noisy = await call('vrchat_events', { since: 0, includeNoisy: true });
  assert.ok(noisy.events.some((e) => e.name === 'Voice'));
});

await check('vrchat_wait resolves on a matching gesture', async () => {
  const cursor = (await call('vrchat_events', { since: 0, limit: 1 })).lastSeq;
  const waiting = call('vrchat_wait', { param: 'GestureRight', timeoutMs: 3000, since: cursor });
  await sleep(60);
  vrchatSend('/avatar/parameters/GestureRight', [{ type: 'i', value: 1 }]);
  const result = await waiting;
  assert.equal(result.timeout, false);
  assert.equal(result.event.name, 'GestureRight');
  assert.equal(result.event.value, 1);
  assert.equal(typeof result.params.GestureLeft, 'number');
});

await check('vrchat_wait times out with a snapshot instead of hanging', async () => {
  const result = await call('vrchat_wait', { param: 'NoSuchParam', timeoutMs: 60 });
  assert.equal(result.timeout, true);
  assert.equal(result.event, null);
});

await check('vrchat_osc_send passes typed args through', async () => {
  received.length = 0;
  await call('vrchat_osc_send', { address: '/chatbox/typing', args: [true] });
  await sleep(40);
  assert.ok(received.some((m) => m.address === '/chatbox/typing' && m.args[0].value === true));
});

await check('vrchat_pose drives the VMT channel end-to-end', async () => {
  vmtReceived.length = 0;
  const result = await call('vrchat_pose', {
    hand: 'left',
    target: { x: -0.35, y: 1.45, z: 0.2 },
    durationMs: 100,
    hold: false,
    humanize: false,
  });
  await sleep(80);
  assert.equal(result.finished, true);
  assert.equal(result.driver.alive, true);
  assert.ok(vmtReceived.some((m) => m.address === '/VMT/SetRoomMatrix/Temporary'), 'room matrix should be sent first');
  const poseFrames = vmtReceived.filter((m) => m.address === '/VMT/Room/Unity' && m.args[1]?.value !== 0);
  assert.ok(poseFrames.length >= 3, `pose frames: ${poseFrames.length}`);
  assert.equal(poseFrames[0].args[0].value, 1, 'left hand slot');
  assert.equal(poseFrames[0].args[1].value, 5, 'Index-compatible left controller');
  const last = poseFrames.at(-1);
  assert.ok(Math.abs(last.args[3].value - (-0.35)) < 1e-5, `last x ${last.args[3].value}`);
  assert.match(registry.get('vrchat_pose').output.render({}, result)[0].text, /VMT driver alive/);
});

await check('vrchat_pose hold + cancel hands control back', async () => {
  const started = await call('vrchat_pose', {
    hand: 'right',
    right: { target: { x: 0.55, y: 1.3, z: 0.25 } },
    durationMs: 80,
    hold: true,
    humanize: false,
  });
  assert.equal(started.holdActive, true);
  const status = await call('vrchat_status');
  assert.equal(status.pose.holdActive, true);

  vmtReceived.length = 0;
  const cancelled = await call('vrchat_pose', { cancel: true, disable: true });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.disabled, true);
  await sleep(60);
  const disableFrames = vmtReceived.filter((m) => m.address === '/VMT/Room/Unity' && m.args[1]?.value === 0);
  assert.ok(disableFrames.length >= 2, 'both hands should be disabled');
});

await check('vrchat_head drives the A-line head channel end-to-end', async () => {
  headReceived.length = 0;
  const result = await call('vrchat_head', {
    target: { x: 0.2, y: 1.6, z: 0.5 },
    rotation: { yaw: 90 },
    durationMs: 100,
    hold: false,
    humanize: false,
  });
  await sleep(80);
  assert.equal(result.finished, true);
  assert.equal(result.driver.alive, true);
  assert.equal(result.space, 'unity-lh');
  assert.ok(result.frames >= 3, `head frames: ${result.frames}`);

  const frames = headReceived.filter((m) => m.address === '/dsh/head/pose');
  assert.ok(frames.length >= 3, `head packets: ${frames.length}`);
  for (const message of frames) {
    assert.equal(message.args.length, 7);
    assert.deepEqual(message.args.map((arg) => arg.type), ['f', 'f', 'f', 'f', 'f', 'f', 'f']);
  }
  // 末帧 = Unity(0.2, 1.6, 0.5) + yaw90 → OpenVR pos(0.2, 1.6, -0.5)、quat(0, -√½, 0, √½)
  const last = frames.at(-1);
  assert.ok(Math.abs(last.args[0].value - 0.2) < 1e-5, `x ${last.args[0].value}`);
  assert.ok(Math.abs(last.args[1].value - 1.6) < 1e-5, `y ${last.args[1].value}`);
  assert.ok(Math.abs(last.args[2].value - (-0.5)) < 1e-5, `z ${last.args[2].value}`);
  assert.ok(Math.abs(last.args[3].value - 0) < 1e-5, `qx ${last.args[3].value}`);
  assert.ok(Math.abs(last.args[4].value - (-Math.SQRT1_2)) < 1e-5, `qy ${last.args[4].value}`);
  assert.ok(Math.abs(last.args[5].value - 0) < 1e-5, `qz ${last.args[5].value}`);
  assert.ok(Math.abs(last.args[6].value - Math.SQRT1_2) < 1e-5, `qw ${last.args[6].value}`);

  assert.match(registry.get('vrchat_head').output.render({}, result)[0].text, /dsh_hmd alive/);
  const status = await call('vrchat_status');
  assert.equal(status.head.driver.driverAlive, true);
  assert.ok(status.head.framesSent > 0);
  assert.ok(Math.abs(status.head.pose.position[2] - 0.5) < 1e-6);
  assert.ok(Math.abs(status.head.pose.orientation.yaw - 90) < 1e-6);
});

await check('vrchat_look auto prefers the A-line head channel', async () => {
  received.length = 0;
  headReceived.length = 0;
  const result = await call('vrchat_look', { angleDeg: 90, hold: false, humanize: false });
  await sleep(100);
  assert.equal(result.mode, 'head');
  assert.equal(result.headAvailable, true);
  assert.ok(Math.abs(result.actualDeg - 90) < 1, `actualDeg ${result.actualDeg}`);
  assert.ok(Math.abs(result.startYawDeg - 90) < 1e-6, `startYawDeg ${result.startYawDeg}`);
  assert.ok(Math.abs(result.endYawDeg - 180) < 1, `endYawDeg ${result.endYawDeg}`);
  assert.ok(Math.abs(result.pitchDeg) < 0.01, `pitch ${result.pitchDeg}`);
  const headFrames = headReceived.filter((m) => m.address === '/dsh/head/pose');
  assert.ok(headFrames.length >= 3, `head frames: ${headFrames.length}`);
  assert.equal(
    received.filter((m) => m.address === '/input/LookHorizontal').length,
    0,
    'auto must not send snap turns while the head driver works',
  );
});

await check('vrchat_look mode="snap" still snaps when forced; planOnly sends nothing', async () => {
  received.length = 0;
  headReceived.length = 0;
  const result = await call('vrchat_look', {
    mode: 'snap', angleDeg: -45, holdMs: 60, gapMinMs: 180, gapMaxMs: 320, seed: 1,
  });
  await sleep(120);
  assert.equal(result.mode, 'snap');
  assert.equal(result.headAvailable, true);
  const turns = received.filter((m) => m.address === '/input/LookHorizontal');
  assert.deepEqual(turns.map((m) => m.args[0].value), [-1, 0]);
  assert.equal(headReceived.filter((m) => m.address === '/dsh/head/pose').length, 0, 'forced snap must not touch the head');

  received.length = 0;
  const plan = await call('vrchat_look', { mode: 'snap', angleDeg: 180, stepDeg: 45, planOnly: true });
  assert.equal(plan.planOnly, true);
  assert.equal(plan.mode, 'snap');
  assert.equal(plan.snaps, 4);
  await sleep(40);
  assert.equal(received.filter((m) => m.address === '/input/LookHorizontal').length, 0, 'planOnly must not send');

  const headPlan = await call('vrchat_look', { angleDeg: 45, planOnly: true });
  assert.equal(headPlan.planOnly, true);
  assert.equal(headPlan.mode, 'head');
  assert.ok(Math.abs(headPlan.requestedDeg - 45) < 1e-6, `requestedDeg ${headPlan.requestedDeg}`);
  assert.ok(headPlan.durationMs > 0);
});

await check('vrchat_look falls back to snap when the head driver is gone', async () => {
  closeHeadDriver();
  await sleep(60);
  received.length = 0;
  headReceived.length = 0;
  const result = await call('vrchat_look', {
    mode: 'head', angleDeg: 45, holdMs: 60, gapMinMs: 180, gapMaxMs: 320, seed: 2,
  });
  await sleep(120);
  assert.equal(result.mode, 'snap');
  assert.equal(result.headAvailable, false);
  assert.equal(result.fallback, true);
  assert.match(String(result.warning), /not available|fell back/);
  const turns = received.filter((m) => m.address === '/input/LookHorizontal');
  assert.ok(turns.length >= 2, `snap packets: ${turns.length}`);
  assert.equal(turns[0].args[0].value, 1);
});

await check('vrchat_status head section reports the driver as unavailable after it goes away', async () => {
  const status = await call('vrchat_status');
  assert.equal(status.head.driver.driverAlive, false);
  assert.equal(typeof status.head.driver.lastProbeMsAgo, 'number');
});

await check('every tool schema only uses the DSH-supported JSON Schema subset', () => {
  // 与 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema 同规则（见 docs/dsh-plugin-api.md §3.2）：
  // 只允许 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解；
  // properties 递归；required 的名字必须在 properties 里；没有 type 的节点不能带约束关键字。
  const KEYWORDS = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'examples',
  ]);
  const CONSTRAINT = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
  const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const problems = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      problems.push(`${path}: must be a schema object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!KEYWORDS.has(key)) problems.push(`${path}.${key} is not supported`);
    }
    if (node.type !== undefined && node.oneOf !== undefined) problems.push(`${path}: type + oneOf`);
    if (node.type !== undefined && !TYPES.has(node.type)) problems.push(`${path}.type invalid`);
    if (node.type === undefined && node.oneOf === undefined) {
      for (const key of CONSTRAINT) {
        if (Object.hasOwn(node, key)) problems.push(`${path}.${key} requires type or oneOf`);
      }
    }
    if (node.type === 'object') {
      if (!Object.hasOwn(node, 'properties') && !Object.hasOwn(node, 'additionalProperties')) {
        problems.push(`${path}: object schema should declare properties or additionalProperties`);
      }
      if (Object.hasOwn(node, 'required')) {
        const declared = node.properties ?? {};
        for (const name of node.required) {
          if (!Object.hasOwn(declared, name)) problems.push(`${path}.required names "${name}" not in properties`);
        }
      }
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${name}`);
    if (node.items !== undefined) walk(node.items, `${path}.items`);
    (node.oneOf ?? []).forEach((child, index) => walk(child, `${path}.oneOf[${index}]`));
  };
  for (const definition of registry.values()) {
    assert.equal(definition.parameters?.type, 'object', `${definition.name}: parameters must be object-rooted`);
    walk(definition.parameters, `${definition.name}.parameters`);
    walk(definition.output.schema, `${definition.name}.output.schema`);
  }
  assert.deepEqual(problems, []);
});

await check('every tool has a renderable output', () => {
  for (const definition of registry.values()) {
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.ok(definition.description.length > 20);
    assert.equal(definition.parameters.type, 'object');
  }
});

for (const dispose of disposers.reverse()) dispose();
sender.close();
receiver.close();
if (aliveTimer) clearInterval(aliveTimer);
vmtDriver.close();
closeHeadDriver();
try { rmSync(fakeRepo, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${passed} offline plugin checks passed`);
