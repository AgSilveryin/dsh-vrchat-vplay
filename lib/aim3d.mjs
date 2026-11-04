// aim3d.mjs — 3D 瞄准几何：把"手的位置/朝向"与"目标点/目标平面"放进同一个空间求交。
//
// 为什么需要它（2026-11-04 真机结论，见 docs/C-瞄准方案.md §11.4）：
//   只把"激光在 2D 截图里的端点"伺服到菜单像素，点击仍然点不中 UI —— 因为激光线在画面里
//   可能从面板前方/后方穿过，2D 对齐不等于 3D 射线与面板相交。正确做法是：
//     1) 由左手位姿 + 菜单相对偏移，估计菜单面板的 3D 平面（点 + 法线）；
//     2) 取右手位置为射线起点、右手朝向为方向，与平面求交；
//     3) 由"手位置 → 目标点"反解出所需的 yaw/pitch，再发给 vrchat_pose。
//
// 坐标约定（与 vrchat_pose / vrchat_head 一致，Unity 左手系）：
//   * x 右、y 上、z 前；手部 rotation 的 yaw 绕 Y（+ = 右）、pitch 绕 X（+ = 下，真机实测）。
//   * 欧拉角顺序：先 yaw、再 pitch、最后 roll（内旋），与 index.js 里位姿构造保持同一约定。
//
// 纯函数、零依赖；本模块的数学有单测，但"菜单相对左手的偏移/朝向"需要在真机上标定（未验证）。

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 欧拉角（度，Unity 左手系）→ 单位方向向量（手/头正前方 = +Z）。接受 yawDeg/yaw 两种键名。 */
export function anglesToDirection({ yawDeg, pitchDeg, rollDeg, yaw, pitch, roll } = {}) {
  const yawValue = finite(yawDeg ?? yaw) * DEG;
  const pitchValue = finite(pitchDeg ?? pitch) * DEG;
  const rollValue = finite(rollDeg ?? roll) * DEG;
  // 基础方向 +Z，先绕 X 转 pitch（+ = 下 → y 分量 -sin），再绕 Y 转 yaw（+ = 右），最后绕 Z 转 roll（不改变 +Z 基向量）。
  // 用四元数组合保证和"yaw→pitch→roll"顺序一致：
  const qy = { x: 0, y: Math.sin(yawValue / 2), z: 0, w: Math.cos(yawValue / 2) };
  const qx = { x: Math.sin(pitchValue / 2), y: 0, z: 0, w: Math.cos(pitchValue / 2) };
  const qz = { x: 0, y: 0, z: Math.sin(rollValue / 2), w: Math.cos(rollValue / 2) };
  // q = qy * qx * qz（Unity 的 ZXY 在 yaw→pitch→roll 写法下等价于依次右乘）
  const q = multiplyQuaternions(multiplyQuaternions(qy, qx), qz);
  const direction = rotateVector(q, { x: 0, y: 0, z: 1 });
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

/** 四元数乘法（x,y,z,w）。 */
export function multiplyQuaternions(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 用四元数旋转向量。 */
export function rotateVector(q, v) {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

/** 方向向量 → 手部 yaw/pitch（度）；pitch + = 下（与 vrchat_pose 实测一致）。 */
export function directionToAngles(direction, { clampDeg = 85 } = {}) {
  const { x, y, z } = direction;
  const length = Math.hypot(x, y, z);
  if (length === 0) throw new Error('aim3d: zero-length direction');
  const nx = x / length;
  const ny = y / length;
  const nz = z / length;
  const yawDeg = Math.atan2(nx, nz) * RAD;
  // 方向 y<0 = 朝下 → pitch 为正；asin 返回 -90..90
  const pitchDeg = -Math.asin(Math.max(-1, Math.min(1, ny))) * RAD;
  const clamp = Number.isFinite(Number(clampDeg)) ? Math.abs(Number(clampDeg)) : 180;
  return {
    yawDeg: Math.max(-clamp, Math.min(clamp, yawDeg)),
    pitchDeg: Math.max(-clamp, Math.min(clamp, pitchDeg)),
  };
}

/** 射线与平面求交（平面：point + 单位法线）。返回 { hit, t, point }；平行/背向返回 hit=false。 */
export function rayPlaneIntersection({ origin, direction, planePoint, planeNormal }) {
  const normalLength = Math.hypot(planeNormal.x, planeNormal.y, planeNormal.z) || 1;
  const n = { x: planeNormal.x / normalLength, y: planeNormal.y / normalLength, z: planeNormal.z / normalLength };
  const denominator = direction.x * n.x + direction.y * n.y + direction.z * n.z;
  if (Math.abs(denominator) < 1e-9) return { hit: false, reason: 'parallel' };
  const t = ((planePoint.x - origin.x) * n.x + (planePoint.y - origin.y) * n.y + (planePoint.z - origin.z) * n.z) / denominator;
  if (!Number.isFinite(t) || t < 0) return { hit: false, reason: 'behind' };
  return {
    hit: true,
    t,
    point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t },
  };
}

/** 两个 3D 点求方向（手 → 目标）。 */
export function directionBetween(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) throw new Error('aim3d: from and to are the same point');
  return { x: dx / length, y: dy / length, z: dz / length, distance: length };
}

/**
 * 由"手位置 + 目标点"反解 vrchat_pose 的 rotation（只转不移动）。
 * @returns {{yawDeg:number, pitchDeg:number, rotation:{yaw:number,pitch:number,roll:number}, direction:object, distance:number}}
 */
export function solveHandAim({ handPosition, target, clampDeg = 85, rollDeg = 0 } = {}) {
  const direction = directionBetween(handPosition, target);
  const angles = directionToAngles(direction, { clampDeg });
  return {
    yawDeg: angles.yawDeg,
    pitchDeg: angles.pitchDeg,
    rotation: { yaw: angles.yawDeg, pitch: angles.pitchDeg, roll: finite(rollDeg) },
    direction,
    distance: direction.distance,
    clamped: Math.abs(angles.yawDeg) >= clampDeg || Math.abs(angles.pitchDeg) >= clampDeg,
  };
}

/**
 * 右手射线与左手菜单平面求交（用于"射线到底能不能打中面板"的判定）。
 * 菜单平面默认取左手位置 + 由左手 rotation 推出的朝向（菜单相对左手偏移可用 `offset`/`tiltDeg` 标定）。
 */
export function intersectHandRayWithMenu({ rightHand, leftHand, menuOffset = { x: 0, y: 0, z: 0 }, menuTiltDeg = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 } } = {}) {
  const rayDirection = anglesToDirection(rightHand?.rotation ?? {});
  const leftAngles = leftHand?.rotation ?? {};
  // 菜单平面法线 = 左手朝向再叠加一个"菜单相对左手的固定倾角"（默认 0，需真机标定）。
  const planeNormal = anglesToDirection({
    yawDeg: finite(leftAngles.yawDeg ?? leftAngles.yaw) + finite(menuTiltDeg.yawDeg),
    pitchDeg: finite(leftAngles.pitchDeg ?? leftAngles.pitch) + finite(menuTiltDeg.pitchDeg),
    rollDeg: finite(leftAngles.rollDeg ?? leftAngles.roll) + finite(menuTiltDeg.rollDeg),
  });
  const planePoint = {
    x: finite(leftHand?.position?.x) + finite(menuOffset.x),
    y: finite(leftHand?.position?.y) + finite(menuOffset.y),
    z: finite(leftHand?.position?.z) + finite(menuOffset.z),
  };
  const intersection = rayPlaneIntersection({ origin: { x: finite(rightHand?.position?.x), y: finite(rightHand?.position?.y), z: finite(rightHand?.position?.z) }, direction: rayDirection, planePoint, planeNormal });
  return { ...intersection, rayDirection, planeNormal, planePoint };
}

/**
 * 给定"菜单上一点"，反解右手应该摆的 yaw/pitch（需要先标定菜单平面/点）。
 * 真机上可这样用：先目测/几何估计菜单上目标点 P，然后 solveAimToPoint，发 pose，再截图验证。
 */
export function solveAimToPoint({ handPosition, point, clampDeg = 85, rollDeg = 0 } = {}) {
  return solveHandAim({ handPosition, target: point, clampDeg, rollDeg });
}

/** 把射线参数化成"手位置 + 方向"（手位置可来自 vrchat_pose 的 target）。 */
export function handRay({ position, rotation }) {
  return {
    origin: { x: finite(position?.x), y: finite(position?.y), z: finite(position?.z) },
    direction: anglesToDirection(rotation ?? {}),
  };
}
