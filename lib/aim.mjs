// aim.mjs — 激光瞄准点击闭环的离线核心（纯函数；不读文件、不碰 socket，可随包分发）
//
// 用途：为 HANDOFF §8-C「打开菜单 → 激光指向菜单项 → 扳机点击 → 截图确认」提供可离线单测的数学层：
//   1. 像素 ↔ 角度（单眼视图坐标 → 手部/头部 yaw/pitch，及其反函数）
//   2. 手部瞄准位姿（像素目标 → 可直接传给 vrchat_pose 的 {target, rotation}）
//   3. 帧指纹 / 帧差（点击后用区域像素差异判断"画面有没有变"）
//   4. 点击序列计划（pose → settle → press → settle → verify，供真机脚本按步执行）
//
// 坐标系与符号约定（与 lib/head.js、lib/vmt.js 对齐，务必先读）：
//   * 截图坐标：左上角为原点，x 向右、y 向下；**(px, py) 是单眼视图内的像素坐标**。
//   * 相机模型：水平视场角 fovDeg（默认 90°），fx = (width/2) / tan(fovDeg/2)，fy = fx（方形像素）。
//     注意：SteamVR「Headset Window」截图是**双眼并排**（1280×720 = 左右各 640×720），
//     像素→角度必须用**单眼**的 width/height，否则角度会差约一倍。见 stereoLayout()。
//   * yaw：+ = 向右转（朝 +X）；hand 与 head 相同。
//   * pitch：axis='hand' 时 + = 向下；axis='head' 时 + = 向上（lib/head.js 的直观语义）。
//     hand 的 pitch 正负是 HANDOFF 的经验值（Unity 左手系里控制器本地 +Z 朝前、绕 +X 正转即低头），
//     **未真机标定**，见 UNVERIFIED_ASSUMPTIONS。
//   * 输出 rotation 是度，直接可给 vrchat_pose（Unity 欧拉语义：qYaw*qPitch*qRoll，pitch+ = 下）。
//   * 角度默认钳制到 ±85°（手腕/颈部可用范围 + 避开万向锁），可用 maxYawDeg/maxPitchDeg 覆盖。
//
// 本文件没有 import：测试与离线 CLI 都能直接跑，打包后也能被宿主复用。

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** 瞄准层默认值（都可被调用参数覆盖）。 */
export const AIM_DEFAULTS = Object.freeze({
  fovDeg: 90,          // 水平视场角（度）；HANDOFF 线索，未真机标定
  maxYawDeg: 85,       // yaw 钳制
  maxPitchDeg: 85,     // pitch 钳制
  axis: 'hand',        // 默认按手部约定解释 pitch
  reachM: 0.45,        // moveMode='reach' 时默认伸手长度（米）
  threshold: 0.0005,   // framesDiffer 默认差异比阈值（0.05%）
  minChangedPixels: 1, // 至少多少个采样像素变化才算"变了"
});

/**
 * 真机尚未验证的假设清单（生成建议时原样带出，防止把猜测当成实测）。
 * 文档 docs/C-瞄准方案.md 有逐项「预期/如何验证/失败怎么改」。
 */
export const UNVERIFIED_ASSUMPTIONS = Object.freeze([
  '水平 FOV=90°：HANDOFF 线索值，未真机标定；换头盔/改渲染分辨率后必须重新标定（也可能是垂直 FOV 或整幅 FOV）',
  '控制器激光方向：yaw 正=右、pitch 正=下（本地 +Z 朝前）；HANDOFF 经验值，未真机标定',
  '手部静止位姿/旋转基座：默认值抄自 lib/vmt.js DEFAULT_POSES 与肩部估计，未真机标定',
  '激光命中点=手部原点：未考虑控制器 aim pose 与 grip pose 的偏移，未真机标定',
  '截图与位姿/点击的时延：settle 350ms / verify 500ms 是估计值，未真机标定',
  '单眼视图分界：现有 1280×720 截图已确认左右各 640×720（SBS），其它截图源需重新确认',
]);

// ── 内部工具 ────────────────────────────────────────────────────────────────

const isObject = (value) => value !== null && typeof value === 'object';

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** 把 -0 归一成 +0（Math.atan2 会产出 -0，JSON/深比较里容易吓人一跳）。 */
function cleanZero(value) {
  return value === 0 ? 0 : value;
}

/** 角度上限：null/Infinity → 不钳制；非法值 → fallback。 */
function toAngleLimit(value, fallback) {
  if (value === null || value === Infinity) return Infinity;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 179);
}

/** 整数提取并夹到 [min,max]；非法值用 fallback（fallback 也会被夹）。 */
function toInt(value, fallback, min, max) {
  const n = Number(value);
  const base = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return clamp(base, min, max);
}

