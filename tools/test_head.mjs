// vrchat_head（A 线自研 HMD 驱动）单测：本地 UDP mock，不需要 SteamVR / VRChat。
//
// 覆盖：
//   - OpenVR 右手系 ↔ Unity 左手系换算（位置 z 取反、四元数 qz/qw 取反 + w 归一）
//   - 欧拉角语义（yaw+右 / pitch+抬头 / roll+右歪）
//   - OSC 编码：/dsh/head/pose 7 个 float（类型标签 ,fffffff、大端）
//   - 插值/帧率/末帧精确、hold 呼吸微动作、抢占、wait:false、abort、cancel
//   - 无驱动降级（端口占用探活）与 assumed 覆盖
//
// 运行：node tools/test_head.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { decodePacket, decodeOscString } from '../lib/osc.js';
import {
  DEFAULT_HEAD_POSE,
  HEAD_ADDRESS,
  HeadClient,
  HeadController,
  headPositionFrom,
  normalizeOrientation,
  openvrToUnity,
  orientationFromQuat,
  orientationToQuat,
  probePortOccupied,
  resolveHeadTarget,
  unityToOpenVR,
} from '../lib/head.js';

const HOST = '127.0.0.1';
const PORT = 19080;        // mock A 线驱动
const FREE_PORT = 19082;   // 没有驱动的端口

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

// ── mock A 线驱动：只收包头，不回包（真实驱动也没有回包）────────────────────
const packets = [];
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
await new Promise((resolve) => driver.bind(PORT, HOST, resolve));

const headPackets = () => packets.filter((packet) => packet.address === HEAD_ADDRESS);
const lastHead = () => headPackets().at(-1);

const controller = new HeadController({
  host: HOST,
  port: PORT,
  hz: 90,
  holdHz: 30,
  humanize: false,
  idleDrift: false,
  probeCacheMs: 0,
  logger: silentLogger,
});
controller.start();

const nearlyEqual = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

