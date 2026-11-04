// laser.mjs — 在 Headset Window 截图里找 VRChat 的激光射线（交互指向）。
//
// 2026-11-04 真机实测（Index 兼容手柄 + VMT，快捷菜单打开时）：
//   * 激光是一条 1–2 px 宽的淡青色直线，颜色约 rgb(95,178,189)；
//   * 它从手部控制器射向"当前指向"，在命中第一个表面处终止（或最大长度处）；
//   * 实测点集拟合出直线后，取"离手部远端"的端点就是当前瞄准点（用于闭环伺服）。
//   * 朝向符号（真机实测，右眼画面）：hand yaw + = 画面里瞄准点往右；hand pitch + = 往下。
//     （与 HANDOFF §8-C 的推断一致；head 的 pitch 正好相反。）
//
// 注意：不同分辨率/画质/播放器下这条射线的颜色和粗细可能变化；本模块把颜色阈值与
// 扫描区域都做成参数，并保留 detectLaserPixels() 供标定脚本重新采样。颜色阈值基于
// 2026-11-04 的 1280x720 SBS 截图（左右眼各 640x720），在别的环境里先用 --calibrate 验证。
//
// 纯函数、零依赖（不读文件、不发包），可被 MCP / daemon / 真机脚本复用。

/**
 * 实测激光颜色并非固定值：它是叠加混合的淡青细线，颜色随背后场景亮度变化。
 * 本机采到的两组样本：
 *   * 深色地板背景：rgb(95,178,189)（偏暗青）
 *   * 亮地板背景：  rgb(107,229,251)（更亮更蓝）
 * 因此阈值按"红通道明显低于绿/蓝、且不是菜单青（菜单图标 r≈43 被排除）、不是镜面高光
 * （r≈157 被排除）"来定；更细的判别交给 fitLine 的离群点剔除。
 */
export const LASER_COLOR = Object.freeze({
  rMin: 55,
  rMax: 145,
  gMin: 145,
  gMax: 255,
  bMin: 165,
  bMax: 255,
  bMinusGMin: 2,
  bMinusGMax: 70,
  gMinusRMin: 35,
});

/** 截图是 SBS 双眼时，取哪只眼做分析以及单眼宽度。 */
export function resolveEye({ width, height, eye = 'right', layout = 'auto' } = {}) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('laser: `width`/`height` must be positive numbers');
  }
  const isSbs = layout === 'sbs' || (layout !== 'mono' && width >= height * 1.6);
  if (!isSbs) {
    return { layout: 'mono', eyeWidth: width, eyeHeight: height, offsetX: 0, eye };
  }
  const eyeWidth = Math.floor(width / 2);
  const offsetX = eye === 'left' ? 0 : eyeWidth;
  return { layout: 'sbs', eyeWidth, eyeHeight: height, offsetX, eye };
}

/**
 * 收集激光颜色像素（单眼坐标系，左上原点）。
 * @param {Uint8Array|Buffer} rgba 整幅 RNBA（SBS 也行，按 eye 裁剪）
 * @returns {{count:number, points:{x:number,y:number}[], eye:{layout:string,eyeWidth:number,offsetX:number}}}
 */
export function detectLaserPixels(rgba, options = {}) {
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const width = Number(opts.width);
  const height = Number(opts.height);
  const eye = resolveEye({ width, height, eye: opts.eye ?? 'right', layout: opts.layout ?? 'auto' });
  const color = { ...LASER_COLOR, ...(opts.color ?? {}) };
  if (!rgba || typeof rgba.length !== 'number' || rgba.length < width * height * 4) {
    throw new Error('laser: rgba buffer is smaller than width*height*4');
  }
  const points = [];
  const x0 = eye.offsetX;
  const x1 = x0 + eye.eyeWidth;
  for (let y = 0; y < height; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      if (r < color.rMin || r > color.rMax) continue;
      if (g < color.gMin || g > color.gMax) continue;
      if (b < color.bMin || b > color.bMax) continue;
      const bg = b - g;
      if (bg < color.bMinusGMin || bg > color.bMinusGMax) continue;
      if (g - r < color.gMinusRMin) continue;
      points.push({ x: x - x0, y });
    }
  }
  return { count: points.length, points, eye };
}

