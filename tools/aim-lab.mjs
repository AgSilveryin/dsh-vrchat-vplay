// tools/aim-lab.mjs — 激光瞄准的离线实验 CLI（纯工具，不随包、不启动 SteamVR/VRChat、不发 UDP）。
//
// 两个模式：
//   单图模式：解码真实截图 → 目标点（归一化或像素）→ 像素/角度/建议 vrchat_pose 位姿 JSON
//   差异模式：解码两张截图 → 区域指纹 + 差异比（用于"点击后画面有没有变"）
//
// PNG 解码复用配套玩家工程的零依赖解码器 player/src/perception/png.mjs（动态 import + 目录探测，
// 探测顺序参考 lib/player-process.mjs）：--player-dir / VPLAY_PLAYER_DIR → 插件自包含包内的
// player/src/perception/png.mjs → 开发期兄弟目录 ../vrchat-vr-driver → 旧路径兜底。
//
// 注意（真实截图观察，2026-11-04 用本机 15 张 shots/live/*.png 核对）：
//   * SteamVR「Headset Window」截图是**双眼并排（SBS）**：1280×720 = 左右各 640×720。
//     像素→角度必须按单眼视图宽算 fx，否则角度差约一倍。本工具默认自动判断布局，
//     用 --layout sbs|mono 可强制覆盖（自动判断只是启发式，判定依据会打印在 json.layout 里）。
//   * 07-click.png 是 dashboard 桌面视图（单幅、非 SBS）——自动判断会认成 mono，角度仅作参考。
//
// 用法：
//   node tools/aim-lab.mjs --png shots/live/20-quickmenu-open.png --target 0.8,0.9
//   node tools/aim-lab.mjs --png <绝对路径>.png --target 384,648 --pixels --eye right
//   node tools/aim-lab.mjs --diff shots/live/20-quickmenu-open.png shots/live/21-dashboard-hidden.png
//   node tools/aim-lab.mjs --diff a.png b.png --region 900,520,380,200 --threshold 0.001
//   node tools/aim-lab.mjs --help
//
// 退出码：0 成功；1 参数/解码/计算错误（stdout 仍是 JSON：{"ok":false,"error":...}）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AIM_DEFAULTS,
  UNVERIFIED_ASSUMPTIONS,
  frameSignature,
  framesDiffer,
  handAimFromTarget,
  mapImagePointToEye,
  pixelToAngles,
  planClickSequence,
} from '../lib/aim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
/** 旧版硬编码兜底（与 lib/player-process.mjs 的 LEGACY_PLAYER_DIR 一致；仅当它真的存在才用）。 */
const LEGACY_PLAYER_DIR = 'D:\\中转站API\\vrchat-vr-driver';

const SBS_SAD_THRESHOLD = 30; // 左右两半平均亮度差的启发式阈值（0..255）