/** 读取并校验宽度（只要求 width，用于焦距换算）。 */
function readWidth(options) {
  const width = Number(isObject(options) ? options.width : NaN);
  if (!Number.isFinite(width) || width < 1) {
    throw new Error('aim: `width` must be a positive number');
  }
  return Math.floor(width);
}

/** 读取并校验图像尺寸（width/height 必须是正数；返回整数）。 */
function readImageSize(options) {
  const width = readWidth(options);
  const height = Number(isObject(options) ? options.height : NaN);
  if (!Number.isFinite(height) || height < 1) {
    throw new Error('aim: `width`/`height` must be positive numbers');
  }
  return { width, height: Math.floor(height) };
}

/** 把 region 夹进图像范围；不传 = 整幅；空区域/完全在画面外抛错。返回 {x,y,width,height}。 */
function normalizeRegion(region, width, height) {
  if (region === undefined || region === null) return { x: 0, y: 0, width, height };
  if (!isObject(region)) throw new Error('aim: `region` must be an object {x,y,width,height}');
  // 起点已经超出画面 → 直接报错（比静默夹成 1 像素更好排查）
  if (Number(region.x) >= width || Number(region.y) >= height) {
    throw new Error('aim: `region` is empty or outside the image');
  }
  const x = toInt(region.x, 0, 0, Math.max(0, width - 1));
  const y = toInt(region.y, 0, 0, Math.max(0, height - 1));
  const w = toInt(region.width, width - x, 1, Math.max(1, width - x));
  const h = toInt(region.height, height - y, 1, Math.max(1, height - y));
  const width2 = Math.min(w, width - x);
  const height2 = Math.min(h, height - y);
  if (width2 < 1 || height2 < 1) throw new Error('aim: `region` is empty or outside the image');
  return { x, y, width: width2, height: height2 };
}

