// tools/test_aim.mjs — lib/aim.mjs 的离线单测（零依赖；不启动 SteamVR/VRChat、不发 UDP）。
//
// 覆盖：
//   * FOV→fx→角度推导：中心/右半屏/上半屏、FOV 与宽高变化、无效输入
//   * 像素↔角度 round-trip（误差 < 0.01°）、角度钳制 ±85°
//   * SBS 双眼截图辅助（左右眼矩形、整图坐标→单眼坐标）
//   * handAimFromTarget：rotate/reach、左右手默认位姿、restPose/handHeightM、非法参数
//   * frameSignature / framesDiffer：纯色、改动 1 像素、区域外改动、step、tolerance、阈值、
//     尺寸不一致报错、signature 与原始帧混用
//   * planClickSequence 的步骤顺序与关键参数
//
// 运行：node tools/test_aim.mjs
import assert from 'node:assert/strict';
import {
  AIM_DEFAULTS,
  HAND_PIVOTS,
  HAND_REST_POSES,
  UNVERIFIED_ASSUMPTIONS,
  anglesToPixel,
  focalLengthPx,
  frameSignature,
  framesDiffer,
  handAimFromTarget,
  handForward,
  headForward,
  mapImagePointToEye,
  pixelToAngles,
  planClickSequence,
  stereoEyeRect,
  stereoLayout,
} from '../lib/aim.mjs';

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

function approx(actual, expected, eps, label) {
  assert.ok(Number.isFinite(actual), `${label}: 不是有限数 (${actual})`);
  assert.ok(Math.abs(actual - expected) <= eps,
    `${label}: 期望 ${expected} ±${eps}，实际 ${actual}`);
}

