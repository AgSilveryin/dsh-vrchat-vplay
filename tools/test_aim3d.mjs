// test_aim3d.mjs — lib/aim3d.mjs 的离线单测（纯数学，不需要 VR）。
import {
  anglesToDirection, directionToAngles, rayPlaneIntersection, directionBetween,
  solveHandAim, intersectHandRayWithMenu, handRay, multiplyQuaternions, rotateVector,
} from '../lib/aim3d.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`ok   ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function near(a, b, tolerance = 1e-6) { return Math.abs(a - b) <= tolerance; }
function vnear(v, w, tolerance = 1e-6) { return near(v.x, w.x, tolerance) && near(v.y, w.y, tolerance) && near(v.z, w.z, tolerance); }

// ── 1) 角度 → 方向 ──────────────────────────────────────────────────────────
check('yaw0/pitch0 → +Z', vnear(anglesToDirection({}), { x: 0, y: 0, z: 1 }));
check('yaw+90 → +X（右）', vnear(anglesToDirection({ yawDeg: 90 }), { x: 1, y: 0, z: 0 }, 1e-9));
check('yaw-90 → -X（左）', vnear(anglesToDirection({ yawDeg: -90 }), { x: -1, y: 0, z: 0 }, 1e-9));
{
  const direction = anglesToDirection({ pitchDeg: 30 });
  check('pitch+30 → 朝下（y<0）', direction.y < -0.4 && direction.z > 0.8, JSON.stringify(direction));
  check('pitch-30 → 朝上（y>0）', anglesToDirection({ pitchDeg: -30 }).y > 0.4);
}
check('roll 不影响 +Z 方向本身', vnear(anglesToDirection({ rollDeg: 45 }), { x: 0, y: 0, z: 1 }));

// ── 2) 方向 → 角度 + round-trip ─────────────────────────────────────────────
{
  let maxError = 0;
  for (const yawDeg of [-60, -30, 0, 30, 60, 80]) {
    for (const pitchDeg of [-60, -30, 0, 30, 60]) {
      const direction = anglesToDirection({ yawDeg, pitchDeg });
      const back = directionToAngles(direction);
      maxError = Math.max(maxError, Math.abs(back.yawDeg - yawDeg), Math.abs(back.pitchDeg - pitchDeg));
    }
  }
  check('角度→方向→角度 round-trip 误差 < 1e-9', maxError < 1e-9, `maxError=${maxError}`);
}
{
  const clamped = directionToAngles(anglesToDirection({ yawDeg: 89, pitchDeg: 89 }), { clampDeg: 85 });
  check('directionToAngles 支持钳制', Math.abs(clamped.yawDeg) <= 85 && Math.abs(clamped.pitchDeg) <= 85, JSON.stringify(clamped));
}

// ── 3) 四元数基础 ───────────────────────────────────────────────────────────
{
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  check('单位四元数旋转不变', vnear(rotateVector(identity, { x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 }, 1e-9));
  const qy = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }; // yaw 90°
  check('绕 Y 转 90°：+Z → +X', vnear(rotateVector(qy, { x: 0, y: 0, z: 1 }), { x: 1, y: 0, z: 0 }, 1e-9));
  check('四元数乘法结合顺序', vnear(rotateVector(multiplyQuaternions(qy, identity), { x: 0, y: 0, z: 1 }), { x: 1, y: 0, z: 0 }, 1e-9));
}

// ── 4) 射线-平面求交 ────────────────────────────────────────────────────────
{
  const hit = rayPlaneIntersection({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, planePoint: { x: 0, y: 0, z: 2 }, planeNormal: { x: 0, y: 0, z: -1 } });
  check('前向射线与 z=2 平面相交', hit.hit === true && near(hit.t, 2) && vnear(hit.point, { x: 0, y: 0, z: 2 }),
    JSON.stringify(hit));
  const parallel = rayPlaneIntersection({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, planePoint: { x: 0, y: 0, z: 2 }, planeNormal: { x: 0, y: 1, z: 0 } });
  check('平行 → 不相交', parallel.hit === false && parallel.reason === 'parallel');
  const behind = rayPlaneIntersection({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, planePoint: { x: 0, y: 0, z: -1 }, planeNormal: { x: 0, y: 0, z: 1 } });
  check('平面在射线背后 → 不相交', behind.hit === false && behind.reason === 'behind');
  const slanted = rayPlaneIntersection({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 1 }, planePoint: { x: 0, y: 0, z: 1 }, planeNormal: { x: 0, y: 0, z: 1 } });
  check('斜射线与平面相交点正确', slanted.hit === true && vnear(slanted.point, { x: 1, y: 0, z: 1 }, 1e-9), JSON.stringify(slanted));
}