const sameRegion = (a, b) => Boolean(a && b
  && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** 把 {yaw,pitch,roll} 或 [yaw,pitch,roll] 归一成对象（全有限数）。 */
function normalizeEuler(rotation, fallback = { yaw: 0, pitch: 0, roll: 0 }) {
  if (Array.isArray(rotation)) {
    return {
      yaw: numOr(rotation[0], fallback.yaw),
      pitch: numOr(rotation[1], fallback.pitch),
      roll: numOr(rotation[2], fallback.roll),
    };
  }
  if (isObject(rotation)) {
    return {
      yaw: numOr(rotation.yaw, fallback.yaw),
      pitch: numOr(rotation.pitch, fallback.pitch),
      roll: numOr(rotation.roll, fallback.roll),
    };
  }
  return { yaw: fallback.yaw, pitch: fallback.pitch, roll: fallback.roll };
}

// ── 像素 ↔ 角度 ─────────────────────────────────────────────────────────────

/**
 * 水平视场角 → 焦距（像素）。fx = (width/2) / tan(fovDeg/2)。
 * 方形像素假设下 fy = fx；pixelToAngles 里两个都用 fx。
 *
 * @param {{width:number, fovDeg?:number}} options
 * @returns {number} 焦距（像素）
 */
export function focalLengthPx(options = {}) {
  const width = readWidth(options);
  const fovDeg = clamp(numOr(options.fovDeg, AIM_DEFAULTS.fovDeg), 1, 179);
  return (width / 2) / Math.tan((fovDeg * DEG) / 2);
}

/**
 * 单眼视图像素 → 角度。
 *
 * @param {object} options
 * @param {number} options.px 单眼视图内像素 x（左上原点，向右为正）
 * @param {number} options.py 单眼视图内像素 y（向下为正）
 * @param {number} options.width 单眼视图宽（不是整幅 SBS 图宽！）
 * @param {number} options.height 单眼视图高
 * @param {number} [options.fovDeg=90] 水平视场角
 * @param {'hand'|'head'} [options.axis='hand'] pitch 符号约定：hand+ = 下，head+ = 上
 * @param {number|null} [options.maxYawDeg=85] yaw 钳制；null = 不钳制
 * @param {number|null} [options.maxPitchDeg=85] pitch 钳制；null = 不钳制
 * @param {number} [options.yawOffsetDeg=0] 标定偏移（真机实测后填，见 docs/C-瞄准方案.md）
 * @param {number} [options.pitchOffsetDeg=0] 标定偏移（真机实测后填）
 * @returns {{yawDeg:number, pitchDeg:number, pitchUpDeg:number, fx:number, fy:number,
 *            axis:'hand'|'head', fovDeg:number, width:number, height:number, valid:boolean,
 *            clamped:{yaw:boolean,pitch:boolean},
 *            offset:{yawDeg:number,pitchDeg:number},
 *            raw:{yawDeg:number, pitchDeg:number, pitchUpDeg:number}}}
 */
export function pixelToAngles(options = {}) {
  const opts = isObject(options) ? options : {};
  const { width, height } = readImageSize(opts);
  const fovDeg = clamp(numOr(opts.fovDeg, AIM_DEFAULTS.fovDeg), 1, 179);
  const axis = opts.axis === 'head' ? 'head' : 'hand';
  const fx = (width / 2) / Math.tan((fovDeg * DEG) / 2);
  const fy = fx;
  const maxYaw = toAngleLimit(opts.maxYawDeg, AIM_DEFAULTS.maxYawDeg);
  const maxPitch = toAngleLimit(opts.maxPitchDeg, AIM_DEFAULTS.maxPitchDeg);
  const yawOffset = numOr(opts.yawOffsetDeg, 0);
  const pitchOffset = numOr(opts.pitchOffsetDeg, 0);

  const pxRaw = Number(opts.px);
  const pyRaw = Number(opts.py);
  const valid = Number.isFinite(pxRaw) && Number.isFinite(pyRaw);
  const px = valid ? pxRaw : width / 2;   // 非法输入回退到中心（中心 = 0°）
  const py = valid ? pyRaw : height / 2;

  // 屏幕 y 向下：dy>0 = 目标在中心下方。
  const dx = px - width / 2;
  const dy = py - height / 2;
  // 相机系里"向上"为正，所以横向 yaw = atan2(dx, fx)。
  const yawRaw = Math.atan2(dx, fx) * RAD;
  const pitchUpRaw = Math.atan2(-dy, fy) * RAD;
  // hand：pitch+ = 下 → 取反；head：pitch+ = 上 → 保持。
  const pitchRaw = axis === 'head' ? pitchUpRaw : -pitchUpRaw;
  // 标定偏移加在钳制之前（真机实测的常值偏差）。
  const yawWithOffset = yawRaw + yawOffset;
  const pitchWithOffset = pitchRaw + pitchOffset;

  const yawDeg = clamp(yawWithOffset, -maxYaw, maxYaw);
  const pitchDeg = clamp(pitchWithOffset, -maxPitch, maxPitch);
  return {
    yawDeg: cleanZero(yawDeg),
    pitchDeg: cleanZero(pitchDeg),
    pitchUpDeg: cleanZero(pitchUpRaw), // 与 axis 无关的"向上"角，便于对照头部/激光
    fx,
    fy,
    axis,
    fovDeg,
    width,
    height,
    valid,
    clamped: { yaw: yawDeg !== yawWithOffset, pitch: pitchDeg !== pitchWithOffset },
    offset: { yawDeg: yawOffset, pitchDeg: pitchOffset },
    raw: { yawDeg: cleanZero(yawRaw), pitchDeg: cleanZero(pitchRaw), pitchUpDeg: cleanZero(pitchUpRaw) },
  };
}

/**
 * 角度 → 单眼视图像素（pixelToAngles 的反函数；不做钳制，保证 round-trip 精确）。
 *
 * @param {object} options
 * @param {number} [options.yawDeg=0] + = 右
 * @param {number} [options.pitchDeg=0] hand：+ = 下；head：+ = 上
 * @param {number} options.width 单眼视图宽
 * @param {number} options.height 单眼视图高
 * @param {number} [options.fovDeg=90]
 * @param {'hand'|'head'} [options.axis='hand']
 * @returns {{px:number, py:number, dx:number, dy:number, fx:number, fy:number,
 *            axis:'hand'|'head', fovDeg:number, width:number, height:number}}
 */
export function anglesToPixel(options = {}) {
  const opts = isObject(options) ? options : {};
  const { width, height } = readImageSize(opts);
  const fovDeg = clamp(numOr(opts.fovDeg, AIM_DEFAULTS.fovDeg), 1, 179);
  const axis = opts.axis === 'head' ? 'head' : 'hand';
  const fx = (width / 2) / Math.tan((fovDeg * DEG) / 2);
  const fy = fx;
  const yaw = numOr(opts.yawDeg, 0);
  const pitch = numOr(opts.pitchDeg, 0);
  // 统一换成"向上"角再算 dy（屏幕 y 向下，dy = -fy*tan(up)）。
  const pitchUp = axis === 'head' ? pitch : -pitch;
  const dx = fx * Math.tan(yaw * DEG);
  const dy = -fy * Math.tan(pitchUp * DEG);
  return {
    px: cleanZero(width / 2 + dx),
    py: cleanZero(height / 2 + dy),
    dx: cleanZero(dx),
    dy: cleanZero(dy),
    fx,
    fy,
    axis,
    fovDeg,
    width,
    height,
  };
}

// ── 朝向向量（可选辅助：伸手/位置微调/文档对照用）─────────────────────────

/**
 * 手部朝向 → 单位前向量（Unity 左手系，+Z 前）。
 * 约定：yaw+ = 右，pitch+ = 下（与 vrchat_pose 的 Unity 欧拉语义一致）。
 */
export function handForward(options = {}) {
  const yaw = numOr(isObject(options) ? options.yawDeg : NaN, 0) * DEG;
  const pitch = numOr(isObject(options) ? options.pitchDeg : NaN, 0) * DEG;
  return [
    cleanZero(Math.sin(yaw) * Math.cos(pitch)),
    cleanZero(-Math.sin(pitch)),
    cleanZero(Math.cos(yaw) * Math.cos(pitch)),
  ];
}

/**
 * 头部朝向 → 单位前向量（Unity 左手系，+Z 前）。
 * 约定：yaw+ = 右，pitch+ = 上（与 vrchat_head 的直观语义一致）。
 */
export function headForward(options = {}) {
  const yaw = numOr(isObject(options) ? options.yawDeg : NaN, 0) * DEG;
  const pitch = numOr(isObject(options) ? options.pitchDeg : NaN, 0) * DEG;
  return [
    cleanZero(Math.sin(yaw) * Math.cos(pitch)),
    cleanZero(Math.sin(pitch)),
    cleanZero(Math.cos(yaw) * Math.cos(pitch)),
  ];
}

// ── 双眼并排（SBS）截图辅助 ─────────────────────────────────────────────────

/**
 * SteamVR「Headset Window」截图是双眼并排（SBS）：整图宽 = 2 × 单眼宽。
 * 返回左右眼各自的矩形（整图坐标系）。
 *
 * @param {{width:number, height:number}} options 整幅截图尺寸
 * @returns {{type:'side-by-side', width:number, height:number,
 *            eyes:{left:{x:number,y:number,width:number,height:number},
 *                  right:{x:number,y:number,width:number,height:number}}}}
 */
export function stereoLayout(options = {}) {
  const { width, height } = readImageSize(options);
  const leftWidth = Math.floor(width / 2);
  return {
    type: 'side-by-side',
    width,
    height,
    eyes: {
      left: { x: 0, y: 0, width: leftWidth, height },
      right: { x: leftWidth, y: 0, width: width - leftWidth, height },
    },
  };
}

/**
 * 取某只眼的矩形（整图坐标系）。
 * @param {{width:number, height:number, eye:'left'|'right'}} options
 */
export function stereoEyeRect(options = {}) {
  const opts = isObject(options) ? options : {};
  const layout = stereoLayout(opts);
  const eye = opts.eye;
  if (eye !== 'left' && eye !== 'right') {
    throw new Error('aim.stereoEyeRect: `eye` must be "left" or "right"');
  }
  return { ...layout.eyes[eye], eye };
}

/**
 * 整幅截图坐标 → 单眼视图坐标（用于把 agent 看整图给出的目标点换算到某只眼）。
 * eye='auto' 时按 x 落在左/右半边自动选择（同一目标在两眼中角度几乎一致）。
 *
 * @param {{x:number, y:number, width:number, height:number, eye?:'auto'|'left'|'right'}} options
 * @returns {{eye:'left'|'right', rect:{x,y,width,height}, pixel:{x:number,y:number}, layout:'side-by-side'}}
 */
export function mapImagePointToEye(options = {}) {
  const opts = isObject(options) ? options : {};
  const { width, height } = readImageSize(opts);
  const x = Number(opts.x);
  const y = Number(opts.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('aim.mapImagePointToEye: `x`/`y` must be finite numbers');
  }
  const layout = stereoLayout({ width, height });
  const requested = opts.eye;
  if (requested !== undefined && requested !== 'auto' && requested !== 'left' && requested !== 'right') {
    throw new Error('aim.mapImagePointToEye: `eye` must be "auto", "left" or "right"');
  }
  const eye = requested === 'left' || requested === 'right'
    ? requested
    : (x < width / 2 ? 'left' : 'right');
  const rect = layout.eyes[eye];
  return {
    eye,
    rect,
    pixel: { x: x - rect.x, y: y - rect.y },
    layout: layout.type,
  };
}

// ── 手部瞄准位姿 ────────────────────────────────────────────────────────────

/**
 * 手部静止位姿（米，Unity 左手系）。position 与 lib/vmt.js DEFAULT_POSES 一致；
 * rotation 用欧拉对象表示（全 0 = 朝前），方便标定时整体偏移。
 * **未真机标定**：真机上需按 docs/C-瞄准方案.md 的流程测出实际静止位置。
 */
export const HAND_REST_POSES = Object.freeze({
  left: Object.freeze({
    position: Object.freeze([-0.25, 1.2, 0.18]),
    rotation: Object.freeze({ yaw: 0, pitch: 0, roll: 0 }),
  }),
  right: Object.freeze({
    position: Object.freeze([0.25, 1.2, 0.18]),
    rotation: Object.freeze({ yaw: 0, pitch: 0, roll: 0 }),
  }),
});

/**
 * 手部旋转基座（肩/胸前）默认位置（米）。只在 moveMode='reach' 时参与"位置微调"。
 * **未真机标定**：默认值是按 1.7m 身高、双肩宽约 0.44m 猜的。
 */
export const HAND_PIVOTS = Object.freeze({
  left: Object.freeze([-0.22, 1.35, 0.0]),
  right: Object.freeze([0.22, 1.35, 0.0]),
});

function normalizeRestPose(hand, restPose) {
  const base = HAND_REST_POSES[hand];
  if (!isObject(restPose)) {
    return {
      position: [...base.position],
      rotation: { ...base.rotation },
      source: 'default',
    };
  }
  const position = Array.isArray(restPose.position)
    ? [
      numOr(restPose.position[0], base.position[0]),
      numOr(restPose.position[1], base.position[1]),
      numOr(restPose.position[2], base.position[2]),
    ]
    : [...base.position];
  return {
    position,
    rotation: normalizeEuler(restPose.rotation, base.rotation),
    source: 'provided',
  };
}

/**
 * 像素目标 → 手部瞄准位姿（可直接喂给 vrchat_pose）。
 *
 * 两种模式：
 *   * moveMode='rotate'（默认，推荐先用）：只改 rotation，position 保持静止位姿（+ 可选 handHeightM）。
 *     —— 旋转基座在肩/胸前，激光从手部原点出发；先验证方向是否正确，再谈位置微调。
 *   * moveMode='reach'：按 yaw/pitch 从 pivotM 沿手部前向量伸 distanceM，position 也一起给。
 *     —— 需要目标距离已知（菜单通常 0.5–1m，无法从单张截图测距，需人工给）。
 *
 * @param {object} options
 * @param {{x:number, y:number}} options.target 单眼视图内像素目标
 * @param {number} options.width 单眼视图宽
 * @param {number} options.height 单眼视图高
 * @param {number} [options.fovDeg=90]
 * @param {'left'|'right'} [options.hand='right']
 * @param {{position?:number[], rotation?:{yaw:number,pitch:number,roll:number}|number[]}} [options.restPose]
 * @param {number} [options.handHeightM] 覆盖静止位姿高度 y（米），用于标定
 * @param {'rotate'|'reach'} [options.moveMode='rotate']
 * @param {[number,number,number]} [options.pivotM] reach 模式的旋转基座（米）
 * @param {number} [options.distanceM=0.45] reach 模式伸手长度（米）
 * @param {number} [options.rollDeg=0] 附加 roll（度）
 * @param {number|null} [options.maxYawDeg=85]
 * @param {number|null} [options.maxPitchDeg=85]
 * @param {number} [options.yawOffsetDeg=0] 标定偏移（真机实测后填）
 * @param {number} [options.pitchOffsetDeg=0] 标定偏移（真机实测后填）
 * @returns {{hand:'left'|'right', mode:'rotate'|'reach', width:number, height:number,
 *            fovDeg:number, pixel:{x:number,y:number},
 *            angles:{yawDeg:number,pitchDeg:number,pitchUpDeg:number,
 *                    raw:object, clamped:object, offset:object},
 *            target:{x:number,y:number,z:number},
 *            rotation:{yaw:number,pitch:number,roll:number},
 *            restPose:{position:number[], rotation:object},
 *            pivotM:number[]|null, distanceM:number|null,
 *            warnings:string[], unverified:readonly string[]}}
 */
export function handAimFromTarget(options = {}) {
  const opts = isObject(options) ? options : {};
  const hand = opts.hand === undefined || opts.hand === null ? 'right' : opts.hand;
  if (hand !== 'left' && hand !== 'right') {
    throw new Error('aim.handAimFromTarget: `hand` must be "left" or "right"');
  }
  const { width, height } = readImageSize(opts);
  const fovDeg = clamp(numOr(opts.fovDeg, AIM_DEFAULTS.fovDeg), 1, 179);
  const warnings = [];

  const targetInput = isObject(opts.target) ? opts.target : {};
  let targetX = Number(targetInput.x);
  let targetY = Number(targetInput.y);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    targetX = width / 2;
    targetY = height / 2;
    warnings.push('target 像素不是有限数，已回退到画面中心（0°/0°）');
  }

  const maxYaw = toAngleLimit(opts.maxYawDeg, AIM_DEFAULTS.maxYawDeg);
  const maxPitch = toAngleLimit(opts.maxPitchDeg, AIM_DEFAULTS.maxPitchDeg);
  const angles = pixelToAngles({
    px: targetX,
    py: targetY,
    width,
    height,
    fovDeg,
    axis: 'hand',
    maxYawDeg: maxYaw === Infinity ? null : maxYaw,
    maxPitchDeg: maxPitch === Infinity ? null : maxPitch,
    yawOffsetDeg: opts.yawOffsetDeg,
    pitchOffsetDeg: opts.pitchOffsetDeg,
  });

  const rest = normalizeRestPose(hand, opts.restPose);
  const rollExtra = numOr(opts.rollDeg, 0);
  const rotation = {
    yaw: clamp(rest.rotation.yaw + angles.yawDeg, -maxYaw, maxYaw),
    pitch: clamp(rest.rotation.pitch + angles.pitchDeg, -maxPitch, maxPitch),
    roll: clamp(rest.rotation.roll + rollExtra, -180, 180),
  };
  const finalClamped = {
    yaw: rotation.yaw !== rest.rotation.yaw + angles.yawDeg,
    pitch: rotation.pitch !== rest.rotation.pitch + angles.pitchDeg,
  };

  const position = [...rest.position];
  if (Number.isFinite(Number(opts.handHeightM))) {
    position[1] = Number(opts.handHeightM);
  }

  const moveMode = opts.moveMode === 'reach' ? 'reach' : 'rotate';
  let pivot = null;
  let distanceM = null;
  if (moveMode === 'reach') {
    const pivotInput = Array.isArray(opts.pivotM) ? opts.pivotM : HAND_PIVOTS[hand];
    pivot = [
      numOr(pivotInput?.[0], HAND_PIVOTS[hand][0]),
      numOr(pivotInput?.[1], HAND_PIVOTS[hand][1]),
      numOr(pivotInput?.[2], HAND_PIVOTS[hand][2]),
    ];
    distanceM = clamp(numOr(opts.distanceM, AIM_DEFAULTS.reachM), 0.05, 1.2);
    const forward = handForward({ yawDeg: rotation.yaw, pitchDeg: rotation.pitch });
    position[0] = pivot[0] + forward[0] * distanceM;
    position[1] = pivot[1] + forward[1] * distanceM;
    position[2] = pivot[2] + forward[2] * distanceM;
    warnings.push('reach 模式的 pivotM/distanceM 未真机标定；菜单距离无法从单张截图测得');
  }

  return {
    hand,
    mode: moveMode,
    width,
    height,
    fovDeg,
    pixel: { x: targetX, y: targetY },
    angles: {
      yawDeg: angles.yawDeg,
      pitchDeg: angles.pitchDeg,
      pitchUpDeg: angles.pitchUpDeg,
      raw: angles.raw,
      offset: angles.offset,
      clamped: { ...angles.clamped, ...finalClamped },
    },
    target: { x: position[0], y: position[1], z: position[2] },
    rotation,
    restPose: { position: [...rest.position], rotation: { ...rest.rotation }, source: rest.source },
    pivotM: pivot,
    distanceM,
    warnings,
    unverified: UNVERIFIED_ASSUMPTIONS,
  };
}