const HELP = `aim-lab — 激光瞄准离线实验 CLI（零依赖、不启动 VR）

单图模式（像素 → 角度 → vrchat_pose 建议位姿）：
  node tools/aim-lab.mjs --png <图片> [--target x,y] [选项]

    --target <x,y>      目标点。默认按整幅截图的归一化坐标（0..1）解释，如 0.8,0.9；
                        加 --pixels 则按整幅截图的绝对像素解释
    --pixels            目标点是绝对像素（不是 0..1）
    --hand <left|right> 哪只手（默认 right）
    --eye <auto|left|right>
                        双眼并排时用哪只眼（默认 auto：按目标 x 落在左/右半自动选）
    --layout <auto|sbs|mono>
                        截图布局（默认 auto：按左右两半相似度自动判断）
    --fov <deg>         水平视场角（默认 90；未真机标定）
    --yaw-offset <deg>  标定偏移：加到算出的 yaw 上（默认 0；真机实测后填）
    --pitch-offset <deg>
                        标定偏移：加到算出的 hand pitch 上（默认 0；真机实测后填）

差异模式（点击后画面是否变化）：
  node tools/aim-lab.mjs --diff <前图> <后图> [选项]

    --region x,y,w,h    只比较该区域（默认整幅）
    --threshold <ratio> 差异比阈值（默认 ${AIM_DEFAULTS.threshold}，即 0.05%）
    --step <n>          采样步长（默认 1；>1 更快但可能漏掉小改动）
    --tolerance <n>     单通道差 <= n 视为未变（默认 0，抗渲染噪声）

通用：
  --player-dir <路径>   玩家工程根目录 / player 目录 / png.mjs 文件（默认自动探测）
                        （也认环境变量 VPLAY_PLAYER_DIR；源码目录没有 player/ 是正常的）
  --help, -h            显示本帮助

示例（在插件目录运行；shots/live/ 会自动去兄弟工程 vrchat-vr-driver 下找）：
  node tools/aim-lab.mjs --png shots/live/20-quickmenu-open.png --target 0.8,0.9
  node tools/aim-lab.mjs --diff shots/live/20-quickmenu-open.png shots/live/21-dashboard-hidden.png

说明：所有输出都是 JSON（stdout）；未真机标定的假设原样列在 unverified 里。`;

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseNumbers(text, count, label) {
  const parts = String(text).split(',').map((part) => part.trim());
  if (parts.length !== count) throw new Error(`${label} 需要 ${count} 个逗号分隔的数字，收到 "${text}"`);
  const numbers = parts.map((part) => Number(part));
  if (!numbers.every(Number.isFinite)) throw new Error(`${label} 里有非数字："${text}"`);
  return numbers;
}

function parseArgs(argv) {
  const opts = {
    mode: 'none',
    help: false,
    png: '',
    target: null,
    pixels: false,
    hand: 'right',
    eye: 'auto',
    layout: 'auto',
    fovDeg: AIM_DEFAULTS.fovDeg,
    yawOffsetDeg: 0,
    pitchOffsetDeg: 0,
    diff: null,
    region: null,
    threshold: AIM_DEFAULTS.threshold,
    step: 1,
    tolerance: 0,
    playerDir: process.env.VPLAY_PLAYER_DIR || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let key = arg;
    let inline = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      key = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const next = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`参数 ${key} 缺少值`);
      return argv[i];
    };
    switch (key) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--png':
        opts.png = next();
        opts.mode = 'image';
        break;
      case '--target':
        opts.target = parseNumbers(next(), 2, '--target');
        break;
      case '--pixels':
        opts.pixels = true;
        break;
      case '--hand': {
        const hand = next();
        if (hand !== 'left' && hand !== 'right') throw new Error('--hand 只能是 left 或 right');
        opts.hand = hand;
        break;
      }
      case '--eye': {
        const eye = next();
        if (eye !== 'auto' && eye !== 'left' && eye !== 'right') throw new Error('--eye 只能是 auto/left/right');
        opts.eye = eye;
        break;
      }
      case '--layout': {
        const layout = next();
        if (layout !== 'auto' && layout !== 'sbs' && layout !== 'mono') throw new Error('--layout 只能是 auto/sbs/mono');
        opts.layout = layout;
        break;
      }
      case '--fov':
        opts.fovDeg = Number(next());
        if (!Number.isFinite(opts.fovDeg) || opts.fovDeg <= 0 || opts.fovDeg >= 180) {
          throw new Error('--fov 需要在 (0,180) 度之间');
        }
        break;
      case '--yaw-offset':
        opts.yawOffsetDeg = Number(next());
        if (!Number.isFinite(opts.yawOffsetDeg) || Math.abs(opts.yawOffsetDeg) > 90) {
          throw new Error('--yaw-offset 需要在 -90..90 度之间');
        }
        break;
      case '--pitch-offset':
        opts.pitchOffsetDeg = Number(next());
        if (!Number.isFinite(opts.pitchOffsetDeg) || Math.abs(opts.pitchOffsetDeg) > 90) {
          throw new Error('--pitch-offset 需要在 -90..90 度之间');
        }
        break;
      case '--diff':
        opts.diff = [next(), next()];
        opts.mode = 'diff';
        break;
      case '--region':
        opts.region = parseNumbers(next(), 4, '--region');
        break;
      case '--threshold':
        opts.threshold = Number(next());
        if (!Number.isFinite(opts.threshold) || opts.threshold < 0 || opts.threshold > 1) {
          throw new Error('--threshold 需要在 0..1 之间');
        }
        break;
      case '--step':
        opts.step = Number(next());
        if (!Number.isInteger(opts.step) || opts.step < 1) throw new Error('--step 必须是 >=1 的整数');
        break;
      case '--tolerance':
        opts.tolerance = Number(next());
        if (!Number.isFinite(opts.tolerance) || opts.tolerance < 0 || opts.tolerance > 255) {
          throw new Error('--tolerance 需要在 0..255 之间');
        }
        break;
      case '--player-dir':
        opts.playerDir = next();
        break;
      default:
        throw new Error(`未知参数：${arg}（--help 看用法）`);
    }
  }
  if (!opts.help) {
    if (opts.mode === 'none') throw new Error('需要 --png <图片> 或 --diff <前图> <后图>（--help 看用法）');
    if (opts.mode === 'image' && !opts.png) throw new Error('--png 缺少图片路径');
    if (opts.mode === 'diff' && (!opts.diff || !opts.diff[0] || !opts.diff[1])) {
      throw new Error('--diff 需要两张图片路径');
    }
  }
  return opts;
}