// ── 5) 手 → 目标 反向解 ─────────────────────────────────────────────────────
{
  const solved = solveHandAim({ handPosition: { x: 0.3, y: 1.4, z: 0.3 }, target: { x: 0, y: 1.4, z: 1.3 } });
  check('目标在正前方偏左 → yaw<0、pitch≈0', solved.yawDeg < -10 && near(solved.pitchDeg, 0, 0.5), JSON.stringify({ yaw: solved.yawDeg, pitch: solved.pitchDeg }));
  const direction = anglesToDirection(solved.rotation);
  check('反解出的 rotation 再转成方向能指向目标', vnear(direction, solved.direction, 1e-9));
  const above = solveHandAim({ handPosition: { x: 0, y: 1.4, z: 0.2 }, target: { x: 0, y: 1.6, z: 1.0 } });
  check('目标在上方 → pitch<0（抬头）', above.pitchDeg < 0, JSON.stringify(above.pitchDeg));
  const below = solveHandAim({ handPosition: { x: 0, y: 1.4, z: 0.2 }, target: { x: 0, y: 1.2, z: 1.0 } });
  check('目标在下方 → pitch>0（低头）', below.pitchDeg > 0, JSON.stringify(below.pitchDeg));
  const far = solveHandAim({ handPosition: { x: 0, y: 1.4, z: 0.2 }, target: { x: 5, y: 1.4, z: 0.2 }, clampDeg: 60 });
  check('大角度被钳制并标记', far.clamped === true && Math.abs(far.yawDeg) <= 60, JSON.stringify(far));
}

// ── 6) 右手射线 × 左手菜单平面 ──────────────────────────────────────────────
{
  const rightHand = { position: { x: 0.28, y: 1.42, z: 0.34 }, rotation: { yawDeg: 0, pitchDeg: 0 } };
  const leftHand = { position: { x: -0.2, y: 1.3, z: 0.5 }, rotation: { yawDeg: 0, pitchDeg: 0 } };
  // 平面法线 = 左手朝向（+Z），平面过 (-0.2,1.3,0.5)；右手射线 +Z 从 z=0.34 出发，t=0.16 命中。
  const result = intersectHandRayWithMenu({ rightHand, leftHand });
  check('右手射线与菜单平面相交', result.hit === true && near(result.t, 0.16, 1e-9), JSON.stringify(result));
  check('交点落在平面点上', vnear(result.point, { x: 0.28, y: 1.42, z: 0.5 }, 1e-9), JSON.stringify(result.point));
  const miss = intersectHandRayWithMenu({ rightHand: { position: { x: 0.28, y: 1.42, z: 0.6 }, rotation: { yawDeg: 0, pitchDeg: 0 } }, leftHand });
  check('射线起点已越过平面 → 不相交（背后）', miss.hit === false && miss.reason === 'behind');
  const offset = intersectHandRayWithMenu({ rightHand, leftHand, menuOffset: { x: 0, y: 0, z: 0.2 } });
  check('menuOffset 平移平面后命中距离变化', offset.hit === true && near(offset.t, 0.36, 1e-9), JSON.stringify(offset.t));
}

// ── 7) handRay 便捷函数 ─────────────────────────────────────────────────────
{
  const ray = handRay({ position: { x: 1, y: 2, z: 3 }, rotation: { yawDeg: 90 } });
  check('handRay：起点/方向正确', vnear(ray.origin, { x: 1, y: 2, z: 3 }) && vnear(ray.direction, { x: 1, y: 0, z: 0 }, 1e-9), JSON.stringify(ray));
  let threw = false;
  try { directionBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }); } catch { threw = true; }
  check('同点求方向抛错', threw);
}

console.log(`\n${failed === 0 ? `${passed} offline aim3d checks passed` : `${failed} FAILED / ${passed + failed} checks`}`);
process.exit(failed === 0 ? 0 : 1);
