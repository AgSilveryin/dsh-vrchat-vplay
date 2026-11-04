// vrchat_pose 位姿通道单测（不需要 SteamVR / VRChat / VMT 真驱动）。
//
// 做法：起一个本地 UDP socket 当"mock VMT 驱动"（收 19090，周期性发 /VMT/Out/Alive 到 19091），
// 然后让真实的 PoseController 发位姿，逐包解码验证：
//   - OSC 字节布局（地址/类型标签/大端 float/int）
//   - 插值是否单调、末帧是否精确落到目标
//   - 发送频率/帧数、hold 微动作、抢占、cancel/abort、无驱动降级
//
// 运行：node tools/test_pose.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { encodeMessage, decodePacket, decodeOscString } from '../lib/osc.js';
import {
  DEFAULT_POSES,
  PoseController,
  positionFrom,
  quatFromEuler,
  resolvePoseTargets,
  rotationToQuat,
  slerpQuat,
} from '../lib/vmt.js';

const HOST = '127.0.0.1';
const SEND_PORT = 19090;   // mock 驱动监听（controller -> driver）
const REPLY_PORT = 19091;  // 主 controller 监听 Alive（driver -> controller）
const REPLY_PORT2 = 19092; // 无驱动场景用

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

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

// ── mock VMT 驱动：收位姿 + 周期发 Alive ──────────────────────────────────

const packets = [];
let aliveEnabled = true;

const driver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
driver.on('message', (buffer) => {
  let messages;
  try {
    messages = decodePacket(buffer);
  } catch {
    return;
  }
  for (const message of messages) {
    packets.push({ at: Date.now(), address: message.address, args: message.args, raw: buffer });
  }
});
await new Promise((resolve) => driver.bind(SEND_PORT, HOST, resolve));

const ALIVE_PACKET = encodeMessage('/VMT/Out/Alive', [
  { type: 's', value: 'Virtual Motion Tracker' },
  { type: 's', value: '0.15-test' },
]);
const aliveTimer = setInterval(() => {
  if (aliveEnabled) driver.send(ALIVE_PACKET, REPLY_PORT, HOST);
}, 100);
aliveTimer.unref?.();

const posePackets = () => packets.filter((packet) => packet.address === '/VMT/Room/Unity');
const framesFor = (slot) => posePackets().filter((packet) => packet.args[0]?.value === slot);
const motionFramesFor = (slot) => framesFor(slot).filter((packet) => packet.args[1]?.value !== 0);
const lastMotionFrame = (slot) => {
  const frames = motionFramesFor(slot);
  return frames[frames.length - 1];
};

const controller = new PoseController({
  host: HOST,
  sendPort: SEND_PORT,
  listenPort: REPLY_PORT,
  hz: 60,
  holdHz: 20,
  humanize: false,
  idleDrift: false,
  listenerIdleMs: 0,
  probeTimeoutMs: 600,
  logger: silentLogger,
});
controller.start();