// ── 帧指纹 / 帧差（点击确认）───────────────────────────────────────────────

function readFrameLike(frame, label) {
  if (!isObject(frame)) {
    throw new Error(`aim.framesDiffer: \`${label}\` must be a frame {data,width,height} or frameSignature() result`);
  }
  const { width, height } = readImageSize(frame);
  const data = frame.data;
  if (!data || typeof data.length !== 'number' || data.length < width * height * 4) {
    throw new Error(`aim.framesDiffer: \`${label}\`.data must be an RGBA buffer with length >= width*height*4`);
  }
  return {
    width,
    height,
    data,
    region: isObject(frame.region) ? { ...frame.region } : null,
    step: Number.isFinite(Number(frame.step)) ? Number(frame.step) : null,
    hash: Number.isFinite(Number(frame.hash)) ? Number(frame.hash) : null,
  };
}

/**
 * 对 RGBA 缓冲的区域算指纹（FNV-1a 32 位）与均值，用来判断"整块画面有没有变"。
 *
 * 返回对象带 `data`（对入参缓冲的引用，不复制），所以可以直接把两个 signature
 * 传给 framesDiffer() 做逐像素差异——中间不要改写入参缓冲。
 *
 * @param {Uint8Array|Buffer} rgba 长度 >= width*height*4 的 RGBA 缓冲
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {{x:number,y:number,width:number,height:number}} [options.region] 区域（默认整幅）
 * @param {number} [options.step=1] 采样步长（1 = 逐像素；>1 更快但可能漏小变化）
 * @returns {{width:number,height:number,region:object,step:number,sampleCount:number,
 *            hash:number,hashHex:string,meanRGB:{r:number,g:number,b:number},meanA:number,
 *            data:Uint8Array|Buffer}}
 */