// ── 图片路径 / PNG 解码器探测 ────────────────────────────────────────────────

/** 相对路径先按 cwd 找，找不到再去兄弟工程 vrchat-vr-driver 下找（方便 --png shots/live/xx.png）。 */
function resolveImagePath(file) {
  const direct = isAbsolute(file) ? file : resolve(file);
  if (existsSync(direct)) return direct;
  const sibling = resolve(PLUGIN_DIR, '..', 'vrchat-vr-driver', file);
  if (existsSync(sibling)) return sibling;
  const legacy = resolve(LEGACY_PLAYER_DIR, file);
  if (existsSync(legacy)) return legacy;
  throw new Error(`找不到图片：${file}（已尝试 ${direct} / ${sibling}）`);
}

/**
 * 动态探测 PNG 解码器（player/src/perception/png.mjs）。
 * 候选顺序与 lib/player-process.mjs 的 resolvePlayerPaths 一致：
 *   显式 --player-dir / VPLAY_PLAYER_DIR → 插件自包含包(plugin/player) → 兄弟工程 → 旧路径。
 * @returns {Promise<{decodePng:Function, path:string, source:string, tried:string[]}>}
 */
async function loadPngDecoder(playerDirOption) {
  const candidates = [];
  const seen = new Set();
  const push = (file, source) => {
    const full = resolve(file);
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: full, source });
  };
  if (playerDirOption) {
    const p = resolve(playerDirOption);
    if (/\.mjs$/i.test(p)) {
      push(p, 'player-dir');
    } else {
      push(join(p, 'player', 'src', 'perception', 'png.mjs'), 'player-dir'); // 仓库根
      push(join(p, 'src', 'perception', 'png.mjs'), 'player-dir');           // player 目录
    }
  }
  push(join(PLUGIN_DIR, 'player', 'src', 'perception', 'png.mjs'), 'plugin'); // 自包含发布包
  push(join(PLUGIN_DIR, '..', 'vrchat-vr-driver', 'player', 'src', 'perception', 'png.mjs'), 'sibling');
  push(join(LEGACY_PLAYER_DIR, 'player', 'src', 'perception', 'png.mjs'), 'legacy');

  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate.path);
    if (!existsSync(candidate.path)) continue;
    try {
      const module = await import(pathToFileURL(candidate.path).href);
      if (typeof module.decodePng === 'function') {
        return { decodePng: module.decodePng, path: candidate.path, source: candidate.source, tried };
      }
      tried[tried.length - 1] = `${candidate.path}（没有导出 decodePng）`;
    } catch (error) {
      tried[tried.length - 1] = `${candidate.path}（import 失败：${error?.message ?? error}）`;
    }
  }
  throw new Error(`找不到可用的 PNG 解码器 player/src/perception/png.mjs，已尝试：\n${tried.join('\n')}`);
}

