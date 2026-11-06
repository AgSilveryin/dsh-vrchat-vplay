// run-tests.mjs — 一次跑完插件仓库的全部离线测试（CI 与本地共用）
// 用法：node tools/run-tests.mjs
// 覆盖：插件离线 / OSC / 工具集 / MCP / daemon / 瞄准 / 激光 / 3D 几何 / 体检 / 启动 / 虚拟手柄 / 面板 / 玩家编排 / 手部 / 转头 / 拟人 / 头部
// 说明：全部离线、不需要 VRChat/SteamVR（test_head 只用假 UDP 收包，也不需要真头显）。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'plugin-offline-test.mjs',
  'osc-selftest.mjs',
  'test_toolset.mjs',
  'test_mcp.mjs',
  'test_vplayd.mjs',
  'test_aim.mjs',
  'test_aim3d.mjs',
  'test_laser.mjs',
  'test_doctor.mjs',
  'test_launch.mjs',
  'test_vmtinput.mjs',
  'test_panel.mjs',
  'test_player.mjs',
  'test_pose.mjs',
  'test_look.mjs',
  'test_humanize.mjs',
  'test_head.mjs',
];

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [join(HERE, file)], { stdio: 'inherit', env: process.env });
  child.on('error', (error) => resolve({ file, code: 1, ms: Date.now() - started, error: String(error?.message ?? error) }));
  child.on('exit', (code, signal) => resolve({ file, code: code === null ? 1 : code, ms: Date.now() - started, signal }));
});

const results = [];
for (const file of SUITES) {
  console.log(`\n──────── ${file} ────────`);
  const result = await run(file);
  results.push(result);
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'}  ${file}  (${(result.ms / 1000).toFixed(1)}s)`);
}

const failed = results.filter((result) => result.code !== 0);
const totalMs = results.reduce((sum, result) => sum + result.ms, 0);
console.log('\n════════ 汇总 ════════');
for (const result of results) {
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'}  ${result.file}  ${(result.ms / 1000).toFixed(1)}s`);
}
console.log(`\n${results.length - failed.length}/${results.length} 套通过，用时 ${(totalMs / 1000).toFixed(1)}s`);
if (failed.length > 0) {
  console.error(`失败：${failed.map((result) => result.file).join(', ')}`);
  process.exit(1);
}