export function frameSignature(rgba, options = {}) {
  const opts = isObject(options) ? options : {};
  const { width, height } = readImageSize(opts);
  if (!rgba || typeof rgba.length !== 'number' || rgba.length < width * height * 4) {
    throw new Error('aim.frameSignature: `rgba` must be an RGBA buffer with length >= width*height*4');
  }
  const region = normalizeRegion(opts.region, width, height);
  const step = toInt(opts.step, 1, 1, 64);

  let hash = 0x811c9dc5 >>> 0;
  let sampleCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  const rowBytes = width * 4;

  for (let y = region.y; y < region.y + region.height; y += step) {
    const rowBase = y * rowBytes;
    const end = rowBase + (region.x + region.width) * 4;
    for (let i = rowBase + region.x * 4; i < end; i += step * 4) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const a = rgba[i + 3];
      hash ^= ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      sampleCount += 1;
      sumR += r;
      sumG += g;
      sumB += b;
      sumA += a;
    }
  }
  const n = sampleCount || 1;
  return {
    width,
    height,
    region,
    step,
    sampleCount,
    hash: hash >>> 0,
    hashHex: (hash >>> 0).toString(16).padStart(8, '0'),
    meanRGB: { r: sumR / n, g: sumG / n, b: sumB / n },
    meanA: sumA / n,
    data: rgba,
  };
}

