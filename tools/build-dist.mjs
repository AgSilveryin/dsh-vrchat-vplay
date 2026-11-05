// build-dist.mjs — 打自包含发布包：插件本体 + 配套 player/（真感知/导航/3D 监视器）。
//
// 为什么不是直接 npm pack：
//   * 开发期 player/ 在兄弟仓库 D:\中转站API\vrchat-vr-driver\player，不在插件目录里；
//   * 直接 pack 出来的包只含 OSC 桥，装到别人机器上 vrchat_player 会报 "demo not found"。
// 所以这里先在 tmp/dist-staging 里拼一棵"自包含"的树（插件 + player/），再从那里 pack。
//
// 用法：
//   node tools/build-dist.mjs                       # 打包到 <repo>/../../dist
//   node tools/build-dist.mjs --out D:\somewhere    # 指定输出目录
//   node tools/build-dist.mjs --src D:\...\vrchat-vr-driver\player   # 指定 player 源
//   node tools/build-dist.mjs --keep-staging        # 保留暂存树（排查用）
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, cpSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const keepStaging = argv.includes('--keep-staging');

const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '0.0.0');
const outDir = resolve(flagValue('--out', join(PLUGIN_DIR, '..', 'dist')));
const playerSrc = resolve(flagValue('--src', join(PLUGIN_DIR, '..', 'vrchat-vr-driver', 'player')));
const stagingRoot = join(PLUGIN_DIR, 'tmp', 'dist-staging');
const staging = join(stagingRoot, 'package');

if (!existsSync(join(playerSrc, 'demo.mjs'))) {
  console.error(`[build-dist] player 源不存在或没有 demo.mjs：${playerSrc}`);
  console.error('           用 --src <vrchat-vr-driver/player> 指过去，或先把配套工程放到插件同级目录。');
  process.exit(2);
}

console.log(`[build-dist] plugin  ${PLUGIN_DIR}`);
console.log(`[build-dist] player  ${playerSrc}`);
console.log(`[build-dist] out     ${outDir}`);

