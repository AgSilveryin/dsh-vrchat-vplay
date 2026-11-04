// aim-servo.mjs — C 线真机闭环：用截图里的激光端点做视觉伺服，指向目标像素后扳机点击。
//
// 需要：SteamVR + VRChat（VR 模式）+ VMT/dsh_hmd 驱动 + 快捷菜单打开（激光只在交互 UI 时出现）。
// 不启动/不关闭游戏；只发位姿与扳机，截图为证据。
//
// 用法：
//   node tools/aim-servo.mjs --probe                          # 低头/平视各截一张，打印激光检测结果
//   node tools/aim-servo.mjs --calibrate                      # 扫 yaw/pitch 网格，拟合 px/deg 增益
//   node tools/aim-servo.mjs --target 380,500 --click         # 伺服到目标像素后点一下扳机并截图对比
// 常用参数：--head-pitch -25  --eye right|left  --tol 12  --max-iters 6  --settle-ms 350
//          --evidence-dir <目录>  --baseline name
//
// 输出：每步截图 + aim-servo-<stamp>.json（含每次测量、角度、误差、最终点击前后差异比）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createToolset } from '../lib/host-shim.mjs';
import { detectLaser, pixelErrorToHandDelta, AIM_GAIN } from '../lib/laser.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);
const num = (name, fallback) => {
  const value = Number(flag(name, NaN));
  return Number.isFinite(value) ? value : fallback;
};