/**
 * 最小二乘拟合直线 + 离群点剔除（两轮）：截图里除了激光，常混进墙面/菜单的淡蓝像素；
 * 不剔除的话这些散点会把端点拽到画面另一头，伺服会一直"看到同一个假目标"。
 * 返回中心、单位方向、两端点、长度、角度（图像坐标系，y 向下）。
 */
export function fitLine(points, options = {}) {
  const opts = options === null || typeof options !== 'object' ? {} : options;
  if (!Array.isArray(points) || points.length < 8) return { ok: false, reason: 'too few points', count: points?.length ?? 0 };
  const maxResidual = Number.isFinite(Number(opts.maxResidual)) ? Number(opts.maxResidual) : 3;
  let current = points;
  let fit = null;
  for (let round = 0; round < 3; round += 1) {
    let sumX = 0;
    let sumY = 0;
    for (const p of current) {
      sumX += p.x;
      sumY += p.y;
    }
    const cx = sumX / current.length;
    const cy = sumY / current.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of current) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    // 垂直距离 = |dx*uy - dy*ux|；只保留贴线的点，散点不参与端点。
    const inliers = [];
    for (const p of current) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (Math.abs(dx * uy - dy * ux) <= maxResidual) inliers.push(p);
    }
    fit = { cx, cy, ux, uy };
    if (inliers.length === current.length || inliers.length < 8) {
      if (inliers.length >= 8) current = inliers;
      break;
    }
    current = inliers;
  }
  const { cx, cy, ux, uy } = fit;
  let minT = Infinity;
  let maxT = -Infinity;
  let minP = null;
  let maxP = null;
  for (const p of current) {
    const t = (p.x - cx) * ux + (p.y - cy) * uy;
    if (t < minT) {
      minT = t;
      minP = p;
    }
    if (t > maxT) {
      maxT = t;
      maxP = p;
    }
  }
  const length = maxT - minT;
  const angleDeg = (Math.atan2(maxP.y - minP.y, maxP.x - minP.x) * 180) / Math.PI;
  // 真机实测的激光线长度 143–500 px（1280x720 SBS、单眼 640 宽）；60 px 以下当作噪声/短线。
  const minLength = Number.isFinite(Number(opts.minLength)) ? Number(opts.minLength) : 60;
  return {
    ok: length >= minLength,
    reason: length >= minLength ? null : 'line too short',
    count: current.length,
    inputCount: points.length,
    center: { x: cx, y: cy },
    direction: { x: ux, y: uy },
    endpoints: [minP, maxP],
    length,
    angleDeg,
  };
}

/**
 * 取"瞄准远端"：离手部参考点更远的那个端点。
 * handHint 默认取画面右下（右眼画面里右手控制器所在区域）；左手时用左下。
 * 为什么不用"手部控制器像素"精确检测：控制器模型是灰色硬件，检测不稳；用固定 hint 足够，
 * 因为激光一定从手部方向射向画面另一侧。
 */
export function pickFarEndpoint(line, { handHint } = {}) {
  if (!line || line.ok !== true) return null;
  const hint = handHint ?? { x: 600, y: 560 };
  const [a, b] = line.endpoints;
  const da = (a.x - hint.x) ** 2 + (a.y - hint.y) ** 2;
  const db = (b.x - hint.x) ** 2 + (b.y - hint.y) ** 2;
  return da >= db ? { far: a, near: b } : { far: b, near: a };
}

/**
 * 参考帧差分：激光是画面里唯一"会动"的淡蓝细线；先把手转到激光射不到画面的位置截一张
 * 参考帧（静态的墙/菜单/镜子高光都在），再把当前帧的颜色候选点里"参考帧同位置附近也有
 * 候选点"的点剔掉，剩下的就是激光。这比单纯颜色阈值稳得多。
 *
 * @param {{x:number,y:number}[]} candidates 当前帧的激光颜色候选点
 * @param {{x:number,y:number}[]} referencePoints 参考帧（无激光）的激光颜色候选点
 * @param {number} radiusPx 邻域半径（像素）
 */