try {
  // ── 纯函数部分 ──────────────────────────────────────────────────────────

  await check('四元数：欧拉角/球面插值/归一化', () => {
    const q90 = quatFromEuler({ yaw: 90 });
    assert.ok(Math.abs(q90[0]) < 1e-9);
    assert.ok(Math.abs(q90[1] - Math.SQRT1_2) < 1e-9);
    assert.ok(Math.abs(q90[3] - Math.SQRT1_2) < 1e-9);
    const half = slerpQuat([0, 0, 0, 1], q90, 0.5);
    const q45 = quatFromEuler({ yaw: 45 });
    for (let i = 0; i < 4; i += 1) assert.ok(Math.abs(half[i] - q45[i]) < 1e-9, `slerp[${i}]`);
    const normalized = rotationToQuat({ qx: 0, qy: 0, qz: 0, qw: 2 });
    assert.deepEqual(normalized, [0, 0, 0, 1]);
  });

  await check('位置解析：缺省轴沿用当前值，非法值报错', () => {
    assert.deepEqual(positionFrom({ x: 0.3 }, [-0.25, 1.2, 0.18]), [0.3, 1.2, 0.18]);
    assert.deepEqual(positionFrom(undefined, [-0.25, 1.2, 0.18]), [-0.25, 1.2, 0.18]);
    assert.throws(() => positionFrom({}, [-0.25, 1.2, 0.18]), /at least one/);
    assert.throws(() => positionFrom({ x: 'nope' }, [-0.25, 1.2, 0.18]), /finite number/);
  });

  await check('resolvePoseTargets：hand 推断与 per-hand 覆盖', () => {
    const onlyLeft = resolvePoseTargets({ left: { target: { x: -0.4 } } }, DEFAULT_POSES);
    assert.equal(onlyLeft.hand, 'left');
    assert.deepEqual(onlyLeft.sides, ['left']);
    assert.deepEqual(onlyLeft.targets.left.position, [-0.4, 1.2, 0.18]);

    const overridden = resolvePoseTargets({
      hand: 'both',
      target: { y: 1.4 },
      right: { target: { x: 0.5 } },
    }, DEFAULT_POSES);
    assert.deepEqual(overridden.targets.left.position, [-0.25, 1.4, 0.18]);
    assert.deepEqual(overridden.targets.right.position, [0.5, 1.4, 0.18]);

    assert.throws(() => resolvePoseTargets({ hand: 'both' }, DEFAULT_POSES), /no target/);
    assert.throws(() => resolvePoseTargets({ hand: 'middle', target: { x: 0 } }, DEFAULT_POSES), /hand/);
  });

  // ── 探活 ────────────────────────────────────────────────────────────────

  await check('探活：收到 mock 驱动的 /VMT/Out/Alive', async () => {
    const probe = await controller.client.probeDriver(800);
    assert.equal(probe.alive, true);
    assert.equal(controller.client.listening, true);
  });

  // ── 主路径：平滑插值到目标 ───────────────────────────────────────────────

  await check('animate：OSC 字节布局正确（地址/类型标签/大端 int+float）', async () => {
    packets.length = 0;
    await controller.animate({
      hand: 'left',
      left: { target: { x: -0.3, y: 1.4, z: 0.2 } },
      durationMs: 120,
      hold: false,
      humanize: false,
    });
    await sleep(80); // 最后一包 UDP 投递是异步的，等 mock 收齐再断言
    const [firstPose] = motionFramesFor(1);
    assert.ok(firstPose !== undefined, 'no pose frame captured');
    const [address, afterAddress] = decodeOscString(firstPose.raw, 0);
    const [tags] = decodeOscString(firstPose.raw, afterAddress);
    assert.equal(address, '/VMT/Room/Unity');
    assert.equal(tags, ',iiffffffff');
    assert.equal(firstPose.args.length, 10);
    assert.deepEqual(firstPose.args.map((arg) => arg.type), ['i', 'i', 'f', 'f', 'f', 'f', 'f', 'f', 'f', 'f']);
    // 直接按字节再验一遍：args 从 afterAddress+12 开始（地址 16B + 标签串 12B）
    const argsOffset = afterAddress + 12;
    assert.equal(firstPose.raw.readInt32BE(argsOffset), 1, 'slot = 1 (left)');
    assert.equal(firstPose.raw.readInt32BE(argsOffset + 4), 5, 'enable = 5 (left Index controller)');
    assert.ok(Math.abs(firstPose.raw.readFloatBE(argsOffset + 8) - firstPose.args[2].value) < 1e-7, 'time offset float32');
    assert.ok(Math.abs(firstPose.raw.readFloatBE(argsOffset + 12) - firstPose.args[3].value) < 1e-7, 'x float32 (big-endian)');
    assert.ok(Math.abs(firstPose.raw.readFloatBE(argsOffset + 16) - firstPose.args[4].value) < 1e-7, 'y float32 (big-endian)');
    // 首包必须是单位 RoomMatrix（不装 VMT Manager 时驱动要求先设置，否则 RejectTracking）
    assert.equal(packets[0].address, '/VMT/SetRoomMatrix/Temporary');
    assert.equal(packets[0].args.length, 12);
    assert.deepEqual(packets[0].args.map((arg) => arg.value), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  await check('animate：单调插值、末帧精确命中目标、帧率/时长合理', async () => {
    packets.length = 0;
    const startLeft = [...controller.state().hands.left.position];
    const startedAt = Date.now();
    const result = await controller.animate({
      hand: 'both',
      left: { target: { x: -0.35, y: 1.45, z: 0.22 } },
      right: { target: { x: 0.3, y: 1.4, z: 0.2 } },
      durationMs: 300,
      easing: 'linear',
      hold: false,
      humanize: false,
    });
    const elapsedMs = Date.now() - startedAt;
    await sleep(80);

    assert.equal(result.finished, true);
    assert.equal(result.interrupted, false);
    assert.equal(result.easing, 'linear');
    assert.equal(result.hz, 60);
    assert.equal(result.effectiveDurationMs, 300);
    assert.equal(result.driver.alive, true);
    assert.equal(result.warning, null);
    assert.ok(result.frames >= 8, `too few frames: ${result.frames}`);
    assert.ok(result.frames <= 30, `too many frames: ${result.frames}`);
    assert.ok(elapsedMs >= 260 && elapsedMs <= 900, `unexpected wall time: ${elapsedMs}ms`);

    const leftFrames = motionFramesFor(1);
    const rightFrames = motionFramesFor(2);
    assert.equal(leftFrames.length, result.frames);
    assert.equal(rightFrames.length, result.frames);

    // 起点 = 上一段动作结束后的姿态
    assert.ok(Math.abs(leftFrames[0].args[3].value - startLeft[0]) < 1e-6, `first x ${leftFrames[0].args[3].value}`);
    // linear 插值：x 单调不增
    for (let i = 1; i < leftFrames.length; i += 1) {
      assert.ok(leftFrames[i].args[3].value <= leftFrames[i - 1].args[3].value + 1e-9, `x not monotonic at ${i}`);
    }
    const lastLeft = leftFrames[leftFrames.length - 1];
    assert.ok(Math.abs(lastLeft.args[3].value - (-0.35)) < 1e-6, `last x ${lastLeft.args[3].value}`);
    assert.ok(Math.abs(lastLeft.args[4].value - 1.45) < 1e-6, `last y ${lastLeft.args[4].value}`);
    assert.ok(Math.abs(lastLeft.args[5].value - 0.22) < 1e-6, `last z ${lastLeft.args[5].value}`);
    const lastRight = rightFrames[rightFrames.length - 1];
    assert.ok(Math.abs(lastRight.args[3].value - 0.3) < 1e-6, `right x ${lastRight.args[3].value}`);

    // hold:false → 结束后发 enable=0 交还真实手柄
    assert.equal(framesFor(1).at(-1).args[1].value, 0);
    assert.equal(framesFor(2).at(-1).args[1].value, 0);

    // 帧间隔：drift 补偿后平均接近 1000/60ms（Windows 定时器粒度下允许较宽）
    const times = leftFrames.map((frame) => frame.at);
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(average >= 8 && average <= 40, `avg frame gap ${average}ms`);
  });

  await check('easing：easeOut 中点比 linear 更靠前', async () => {
    packets.length = 0;
    await controller.animate({
      hand: 'left', left: { target: { x: -0.45 } }, durationMs: 240, easing: 'easeOut', hold: false, humanize: false,
    });
    await sleep(80);
    const frames = motionFramesFor(1);
    const midIndex = Math.floor(frames.length / 2);
    const progress = (frames[midIndex].args[3].value - (-0.25)) / (-0.45 - -0.25);
    assert.ok(progress > 0.6, `easeOut mid progress should lead: ${progress}`);
  });

  // ── hold：动作结束后继续喂位姿 + 微动作 ──────────────────────────────────

  await check('hold：结束后继续发送且带小幅微动作，cancel 后交还手柄', async () => {
    packets.length = 0;
    const result = await controller.animate({
      hand: 'right',
      right: { target: { x: 0.5, y: 1.3, z: 0.25 } },
      durationMs: 100,
      hold: true,
      humanize: true,
      seed: 11,
    });
    assert.equal(result.finished, true);
    assert.equal(result.holdActive, true);
    assert.equal(controller.state().holdActive, true);

    const before = framesFor(2).length;
    await sleep(400);
    const after = framesFor(2).length;
    assert.ok(after - before >= 4, `hold should keep streaming, delta=${after - before}`);

    const holdFrames = motionFramesFor(2).slice(-4);
    for (const frame of holdFrames) {
      assert.ok(Math.abs(frame.args[3].value - 0.5) <= 0.0131, `hold x ${frame.args[3].value}`);
      assert.ok(Math.abs(frame.args[4].value - 1.3) <= 0.0131, `hold y ${frame.args[4].value}`);
      assert.ok(Math.abs(frame.args[5].value - 0.25) <= 0.0131, `hold z ${frame.args[5].value}`);
    }

    const cancelResult = controller.cancel({ disable: true });
    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.hadMotion, false);
    assert.equal(cancelResult.holdActive, true);
    assert.equal(cancelResult.disabled, true);
    await sleep(80);
    assert.equal(framesFor(2).at(-1).args[1].value, 0);

    const settled = packets.length;
    await sleep(150);
    assert.ok(packets.length - settled <= 1, 'no frames after cancel');
  });

  // ── 抢占 ────────────────────────────────────────────────────────────────

  await check('抢占：新动作打断旧动作，旧调用返回 interrupted', async () => {
    packets.length = 0;
    const first = controller.animate({
      hand: 'right',
      right: { target: { x: 0.8, y: 1.2, z: 0.3 } },
      durationMs: 700,
      hold: false,
      humanize: false,
    });
    await sleep(150);
    const second = await controller.animate({
      hand: 'right',
      right: { target: { x: -0.5, y: 1.2, z: 0.3 } },
      durationMs: 200,
      hold: false,
      humanize: false,
    });
    const firstResult = await first;
    await sleep(80);
    assert.equal(firstResult.interrupted, true);
    assert.equal(firstResult.finished, false);
    assert.equal(second.finished, true);
    assert.ok(Math.abs(lastMotionFrame(2).args[3].value - (-0.5)) < 1e-6);
    // 抢占后不应再有人在往 +0.8 方向慢慢走：最后一段 x 应到 -0.5
    assert.equal(controller.state().activeMotion, null);
  });

  // ── wait:false ──────────────────────────────────────────────────────────

  await check('wait:false：立即返回，动作在后台继续', async () => {
    packets.length = 0;
    const startedAt = Date.now();
    const result = await controller.animate({
      hand: 'left',
      left: { target: { x: -0.4, y: 1.3 } },
      durationMs: 400,
      hold: false,
      humanize: false,
      wait: false,
    });
    const quick = Date.now() - startedAt;
    assert.equal(result.started, true);
    assert.equal(result.finished, false);
    assert.ok(quick < 300, `wait:false should return immediately, took ${quick}ms`);
    assert.ok(controller.state().activeMotion !== null);
    await sleep(700);
    assert.equal(controller.state().activeMotion, null);
    assert.ok(motionFramesFor(1).length >= 5);
  });

  // ── abort（exec.signal）─────────────────────────────────────────────────

  await check('abort：signal 触发后停止发包、返回 cancelled', async () => {
    packets.length = 0;
    const abortController = new AbortController();
    const pending = controller.animate({
      hand: 'right',
      right: { target: { x: 0.1, y: 1.3 } },
      durationMs: 800,
      hold: false,
      humanize: false,
      signal: abortController.signal,
    });
    await sleep(150);
    abortController.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.interrupted, false);
    const count = packets.length;
    await sleep(150);
    assert.equal(packets.length, count, 'no packets after abort');
    assert.equal(controller.state().holdActive, false);
  });

  await check('cancel：进行中的动作被 cancel，disable 会发 enable=0', async () => {
    packets.length = 0;
    const pending = controller.animate({
      hand: 'both',
      target: { y: 1.45 },
      durationMs: 800,
      hold: false,
      humanize: false,
    });
    await sleep(140);
    const cancelResult = controller.cancel({ disable: true });
    const motionResult = await pending;
    assert.equal(cancelResult.hadMotion, true);
    assert.equal(cancelResult.disabled, true);
    assert.equal(motionResult.cancelled, true);
    await sleep(80);
    assert.equal(framesFor(1).at(-1).args[1].value, 0);
    assert.equal(framesFor(2).at(-1).args[1].value, 0);
  });

  // ── 无驱动：只降级警告，不报错 ──────────────────────────────────────────

  await check('无驱动：driver.alive=false + warning，仍然发包（降级）', async () => {
    aliveEnabled = false; // mock 驱动不再回 Alive
    const controller2 = new PoseController({
      host: HOST,
      sendPort: SEND_PORT,
      listenPort: REPLY_PORT2,
      hz: 30,
      humanize: false,
      listenerIdleMs: 0,
      probeTimeoutMs: 250,
      probeCacheMs: 0,
      probeBackoffMs: 0,
      logger: silentLogger,
    });
    controller2.start();
    try {
      packets.length = 0;
      const startedAt = Date.now();
      const result = await controller2.animate({
        hand: 'left',
        left: { target: { x: -0.4 } },
        durationMs: 120,
        hold: false,
        humanize: false,
      });
      assert.equal(result.driver.alive, false);
      assert.equal(typeof result.warning, 'string');
      assert.match(result.warning, /not detected/);
      assert.ok(result.frames >= 2, `degraded mode should still send frames: ${result.frames}`);
      assert.ok(Date.now() - startedAt >= 200, 'probe should have waited for alive');
      assert.equal(controller2.state().driver.driverAlive, false);
    } finally {
      controller2.dispose();
    }
  });

  await check('端口被占（client 报告 listen-unavailable）：alive=null + unknown 警告', async () => {
    const fakeClient = {
      enableMode: 'index',
      roomMatrixSentAt: 0,
      start() {},
      stop() {},
      async probeDriver() {
        return { alive: null, reason: 'listen-unavailable' };
      },
      state() {
        return { listenError: 'EADDRINUSE: mock', lastAliveMsAgo: null, lastUnavailable: null };
      },
      sendPose() {
        return 1;
      },
      sendRoomMatrixIdentity() {
        return 1;
      },
    };
    const controller3 = new PoseController({ client: fakeClient, hz: 30, holdHz: 10, humanize: false });
    controller3.start();
    try {
      const result = await controller3.animate({
        hand: 'right', right: { target: { x: 0.2 } }, durationMs: 60, hold: false, humanize: false,
      });
      assert.equal(result.driver.alive, null);
      assert.equal(result.driver.reason, 'listen-unavailable');
      assert.match(result.warning, /unknown/);
      assert.ok(result.frames >= 2);
    } finally {
      controller3.dispose();
    }
  });
} finally {
  controller.dispose();
  aliveTimer && clearInterval(aliveTimer);
  driver.close();
}

console.log(`\n${passed} pose checks passed`);