/**
 * 比较两帧（或两个 frameSignature 结果）的差异。
 *
 * 判断规则（便于"点击后画面是否变化"）：
 *   differ = totalPixels>0 && changedPixels >= minChangedPixels && diffRatio >= threshold
 * 默认 minChangedPixels=1 且 threshold=0.0005（0.05%），单个像素噪声不算变化；
 * 需要"sensitivity"时把 threshold 调 0、或把 minChangedPixels 设小。
 *
 * @param {{data:Uint8Array|Buffer,width:number,height:number,region?:object,step?:number,hash?:number}} a
 * @param {object} b 同 a
 * @param {object} [options]
 * @param {number} [options.threshold=0.0005] 差异比阈值（0..1）
 * @param {number} [options.minChangedPixels=1] 最少变化像素数
 * @param {number} [options.tolerance=0] 单通道差 <= tolerance 视为未变（抗压缩/渲染噪声）
 * @param {object} [options.region] 比较区域；默认取 a/b 的 region，否则整幅
 * @param {number} [options.step=1] 采样步长；默认取 a/b 的 step（相同才用），否则 1
 * @returns {{width:number,height:number,region:object,step:number,totalPixels:number,
 *            changedPixels:number,diffRatio:number,diffRatioPct:number,meanAbsDiff:number,
 *            tolerance:number,threshold:number,minChangedPixels:number,
 *            differ:boolean,identical:boolean,hashA:number|null,hashB:number|null}}
 */