export function subtractReference(candidates, referencePoints, radiusPx = 3) {
  if (!Array.isArray(candidates)) return [];
  if (!Array.isArray(referencePoints) || referencePoints.length === 0) return candidates;
  const cell = Math.max(1, Math.round(radiusPx));
  const buckets = new Map();
  for (const p of referencePoints) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const radiusSq = radiusPx * radiusPx;
  const result = [];
  for (const p of candidates) {
    const bx = Math.floor(p.x / cell);
    const by = Math.floor(p.y / cell);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx += 1) {
      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        const bucket = buckets.get(`${bx + dx},${by + dy}`);
        if (!bucket) continue;
        for (const r of bucket) {
          if ((r.x - p.x) ** 2 + (r.y - p.y) ** 2 <= radiusSq) {
            hit = true;
            break;
          }
        }
      }
    }
    if (!hit) result.push(p);
  }
  return result;
}

/**
 * RANSAC 直线检测：画面里常混入大量非激光的淡青像素（菜单图标/镜面高光/世界发光物），
 * 全局最小二乘会被它们带偏。这里随机采样两点、统计内点，选最长的那条直线，再用内点做
 * 最小二乘精修。确定性 RNG（seed）保证同一帧结果可复现。
 */
export function fitLineRansac(points, options = {}) {
  const opts = options === null || typeof options !== 'object' ? {} : options;
  if (!Array.isArray(points) || points.length < 12) return { ok: false, reason: 'too few points', count: points?.length ?? 0 };
  const maxResidual = Number.isFinite(Number(opts.maxResidual)) ? Number(opts.maxResidual) : 2.5;
  const iterations = Math.max(50, Math.min(8000, Number.isFinite(Number(opts.iterations)) ? Number(opts.iterations) : 1200));
  const minInliers = Number.isFinite(Number(opts.minInliers)) ? Number(opts.minInliers) : Math.max(24, Math.round(points.length * 0.05));
  let state = (Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : 20261104) >>> 0;
  const rand = () => {
    // xorshift32
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  let best = null;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const a = points[(rand() * points.length) | 0];
    const b = points[(rand() * points.length) | 0];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 120) continue;
    const ux = dx / length;
    const uy = dy / length;
    let inliers = 0;
    for (const p of points) {
      const px = p.x - a.x;
      const py = p.y - a.y;
      if (Math.abs(px * uy - py * ux) <= maxResidual) inliers += 1;
    }
    if (best === null || inliers > best.inliers) best = { inliers, a, b, ux, uy };
  }
  if (best === null || best.inliers < minInliers) return { ok: false, reason: 'no line', count: points.length, bestInliers: best?.inliers ?? 0 };
  // 精修：用内点做两轮最小二乘 + 端点。
  let inliers = points.filter((p) => {
    const px = p.x - best.a.x;
    const py = p.y - best.a.y;
    return Math.abs(px * best.uy - py * best.ux) <= maxResidual;
  });
  let refined = null;
  for (let round = 0; round < 2; round += 1) {
    let sumX = 0;
    let sumY = 0;
    for (const p of inliers) { sumX += p.x; sumY += p.y; }
    const cx = sumX / inliers.length;
    const cy = sumY / inliers.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of inliers) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    refined = { cx, cy, ux: Math.cos(theta), uy: Math.sin(theta) };
    const next = points.filter((p) => Math.abs((p.x - cx) * refined.uy - (p.y - cy) * refined.ux) <= maxResidual);
    if (next.length < 12) break;
    inliers = next;
  }
  let minT = Infinity, maxT = -Infinity, minP = null, maxP = null;
  for (const p of inliers) {
    const t = (p.x - refined.cx) * refined.ux + (p.y - refined.cy) * refined.uy;
    if (t < minT) { minT = t; minP = p; }
    if (t > maxT) { maxT = t; maxP = p; }
  }
  const length = maxT - minT;
  const minLength = Number.isFinite(Number(opts.minLength)) ? Number(opts.minLength) : 60;
  return {
    ok: length >= minLength,
    reason: length >= minLength ? null : 'line too short',
    count: inliers.length,
    inputCount: points.length,
    center: { x: refined.cx, y: refined.cy },
    direction: { x: refined.ux, y: refined.uy },
    endpoints: [minP, maxP],
    length,
    angleDeg: (Math.atan2(maxP.y - minP.y, maxP.x - minP.x) * 180) / Math.PI,
    ransac: true,
  };
}