const HEAD_PITCH = num('--head-pitch', -25);
const HEAD_YAW = num('--head-yaw', 0);
const EYE = flag('--eye', 'right');
const LAYOUT = flag('--layout', 'auto');
const TOL = num('--tol', 12);
const MAX_ITERS = Math.max(1, Math.min(12, num('--max-iters', 6)));
const SETTLE_MS = Math.max(0, num('--settle-ms', 350));
const HAND_BASE = {
  x: num('--hand-x', 0.28),
  y: num('--hand-y', 1.42),
  z: num('--hand-z', 0.34),
};
const GAIN = { yawPxPerDeg: num('--yaw-px-per-deg', AIM_GAIN.yawPxPerDeg), pitchPxPerDeg: num('--pitch-px-per-deg', AIM_GAIN.pitchPxPerDeg) };
const EVIDENCE_DIR = resolve(flag('--evidence-dir', join(ROOT, '..', 'vrchat-vr-driver', 'shots', 'live')));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BASELINE = flag('--baseline', '');
const USE_REFERENCE = !has('--no-reference');
mkdirSync(EVIDENCE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
// 标定/伺服期间关掉拟人抖动与 idle drift：画面必须稳定，否则像素测量被漂移污染。
const ts = createToolset({
  config: {
    panelEnabled: false,
    listenEnabled: false,
    headHumanize: false,
    headIdleDrift: false,
    poseHumanize: false,
    poseIdleDrift: false,
  },
  logger: quiet,
});
const decoder = await import(pathToFileURL(join(ROOT, '..', 'vrchat-vr-driver', 'player', 'src', 'perception', 'png.mjs')).href);

const evidence = { stamp: STAMP, mode: null, headPitch: HEAD_PITCH, handBase: HAND_BASE, gain: GAIN, eye: EYE, steps: [] };

async function setHead(pitch = HEAD_PITCH, yaw = HEAD_YAW) {
  const result = await ts.call('vrchat_head', { target: { y: 1.6 }, rotation: { yaw, pitch, roll: 0 }, durationMs: 250, wait: true, hold: true });
  return result;
}
/** 右手指向；左手必须一直跟随发流，否则 VMT 左手失效 → 挂在左手的快捷菜单会消失。 */
async function setHand(yaw, pitch) {
  const result = await ts.call('vrchat_pose', {
    hand: 'both',
    left: { target: { x: -0.32, y: 1.3, z: 0.35 }, rotation: { yaw: 10, pitch: -20, roll: 0 } },
    right: { target: HAND_BASE, rotation: { yaw, pitch, roll: 0 } },
    durationMs: 250,
    wait: true,
    hold: true,
  });
  return result;
}
/** 抓一张原始帧（RGBＡ + 路径）；不在这里做检测，方便先取参考帧。 */
async function captureRaw(tag) {
  const result = await ts.call('vrchat_screenshot');
  if (result.ok !== true) return { ok: false, error: result.error };
  const png = Buffer.from(result.image?.data ?? '', 'base64');
  const path = join(EVIDENCE_DIR, `aim-servo-${STAMP}-${tag}.png`);
  writeFileSync(path, png);
  const decoded = decoder.decodePng(png);
  return { ok: true, path, width: decoded.width, height: decoded.height, decoded };
}
/** 无激光参考帧：把手转到"朝后"，让激光射出画面，此时画面里只剩静态的淡蓝物体。 */
let referenceFrame = null;
async function captureReference() {
  if (!USE_REFERENCE) return { ok: false, skipped: true };
  await setHand(170, 0);
  await sleep(SETTLE_MS);
  const raw = await captureRaw('reference-no-laser');
  if (raw.ok) referenceFrame = raw;
  await setHand(0, 0);
  return raw;
}
function laserArgs() {
  return {
    width: referenceFrame?.width ?? 1280,
    height: referenceFrame?.height ?? 720,
    eye: EYE,
    layout: LAYOUT,
    referenceRgba: referenceFrame?.decoded?.data ?? null,
    referenceRadiusPx: 3,
  };
}
async function screenshot(tag) {
  const raw = await captureRaw(tag);
  if (!raw.ok) return raw;
  const laser = detectLaser(raw.decoded.data, laserArgs());
  return { ok: true, path: raw.path, width: raw.width, height: raw.height, laser };
}
async function measure(tag, yaw, pitch) {
  await setHand(yaw, pitch);
  await sleep(SETTLE_MS);
  const shot = await screenshot(tag);
  const step = { tag, yaw, pitch, laser: shot.laser ?? null, path: shot.path ?? null, error: shot.error ?? null };
  evidence.steps.push(step);
  return step;
}
function fmtStep(step) {
  const aim = step.laser?.aim;
  return `${step.tag} yaw=${step.yaw.toFixed(1)} pitch=${step.pitch.toFixed(1)} aim=${aim ? `${Math.round(aim.x)},${Math.round(aim.y)}` : '-'} count=${step.laser?.count ?? 0}${step.error ? ` err=${step.error}` : ''}`;
}

async function probe() {
  evidence.mode = 'probe';
  await setHead();
  const ref = await captureReference();
  evidence.reference = ref.path ?? null;
  await setHand(0, 0);
  await sleep(SETTLE_MS);
  const shot = await screenshot('probe');
  console.log(fmtStep({ tag: 'probe', yaw: 0, pitch: 0, laser: shot.laser, path: shot.path }));
  if (shot.laser?.ok) console.log('line:', JSON.stringify({ angleDeg: shot.laser.line.angleDeg.toFixed(1), length: shot.laser.line.length.toFixed(1), aim: shot.laser.aim, near: shot.laser.near, filtered: shot.laser.filteredCount }));
  else console.log('激光没检出：确认 VRChat 快捷菜单是否打开、手是否在画面里、--head-pitch 是否合适');
  return shot.laser?.ok === true;
}

async function calibrate() {
  evidence.mode = 'calibrate';
  await setHead();
  const ref = await captureReference();
  evidence.reference = ref.path ?? null;
  const rows = [];
  for (const yaw of [-20, -10, 0, 10, 20]) {
    for (const pitch of [-20, -10, 0, 10, 20]) {
      const step = await measure(`cal-yaw${yaw}-pitch${pitch}`, yaw, pitch);
      console.log(fmtStep(step));
      if (step.laser?.ok) rows.push({ yaw, pitch, ax: step.laser.aim.x, ay: step.laser.aim.y });
    }
  }
  if (rows.length < 6) { console.log('有效样本太少，标定失败'); return false; }
  // 最小二乘：ax = a0 + a1*yaw + a2*pitch ; ay = b0 + b1*yaw + b2*pitch
  const solve3 = (targets) => {
    // 正规方程 3x3
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (let i = 0; i < rows.length; i += 1) {
      const v = [1, rows[i].yaw, rows[i].pitch];
      for (let r = 0; r < 3; r += 1) {
        b[r] += v[r] * targets[i];
        for (let c = 0; c < 3; c += 1) A[r][c] += v[r] * v[c];
      }
    }
    // 高斯消元（3x3，简单实现）
    const M = A.map((row, r) => [...row, b[r]]);
    for (let col = 0; col < 3; col += 1) {
      let pivot = col;
      for (let r = col + 1; r < 3; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const p = M[col][col];
      if (Math.abs(p) < 1e-9) return null;
      for (let c = col; c < 4; c += 1) M[col][c] /= p;
      for (let r = 0; r < 3; r += 1) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let c = col; c < 4; c += 1) M[r][c] -= f * M[col][c];
      }
    }
    return [M[0][3], M[1][3], M[2][3]];
  };
  const fitX = solve3(rows.map((r) => r.ax));
  const fitY = solve3(rows.map((r) => r.ay));
  let residual = 0;
  for (const r of rows) {
    const px = fitX[0] + fitX[1] * r.yaw + fitX[2] * r.pitch;
    const py = fitY[0] + fitY[1] * r.yaw + fitY[2] * r.pitch;
    residual += Math.hypot(px - r.ax, py - r.ay);
  }
  const result = {
    samples: rows.length,
    aimX: { intercept: Number(fitX[0].toFixed(2)), perYaw: Number(fitX[1].toFixed(2)), perPitch: Number(fitX[2].toFixed(2)) },
    aimY: { intercept: Number(fitY[0].toFixed(2)), perYaw: Number(fitY[1].toFixed(2)), perPitch: Number(fitY[2].toFixed(2)) },
    meanResidualPx: Number((residual / rows.length).toFixed(2)),
  };
  evidence.calibration = result;
  console.log('\n标定结果：', JSON.stringify(result, null, 2));
  console.log(`→ 建议增益：yaw ${Math.abs(result.aimX.perYaw).toFixed(2)} px/deg，pitch ${Math.abs(result.aimY.perPitch).toFixed(2)} px/deg`);
  return true;
}

