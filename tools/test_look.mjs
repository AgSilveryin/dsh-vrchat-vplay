// vrchat_look（snap turn 降级转头）单测：本地 UDP socket 当 mock VRChat。
//
// 验证点：
//   - 纯函数：角度→N 次 snap 的换算、目标点→yaw、角度规范化、最大步数保护
//   - 发送序列：每次 snap 是 (1 → 0)，轴用 float、按钮用 int，间隔在人类式抖动区间内
//   - 朝向累计：连续调用 yaw 估计正确
//   - 中断：signal 后停止，且不会把输入留在"按下"状态
//
// 运行：node tools/test_look.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { encodeMessage, decodePacket } from '../lib/osc.js';
import {
  SnapTurner,
  LOOK_ADDRESSES,
  normalizeAngle,
  normalizeLookMode,
  normalizeSnapMode,
  planSnapTurn,
  yawToTarget,
} from '../lib/look.js';

const HOST = '127.0.0.1';
const PORT = 19095;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// ── mock VRChat：收 /input/* ───────────────────────────────────────────────
const received = [];
const receiver = dgram.createSocket({ type: 'udp4' });
receiver.on('message', (buffer) => {
  let messages;
  try {
    messages = decodePacket(buffer);
  } catch {
    return;
  }
  for (const message of messages) {
    received.push({ at: Date.now(), address: message.address, args: message.args });
  }
});
await new Promise((resolve) => receiver.bind(PORT, HOST, resolve));

const sender = dgram.createSocket('udp4');
const send = (address, args) => {
  sender.send(encodeMessage(address, args), PORT, HOST);
};

const turner = new SnapTurner({ send });

const axisMessages = () => received.filter((message) => message.address === LOOK_ADDRESSES.axis);
const values = (messages) => messages.map((message) => message.args[0]?.value);