function decodeFile(file, decodePng) {
  const absolute = resolveImagePath(file);
  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch (error) {
    throw new Error(`读取图片失败：${absolute}（${error?.message ?? error}）`);
  }
  let decoded;
  try {
    decoded = decodePng(buffer);
  } catch (error) {
    throw new Error(`PNG 解码失败：${absolute}（${error?.message ?? error}；本工具只支持 8-bit 非隔行 PNG）`);
  }
  return { absolute, decoded };
}

// ── 布局判断（启发式）──────────────────────────────────────────────────────

/** 左右两半的平均亮度差（0..255，越小越像双眼并排的立体图）。 */
function halfSad(decoded) {
  const { width, height, data } = decoded;
  const half = Math.floor(width / 2);
  if (half < 8 || height < 8) return null;
  const stepX = Math.max(2, Math.floor(half / 80));
  const stepY = Math.max(2, Math.floor(height / 45));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < half; x += stepX) {
      const i = (y * width + x) * 4;
      const j = (y * width + x + half) * 4;
      const l1 = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const l2 = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      sum += Math.abs(l1 - l2);
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

/** 判断布局：auto 用左右两半相似度；显式 --layout 直接采用。 */
function resolveLayout(decoded, requested) {
  if (requested === 'sbs' || requested === 'mono') {
    return {
      type: requested === 'sbs' ? 'side-by-side' : 'mono',
      detected: false,
      sad: halfSad(decoded),
      reason: `--layout ${requested} 显式指定`,
    };
  }
  const sad = halfSad(decoded);
  if (sad === null) {
    return { type: 'mono', detected: true, sad, reason: '图像太窄，无法按双眼并排处理，退回 mono' };
  }
  if (sad <= SBS_SAD_THRESHOLD) {
    return {
      type: 'side-by-side',
      detected: true,
      sad,
      reason: `左右两半平均亮度差 ${sad.toFixed(1)} <= ${SBS_SAD_THRESHOLD}，按 SBS 双眼图处理（启发式）`,
    };
  }
  return {
    type: 'mono',
    detected: true,
    sad,
    reason: `左右两半平均亮度差 ${sad.toFixed(1)} > ${SBS_SAD_THRESHOLD}，按单幅图处理（启发式）`,
  };
}

// ── 单图模式 ────────────────────────────────────────────────────────────────

function runImageMode(opts, decodedInfo, decoderInfo) {
  const { absolute, decoded } = decodedInfo;
  const layout = resolveLayout(decoded, opts.layout);
  const isSbs = layout.type === 'side-by-side';

  const targetInput = opts.target ?? [0.5, 0.5]; // 默认画面中心
  const [targetAX, targetAY] = targetInput;
  let fullPixel;
  if (opts.pixels) {
    fullPixel = { x: targetAX, y: targetAY };
  } else {
    if (targetAX < 0 || targetAX > 1 || targetAY < 0 || targetAY > 1) {
      throw new Error('--target 归一化坐标必须在 0..1；绝对像素请加 --pixels');
    }
    fullPixel = { x: targetAX * decoded.width, y: targetAY * decoded.height };
  }

  let view;
  let eyePixel;
  let eye = null;
  if (isSbs) {
    const mapped = mapImagePointToEye({
      x: fullPixel.x,
      y: fullPixel.y,
      width: decoded.width,
      height: decoded.height,
      eye: opts.eye,
    });
    eye = mapped.eye;
    view = { width: mapped.rect.width, height: mapped.rect.height };
    eyePixel = mapped.pixel;
    if (eyePixel.x < 0 || eyePixel.x > view.width - 1 || eyePixel.y < 0 || eyePixel.y > view.height - 1) {
      throw new Error(`目标点不在 ${mapped.eye} 眼视图内（整图像素 x=${fullPixel.x.toFixed(1)}）；`
        + '检查 --target / --eye，或改用 --layout mono');
    }
  } else {
    view = { width: decoded.width, height: decoded.height };
    eyePixel = { x: fullPixel.x, y: fullPixel.y };
  }

  const angles = pixelToAngles({
    px: eyePixel.x,
    py: eyePixel.y,
    width: view.width,
    height: view.height,
    fovDeg: opts.fovDeg,
    axis: 'hand',
    yawOffsetDeg: opts.yawOffsetDeg,
    pitchOffsetDeg: opts.pitchOffsetDeg,
  });
  const aim = handAimFromTarget({
    target: eyePixel,
    width: view.width,
    height: view.height,
    fovDeg: opts.fovDeg,
    hand: opts.hand,
    yawOffsetDeg: opts.yawOffsetDeg,
    pitchOffsetDeg: opts.pitchOffsetDeg,
  });

  const notes = [];
  if (isSbs) {
    notes.push(`真实 Headset Window 截图是双眼并排：整图 ${decoded.width}×${decoded.height}，`
      + `单眼 ${view.width}×${view.height}；fx=${angles.fx.toFixed(3)}（按单眼宽算，别用整图宽）`);
  } else {
    notes.push('该图按单幅处理（07-click.png 这类 dashboard 桌面截图就是单幅）：像素→角度只是近似参考，不是头显双眼映射');
  }
  notes.push('FOV/手部激光方向/静止位姿均未真机标定，详见 unverified 与 docs/C-瞄准方案.md');

  return {
    ok: true,
    mode: 'image',
    file: absolute,
    decoder: { path: decoderInfo.path, source: decoderInfo.source },
    image: {
      width: decoded.width,
      height: decoded.height,
      layout: {
        type: layout.type,
        detected: layout.detected,
        sad: layout.sad === null ? null : Number(layout.sad.toFixed(2)),
        reason: layout.reason,
      },
    },
    target: {
      input: opts.pixels
        ? { x: targetAX, y: targetAY, unit: 'pixel' }
        : { x: targetAX, y: targetAY, unit: 'normalized' },
      fullImagePixel: { x: Number(fullPixel.x.toFixed(2)), y: Number(fullPixel.y.toFixed(2)) },
      eye,
      eyePixel: { x: Number(eyePixel.x.toFixed(2)), y: Number(eyePixel.y.toFixed(2)) },
    },
    view: {
      width: view.width,
      height: view.height,
      fovDeg: opts.fovDeg,
      fxPixels: Number(angles.fx.toFixed(3)),
      fyPixels: Number(angles.fy.toFixed(3)),
    },
    calibration: {
      yawOffsetDeg: angles.offset.yawDeg,
      pitchOffsetDeg: angles.offset.pitchDeg,
      note: '真机标定后把偏移填进 --yaw-offset/--pitch-offset（或代码默认），默认 0 = 未标定',
    },
    hand: opts.hand,
    angles: {
      yawDeg: Number(angles.yawDeg.toFixed(4)),
      pitchDeg: Number(angles.pitchDeg.toFixed(4)),
      pitchUpDeg: Number(angles.pitchUpDeg.toFixed(4)),
      raw: {
        yawDeg: Number(angles.raw.yawDeg.toFixed(4)),
        pitchDeg: Number(angles.raw.pitchDeg.toFixed(4)),
      },
      clamped: angles.clamped,
      convention: 'yaw+ 右；hand pitch+ 下（head pitch+ 上）',
    },
    poseInput: {
      hand: aim.hand,
      target: aim.target,
      rotation: aim.rotation,
      note: '可直接作为 vrchat_pose 的入参（只转不移动，moveMode=rotate）',
    },
    restPose: aim.restPose,
    warnings: aim.warnings,
    notes,
    unverified: UNVERIFIED_ASSUMPTIONS,
  };
}

// ── 差异模式 ────────────────────────────────────────────────────────────────

function runDiffMode(opts, fileA, fileB, decoderInfo) {
  const a = decodeFile(fileA, decoderInfo.decodePng);
  const b = decodeFile(fileB, decoderInfo.decodePng);
  if (a.decoded.width !== b.decoded.width || a.decoded.height !== b.decoded.height) {
    throw new Error(`两张图尺寸不同：${a.decoded.width}×${a.decoded.height} vs ${b.decoded.width}×${b.decoded.height}`);
  }
  const region = opts.region
    ? { x: opts.region[0], y: opts.region[1], width: opts.region[2], height: opts.region[3] }
    : undefined;
  const sigA = frameSignature(a.decoded.data, {
    width: a.decoded.width,
    height: a.decoded.height,
    region,
    step: opts.step,
  });
  const sigB = frameSignature(b.decoded.data, {
    width: b.decoded.width,
    height: b.decoded.height,
    region,
    step: opts.step,
  });
  const diff = framesDiffer(sigA, sigB, {
    threshold: opts.threshold,
    minChangedPixels: 1,
    tolerance: opts.tolerance,
  });
  return {
    ok: true,
    mode: 'diff',
    fileA: a.absolute,
    fileB: b.absolute,
    decoder: { path: decoderInfo.path, source: decoderInfo.source },
    image: { width: a.decoded.width, height: a.decoded.height },
    signatures: {
      a: { hash: sigA.hash, hashHex: sigA.hashHex, sampleCount: sigA.sampleCount },
      b: { hash: sigB.hash, hashHex: sigB.hashHex, sampleCount: sigB.sampleCount },
    },
    region: diff.region,
    step: diff.step,
    totalPixels: diff.totalPixels,
    changedPixels: diff.changedPixels,
    diffRatio: Number(diff.diffRatio.toFixed(6)),
    diffRatioPct: Number(diff.diffRatioPct.toFixed(4)),
    meanAbsDiff: Number(diff.meanAbsDiff.toFixed(3)),
    threshold: diff.threshold,
    tolerance: diff.tolerance,
    differ: diff.differ,
    identical: diff.identical,
    notes: [
      'differ=true 只表示比较区域内的像素变了；点击后菜单动画/激光闪烁也会让画面变化，'
        + '要用"点击前基线 + 多次重复 + 固定区域"来降低误判',
      '阈值/区域未真机标定，先用 --threshold 0 观察 changedPixels 再定值',
    ],
  };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const decoderInfo = await loadPngDecoder(opts.playerDir);
  let report;
  if (opts.mode === 'image') {
    const decodedInfo = decodeFile(opts.png, decoderInfo.decodePng);
    report = runImageMode(opts, decodedInfo, decoderInfo);
  } else {
    report = runDiffMode(opts, opts.diff[0], opts.diff[1], decoderInfo);
  }
  // planClickSequence 是给真机脚本用的（这里只在单图模式附上，方便直接抄参数）
  if (opts.mode === 'image') {
    const plan = planClickSequence({
      target: report.target.eyePixel,
      width: report.view.width,
      height: report.view.height,
      fovDeg: opts.fovDeg,
      hand: opts.hand,
      yawOffsetDeg: opts.yawOffsetDeg,
      pitchOffsetDeg: opts.pitchOffsetDeg,
    });
    report.clickPlan = plan.steps;
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

try {
  const code = await main();
  if (code !== 0) process.exitCode = code;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
}