/**
 * 一步到位：截图 RGBA → 激光直线 + 瞄准端点（单眼坐标）。
 * 点数多时用 RANSAC（画面里淡青杂物多），点数少时用离群点剔除版最小二乘。
 * @returns {{ok:boolean, count:number, line?:object, aim?:{x:number,y:number}, near?:object, eye?:object, reason?:string}}
 */
export function detectLaser(rgba, options = {}) {
  const opts = options === null || typeof options !== 'object' ? {} : options;
  const detected = detectLaserPixels(rgba, opts);
  let points = detected.points;
  let referenceCount = null;
  if (opts.referenceRgba) {
    const ref = detectLaserPixels(opts.referenceRgba, opts);
    referenceCount = ref.count;
    points = subtractReference(points, ref.points, Number.isFinite(Number(opts.referenceRadiusPx)) ? Number(opts.referenceRadiusPx) : 3);
  }
  const useRansac = points.length >= 120;
  const line = useRansac
    ? fitLineRansac(points, { minLength: opts.minLength, maxResidual: opts.maxResidual, iterations: opts.iterations, seed: opts.seed })
    : fitLine(points, { minLength: opts.minLength, maxResidual: opts.maxResidual });
  if (line.ok !== true) {
    return { ok: false, count: detected.count, filteredCount: points.length, referenceCount, reason: line.reason, eye: detected.eye };
  }
  const ends = pickFarEndpoint(line, { handHint: opts.handHint });
  return { ok: true, count: detected.count, filteredCount: points.length, referenceCount, line, aim: ends.far, near: ends.near, eye: detected.eye };
}

/**
 * 由实测像素误差反推手部角度增量（图像坐标系：x 右、y 下）。
 * 实测标定（2026-11-04，1280x720 SBS，手在 x=0.28,y=1.42,z=0.34，头 pitch=-25）：
 *   yaw  +25° → 瞄准点右移 ~+83 px（≈3.3 px/°）
 *   yaw  -25° → 瞄准点左移 ~-98 px（≈3.9 px/°）
 *   pitch +25° → 瞄准点下移 ~+171 px（≈6.8 px/°）
 *   pitch -25° → 瞄准点上移 ~-121 px（≈4.8 px/°）
 * 取中间值作为默认增益；真机脚本可用 --px-per-deg 覆盖，或先用 calibrate 步进测量。
 */
export const AIM_GAIN = Object.freeze({ yawPxPerDeg: 3.6, pitchPxPerDeg: 5.8 });

/**
 * 像素误差 → 手部角度增量（yaw+ 右、pitch+ 下，与 vrchat_pose 的 rotation 一致）。
 * @param {{dx:number, dy:number, gain?:{yawPxPerDeg:number,pitchPxPerDeg:number}, maxStepDeg?:number}} input
 */
export function pixelErrorToHandDelta({ dx, dy, gain = AIM_GAIN, maxStepDeg = 20 } = {}) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('laser: dx/dy must be finite numbers');
  const yawPxPerDeg = Number(gain?.yawPxPerDeg) > 0 ? Number(gain.yawPxPerDeg) : AIM_GAIN.yawPxPerDeg;
  const pitchPxPerDeg = Number(gain?.pitchPxPerDeg) > 0 ? Number(gain.pitchPxPerDeg) : AIM_GAIN.pitchPxPerDeg;
  const clamp = (value) => Math.max(-maxStepDeg, Math.min(maxStepDeg, value));
  return {
    dyawDeg: clamp(dx / yawPxPerDeg),
    dpitchDeg: clamp(dy / pitchPxPerDeg),
  };
}