try {
  // ── 纯函数 ──────────────────────────────────────────────────────────────

  await check('planSnapTurn：角度→snap 次数/方向/达成角度', () => {
    const plan = planSnapTurn(90, { stepDeg: 45, seed: 1 });
    assert.equal(plan.snaps, 2);
    assert.equal(plan.direction, 1);
    assert.equal(plan.achievedDeg, 90);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.gapsMs.length, 1);

    const negative = planSnapTurn(-135, { stepDeg: 45, seed: 2 });
    assert.equal(negative.snaps, -3);
    assert.equal(negative.achievedDeg, -135);
    assert.deepEqual(negative.steps.map((step) => step.direction), [-1, -1, -1]);

    // 不足半格 = 不转
    assert.equal(planSnapTurn(20, { stepDeg: 45 }).snaps, 0);
    assert.equal(planSnapTurn(0, { stepDeg: 45 }).steps.length, 0);
    // 步长是 90° 时，100° 只转 1 格
    assert.equal(planSnapTurn(100, { stepDeg: 90 }).snaps, 1);
  });

  await check('planSnapTurn：间隔在配置区间内、相邻不相等、同 seed 可复现', () => {
    const plan = planSnapTurn(360, { stepDeg: 45, gapMinMs: 180, gapMaxMs: 320, seed: 9 });
    assert.equal(plan.snaps, 8);
    assert.equal(plan.gapsMs.length, 7);
    for (let i = 0; i < plan.gapsMs.length; i += 1) {
      assert.ok(plan.gapsMs[i] >= 180 && plan.gapsMs[i] <= 320, `gap ${plan.gapsMs[i]}`);
      if (i > 0) assert.notEqual(plan.gapsMs[i], plan.gapsMs[i - 1]);
    }
    assert.deepEqual(planSnapTurn(360, { stepDeg: 45, seed: 9 }).gapsMs, plan.gapsMs);
    assert.notDeepEqual(planSnapTurn(360, { stepDeg: 45, seed: 10 }).gapsMs, plan.gapsMs);
  });

  await check('planSnapTurn：maxSnaps 保护 + axis/comfort 动作不同', () => {
    const clamped = planSnapTurn(3600, { stepDeg: 45, maxSnaps: 16 });
    assert.equal(clamped.snaps, 16);
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.achievedDeg, 720);

    const comfort = planSnapTurn(90, { stepDeg: 45, mode: 'comfort', seed: 1 });
    assert.deepEqual(comfort.steps.map((step) => step.action), ['ComfortRight', 'ComfortRight']);
    assert.deepEqual(comfort.steps.map((step) => step.kind), ['button', 'button']);

    const comfortLeft = planSnapTurn(-90, { stepDeg: 45, mode: 'comfort', seed: 1 });
    assert.deepEqual(comfortLeft.steps.map((step) => step.action), ['ComfortLeft', 'ComfortLeft']);

    const axis = planSnapTurn(90, { stepDeg: 45, seed: 1 });
    assert.deepEqual(axis.steps.map((step) => step.kind), ['axis', 'axis']);
  });

  await check('yawToTarget / normalizeAngle：Unity 左手系换算正确', () => {
    assert.equal(yawToTarget({ x: 1, z: 0 }), 90);
    assert.equal(yawToTarget({ x: 0, z: -1 }), 180);
    assert.equal(yawToTarget({ x: -1, z: 0 }), -90);
    assert.equal(yawToTarget({ x: 0, y: 1.6, z: 2 }), 0);
    assert.equal(yawToTarget([0, 1.6, -2]), 180);
    assert.equal(yawToTarget(30), 30);
    assert.equal(normalizeAngle(190), -170);
    assert.equal(normalizeAngle(-190), 170);
    assert.equal(normalizeAngle(180), 180);
    assert.equal(normalizeAngle(540), 180);
    assert.equal(normalizeAngle(360), 0);
    assert.throws(() => yawToTarget({}), /target/);
  });

  await check('normalizeLookMode：auto/head/snap + 旧 axis/comfort 兼容', () => {
    assert.deepEqual(normalizeLookMode('auto'), { mode: 'auto', snapMode: 'axis', legacy: false });
    assert.deepEqual(normalizeLookMode('head'), { mode: 'head', snapMode: 'axis', legacy: false });
    assert.deepEqual(normalizeLookMode('snap'), { mode: 'snap', snapMode: 'axis', legacy: false });
    assert.deepEqual(normalizeLookMode('axis'), { mode: 'snap', snapMode: 'axis', legacy: true });
    assert.deepEqual(normalizeLookMode('comfort'), { mode: 'snap', snapMode: 'comfort', legacy: true });
    assert.deepEqual(normalizeLookMode('AUTO'), { mode: 'auto', snapMode: 'axis', legacy: false });
    assert.deepEqual(normalizeLookMode('bogus'), { mode: 'auto', snapMode: 'axis', legacy: false });
    assert.deepEqual(normalizeLookMode(undefined), { mode: 'auto', snapMode: 'axis', legacy: false });
    assert.equal(normalizeSnapMode('comfort'), 'comfort');
    assert.equal(normalizeSnapMode('nope'), 'axis');
  });

  // ── 发送序列（axis 模式）──────────────────────────────────────────────

  await check('turn(90°, step 45°)：发 2 次 (1→0) 的 float 轴，间隔带抖动', async () => {
    received.length = 0;
    const result = await turner.turn({
      angleDeg: 90,
      stepDeg: 45,
      gapMinMs: 180,
      gapMaxMs: 320,
      holdMs: 70,
      seed: 5,
    });
    assert.equal(result.snaps, 2);
    assert.equal(result.actualDeg, 90);
    assert.equal(result.startYawDeg, 0);
    assert.equal(result.endYawDeg, 90);
    assert.equal(result.packetsSent, 4);
    assert.equal(result.cancelled, false);

    await sleep(80); // UDP 是异步投递的，等 mock 侧收齐
    const messages = axisMessages();
    assert.equal(messages.length, 4);
    for (const message of messages) {
      assert.equal(message.args[0].type, 'f');
    }
    assert.deepEqual(values(messages), [1, 0, 1, 0]);

    const holdMs = messages[1].at - messages[0].at;
    assert.ok(holdMs >= 40 && holdMs <= 250, `press hold ${holdMs}ms`);
    const gapMs = messages[2].at - messages[1].at;
    assert.ok(gapMs >= 150 && gapMs <= 420, `inter-snap gap ${gapMs}ms`);
  });

  await check('turn 累计 yaw：再转 -45° 回到 45°', async () => {
    received.length = 0;
    const result = await turner.turn({ angleDeg: -45, stepDeg: 45, holdMs: 60, seed: 6 });
    assert.equal(result.snaps, -1);
    assert.equal(result.startYawDeg, 90);
    assert.equal(result.endYawDeg, 45);
    await sleep(80);
    assert.deepEqual(values(axisMessages()), [-1, 0]);
  });

  // ── target 模式 ────────────────────────────────────────────────────────

  await check('target 模式：面向世界坐标点', async () => {
    const fresh = new SnapTurner({ send });
    received.length = 0;
    const first = await fresh.turn({ target: { x: 1, y: 1.6, z: 0 }, stepDeg: 45, holdMs: 60, seed: 2 });
    assert.equal(first.actualDeg, 90);
    assert.equal(first.endYawDeg, 90);
    await sleep(80); // 等第一轮的最后一个 UDP 包落地，再清空

    received.length = 0;
    const second = await fresh.turn({ target: { x: 0, z: -1 }, stepDeg: 45, holdMs: 60, seed: 3 });
    assert.equal(second.startYawDeg, 90);
    assert.equal(second.actualDeg, 90);
    assert.equal(second.endYawDeg, 180);
    await sleep(80);
    assert.deepEqual(values(axisMessages()), [1, 0, 1, 0]);
  });

  // ── comfort 模式（VR 按钮）─────────────────────────────────────────────

  await check('comfort 模式：ComfortRight 按钮用 int 1/0，不碰 LookHorizontal', async () => {
    const fresh = new SnapTurner({ send });
    received.length = 0;
    const result = await fresh.turn({
      angleDeg: 45,
      mode: 'comfort',
      stepDeg: 45,
      holdMs: 60,
      seed: 1,
    });
    assert.equal(result.mode, 'comfort');
    assert.equal(result.actualDeg, 45);
    await sleep(80);
    const buttons = received.filter((message) => message.address === LOOK_ADDRESSES.rightButton);
    assert.equal(buttons.length, 2);
    for (const message of buttons) assert.equal(message.args[0].type, 'i');
    assert.deepEqual(values(buttons), [1, 0]);
    assert.equal(axisMessages().length, 0);
  });

  // ── 中断 ────────────────────────────────────────────────────────────────

  await check('signal 中断：停止后续 snap，且最后一次输入回到 0', async () => {
    const fresh = new SnapTurner({ send });
    received.length = 0;
    const abortController = new AbortController();
    const pending = fresh.turn({
      angleDeg: 360,
      stepDeg: 45,
      gapMinMs: 180,
      gapMaxMs: 320,
      holdMs: 90,
      seed: 4,
      signal: abortController.signal,
    });
    await sleep(100);
    abortController.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.ok(Math.abs(result.snaps) < 8, `should stop early, got ${result.snaps} snaps`);

    await sleep(80);
    const messages = axisMessages();
    assert.ok(messages.length >= 2);
    assert.equal(messages.length % 2, 0, 'press/release must be paired');
    assert.equal(messages.at(-1).args[0].value, 0, 'must not leave the axis pressed');
    const settled = received.length;
    await sleep(200);
    assert.equal(received.length, settled, 'no packets after abort');
  });

  await check('plan() 只计算不发包', () => {
    const fresh = new SnapTurner({ send });
    received.length = 0;
    const plan = fresh.plan({ angleDeg: 180, stepDeg: 45, seed: 7 });
    assert.equal(plan.snaps, 4);
    assert.equal(plan.achievedDeg, 180);
    assert.equal(received.length, 0);
  });

  // ── 参数错误 ────────────────────────────────────────────────────────────

  await check('参数错误：既没有 angleDeg 也没有 target 时要报错', async () => {
    const fresh = new SnapTurner({ send });
    await assert.rejects(fresh.turn({}), /angleDeg|target/);
    await assert.rejects(fresh.turn({ angleDeg: 'nope' }), /finite/);
    await assert.rejects(fresh.turn({ target: { x: 'a', z: 0 } }), /target/);
  });
} finally {
  sender.close();
  receiver.close();
}

console.log(`\n${passed} look checks passed`);