export function framesDiffer(a, b, options = {}) {
  const opts = isObject(options) ? options : {};
  const fa = readFrameLike(a, 'a');
  const fb = readFrameLike(b, 'b');
  if (fa.width !== fb.width || fa.height !== fb.height) {
    throw new Error(`aim.framesDiffer: frame sizes differ (${fa.width}x${fa.height} vs ${fb.width}x${fb.height})`);
  }
  const width = fa.width;
  const height = fa.height;
  const region = opts.region
    ? normalizeRegion(opts.region, width, height)
    : (fa.region
      ? normalizeRegion(fa.region, width, height)
      : normalizeRegion(fb.region, width, height));

  const stepA = fa.step === null ? 1 : toInt(fa.step, 1, 1, 64);
  const stepB = fb.step === null ? 1 : toInt(fb.step, 1, 1, 64);
  const step = opts.step !== undefined
    ? toInt(opts.step, 1, 1, 64)
    : (stepA === stepB ? stepA : 1);

  const tolerance = toInt(opts.tolerance, 0, 0, 255);
  const threshold = clamp(numOr(opts.threshold, AIM_DEFAULTS.threshold), 0, 1);
  const minChangedPixels = toInt(opts.minChangedPixels, AIM_DEFAULTS.minChangedPixels, 0, Number.MAX_SAFE_INTEGER);

  const totalPixels = Math.ceil(region.width / step) * Math.ceil(region.height / step);
  const sameRegionSignatures = fa.hash !== null && fb.hash !== null
    && stepA === stepB && sameRegion(fa.region, fb.region);
  const hashA = fa.hash;
  const hashB = fb.hash;

  // 指纹相同 → 直接判定没变（省一轮逐像素循环）。
  if (sameRegionSignatures && hashA === hashB) {
    return {
      width, height, region, step,
      totalPixels, changedPixels: 0, diffRatio: 0, diffRatioPct: 0, meanAbsDiff: 0,
      tolerance, threshold, minChangedPixels,
      differ: false, identical: true, hashA, hashB,
    };
  }

  let changedPixels = 0;
  let absSum = 0;
  const rowBytes = width * 4;
  const xEnd = region.x + region.width;
  const yEnd = region.y + region.height;
  for (let y = region.y; y < yEnd; y += step) {
    const rowBase = y * rowBytes;
    for (let x = region.x; x < xEnd; x += step) {
      const i = rowBase + x * 4;
      const dr = Math.abs(fa.data[i] - fb.data[i]);
      const dg = Math.abs(fa.data[i + 1] - fb.data[i + 1]);
      const db = Math.abs(fa.data[i + 2] - fb.data[i + 2]);
      const da = Math.abs(fa.data[i + 3] - fb.data[i + 3]);
      absSum += dr + dg + db + da;
      if (dr > tolerance || dg > tolerance || db > tolerance || da > tolerance) changedPixels += 1;
    }
  }
  const diffRatio = totalPixels > 0 ? changedPixels / totalPixels : 0;
  return {
    width, height, region, step,
    totalPixels,
    changedPixels,
    diffRatio,
    diffRatioPct: diffRatio * 100,
    meanAbsDiff: totalPixels > 0 ? absSum / (totalPixels * 4) : 0,
    tolerance,
    threshold,
    minChangedPixels,
    differ: totalPixels > 0 && changedPixels >= minChangedPixels && diffRatio >= threshold,
    identical: changedPixels === 0,
    hashA,
    hashB,
  };
}

