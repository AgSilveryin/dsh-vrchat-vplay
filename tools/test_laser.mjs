// test_laser.mjs — lib/laser.mjs 的离线门禁（合成 RGBA，不需要 SteamVR/VRChat）。
import { detectLaser, detectLaserPixels, fitLine, pickFarEndpoint, pixelErrorToHandDelta, resolveEye, LASER_COLOR, AIM_GAIN } from '../lib/laser.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const LASER = { r: 95, g: 178, b: 189 };
const MENU_TEAL = { r: 43, g: 171, b: 194 };

function makeFrame(width, height) {
  return new Uint8Array(width * height * 4);
}
function put(frame, width, x, y, c) {
  const i = (y * width + x) * 4;
  frame[i] = c.r;
  frame[i + 1] = c.g;
  frame[i + 2] = c.b;
  frame[i + 3] = 255;
}
/** 画一条 2px 宽的线（模拟激光）。 */
function drawLine(frame, width, x0, y0, x1, y1, c) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s += 1) {
    const t = steps === 0 ? 0 : s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    put(frame, width, x, y, c);
    put(frame, width, Math.min(width - 1, x + 1), y, c);
  }
}

// ── 1) SBS 1280x720：右眼里画一条激光线 ─────────────────────────────────────
{
  const width = 1280;
  const height = 720;
  const frame = makeFrame(width, height);
  drawLine(frame, width, 640 + 200, 430, 640 + 460, 400, LASER);
  const detected = detectLaserPixels(frame, { width, height, eye: 'right' });
  check('SBS 右眼：检出激光像素', detected.count >= 90, `count=${detected.count}`);
  check('SBS 右眼：报告 layout=sbs / eyeWidth=640', detected.eye.layout === 'sbs' && detected.eye.eyeWidth === 640 && detected.eye.offsetX === 640);
  const line = fitLine(detected.points);
  check('拟合直线成功', line.ok === true && line.length >= 150, JSON.stringify({ ok: line.ok, len: line.length, reason: line.reason }));
  check('线段角度符合画出方向（约 -8°）', Math.abs(line.angleDeg - (-8.1)) < 6, `angle=${line.angleDeg?.toFixed(1)}`);
  const ends = pickFarEndpoint(line, { handHint: { x: 600, y: 560 } });
  check('瞄准端点 = 离手远端（画面上左方）', ends.far.x < ends.near.x, JSON.stringify(ends));
  const one = detectLaser(frame, { width, height, eye: 'right', handHint: { x: 600, y: 560 } });
  check('detectLaser 一步返回 aim', one.ok === true && one.aim.x < 300 && one.aim.y < 450, JSON.stringify(one.aim));
}

// ── 2) 左眼偏移 ──────────────────────────────────────────────────────────────
{
  const width = 1280;
  const height = 720;
  const frame = makeFrame(width, height);
  drawLine(frame, width, 60, 300, 300, 340, LASER);
  const eye = resolveEye({ width, height, eye: 'left' });
  const detected = detectLaserPixels(frame, { width, height, eye: 'left' });
  check('SBS 左眼：offsetX=0 且能检出', eye.offsetX === 0 && detected.count >= 90, `count=${detected.count}`);
  const one = detectLaser(frame, { width, height, eye: 'left' });
  check('左眼线端点坐标不含右眼偏移', one.ok === true && one.aim.x >= 0 && one.aim.x < 320, JSON.stringify(one.aim));
}

// ── 3) 非激光颜色（菜单青色/背景）不该误报 ──────────────────────────────────
{
  const width = 1280;
  const height = 720;
  const frame = makeFrame(width, height);
  drawLine(frame, width, 700, 500, 900, 560, MENU_TEAL); // 右眼里的菜单青
  const detected = detectLaserPixels(frame, { width, height, eye: 'right' });
  check('菜单青色不误报为激光', detected.count === 0, `count=${detected.count}`);
  check('无激光时 detectLaser ok=false', detectLaser(frame, { width, height }).ok === false);
}

// ── 4) 单幅（mono）模式 ─────────────────────────────────────────────────────
{
  const width = 640;
  const height = 720;
  const frame = makeFrame(width, height);
  drawLine(frame, width, 100, 600, 320, 560, LASER);
  const detected = detectLaserPixels(frame, { width, height, layout: 'auto' });
  check('mono 截图自动识别（不切成两眼）', detected.eye.layout === 'mono' && detected.eye.eyeWidth === 640, JSON.stringify(detected.eye));
  const one = detectLaser(frame, { width, height });
  check('mono 也能拿到 aim 端点（线左侧远端）', one.ok === true && one.aim.x < 150, JSON.stringify(one.aim));
}

// ── 5) 点太少 / 线太短 → 不算成功 ────────────────────────────────────────────
{
  const width = 640;
  const height = 720;
  const frame = makeFrame(width, height);
  drawLine(frame, width, 100, 100, 140, 100, LASER); // 40px 短线
  const one = detectLaser(frame, { width, height, layout: 'mono' });
  check('短线不当作有效瞄准（length 门槛）', one.ok === false, JSON.stringify({ count: one.count, reason: one.reason }));
}

// ── 6) 参数校验 ─────────────────────────────────────────────────────────────
{
  let threw = false;
  try { detectLaserPixels(new Uint8Array(0), { width: 0, height: 0 }); } catch (error) { threw = /positive/.test(String(error.message)); }
  check('非法宽高抛错', threw);
  let threw2 = false;
  try { detectLaserPixels(new Uint8Array(10), { width: 1280, height: 720 }); } catch (error) { threw2 = /smaller/.test(String(error.message)); }
  check('buffer 太小抛错', threw2);
}

// ── 7) 像素误差 → 手部角度增量 ──────────────────────────────────────────────
{
  const d = pixelErrorToHandDelta({ dx: 36, dy: -58 });
  check('像素误差换算：dx=36 → yaw≈10°', Math.abs(d.dyawDeg - 36 / AIM_GAIN.yawPxPerDeg) < 1e-9, JSON.stringify(d));
  check('像素误差换算：dy=-58 → pitch≈-10°（上）', d.dpitchDeg < 0, JSON.stringify(d));
  const clamped = pixelErrorToHandDelta({ dx: 10000, dy: 10000, maxStepDeg: 20 });
  check('单步角度钳制在 ±20°', clamped.dyawDeg === 20 && clamped.dpitchDeg === 20, JSON.stringify(clamped));
  check('颜色常量与实测一致', LASER_COLOR.rMin <= 95 && LASER_COLOR.rMax >= 95 && LASER_COLOR.gMin <= 178 && LASER_COLOR.bMax >= 189);
}

console.log(`\n${failed === 0 ? `${passed} offline laser checks passed` : `${failed} FAILED / ${passed + failed} checks`}`);
process.exit(failed === 0 ? 0 : 1);
