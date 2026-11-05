// aim-click-accept.mjs — C 项 Phase 4 验收：连续 5 次选中同一个菜单项（截图 + 差异 + 耗时）。
//
// 真机 2026-11-05 实测的工作姿势（VRChat Home，快捷菜单打开）：
//   * 左手把菜单拿到"右手射线会穿过它"的位置：target=(-0.05,1.35,0.45)、rotation=(yaw 10,pitch -20)
//   * 右手不动，朝前：target=(0.28,1.42,0.34)、rotation=(yaw 0,pitch 0)
//   * 该姿势下扳机点击会命中快速菜单的"设置"页签 → 菜单整页切换
//   * 关菜单（B）再开（B）会回到"导航"首页 → 可以重复同一操作
//
// 每次验收：
//   1) 关菜单+开菜单（保证回到导航页）；
//   2) 截图 before；
//   3) 扳机点击；
//   4) 截图 after；
//   5) 判定：菜单区域变化比例 > 阈值（首页→设置页是大改），且 after 与第 1 次 after 相似（同一菜单项）。
//
// 用法：node tools/aim-click-accept.mjs [--runs 5] [--region 340,290,590,540] [--threshold 0.1]
// 证据写到 shots/live/aim-accept-<stamp>-*.png / .json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createToolset } from '../lib/host-shim.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const num = (name, fallback) => { const i = argv.indexOf(name); const v = Number(argv[i + 1]); return Number.isFinite(v) ? v : fallback; };
const RUNS = Math.max(1, Math.min(10, num('--runs', 5)));
const THRESHOLD = num('--threshold', 0.1);
const REGION = (argv.includes('--region') ? String(argv[argv.indexOf('--region') + 1]) : '340,290,590,540').split(',').map(Number);
const EVIDENCE_DIR = resolve(join(ROOT, '..', 'vrchat-vr-driver', 'shots', 'live'));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync(EVIDENCE_DIR, { recursive: true });

const LEFTHAND = { target: { x: -0.05, y: 1.35, z: 0.45 }, rotation: { yaw: 10, pitch: -20, roll: 0 } };
const RIGHTHAND = { target: { x: 0.28, y: 1.42, z: 0.34 }, rotation: { yaw: 0, pitch: 0, roll: 0 } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ts = createToolset({
  config: { panelEnabled: false, listenEnabled: false, headHumanize: false, headIdleDrift: false, poseHumanize: false, poseIdleDrift: false },
  logger: quiet,
});
const decoder = await import(pathToFileURL(join(ROOT, '..', 'vrchat-vr-driver', 'player', 'src', 'perception', 'png.mjs')).href);

let shotSeq = 0;
async function capture(tag) {
  const r = await ts.call('vrchat_screenshot');
  if (r.ok !== true) throw new Error(`截图失败：${r.error}`);
  const png = Buffer.from(r.image?.data ?? '', 'base64');
  const seq = String(++shotSeq).padStart(2, '0');
  const path = join(EVIDENCE_DIR, `aim-accept-${STAMP}-${seq}-${tag}.png`);
  writeFileSync(path, png);
  const img = decoder.decodePng(png);
  return { path, width: img.width, height: img.height, data: img.data };
}
function regionDiff(a, b, region) {
  const offsetX = b.width >= 1180 ? Math.floor(b.width / 2) : 0;
  const [x0, y0, x1, y1] = region;
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * b.width + (x + offsetX)) * 4;
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      total += 1;
      if (d > 18) changed += 1;
    }
  }
  return { changed, total, ratio: total > 0 ? Number((changed / total).toFixed(4)) : 0 };
}
async function pressB() {
  await ts.call('vrchat_ui', { action: 'press', button: 'b', side: 'left', durationMs: 140 });
  await sleep(900);
}
async function setPose() {
  await ts.call('vrchat_pose', { hand: 'both', left: LEFTHAND, right: RIGHTHAND, durationMs: 250, wait: true, hold: true });
  await sleep(450);
}
async function ensureMenuClosed() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pressB();
    const shot = await capture('state-closed');
    const ratio = darkPanelRatio(shot);
    if (ratio < 0.06) return true;
  }
  return false;
}
async function ensureMenuOpen() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pressB();
    const shot = await capture('state-open');
    const ratio = darkPanelRatio(shot);
    if (ratio >= 0.1) return true;
  }
  return false;
}
function darkPanelRatio(shot) {
  const offsetX = shot.width >= 1180 ? Math.floor(shot.width / 2) : 0;
  const [x0, y0, x1, y1] = REGION;
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * shot.width + (x + offsetX)) * 4;
      const r = shot.data[i], g = shot.data[i + 1], b = shot.data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      total += 1;
      if (lum < 95 && b > 35 && b > r + 8) dark += 1;
    }
  }
  return total > 0 ? dark / total : 0;
}

const evidence = { stamp: STAMP, region: REGION, threshold: THRESHOLD, leftHand: LEFTHAND, rightHand: RIGHTHAND, runs: [], passed: 0, failed: 0 };
try {
  await ts.call('vrchat_head', { target: { y: 1.6 }, rotation: { yaw: 0, pitch: -25, roll: 0 }, durationMs: 250, wait: true, hold: true });
  await setPose();
  let firstAfter = null;
  for (let run = 1; run <= RUNS; run += 1) {
    const t0 = Date.now();
    const closed = await ensureMenuClosed();
    await setPose();
    const open = await ensureMenuOpen();
    await setPose();
    const before = await capture(`run${run}-before`);
    const click = await ts.call('vrchat_ui', { action: 'select' });
    await sleep(1000);
    const after = await capture(`run${run}-after`);
    const ms = Date.now() - t0;
    const diff = regionDiff(before, after, REGION);
    const sameAsFirst = firstAfter === null ? null : regionDiff(firstAfter, after, [REGION[0], REGION[1], REGION[2], REGION[3]]);
    if (firstAfter === null) firstAfter = after;
    const hit = diff.ratio >= THRESHOLD;
    const sameItem = sameAsFirst === null ? true : sameAsFirst.ratio <= 0.08;
    const selected = hit && sameItem;
    evidence.runs.push({ run, closed, open, clickOk: click.ok === true, ms, menuDiff: diff, sameAsFirst, hit, sameItem, selected, before: before.path, after: after.path });
    if (selected) evidence.passed += 1; else evidence.failed += 1;
    console.log(`run ${run}: 菜单关=${closed} 开=${open} click=${click.ok === true} 首页→菜单项差异=${(diff.ratio * 100).toFixed(1)}% 与第1次after差异=${sameAsFirst === null ? '-' : `${(sameAsFirst.ratio * 100).toFixed(1)}%`} → 选中=${selected} · 用时 ${ms} ms`);
    if (!closed || !open) console.log(`  提示：第 ${run} 次菜单状态没对齐，后续结果不可信`);
  }
  evidence.finishedAt = new Date().toISOString();
  const times = evidence.runs.map((r) => r.ms);
  evidence.timesMs = times;
  evidence.avgMs = Math.round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length));
  console.log(`\n结果：${evidence.passed}/${RUNS} 次选中同一个菜单项 · 平均用时 ${evidence.avgMs} ms`);
} finally {
  const out = join(EVIDENCE_DIR, `aim-accept-${STAMP}.json`);
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`证据：${out}`);
  ts.dispose();
}
process.exit(evidence.passed === RUNS ? 0 : 1);