// ── 点击序列计划 ────────────────────────────────────────────────────────────

/**
 * 生成"瞄准 → 点击 → 截图确认"的分步计划（纯数据，不执行任何 IO）。
 * 真机脚本按 steps 依次调用对应工具即可；verify 步骤需要先截一张"点击前"的图作为基线。
 *
 * @param {object} options 同 handAimFromTarget()，另加：
 * @param {number} [options.durationMs=600] vrchat_pose 插值时长
 * @param {number} [options.settleMs=350] 瞄准后稳定时间
 * @param {number} [options.pressHoldMs=120] 扳机按下时长
 * @param {number} [options.verifyDelayMs=500] 点击后等画面稳定的时间
 * @param {string} [options.pressKey='trigger'] 点击键（VRChat 点击=扳机，HANDOFF §4）
 * @param {{x:number,y:number,width:number,height:number}} [options.verifyRegion]
 *        确认区域；默认目标周围 30% 的单眼视图矩形
 * @param {number} [options.verifyThreshold=0.0005] framesDiffer 阈值
 * @returns {{hand:'left'|'right', aim:object, steps:object[],
 *            warnings:string[], assumptions:readonly string[]}}
 */
export function planClickSequence(options = {}) {
  const opts = isObject(options) ? options : {};
  const aim = handAimFromTarget(opts);

  const durationMs = toInt(opts.durationMs, 600, 0, 10_000);
  const settleMs = toInt(opts.settleMs, 350, 0, 5_000);
  const pressHoldMs = toInt(opts.pressHoldMs, 120, 20, 5_000);
  const verifyDelayMs = toInt(opts.verifyDelayMs, 500, 0, 5_000);
  const pressKey = typeof opts.pressKey === 'string' && opts.pressKey.length > 0 ? opts.pressKey : 'trigger';
  const verifyThreshold = clamp(numOr(opts.verifyThreshold, AIM_DEFAULTS.threshold), 0, 1);

  let verifyRegion = opts.verifyRegion;
  if (!isObject(verifyRegion)) {
    const w = Math.max(1, Math.round(aim.width * 0.3));
    const h = Math.max(1, Math.round(aim.height * 0.3));
    verifyRegion = {
      x: Math.round(clamp(aim.pixel.x - w / 2, 0, Math.max(0, aim.width - w))),
      y: Math.round(clamp(aim.pixel.y - h / 2, 0, Math.max(0, aim.height - h))),
      width: w,
      height: h,
    };
  }

  const steps = [
    {
      step: 1,
      phase: 'pose',
      tool: 'vrchat_pose',
      args: {
        hand: aim.hand,
        target: { ...aim.target },
        rotation: { ...aim.rotation },
        durationMs,
        easing: 'easeOut',
        hold: true,
      },
      note: '只转不移动（默认 moveMode=rotate）；像素目标 → 手部朝向',
    },
    {
      step: 2,
      phase: 'settle',
      ms: settleMs,
      note: '等插值到位、激光落点稳定的估计时间（未真机标定）',
    },
    {
      step: 3,
      phase: 'press',
      tool: 'vrchat_ui',
      args: { action: 'press', key: pressKey, side: aim.hand, durationMs: pressHoldMs },
      note: '扳机 = VRChat 的点击/确认（HANDOFF §4 已验证扳机被接收）',
    },
    {
      step: 4,
      phase: 'settle',
      ms: verifyDelayMs,
      note: '等点击生效 / 菜单动画（未真机标定）',
    },
    {
      step: 5,
      phase: 'verify',
      tool: 'vrchat_screenshot',
      then: {
        fn: 'framesDiffer',
        args: { region: { ...verifyRegion }, threshold: verifyThreshold, minChangedPixels: 1 },
      },
      note: '与点击前截图比较：differ=true 只说明画面变了，不等于选中成功（激光闪烁/动画也会变）',
    },
  ];

  return {
    hand: aim.hand,
    aim,
    steps,
    warnings: [...aim.warnings],
    assumptions: UNVERIFIED_ASSUMPTIONS,
  };
}