function makeFrame(width, height, rgba = [0, 0, 0, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { data, width, height };
}

function setPixel(frame, x, y, rgba) {
  const i = (y * frame.width + x) * 4;
  frame.data[i] = rgba[0];
  frame.data[i + 1] = rgba[1];
  frame.data[i + 2] = rgba[2];
  frame.data[i + 3] = rgba[3];
}

// ── 1. fx 推导 ─────────────────────────────────────────────────────────────
await check('focalLengthPx：fov=90 时 fx = width/2', () => {
  approx(focalLengthPx({ width: 1280, fovDeg: 90 }), 640, 1e-9, 'fx 1280');
  approx(focalLengthPx({ width: 640, fovDeg: 90 }), 320, 1e-9, 'fx 640');
  approx(focalLengthPx({ width: 1280, fovDeg: 60 }), 640 / Math.tan(Math.PI / 6), 1e-9, 'fov60');
  // pixelToAngles 返回的 fx 与 focalLengthPx 一致，且 fy = fx（方形像素）
  const angles = pixelToAngles({ px: 640, py: 360, width: 1280, height: 720, fovDeg: 60 });
  approx(angles.fx, focalLengthPx({ width: 1280, fovDeg: 60 }), 1e-9, 'pixel fx');
  assert.equal(angles.fy, angles.fx);
});

await check('focalLengthPx：width 非法时报错', () => {
  assert.throws(() => focalLengthPx({ width: 0 }), /positive/);
  assert.throws(() => focalLengthPx({ width: NaN }), /positive/);
});

// ── 2. 中心点 / 象限方向 ────────────────────────────────────────────────────
await check('pixelToAngles：中心点 → yaw=0 pitch=0（hand 与 head 相同）', () => {
  for (const axis of ['hand', 'head']) {
    const angles = pixelToAngles({ px: 640, py: 360, width: 1280, height: 720, axis });
    assert.equal(angles.yawDeg, 0);
    assert.equal(angles.pitchDeg, 0);
    assert.equal(angles.valid, true);
    assert.deepEqual(angles.clamped, { yaw: false, pitch: false });
  }
});

await check('pixelToAngles：右半屏 → yaw>0，左半屏 → yaw<0', () => {
  const right = pixelToAngles({ px: 960, py: 360, width: 1280, height: 720, fovDeg: 90 });
  const left = pixelToAngles({ px: 320, py: 360, width: 1280, height: 720, fovDeg: 90 });
  assert.ok(right.yawDeg > 0);
  assert.ok(left.yawDeg < 0);
  approx(right.yawDeg, 26.565051177, 1e-6, '右半屏 yaw');
  approx(left.yawDeg, -26.565051177, 1e-6, '左半屏 yaw');
  assert.equal(right.pitchDeg, 0);
});

await check('pixelToAngles：上半屏 → hand pitch<0、head pitch>0（且 pitchUp>0）', () => {
  const pointer = { px: 640, py: 180, width: 1280, height: 720, fovDeg: 90 };
  const hand = pixelToAngles({ ...pointer, axis: 'hand' });
  const head = pixelToAngles({ ...pointer, axis: 'head' });
  assert.ok(hand.pitchDeg < 0, `hand pitch 应 <0，实际 ${hand.pitchDeg}`);
  assert.ok(head.pitchDeg > 0, `head pitch 应 >0，实际 ${head.pitchDeg}`);
  approx(hand.pitchDeg, -15.7, 0.1, 'hand 上半屏 pitch');
  approx(head.pitchDeg, 15.7, 0.1, 'head 上半屏 pitch');
  approx(hand.pitchUpDeg, 15.7, 0.1, 'pitchUp');
  // 两轴互为相反数
  approx(hand.pitchDeg, -head.pitchDeg, 1e-9, 'hand/head 反号');
});

await check('pixelToAngles：下半屏 hand pitch>0 / head pitch<0', () => {
  const hand = pixelToAngles({ px: 640, py: 540, width: 1280, height: 720, axis: 'hand' });
  const head = pixelToAngles({ px: 640, py: 540, width: 1280, height: 720, axis: 'head' });
  assert.ok(hand.pitchDeg > 0);
  assert.ok(head.pitchDeg < 0);
});

await check('pixelToAngles：无效 px/py 回退中心并标记 valid=false', () => {
  const angles = pixelToAngles({ px: NaN, py: Infinity, width: 1280, height: 720 });
  assert.equal(angles.valid, false);
  assert.equal(angles.yawDeg, 0);
  assert.equal(angles.pitchDeg, 0);
});

// ── 3. round-trip ──────────────────────────────────────────────────────────
await check('anglesToPixel ↔ pixelToAngles round-trip 误差 < 0.01°（hand/head、多组角度）', () => {
  const samples = [
    { yawDeg: 0, pitchDeg: 0 },
    { yawDeg: 30, pitchDeg: 20 },
    { yawDeg: -42.5, pitchDeg: -17.25 },
    { yawDeg: 80, pitchDeg: 79 },
    { yawDeg: -79.5, pitchDeg: 60.5 },
  ];
  for (const axis of ['hand', 'head']) {
    for (const sample of samples) {
      const pixel = anglesToPixel({
        yawDeg: sample.yawDeg,
        pitchDeg: sample.pitchDeg,
        width: 1280,
        height: 720,
        fovDeg: 90,
        axis,
      });
      const back = pixelToAngles({
        px: pixel.px,
        py: pixel.py,
        width: 1280,
        height: 720,
        fovDeg: 90,
        axis,
      });
      assert.ok(Math.abs(back.yawDeg - sample.yawDeg) < 0.01,
        `${axis} yaw round-trip: ${back.yawDeg} vs ${sample.yawDeg}`);
      assert.ok(Math.abs(back.pitchDeg - sample.pitchDeg) < 0.01,
        `${axis} pitch round-trip: ${back.pitchDeg} vs ${sample.pitchDeg}`);
    }
  }
});

await check('anglesToPixel：FOV 变化时像素位置随之变化但 round-trip 仍精确', () => {
  const sample = { yawDeg: 20, pitchDeg: -10, width: 640, height: 720 };
  const fov90 = anglesToPixel({ ...sample, fovDeg: 90, axis: 'hand' });
  const fov60 = anglesToPixel({ ...sample, fovDeg: 60, axis: 'hand' });
  assert.notEqual(fov90.px, fov60.px);
  assert.ok(fov60.px > fov90.px, 'FOV 越小，同一角度对应像素偏移越大');
  const back = pixelToAngles({ px: fov60.px, py: fov60.py, width: 640, height: 720, fovDeg: 60, axis: 'hand' });
  approx(back.yawDeg, 20, 1e-9, 'fov60 yaw');
  approx(back.pitchDeg, -10, 1e-9, 'fov60 pitch');
});

// ── 4. 标定偏移 ────────────────────────────────────────────────────────────
await check('标定偏移：yawOffsetDeg/pitchOffsetDeg 生效且参与钳制', () => {
  const center = pixelToAngles({
    px: 640, py: 360, width: 1280, height: 720,
    yawOffsetDeg: 3, pitchOffsetDeg: -2,
  });
  approx(center.yawDeg, 3, 1e-9, 'center yaw+offset');
  approx(center.pitchDeg, -2, 1e-9, 'center pitch+offset');
  assert.equal(center.raw.yawDeg, 0);
  assert.deepEqual(center.offset, { yawDeg: 3, pitchDeg: -2 });
  // 偏移后超限也要被钳制
  const clamped = pixelToAngles({
    px: 640, py: 360, width: 1280, height: 720, yawOffsetDeg: 100,
  });
  assert.equal(clamped.yawDeg, 85);
  assert.equal(clamped.clamped.yaw, true);
  // handAimFromTarget 透传偏移
  const aim = handAimFromTarget({
    target: { x: 320, y: 360 }, width: 640, height: 720,
    yawOffsetDeg: 1.5, pitchOffsetDeg: 2.5,
  });
  assert.equal(aim.rotation.yaw, 1.5);
  assert.equal(aim.rotation.pitch, 2.5);
  assert.deepEqual(aim.angles.offset, { yawDeg: 1.5, pitchDeg: 2.5 });
});

// ── 5. 钳制 ────────────────────────────────────────────────────────────────
await check('角度钳制：超出画面 → ±85°（hand/head 符号不同）', () => {
  const farRight = pixelToAngles({ px: 1e6, py: 360, width: 1280, height: 720, fovDeg: 90 });
  assert.equal(farRight.yawDeg, AIM_DEFAULTS.maxYawDeg);
  assert.equal(farRight.clamped.yaw, true);
  assert.ok(farRight.raw.yawDeg > AIM_DEFAULTS.maxYawDeg);

  const farBelowHand = pixelToAngles({ px: 640, py: 1e6, width: 1280, height: 720, axis: 'hand' });
  assert.equal(farBelowHand.pitchDeg, 85);
  const farBelowHead = pixelToAngles({ px: 640, py: 1e6, width: 1280, height: 720, axis: 'head' });
  assert.equal(farBelowHead.pitchDeg, -85);
  assert.equal(farBelowHead.clamped.pitch, true);

  // 可关闭钳制
  const unbounded = pixelToAngles({ px: 1e6, py: 360, width: 1280, height: 720, maxYawDeg: null });
  assert.ok(unbounded.yawDeg > 85);
  assert.equal(unbounded.clamped.yaw, false);
});

// ── 6. SBS 双眼截图辅助 ─────────────────────────────────────────────────────
await check('stereoLayout：1280×720 → 左右各 640×720；奇数宽右侧多 1 列', () => {
  const layout = stereoLayout({ width: 1280, height: 720 });
  assert.equal(layout.type, 'side-by-side');
  assert.deepEqual(layout.eyes.left, { x: 0, y: 0, width: 640, height: 720 });
  assert.deepEqual(layout.eyes.right, { x: 640, y: 0, width: 640, height: 720 });

  const odd = stereoLayout({ width: 1281, height: 721 });
  assert.equal(odd.eyes.left.width, 640);
  assert.equal(odd.eyes.right.width, 641);
  assert.throws(() => stereoEyeRect({ width: 1280, height: 720, eye: 'center' }), /left|right/);
});

await check('mapImagePointToEye：整图坐标 → 左右眼坐标（auto 按 x 选眼）', () => {
  const right = mapImagePointToEye({ x: 1024, y: 648, width: 1280, height: 720 });
  assert.equal(right.eye, 'right');
  assert.deepEqual(right.pixel, { x: 384, y: 648 });
  const left = mapImagePointToEye({ x: 256, y: 648, width: 1280, height: 720 });
  assert.equal(left.eye, 'left');
  assert.deepEqual(left.pixel, { x: 256, y: 648 });
  const forced = mapImagePointToEye({ x: 256, y: 648, width: 1280, height: 720, eye: 'right' });
  assert.deepEqual(forced.pixel, { x: -384, y: 648 });
  assert.throws(() => mapImagePointToEye({ x: 1, y: 2, width: 1280, height: 720, eye: 'both' }), /auto/);
});

// ── 7. handAimFromTarget ───────────────────────────────────────────────────
await check('handAimFromTarget：中心目标 → rotation 0/0，position=静止位姿', () => {
  const aim = handAimFromTarget({ target: { x: 320, y: 360 }, width: 640, height: 720, hand: 'right' });
  assert.equal(aim.mode, 'rotate');
  assert.deepEqual(aim.rotation, { yaw: 0, pitch: 0, roll: 0 });
  assert.deepEqual(aim.target, { x: 0.25, y: 1.2, z: 0.18 });
  assert.deepEqual(aim.pixel, { x: 320, y: 360 });
  assert.equal(aim.angles.yawDeg, 0);
  assert.ok(Array.isArray(aim.unverified) && aim.unverified.length > 0);

  const left = handAimFromTarget({ target: { x: 320, y: 360 }, width: 640, height: 720, hand: 'left' });
  assert.deepEqual(left.target, { x: -0.25, y: 1.2, z: 0.18 });
});

await check('handAimFromTarget：右下目标 → yaw>0 且 hand pitch>0（可直接给 vrchat_pose）', () => {
  const aim = handAimFromTarget({ target: { x: 600, y: 700 }, width: 640, height: 720, hand: 'right' });
  assert.ok(aim.rotation.yaw > 0, `yaw 应 >0，实际 ${aim.rotation.yaw}`);
  assert.ok(aim.rotation.pitch > 0, `hand pitch 应 >0（下），实际 ${aim.rotation.pitch}`);
  approx(aim.rotation.yaw, Math.atan2(280, 320) * 180 / Math.PI, 1e-9, 'yaw');
  approx(aim.rotation.pitch, Math.atan2(340, 320) * 180 / Math.PI, 1e-9, 'pitch');
  for (const key of ['x', 'y', 'z']) assert.ok(Number.isFinite(aim.target[key]), `target.${key}`);
  for (const key of ['yaw', 'pitch', 'roll']) assert.ok(Number.isFinite(aim.rotation[key]), `rotation.${key}`);
});

await check('handAimFromTarget：restPose / handHeightM 生效', () => {
  const aim = handAimFromTarget({
    target: { x: 320, y: 360 },
    width: 640,
    height: 720,
    hand: 'right',
    restPose: { position: [0, 1, 0.2], rotation: { yaw: 5, pitch: -2, roll: 3 } },
    handHeightM: 1.4,
  });
  assert.deepEqual(aim.target, { x: 0, y: 1.4, z: 0.2 });
  assert.deepEqual(aim.rotation, { yaw: 5, pitch: -2, roll: 3 });
  assert.equal(aim.restPose.source, 'provided');
});

await check('handAimFromTarget：reach 模式按 pivot+前向量*距离 算位置', () => {
  const pivot = [0.2, 1.35, 0];
  // 中心目标 → 朝前，位置 = pivot + [0,0,0.5]
  const center = handAimFromTarget({
    target: { x: 320, y: 360 }, width: 640, height: 720, hand: 'right',
    moveMode: 'reach', pivotM: pivot, distanceM: 0.5,
  });
  approx(center.target.x, 0.2, 1e-9, 'center x');
  approx(center.target.y, 1.35, 1e-9, 'center y');
  approx(center.target.z, 0.5, 1e-9, 'center z');
  approx(center.distanceM, 0.5, 1e-9, 'distance');

  // pitch=30°（向下）：y 应下降 sin30*0.5
  const py = 360 + 320 * Math.tan(30 * Math.PI / 180);
  const down = handAimFromTarget({
    target: { x: 320, y: py }, width: 640, height: 720, hand: 'right',
    moveMode: 'reach', pivotM: pivot, distanceM: 0.5,
  });
  approx(down.rotation.pitch, 30, 1e-6, 'reach pitch');
  approx(down.target.y, 1.35 - Math.sin(30 * Math.PI / 180) * 0.5, 1e-9, 'reach y');
  approx(down.target.z, Math.cos(30 * Math.PI / 180) * 0.5, 1e-9, 'reach z');

  // 默认 pivot（未真机标定）也能用
  const fallback = handAimFromTarget({ target: { x: 320, y: 360 }, width: 640, height: 720, moveMode: 'reach' });
  assert.deepEqual(fallback.pivotM, [...HAND_PIVOTS.right]);
  assert.equal(fallback.distanceM, AIM_DEFAULTS.reachM);
});

await check('handAimFromTarget：非法 hand / 缺尺寸报错；默认 hand=right', () => {
  assert.throws(() => handAimFromTarget({ target: { x: 0, y: 0 }, width: 640, height: 720, hand: 'both' }), /hand/);
  assert.throws(() => handAimFromTarget({ target: { x: 0, y: 0 }, width: 0, height: 720 }), /width/);
  const aim = handAimFromTarget({ target: { x: 320, y: 360 }, width: 640, height: 720 });
  assert.equal(aim.hand, 'right');
});

// ── 8. 前向量 ──────────────────────────────────────────────────────────────
await check('handForward / headForward：中心/右转/俯仰符号', () => {
  assert.deepEqual(handForward({}), [0, 0, 1]);
  assert.deepEqual(headForward({}), [0, 0, 1]);
  const yaw90 = handForward({ yawDeg: 90 });
  approx(yaw90[0], 1, 1e-9, 'hand yaw90 x');
  approx(yaw90[2], 0, 1e-9, 'hand yaw90 z');
  // hand pitch+ = 下 → y 为负；head pitch+ = 上 → y 为正
  approx(handForward({ pitchDeg: 30 })[1], -0.5, 1e-9, 'hand pitch y');
  approx(headForward({ pitchDeg: 30 })[1], 0.5, 1e-9, 'head pitch y');
});

// ── 9. 帧指纹 / 帧差 ───────────────────────────────────────────────────────
await check('frameSignature：相同帧同指纹；改 1 像素后指纹不同', () => {
  const a = makeFrame(16, 16, [10, 20, 30, 255]);
  const b = makeFrame(16, 16, [10, 20, 30, 255]);
  const sigA = frameSignature(a.data, { width: 16, height: 16 });
  const sigB = frameSignature(b.data, { width: 16, height: 16 });
  assert.equal(sigA.sampleCount, 256);
  assert.equal(sigA.hash, sigB.hash);
  assert.equal(sigA.hashHex.length, 8);
  approx(sigA.meanRGB.r, 10, 1e-9, 'mean r');
  approx(sigA.meanRGB.b, 30, 1e-9, 'mean b');
  assert.equal(sigA.region.width, 16);

  setPixel(b, 7, 9, [11, 20, 30, 255]);
  const sigC = frameSignature(b.data, { width: 16, height: 16 });
  assert.notEqual(sigA.hash, sigC.hash);
  assert.equal(sigA.data, a.data, 'signature 持有原始缓冲引用（不复制）');
});

await check('frameSignature：region 与 step 的采样数正确', () => {
  const frame = makeFrame(16, 16, [1, 2, 3, 4]);
  const sig = frameSignature(frame.data, {
    width: 16, height: 16,
    region: { x: 4, y: 4, width: 8, height: 8 },
    step: 2,
  });
  assert.equal(sig.sampleCount, 16);
  assert.deepEqual(sig.region, { x: 4, y: 4, width: 8, height: 8 });
  // region 超出画面时被夹住
  const clamped = frameSignature(frame.data, {
    width: 16, height: 16,
    region: { x: 10, y: 10, width: 100, height: 100 },
  });
  assert.deepEqual(clamped.region, { x: 10, y: 10, width: 6, height: 6 });
  assert.throws(() => frameSignature(frame.data, { width: 16, height: 16, region: { x: 99, y: 99 } }), /region/);
  assert.throws(() => frameSignature(new Uint8Array(4), { width: 16, height: 16 }), /RGBA/);
});

await check('framesDiffer：同帧 → differ=false、diffRatio=0', () => {
  const a = makeFrame(16, 16, [100, 100, 100, 255]);
  const b = makeFrame(16, 16, [100, 100, 100, 255]);
  const diff = framesDiffer(a, b);
  assert.equal(diff.differ, false);
  assert.equal(diff.identical, true);
  assert.equal(diff.changedPixels, 0);
  assert.equal(diff.diffRatio, 0);
  assert.equal(diff.totalPixels, 256);
});

await check('framesDiffer：改 1 像素（threshold=0）→ 检出且差异比=1/像素数', () => {
  const a = makeFrame(16, 16, [0, 0, 0, 255]);
  const b = makeFrame(16, 16, [0, 0, 0, 255]);
  setPixel(b, 3, 4, [9, 0, 0, 255]);
  const diff = framesDiffer(a, b, { threshold: 0, minChangedPixels: 1 });
  assert.equal(diff.changedPixels, 1);
  approx(diff.diffRatio, 1 / 256, 1e-12, 'diffRatio');
  assert.equal(diff.differ, true);
  // 默认阈值（0.05%）下，1/256=0.39% > 0.05%，也会算出 differ=true
  assert.equal(framesDiffer(a, b).differ, true);
  // 阈值高于差异比 → false
  assert.equal(framesDiffer(a, b, { threshold: 0.01 }).differ, false);
});

await check('framesDiffer：区域外改动不算 → changedPixels=0', () => {
  const a = makeFrame(16, 16, [0, 0, 0, 255]);
  const b = makeFrame(16, 16, [0, 0, 0, 255]);
  setPixel(b, 15, 15, [255, 255, 255, 255]);
  const diff = framesDiffer(a, b, { region: { x: 0, y: 0, width: 8, height: 8 } });
  assert.equal(diff.changedPixels, 0);
  assert.equal(diff.differ, false);
  assert.equal(diff.identical, true);
  // step=2 时非采样点的改动会被跳过（16×16 只采 64 个点）
  const stepped = framesDiffer(a, b, { region: { x: 0, y: 0, width: 8, height: 8 }, step: 2 });
  assert.equal(stepped.totalPixels, 16);
});

await check('framesDiffer：tolerance 忽略小差异；step 采样；signature 与原始帧混用', () => {
  const a = makeFrame(16, 16, [10, 10, 10, 255]);
  const b = makeFrame(16, 16, [12, 10, 10, 255]);
  assert.equal(framesDiffer(a, b, { tolerance: 2 }).changedPixels, 0);
  assert.equal(framesDiffer(a, b, { tolerance: 1 }).changedPixels, 256);

  const sigA = frameSignature(a.data, { width: 16, height: 16 });
  const sigB = frameSignature(b.data, { width: 16, height: 16 });
  assert.equal(framesDiffer(sigA, sigB, { tolerance: 2 }).changedPixels, 0);
  assert.equal(framesDiffer(sigA, b, { tolerance: 1 }).changedPixels, 256);
  // 相同指纹快速路径
  const same = framesDiffer(sigA, frameSignature(a.data, { width: 16, height: 16 }));
  assert.equal(same.identical, true);
  assert.equal(same.changedPixels, 0);
});

await check('framesDiffer：尺寸不一致 / 非法帧报错', () => {
  const a = makeFrame(16, 16);
  const b = makeFrame(8, 8);
  assert.throws(() => framesDiffer(a, b), /sizes differ/);
  assert.throws(() => framesDiffer(null, b), /a/);
  assert.throws(() => framesDiffer(a, { width: 16, height: 16 }), /RGBA/);
});

// ── 10. 点击序列计划 ───────────────────────────────────────────────────────
await check('planClickSequence：pose → settle → press → settle → verify 顺序与参数', () => {
  const plan = planClickSequence({
    target: { x: 480, y: 600 },
    width: 640,
    height: 720,
    hand: 'right',
    settleMs: 300,
    pressHoldMs: 100,
    verifyDelayMs: 400,
  });
  assert.deepEqual(plan.steps.map((step) => step.phase), ['pose', 'settle', 'press', 'settle', 'verify']);
  assert.deepEqual(plan.steps.map((step) => step.step), [1, 2, 3, 4, 5]);
  const pose = plan.steps[0];
  assert.equal(pose.tool, 'vrchat_pose');
  assert.equal(pose.args.hand, 'right');
  assert.deepEqual(pose.args.rotation, plan.aim.rotation);
  assert.deepEqual(pose.args.target, plan.aim.target);
  assert.equal(pose.args.hold, true);
  assert.equal(plan.steps[1].ms, 300);
  assert.equal(plan.steps[2].tool, 'vrchat_ui');
  assert.equal(plan.steps[2].args.key, 'trigger');
  assert.equal(plan.steps[2].args.side, 'right');
  assert.equal(plan.steps[3].ms, 400);
  assert.equal(plan.steps[4].tool, 'vrchat_screenshot');
  const region = plan.steps[4].then.args.region;
  assert.ok(region.width > 0 && region.height > 0);
  assert.ok(region.x <= 480 && 480 <= region.x + region.width);
  assert.ok(region.y <= 600 && 600 <= region.y + region.height);
  assert.ok(plan.assumptions.length > 0);
});

await check('planClickSequence：自定义 verifyRegion / pressKey 被采用', () => {
  const region = { x: 1, y: 2, width: 3, height: 4 };
  const plan = planClickSequence({
    target: { x: 100, y: 100 }, width: 640, height: 720,
    verifyRegion: region,
    pressKey: 'trigger',
    verifyThreshold: 0.01,
  });
  assert.deepEqual(plan.steps[4].then.args.region, region);
  assert.equal(plan.steps[4].then.args.threshold, 0.01);
  assert.equal(plan.steps[2].args.key, 'trigger');
});

// ── 11. 约定常量 ──────────────────────────────────────────────────────────
await check('约定常量：默认值、静止位姿与"未验证"清单', () => {
  assert.equal(AIM_DEFAULTS.fovDeg, 90);
  assert.equal(AIM_DEFAULTS.maxYawDeg, 85);
  assert.equal(AIM_DEFAULTS.maxPitchDeg, 85);
  assert.deepEqual([...HAND_REST_POSES.right.position], [0.25, 1.2, 0.18]);
  assert.deepEqual([...HAND_REST_POSES.left.position], [-0.25, 1.2, 0.18]);
  assert.ok(UNVERIFIED_ASSUMPTIONS.length >= 5);
  for (const item of UNVERIFIED_ASSUMPTIONS) {
    assert.equal(typeof item, 'string');
    assert.ok(item.length > 0);
    // 未验证项必须明确表达"未标定/未验证"
    assert.ok(/未真机标定|未验证|需重新确认|估计值/.test(item), `假设缺少未验证标注: ${item}`);
  }
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\ntest_aim: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error?.stack ?? failure.error}`);
  process.exitCode = 1;
}