async function servoAndClick(target) {
  evidence.mode = 'servo';
  evidence.target = target;
  await setHead();
  const ref = await captureReference();
  evidence.reference = ref.path ?? null;
  let yaw = 0;
  let pitch = 0;
  let converged = false;
  let lastAim = null;
  let lastErr = null;
  for (let iter = 0; iter < MAX_ITERS; iter += 1) {
    const step = await measure(`servo-${iter}`, yaw, pitch);
    if (step.laser?.ok !== true) { console.log(`iter ${iter}: 激光丢失，停止`); break; }
    const aim = step.laser.aim;
    const dx = target.x - aim.x;
    const dy = target.y - aim.y;
    const err = Math.hypot(dx, dy);
    lastAim = aim;
    lastErr = err;
    console.log(`iter ${iter}: aim=${Math.round(aim.x)},${Math.round(aim.y)} target=${target.x},${target.y} err=${err.toFixed(1)}px yaw=${yaw.toFixed(1)} pitch=${pitch.toFixed(1)}  (${step.path})`);
    if (err <= TOL) { converged = true; break; }
    const delta = pixelErrorToHandDelta({ dx, dy, gain: GAIN });
    yaw = Math.max(-60, Math.min(60, yaw + delta.dyawDeg));
    pitch = Math.max(-60, Math.min(60, pitch + delta.dpitchDeg));
  }
  evidence.converged = converged;
  evidence.finalAim = lastAim;
  evidence.finalErrorPx = lastErr;
  if (!converged) { console.log(`未收敛（最终误差 ${lastErr?.toFixed(1)} px），不点击`); return false; }
  const before = await screenshot('before-click');
  const click = await ts.call('vrchat_ui', { action: 'select' });
  console.log('点击:', click.ok === true ? 'ok' : JSON.stringify(click).slice(0, 200));
  evidence.click = { ok: click.ok === true };
  await sleep(900);
  const after = await screenshot('after-click');
  if (before.path && after.path) {
    const A = decoder.decodePng((await import('node:fs')).readFileSync(before.path));
    const B = decoder.decodePng((await import('node:fs')).readFileSync(after.path));
    const { framesDiffer } = await import('../lib/aim.mjs');
    const diff = framesDiffer({ data: A.data, width: A.width, height: A.height }, { data: B.data, width: B.width, height: B.height }, { threshold: 0.002 });
    evidence.click.diff = diff;
    console.log(`点击前后画面差异：differ=${diff.differ} ratio=${diff.diffRatio}`);
  }
  return true;
}

try {
  const ok = has('--calibrate') ? await calibrate()
    : has('--target') ? await servoAndClick({ x: num('--target-x', Number(String(flag('--target', '')).split(',')[0])), y: num('--target-y', Number(String(flag('--target', '')).split(',')[1])) })
      : await probe();
  if (ok === false) process.exitCode = 1;
} finally {
  const outFile = join(EVIDENCE_DIR, `aim-servo-${STAMP}-${BASELINE || evidence.mode || 'probe'}.json`);
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`证据：${outFile}`);
  ts.dispose();
}
