// aim-hover.mjs — C 线：用"悬停高亮"找菜单项并点击（不依赖逐帧激光检测，更稳）。
//
// 思路（2026-11-04 真机验证过的菜单行为）：
//   * 快捷菜单（B 短按）开关会整块出现在左手附近；用"深蓝导航面板"像素比例检测开/关；
//   * 激光指到可交互项时该项高亮/放大 → 菜单区域相对"激光指别处"的基线会多出一块变化；
//   * 网格扫描右手 yaw/pitch，取菜单区域变化最大的位姿 → 点击 → 截图验证菜单内容大改。
//
// 用法：
//   node tools/aim-hover.mjs --scan                       # 扫描找悬停位姿（会保证菜单打开）
//   node tools/aim-hover.mjs --click --pose -20,10        # 用指定位姿点一次，打印前后差异
//   node tools/aim-hover.mjs --repeat 5 --pose -20,10     # 连续 5 次：开菜单→摆位→点→验证→关菜单
// 参数：--head-pitch -25、--eye right、--region x0,y0,x1,y1（单眼坐标，默认菜单区域 120,330,500,540）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createToolset } from '../lib/host-shim.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);
const num = (name, fallback) => { const v = Number(flag(name, NaN)); return Number.isFinite(v) ? v : fallback; };

const HEAD_PITCH = num('--head-pitch', -25);
const EYE = flag('--eye', 'right');
const REGION = (flag('--region', '150,410,480,540')).split(',').map(Number);
const EVIDENCE_DIR = resolve(flag('--evidence-dir', join(ROOT, '..', 'vrchat-vr-driver', 'shots', 'live')));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync(EVIDENCE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ts = createToolset({
  config: { panelEnabled: false, listenEnabled: false, headHumanize: false, headIdleDrift: false, poseHumanize: false, poseIdleDrift: false },
  logger: quiet,
});
const decoder = await import(pathToFileURL(join(ROOT, '..', 'vrchat-vr-driver', 'player', 'src', 'perception', 'png.mjs')).href);
const evidence = { stamp: STAMP, headPitch: HEAD_PITCH, region: REGION, menuOpen: null, steps: [] };

let shotSeq = 0;
async function capture(tag) {
  const r = await ts.call('vrchat_screenshot');
  if (r.ok !== true) return { ok: false, error: r.error };
  const png = Buffer.from(r.image?.data ?? '', 'base64');
  const seq = String(++shotSeq).padStart(2, '0');
  const path = join(EVIDENCE_DIR, `aim-hover-${STAMP}-${seq}-${tag}.png`);
  writeFileSync(path, png);
  const img = decoder.decodePng(png);
  return { ok: true, path, width: img.width, height: img.height, data: img.data };
}
function eyeOffset(width) { return width >= 1180 ? (EYE === 'left' ? 0 : Math.floor(width / 2)) : 0; }
function regionStats(img, region, predicate) {
  const offsetX = eyeOffset(img.width);
  const [x0, y0, x1, y1] = region;
  let hits = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + (x + offsetX)) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      total += 1;
      if (predicate(r, g, b)) hits += 1;
    }
  }
  return { hits, total, ratio: total > 0 ? hits / total : 0 };
}
function menuNavyRatio(img) {
  return regionStats(img, REGION, (r, g, b) => {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum < 95 && b > 35 && b > r + 8;
  }).ratio;
}
async function menuOpen() {
  const shot = await capture('state');
  if (!shot.ok) return null;
  const ratio = menuNavyRatio(shot);
  const open = ratio >= 0.1;
  evidence.menuOpen = { ratio: Number(ratio.toFixed(3)), open };
  return open;
}
async function ensureMenu(want) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await menuOpen();
    if (current === null) return false;
    if (current === want) return true;
    await ts.call('vrchat_ui', { action: 'press', button: 'b', side: 'left', durationMs: 140 });
    await sleep(1000);
  }
  return (await menuOpen()) === want;
}
function changedInRegion(a, b, width, region) {
  const offsetX = eyeOffset(width);
  const [x0, y0, x1, y1] = region;
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + (x + offsetX)) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      total += 1;
      if (d > 18) changed += 1;
    }
  }
  return { changed, total, ratio: total > 0 ? Number((changed / total).toFixed(4)) : 0 };
}
async function setHead() {
  await ts.call('vrchat_head', { target: { y: 1.6 }, rotation: { yaw: 0, pitch: HEAD_PITCH, roll: 0 }, durationMs: 250, wait: true, hold: true });
}
async function setHands(yaw, pitch) {
  await ts.call('vrchat_pose', {
    hand: 'both',
    left: { target: { x: -0.32, y: 1.3, z: 0.35 }, rotation: { yaw: 10, pitch: -20, roll: 0 } },
    right: { target: { x: 0.28, y: 1.42, z: 0.34 }, rotation: { yaw, pitch, roll: 0 } },
    durationMs: 250, wait: true, hold: true,
  });
}
/** 右手指向（左手必须一直跟随发流，否则 VMT 左手失效 → 菜单跟着左手的菜单会消失）。 */
async function setHand(yaw, pitch) {
  await setHands(yaw, pitch);
}

