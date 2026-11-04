// analyze-soak.mjs — 读 soak 采样 CSV，输出 fps/RAM/录像增长摘要与泄漏判断（零依赖）。
// 用法：node tools/analyze-soak.mjs <metrics.csv>
// CSV 列：time,uptimeSec,frames,fps,ramMB,cpuSec,recFiles,recBytes,recPruned,framesPerSec
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/analyze-soak.mjs <metrics.csv>');
  process.exit(2);
}
const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
const header = lines.shift();
const rows = [];
for (const line of lines) {
  const cells = line.split(',');
  if (cells[0] === 'error') { rows.push({ error: cells.slice(1).join(',') }); continue; }
  if (cells.length < 10) continue;
  rows.push({
    time: cells[0],
    uptimeSec: Number(cells[1]),
    frames: Number(cells[2]),
    fps: Number(cells[3]),
    ramMB: Number(cells[4]),
    cpuSec: Number(cells[5]),
    recFiles: Number(cells[6]),
    recBytes: Number(cells[7]),
    recPruned: Number(cells[8]),
    measuredFps: Number(cells[9]),
  });
}
const valid = rows.filter((row) => row.error === undefined && Number.isFinite(row.fps));
if (valid.length === 0) {
  console.log('没有有效采样');
  process.exit(1);
}
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Number((sum / sorted.length).toFixed(2)),
    first: sorted[0],
    last: sorted[sorted.length - 1],
  };
};
const ram = valid.map((row) => row.ramMB);
const ramGrowth = ram[ram.length - 1] - ram[0];
const ramGrowthPct = ram[0] > 0 ? (ramGrowth / ram[0]) * 100 : 0;
const fpsStats = stats(valid.map((row) => row.fps));
const uptime = valid[valid.length - 1].uptimeSec;
const frames = valid[valid.length - 1].frames;
const recordings = valid[valid.length - 1];
const result = {
  samples: valid.length,
  spanSec: uptime,
  fps: fpsStats,
  requiredFpsOk: fpsStats.min >= 30,
  ram: { first: ram[0], last: ram[ram.length - 1], max: Math.max(...ram), growthMB: Number(ramGrowth.toFixed(1)), growthPct: Number(ramGrowthPct.toFixed(1)) },
  // HANDOFF §8-H 验收：内存 < 1.5× 启动值（无泄漏性增长）
  ramLeakOk: ram[ram.length - 1] < ram[0] * 1.5,
  recordings: { files: recordings.recFiles, bytes: recordings.recBytes, pruned: recordings.recPruned, limitFiles: 30, limitBytes: 268435456 },
  recordingLimitOk: recordings.recFiles <= 30 && recordings.recBytes <= 268435456,
  framesPerSecondAvg: uptime > 0 ? Number((frames / uptime).toFixed(2)) : null,
  errors: rows.filter((row) => row.error !== undefined).length,
};
console.log(JSON.stringify(result, null, 2));
// 判定：1 小时 soak 的机器可读结论
const pass = result.fps.avg >= 50 && result.requiredFpsOk && result.ramLeakOk && result.recordingLimitOk && result.errors === 0 && result.spanSec >= 1800;
console.log(`\nsoak 判定（>=1800s 且 fps/RAM/录像/CD 均正常）：${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
