// test_toolset.mjs — host-shim 离线门禁：验证脱离 DSH 宿主后 19 个工具定义可用、生命周期干净。
//
// 覆盖：
//   1. apply() 被假宿主调用后恰好捕获 19 个工具，名称与插件注册表一致；
//   2. 每个工具都有 description / JSON-Schema parameters / execute；
//   3. vrchat_status 在隔离端口上真实可用（listening 端口可探测）；
//   4. vrchat_screenshot 在没有 SteamVR 时优雅降级（不抛异常，ok:false）；
//   5. 附件 saveImage：落盘 + base64 可读，cleanup 删目录；
//   6. 未知工具抛错；
//   7. dispose 幂等，且释放 UDP 监听（同端口可再次 bind）与临时附件目录。
import { createSocket } from 'node:dgram';
import { existsSync, statSync } from 'node:fs';
import { createToolset } from '../lib/host-shim.mjs';

const EXPECTED_TOOLS = [
  'vrchat_status',
  'vrchat_say',
  'vrchat_list_params',
  'vrchat_events',
  'vrchat_wait',
  'vrchat_set_param',
  'vrchat_input',
  'vrchat_move',
  'vrchat_pose',
  'vrchat_head',
  'vrchat_look',
  'vrchat_player',
  'vrchat_player_preflight',
  'vrchat_doctor',
  'vrchat_mode',
  'vrchat_ui',
  'vrchat_screenshot',
  'vrchat_drivers',
  'vrchat_osc_send',
];

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000, stepMs = 50) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(stepMs);
  }
}

/** 检查某个 UDP 端口是否还能被独立 bind（用来证明 dispose 真的释放了监听）。 */
function canBindUdp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4' });
    socket.once('error', () => resolve(false));
    socket.bind(port, host, () => socket.close(() => resolve(true)));
  });
}

const BASE_PORT = 19040 + Math.floor(Math.random() * 40);

// ── 1) 工具注册面 ────────────────────────────────────────────────────────────
const toolset = createToolset({
  config: {
    listenEnabled: true,
    listenPort: BASE_PORT,
    sendPort: BASE_PORT + 1,
    panelEnabled: false,
    playerDir: '',
  },
  logger: quietLogger,
});

console.log(`tools captured: ${toolset.tools.size}`);
check('19 个工具全部注册', toolset.tools.size === 19, `got ${toolset.tools.size}`);
check('工具名称与插件注册表一致', JSON.stringify([...toolset.tools.keys()].sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()));

let shapeOk = true;
const shapeDetail = [];
for (const tool of toolset.list()) {
  if (typeof tool.description !== 'string' || tool.description.length < 10) { shapeOk = false; shapeDetail.push(`${tool.name}.description`); }
  if (tool.parameters === null || typeof tool.parameters !== 'object' || tool.parameters.type !== 'object') { shapeOk = false; shapeDetail.push(`${tool.name}.parameters`); }
  if (typeof tool.execute !== 'function') { shapeOk = false; shapeDetail.push(`${tool.name}.execute`); }
}
check('每个工具有 description / parameters(type=object) / execute', shapeOk, shapeDetail.join(','));

// ── 2) 真实调用：vrchat_status（隔离端口）────────────────────────────────────
const listeningOk = await waitFor(async () => {
  const state = await toolset.call('vrchat_status');
  return state.listening === true;
}, 5000);
const status = await toolset.call('vrchat_status');
check('bridge 在隔离端口真实监听', listeningOk, `listening=${status.listening} listenError=${status.listenError}`);
check('vrchat_status 返回配置端口', status.listenPort === BASE_PORT && status.sendPort === BASE_PORT + 1, `got ${status.listenPort}/${status.sendPort}`);
check('vrchat_status 含 pose/head/look 分区', 'pose' in status && 'head' in status && 'look' in status);

// ── 3) 截图在无 SteamVR 时优雅降级 ───────────────────────────────────────────
const shot = await toolset.call('vrchat_screenshot');
check('vrchat_screenshot 无 SteamVR 时 ok:false 不抛', shot.ok === false && typeof shot.error === 'string' && shot.error.length > 0, JSON.stringify(shot).slice(0, 160));
check('截图失败时不产生附件', shot.image === null || shot.image === undefined);

// ── 4) 未知工具 ───────────────────────────────────────────────────────────────
let unknownThrew = false;
try {
  await toolset.call('vrchat_not_a_tool');
} catch (error) {
  unknownThrew = /unknown tool/.test(String(error?.message ?? error));
}
check('未知工具抛 unknown tool 错误', unknownThrew);

// ── 5) 附件：写盘 + base64 + 清理 ────────────────────────────────────────────
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG magic，只为验证落盘/编码，不是完整图片
const saved = await toolset.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'probe.png' });
check('saveImage 落盘', existsSync(saved.path) && statSync(saved.path).size === png.length);
check('saveImage 返回 base64', Buffer.from(saved.data, 'base64').equals(png));
check('saveImage 返回 mediaType', saved.mediaType === 'image/png');
const attachmentDir = toolset.attachments.dir;

// ── 6) dispose：幂等 + 释放监听端口 + 清理附件目录 ───────────────────────────
toolset.dispose();
toolset.dispose();
check('dispose 幂等（调用两次不抛）', true);
const released = await waitFor(() => canBindUdp(BASE_PORT), 3000);
check('dispose 释放 UDP 监听端口', released);
check('dispose 清理临时附件目录', !existsSync(attachmentDir), attachmentDir);

// ── 7) 释放后同一端口可以重新建 toolset ──────────────────────────────────────
const again = createToolset({
  config: { listenEnabled: true, listenPort: BASE_PORT, sendPort: BASE_PORT + 1, panelEnabled: false, playerDir: '' },
  logger: quietLogger,
});
const relistenOk = await waitFor(async () => (await again.call('vrchat_status')).listening === true, 5000);
check('释放后同端口可重新监听', relistenOk);
again.dispose();

console.log(`\n${failed === 0 ? `${passed} offline host-shim checks passed` : `${failed} FAILED / ${passed + failed} checks`}`);
process.exit(failed === 0 ? 0 : 1);