async function scan() {
  evidence.mode = 'scan';
  await setHead();
  const opened = await ensureMenu(true);
  console.log('菜单打开：', opened);
  if (!opened) return false;
  await setHand(-60, 0); // 激光指别处 = 基线
  await sleep(450);
  const baseline = await capture('baseline');
  if (!baseline.ok) { console.log('基线截图失败：', baseline.error); return false; }
  const rows = [];
  for (let yaw = -40; yaw <= 20; yaw += 10) {
    for (let pitch = -10; pitch <= 25; pitch += 7) {
      await setHand(yaw, pitch);
      await sleep(350);
      const shot = await capture(`scan-yaw${yaw}-pitch${pitch}`);
      if (!shot.ok) continue;
      const diff = changedInRegion(baseline.data, shot.data, shot.width, REGION);
      rows.push({ yaw, pitch, changed: diff.changed, ratio: diff.ratio, path: shot.path });
      console.log(`yaw=${String(yaw).padStart(3)} pitch=${String(pitch).padStart(3)} changed=${String(diff.changed).padStart(5)} (${(diff.ratio * 100).toFixed(2)}%)`);
    }
  }
  rows.sort((a, b) => b.changed - a.changed);
  evidence.scan = rows.slice(0, 12);
  console.log('\nTop 8：');
  for (const row of rows.slice(0, 8)) console.log(JSON.stringify(row));
  return rows[0]?.changed > 0;
}

async function clickAt(yaw, pitch, tag) {
  await setHand(yaw, pitch);
  await sleep(450);
  const before = await capture(`${tag}-before`);
  const t0 = Date.now();
  const click = await ts.call('vrchat_ui', { action: 'select' });
  await sleep(1000);
  const after = await capture(`${tag}-after`);
  const ms = Date.now() - t0;
  if (!before.ok || !after.ok) return { ok: false, error: before.error ?? after.error };
  const menuDiff = changedInRegion(before.data, after.data, before.width, REGION);
  return { ok: true, clickOk: click.ok === true, ms, menuDiff, before: before.path, after: after.path };
}

async function clickOnce(yaw, pitch) {
  evidence.mode = 'click';
  await setHead();
  await ensureMenu(true);
  const result = await clickAt(yaw, pitch, 'click');
  evidence.click = result;
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true && result.clickOk;
}

async function repeat(times, yaw, pitch) {
  evidence.mode = 'repeat';
  await setHead();
  const runs = [];
  for (let i = 1; i <= times; i += 1) {
    const t0 = Date.now();
    const opened = await ensureMenu(true);
    const result = await clickAt(yaw, pitch, `run${i}`);
    const totalMs = Date.now() - t0;
    await ensureMenu(false);
    const selected = result.ok === true && result.clickOk === true && (result.menuDiff?.ratio ?? 0) > 0.05;
    runs.push({ run: i, menuOpened: opened, totalMs, selected, ...result });
    console.log(`run ${i}: 菜单开=${opened} clickOk=${result.clickOk} 菜单区域变化=${((result.menuDiff?.ratio ?? 0) * 100).toFixed(2)}% → 选中=${selected} · 用时 ${totalMs} ms`);
  }
  evidence.runs = runs;
  const hits = runs.filter((r) => r.selected === true).length;
  evidence.hits = hits;
  evidence.timesMs = runs.map((r) => r.totalMs);
  console.log(`\n${hits}/${runs.length} 次判定选中（菜单区域变化 > 5%）`);
  return hits;
}

try {
  let ok = false;
  if (has('--scan')) ok = await scan();
  else if (has('--click')) { const [y, p] = flag('--pose', '-20,10').split(',').map(Number); ok = await clickOnce(y, p); }
  else if (has('--repeat')) { const [y, p] = flag('--pose', '-20,10').split(',').map(Number); const times = Math.max(1, Math.min(10, num('--repeat', 5))); ok = (await repeat(times, y, p)) === times; }
  else console.log('用法：--scan | --click --pose yaw,pitch | --repeat N --pose yaw,pitch');
  if (!ok) process.exitCode = 1;
} finally {
  const out = join(EVIDENCE_DIR, `aim-hover-${STAMP}-${evidence.mode ?? 'run'}.json`);
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`证据：${out}`);
  ts.dispose();
}