// ── 1. 清空并重建暂存树 ────────────────────────────────────────────────────
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const copyFile = (rel, required = true) => {
  const from = join(PLUGIN_DIR, rel);
  if (!existsSync(from)) {
    if (required) throw new Error(`[build-dist] 缺少文件：${rel}`);
    return;
  }
  const to = join(staging, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

for (const rel of [
  'index.js',
  'lib',
  'mcp',
  'locale',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'AUP.md',
  'LICENSE',
  'docs',
  'drivers',
]) {
  copyFile(rel);
}

// 内部待办（docs/发布待办.md）会含开发机路径与未决项，绝不进发布包。
rmSync(join(staging, 'docs', '发布待办.md'), { force: true });

// 独立 daemon + 真机瞄准工具随包（tools/ 里其余是开发/测试脚本，不随包）。
copyFile('tools/vplayd.mjs');
copyFile('tools/aim-servo.mjs');
copyFile('tools/aim-lab.mjs');
copyFile('tools/aim-hover.mjs');
copyFile('tools/aim-click-accept.mjs');

// ── 2. 拷 player/（运行时必需；开发/测试产物排除）───────────────────────────
const PLAYER_EXCLUDE = new Set(['tests', 'tmp', 'node_modules', '.selftest-recordings', 'shots']);
cpSync(playerSrc, join(staging, 'player'), {
  recursive: true,
  filter: (src) => {
    const name = basename(src);
    if (PLAYER_EXCLUDE.has(name)) return false;
    // 开发残留（monitor/_*.log、_capture.mjs、_disconnect_demo.mjs、_*.png 等）不进发布包。
    if (name.startsWith('_')) return false;
    if (src.includes(`${join('monitor', 'recordings')}`)) return false;
    // 截图/录像等开发产物不进发布包（包内没有任何运行时需要的图片）
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return false;
    return true;
  },
});

// ── 3. 生成自包含的 package.json ───────────────────────────────────────────
const stagedPkg = {
  ...pkg,
  description:
    'Self-contained VRChat OSC bridge + virtual player for DeepSeek Harness: talk through the chatbox, sense avatar '
    + 'parameters, drive OSC input actions, move hand poses through a VMT driver, control head/body pose through the '
    + 'A-line HMD driver, and run the bundled Phase 1 virtual player (perception, A* nav, 3D skeleton monitor).',
  files: [
    'index.js',
    'lib',
    'mcp',
    'player',
    'drivers',
    'cordis.patch.yml',
    'locale/*.json',
    'icon.svg',
    'README.md',
    'AUP.md',
    'LICENSE',
    'docs',
    'tools/vplayd.mjs',
    'tools/aim-servo.mjs',
    'tools/aim-lab.mjs',
    'tools/aim-hover.mjs',
    'tools/aim-click-accept.mjs',
  ],
  scripts: { test: 'node tools/plugin-offline-test.mjs' },
};
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`, 'utf8');

// ── 4. 自检暂存树（缺一个就跑不起来）──────────────────────────────────────
const required = [
  'index.js',
  'lib/doctor.mjs',
  'lib/launch.mjs',
  'lib/player-process.mjs',
  'lib/host-shim.mjs',
  'lib/aim.mjs',
  'mcp/server.mjs',
  'mcp/protocol.mjs',
  'tools/vplayd.mjs',
  'cordis.patch.yml',
  'player/demo.mjs',
  'player/src/runtime.mjs',
  'player/src/perception/index.mjs',
  'player/src/perception/sources/vision.mjs',
  'player/src/perception/sources/log.mjs',
  'player/src/nav/astar.mjs',
  'player/monitor/server.mjs',
  'player/monitor/index.html',
  'player/monitor/app.js',
  'player/maps/home.json',
  'player/tools/preflight.mjs',
  'player/tools/capture_frame.ps1',
  'drivers/install-drivers.ps1',
  'drivers/uninstall-drivers.ps1',
  'drivers/dsh_hmd/driver.vrdrivermanifest',
  'drivers/dsh_hmd/bin/win64/driver_dsh_hmd.dll',
  'drivers/vmt/driver.vrdrivermanifest',
  'drivers/vmt/bin/win64/driver_vmt.dll',
  'drivers/vmt/LICENSE',
  'drivers/vmt/3rd_licence.txt',
  'docs/MCP.md',
  'docs/DAEMON.md',
];
const missing = required.filter((rel) => !existsSync(join(staging, rel)));
if (missing.length > 0) {
  console.error(`[build-dist] 暂存树缺文件：${missing.join(', ')}`);
  process.exit(3);
}

const countFiles = (dir) => {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += 1;
    }
  };
  walk(dir);
  return total;
};
const totalFiles = countFiles(staging);
const totalBytes = (() => {
  let sum = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else sum += statSync(full).size;
    }
  };
  walk(staging);
  return sum;
})();
console.log(`[build-dist] 暂存树：${totalFiles} 个文件，${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

// ── 5. npm pack（Windows 上 npm 是 .cmd，用 cmd /c 绕开 PS 执行策略）────────
mkdirSync(outDir, { recursive: true });
const packOutput = execFileSync('cmd', ['/c', 'npm pack --json'], {
  cwd: staging,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let packInfo = null;
try {
  packInfo = JSON.parse(packOutput);
} catch {
  packInfo = null;
}
const producedName = Array.isArray(packInfo) && packInfo[0]?.filename
  ? packInfo[0].filename
  : readdirSync(staging).find((name) => name.endsWith('.tgz'));
if (!producedName) {
  console.error('[build-dist] npm pack 没有产出 tgz');
  process.exit(4);
}
const finalTgz = join(outDir, producedName);
rmSync(finalTgz, { force: true });
cpSync(join(staging, producedName), finalTgz);

const tgzBytes = statSync(finalTgz).size;
console.log(`[build-dist] ✔ ${finalTgz}  ${(tgzBytes / 1024).toFixed(1)} KB`);
if (Array.isArray(packInfo) && packInfo[0]?.files) {
  const files = packInfo[0].files.map((entry) => entry.path);
  console.log(`[build-dist] 包内 ${files.length} 个文件；player/ ${files.filter((path) => path.startsWith('player/')).length} 个`);
  for (const needle of ['index.js', 'player/demo.mjs', 'player/monitor/index.html', 'player/src/perception/sources/vision.mjs']) {
    if (!files.includes(needle)) {
      console.error(`[build-dist] 包内缺 ${needle}`);
      process.exit(5);
    }
  }
}

if (!keepStaging) {
  rmSync(stagingRoot, { recursive: true, force: true });
} else {
  console.log(`[build-dist] 暂存树保留在 ${staging}`);
}