try {
  // ── 纯函数：坐标换算 ────────────────────────────────────────────────────
  await check('unityToOpenVR：位置 z 取反，四元数 qz/qw 取反且 w>=0', () => {
    const pose = { position: [0, 1.6, 2], rotation: orientationToQuat({ yaw: 90 }) };
    const openvr = unityToOpenVR(pose);
    assert.deepEqual(openvr.position, [0, 1.6, -2]);
    // Unity yaw+90 的四元数 (0, s, 0, c) → OpenVR 同一旋转的 (0, -s, 0, c)
    assert.ok(nearlyEqual(openvr.rotation[0], 0, 1e-9));
    assert.ok(nearlyEqual(openvr.rotation[1], -Math.SQRT1_2, 1e-9));
    assert.ok(nearlyEqual(openvr.rotation[2], 0, 1e-9));
    assert.ok(nearlyEqual(openvr.rotation[3], Math.SQRT1_2, 1e-9));
    assert.ok(openvr.rotation[3] >= 0);
  });

  await check('unityToOpenVR 自逆：OpenVR→Unity 用同一公式', () => {
    const pose = { position: [0.2, 1.7, -1.4], rotation: orientationToQuat({ yaw: 37, pitch: -22, roll: 11 }) };
    const openvr = unityToOpenVR(pose);
    const back = openvrToUnity(openvr);
    for (let i = 0; i < 3; i += 1) assert.ok(nearlyEqual(back.position[i], pose.position[i], 1e-9), `pos[${i}]`);
    // 四元数与输入相差一个整体符号（同一旋转）也算通过
    const dot = back.rotation.reduce((sum, value, index) => sum + value * pose.rotation[index], 0);
    assert.ok(nearlyEqual(Math.abs(dot), 1, 1e-9), `quat dot ${dot}`);
  });

  await check('欧拉角语义：yaw+右 / pitch+抬头 / roll+右歪', () => {
    const yawQuat = orientationToQuat({ yaw: 90 });
    assert.ok(nearlyEqual(yawQuat[1], Math.SQRT1_2, 1e-9));
    const pitchQuat = orientationToQuat({ pitch: 30 });
    assert.ok(nearlyEqual(pitchQuat[0], -Math.sin(Math.PI / 12), 1e-9), 'pitch+30 → Unity qx = sin(-15°)');
    assert.ok(nearlyEqual(pitchQuat[3], Math.cos(Math.PI / 12), 1e-9));
    const rollQuat = orientationToQuat({ roll: 20 });
    assert.ok(rollQuat[2] < 0, 'roll+right → negative Unity qz');

    // 反解回原值
    for (const orientation of [
      { yaw: 0, pitch: 0, roll: 0 },
      { yaw: 90, pitch: 0, roll: 0 },
      { yaw: -45, pitch: 30, roll: 0 },
      { yaw: 12, pitch: -40, roll: 15 },
    ]) {
      const back = orientationFromQuat(orientationToQuat(orientation));
      assert.ok(nearlyEqual(back.yaw, orientation.yaw, 1e-6), `yaw ${back.yaw} vs ${orientation.yaw}`);
      assert.ok(nearlyEqual(back.pitch, orientation.pitch, 1e-6), `pitch ${back.pitch} vs ${orientation.pitch}`);
      assert.ok(nearlyEqual(back.roll, orientation.roll, 1e-6), `roll ${back.roll} vs ${orientation.roll}`);
    }
  });

  await check('normalizeOrientation：缺省轴沿用、pitch 夹到 ±89、yaw 规范', () => {
    const normalized = normalizeOrientation({ yaw: 370, pitch: 120 }, { yaw: 0, pitch: 5, roll: 7 });
    assert.equal(normalized.yaw, 10);
    assert.equal(normalized.pitch, 89);
    assert.equal(normalized.roll, 7);
    assert.throws(() => normalizeOrientation({ yaw: 'nope' }, DEFAULT_HEAD_POSE.orientation), /finite/);
  });

  await check('resolveHeadTarget：部分 target 保持其他轴、欧拉/四元数都支持', () => {
    const partial = resolveHeadTarget({ target: { z: 2 } }, DEFAULT_HEAD_POSE);
    assert.deepEqual(partial.position, [0, 1.6, 2]);

    const euler = resolveHeadTarget({ rotation: { yaw: 30, pitch: 10 } }, DEFAULT_HEAD_POSE);
    assert.ok(nearlyEqual(euler.orientation.yaw, 30, 1e-9));
    assert.ok(nearlyEqual(euler.orientation.pitch, 10, 1e-9));
    assert.ok(nearlyEqual(euler.orientation.roll, 0, 1e-9));

    const quatInput = resolveHeadTarget({
      rotation: { qx: 0, qy: Math.SQRT1_2, qz: 0, qw: Math.SQRT1_2 },
    }, DEFAULT_HEAD_POSE);
    assert.ok(nearlyEqual(quatInput.orientation.yaw, 90, 1e-6));

    assert.throws(() => resolveHeadTarget({}, DEFAULT_HEAD_POSE), /target|rotation/);
    assert.throws(() => resolveHeadTarget({ target: {} }, DEFAULT_HEAD_POSE), /at least one/);
    assert.throws(() => headPositionFrom('nope', [0, 0, 0]), /object/);
  });

  // ── 探活（端口占用启发式）───────────────────────────────────────────────
  await check('探活：mock 驱动占着 39572→alive=true；空闲端口→alive=false', async () => {
    const alive = await probePortOccupied(HOST, PORT);
    assert.deepEqual(alive, { alive: true, reason: 'port-in-use' });
    const free = await probePortOccupied(HOST, FREE_PORT);
    assert.deepEqual(free, { alive: false, reason: 'port-free' });

    const probe = await controller.probeDriver();
    assert.equal(probe.alive, true);
    assert.equal(probe.reason, 'port-in-use');
    assert.equal(probe.port, PORT);
  });

  await check('assumed 覆盖：headDriverAssumed=false 时不探测', async () => {
    const assumedOff = new HeadClient({ port: PORT, assumed: false });
    assert.deepEqual(await assumedOff.probeDriver(), { alive: false, reason: 'assumed-off', port: PORT });
    assumedOff.stop();
    const assumedOn = new HeadClient({ port: FREE_PORT, assumed: true });
    assert.deepEqual(await assumedOn.probeDriver(), { alive: true, reason: 'assumed-on', port: FREE_PORT });
    assumedOn.stop();
  });

  // ── 主路径：发位姿 ──────────────────────────────────────────────────────
  await check('OSC 编码：/dsh/head/pose 7 个 float（,fffffff + 大端）', async () => {
    packets.length = 0;
    const before = { ...controller.pose, position: [...controller.pose.position], rotation: [...controller.pose.rotation] };
    await controller.animate({
      target: { x: 0.2, z: 1.0 },
      rotation: { yaw: 90 },
      durationMs: 120,
      hold: false,
      humanize: false,
    });
    await sleep(80);
    const first = headPackets()[0];
    assert.ok(first !== undefined, 'no head packet captured');
    const [address, afterAddress] = decodeOscString(first.raw, 0);
    const [tags] = decodeOscString(first.raw, afterAddress);
    assert.equal(address, '/dsh/head/pose');
    assert.equal(tags, ',fffffff');
    assert.equal(first.args.length, 7);
    assert.deepEqual(first.args.map((arg) => arg.type), ['f', 'f', 'f', 'f', 'f', 'f', 'f']);
    // 地址 16B + 标签串 12B → 参数从 28 开始；x 在 +0、y +4、z +8、qx +12
    const argsOffset = afterAddress + 12;
    assert.ok(nearlyEqual(first.raw.readFloatBE(argsOffset), before.position[0], 1e-6), 'x');
    assert.ok(nearlyEqual(first.raw.readFloatBE(argsOffset + 4), before.position[1], 1e-6), 'y');
    assert.ok(nearlyEqual(first.raw.readFloatBE(argsOffset + 8), -before.position[2], 1e-6), 'z (Unity→OpenVR)');
    assert.ok(Math.abs(first.raw.readFloatBE(argsOffset + 12) - first.args[3].value) < 1e-7, 'qx big-endian float32');
  });

  await check('animate：插值单调、末帧精确命中目标（位置/朝向）', async () => {
    packets.length = 0;
    const before = {
      position: [...controller.pose.position],
      orientation: { ...controller.pose.orientation },
    };
    const startedAt = Date.now();
    const result = await controller.animate({
      target: { x: 0.3, y: 1.55, z: 1.2 },
      rotation: { yaw: 60, pitch: -20 },
      durationMs: 250,
      easing: 'linear',
      hold: false,
      humanize: false,
    });
    const elapsedMs = Date.now() - startedAt;
    await sleep(80);

    assert.equal(result.finished, true);
    assert.equal(result.interrupted, false);
    assert.equal(result.hz, 90);
    assert.equal(result.effectiveDurationMs, 250);
    assert.equal(result.driver.alive, true);
    assert.equal(result.warning, null);
    assert.ok(result.frames >= 8 && result.frames <= 30, `frames ${result.frames}`);
    assert.ok(elapsedMs >= 230 && elapsedMs <= 900, `elapsed ${elapsedMs}`);
    assert.equal(result.to.position[2], 1.2);

    const frames = headPackets();
    assert.equal(frames.length, result.frames);
    // Unity 目标 → OpenVR 末帧：位置 z 取反
    const last = frames.at(-1);
    assert.ok(nearlyEqual(last.args[2].value, -1.2, 1e-6), `openvr z ${last.args[2].value}`);
    assert.ok(nearlyEqual(last.args[0].value, 0.3, 1e-6), `openvr x ${last.args[0].value}`);
    // 朝向：yaw+60 pitch-20（低头）→ OpenVR 四元数应与换算函数一致
    const expected = unityToOpenVR({ position: [0, 0, 0], rotation: orientationToQuat({ yaw: 60, pitch: -20 }) });
    for (let i = 0; i < 4; i += 1) {
      assert.ok(nearlyEqual(last.args[3 + i].value, expected.rotation[i], 1e-6), `quat[${i}]`);
    }
    // 位置 z 单调（从默认 0 到 OpenVR -1.2）
    for (let i = 1; i < frames.length; i += 1) {
      assert.ok(frames[i].args[2].value <= frames[i - 1].args[2].value + 1e-9, `z not monotonic at ${i}`);
    }
    // 帧间隔：90Hz 在 Windows 定时器粒度下实际约 60–70Hz，给宽范围
    const times = frames.map((frame) => frame.at);
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(average >= 8 && average <= 40, `avg frame gap ${average}ms`);
    // 头部位姿不需要 RoomMatrix
    assert.ok(!packets.some((packet) => packet.address.includes('RoomMatrix')));
  });

  await check('easing：easeOut 中点比 linear 更靠前', async () => {
    packets.length = 0;
    const startY = controller.pose.position[1];
    await controller.animate({
      target: { y: startY + 0.1 }, durationMs: 240, easing: 'easeOut', hold: false, humanize: false,
    });
    await sleep(80);
    const frames = headPackets();
    const mid = frames[Math.floor(frames.length / 2)];
    const progress = (mid.args[1].value - startY) / 0.1;
    assert.ok(progress > 0.6, `easeOut mid progress ${progress}`);
  });

  // ── hold：呼吸/微动作 ───────────────────────────────────────────────────
  await check('hold：结束后继续流且微动有界，cancel 后停止（state 正确）', async () => {
    packets.length = 0;
    const result = await controller.animate({
      target: { x: 0.1, y: 1.6, z: 0.5 },
      rotation: { yaw: 20 },
      durationMs: 100,
      hold: true,
      humanize: true,
      seed: 11,
    });
    assert.equal(result.finished, true);
    assert.equal(result.holdActive, true);
    assert.equal(controller.state().holdActive, true);

    const before = headPackets().length;
    await sleep(400);
    const after = headPackets().length;
    assert.ok(after - before >= 3, `hold should keep streaming, delta=${after - before}`);

    const base = result.to;
    const holdFrames = headPackets().slice(-4);
    for (const frame of holdFrames) {
      // 位置微动 ≤ driftAmplitude(4mm)，z 是 OpenVR 符号
      assert.ok(Math.abs(frame.args[0].value - base.position[0]) <= 0.0041, `hold x ${frame.args[0].value}`);
      assert.ok(Math.abs(frame.args[1].value - base.position[1]) <= 0.0041, `hold y ${frame.args[1].value}`);
      assert.ok(Math.abs(frame.args[2].value - (-base.position[2])) <= 0.0041, `hold z ${frame.args[2].value}`);
      // 旋转微动很小：与基准四元数点积接近 1
      const baseQuat = unityToOpenVR(base).rotation;
      const dot = [0, 1, 2, 3].reduce((sum, index) => sum + baseQuat[index] * frame.args[3 + index].value, 0);
      assert.ok(Math.abs(dot) > 0.9999, `hold rotation drift too large (dot=${dot})`);
    }

    const cancelResult = controller.cancel();
    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.hadMotion, false);
    assert.equal(cancelResult.holdActive, true);
    assert.equal(controller.state().holdActive, false);
    const settled = headPackets().length;
    await sleep(150);
    assert.ok(headPackets().length - settled <= 1, 'no frames after cancel');
  });

  // ── 抢占 / wait:false / abort ───────────────────────────────────────────
  await check('抢占：新动作打断旧动作，旧调用返回 interrupted', async () => {
    packets.length = 0;
    const first = controller.animate({
      target: { x: 0.8, z: 0.8 },
      durationMs: 700,
      hold: false,
      humanize: false,
    });
    await sleep(150);
    const second = await controller.animate({
      target: { x: -0.5, z: -0.5 },
      durationMs: 200,
      hold: false,
      humanize: false,
    });
    const firstResult = await first;
    assert.equal(firstResult.interrupted, true);
    assert.equal(firstResult.finished, false);
    assert.equal(second.finished, true);
    await sleep(80);
    const last = lastHead();
    assert.ok(nearlyEqual(last.args[0].value, -0.5, 1e-6));
    assert.ok(nearlyEqual(last.args[2].value, 0.5, 1e-6), 'openvr z = -(-0.5)');
    assert.equal(controller.state().activeMotion, null);
  });

  await check('wait:false：立即返回，后台继续；state 可观察', async () => {
    packets.length = 0;
    const startedAt = Date.now();
    const result = await controller.animate({
      target: { x: 0.2, y: 1.5 },
      durationMs: 400,
      hold: false,
      humanize: false,
      wait: false,
    });
    const quick = Date.now() - startedAt;
    assert.equal(result.started, true);
    assert.equal(result.finished, false);
    assert.ok(quick < 300, `wait:false took ${quick}ms`);
    assert.ok(controller.state().activeMotion !== null);
    await sleep(700);
    assert.equal(controller.state().activeMotion, null);
    assert.ok(headPackets().length >= 4);
  });

  await check('abort：signal 触发后停止发包、返回 cancelled', async () => {
    packets.length = 0;
    const abortController = new AbortController();
    const pending = controller.animate({
      target: { y: 1.45 },
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
    await sleep(100); // 等 abort 前最后几包 UDP 投递完
    const count = packets.length;
    await sleep(150);
    assert.equal(packets.length, count, 'no packets after abort');
    assert.equal(controller.state().holdActive, false);
  });

  await check('参数校验：既没有 target 也没有 rotation 时抛错', async () => {
    await assert.rejects(controller.animate({}), /target|rotation/);
  });

  // ── 无驱动降级 ──────────────────────────────────────────────────────────
  await check('无驱动：driver.alive=false + warning，仍然发包（best-effort）', async () => {
    const controller2 = new HeadController({
      host: HOST,
      port: FREE_PORT,
      hz: 30,
      humanize: false,
      probeCacheMs: 0,
      logger: silentLogger,
    });
    controller2.start();
    try {
      packets.length = 0;
      const result = await controller2.animate({
        target: { x: 0, y: 1.6, z: 0 },
        durationMs: 120,
        hold: false,
        humanize: false,
      });
      assert.equal(result.driver.alive, false);
      assert.equal(typeof result.warning, 'string');
      assert.match(result.warning, /not detected/);
      assert.ok(result.frames >= 2, `degraded should still send frames: ${result.frames}`);
      // 端口没人收，但 UDP 确实发出去了（发送计数在 client 上）
      assert.ok(controller2.client.packetsSent >= 2, `packetsSent ${controller2.client.packetsSent}`);
    } finally {
      controller2.dispose();
    }
  });
} finally {
  controller.dispose();
  driver.close();
}

console.log(`\n${passed} head checks passed`);
