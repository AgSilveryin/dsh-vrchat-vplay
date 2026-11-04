// test_launch.mjs — lib/launch.mjs 离线单测（node tools/test_launch.mjs，成功打印 PASS <n> checks）
//
// 全程使用注入的假 deps（假进程表 / 假注册表 / 假 spawn / 假 sleep / 假文件系统），
// **绝不启动真实 Steam / SteamVR / VRChat**，也不读真实注册表。
// 超时场景把 timeouts 设成几十毫秒，保证整体 <= 5s。
//
// 覆盖（对应 task-18 的 5 项 + 额外防御）：
//   ① 全没开 + launch:true → 按 steam→steamvr→vrchat 顺序启动，三轮询后 ok，started 长度 3
//   ② 都开着 → 不 spawn、ok:true、already 全填
//   ③ launch:false → 只探测、不 spawn
//   ④ SteamVR 起不来 → 超时（几十 ms）、failed 含 steamvr、ok:false、notes 有中文提示、不继续启 VRChat
//   ⑤ libraryfolders.vdf 多库路径解析（SteamVR/VRChat 在第二库）
//   ⑥ 额外：SteamPath 正斜杠归一化、进程名大小写、spawn 抛错、deps 抛错不崩、部分已启动

import assert from 'node:assert/strict';

import {
  detectGameEnv,
  ensureGameStack,
  normalizeWinPath,
  parseLibraryFolders,
  DEFAULT_TIMEOUTS,
  GAME_ORDER,
} from '../lib/launch.mjs';

let n = 0;
const check = async (name, fn) => {
  n += 1;
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${n}: ${name}`);
    throw error;
  }
};
const sleep = () => new Promise((resolve) => setImmediate(resolve));
const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();

const STEAM_DIR = 'D:\\game\\steam';
const STEAM_EXE = STEAM_DIR + '\\steam.exe';
const STEAMVR_DIR = STEAM_DIR + '\\steamapps\\common\\SteamVR';
const STEAMVR_EXE = STEAMVR_DIR + '\\bin\\win64\\vrstartup.exe';
const VRCHAT_DIR = STEAM_DIR + '\\steamapps\\common\\VRChat';
const VRCHAT_EXE = VRCHAT_DIR + '\\launch.exe';
const VDF = [
  '"libraryfolders"',
  '{',
  '\t"0"',
  '\t{',
  '\t\t"path"\t\t"D:\\\\game\\\\steam"',
  '\t}',
  '}',
].join('\n');

/**
 * 构造假 deps。
 * @param {object} cfg
 * @param {Set<string>} cfg.files 存在的文件/目录（大小写不敏感比较）
 * @param {Array<{name:string,pid?:number}>} cfg.procs 初始进程表
 * @param {Array<{name:string,delayPolls?:number}>} cfg.appearOnSpawn 假 spawn 后进程"过几次 sleep 才出现"
 * @param {string|null} cfg.steamPath 假注册表值
 * @param {Function} [cfg.spawnHook] 覆盖 spawn 行为
 */
function makeFakeDeps(cfg = {}) {
  const files = new Set([...((cfg.files) || [])].map(norm));
  const procs = (cfg.procs || []).map((p) => ({ name: p.name, pid: p.pid ?? 1000 + Math.floor(Math.random() * 1000) }));
  const pending = []; // {name, depth}
  const spawned = [];
  const sleeps = [];
  let nextPid = 5000;
  const appearConfig = cfg.appearOnSpawn || [];

  const fake = {
    exists: (p) => files.has(norm(p)),
    readText: (p) => {
      const key = norm(p);
      if (cfg.textFiles && Object.prototype.hasOwnProperty.call(cfg.textFiles, key)) return cfg.textFiles[key];
      return null;
    },
    regQuery: (key, name) => {
      if (cfg.regQuery) return cfg.regQuery(key, name);
      if (String(name).toLowerCase() === 'steampath') return cfg.steamPath === undefined ? 'd:/game/steam' : cfg.steamPath;
      return null;
    },
    listProcesses: () => procs.map((p) => ({ ...p })),
    spawn: (exe, args) => {
      spawned.push({ exe, args: Array.isArray(args) ? args.slice() : [] });
      if (cfg.spawnHook) return cfg.spawnHook(exe, args);
      const base = String(exe).split(/[\\/]/).pop().toLowerCase();
      // a.match = 被 spawn 的 exe basename；a.name = 进程表里出现的名字（两者可以不同：
      // 例如 spawn vrstartup.exe 之后进程表里出现的是 vrserver.exe）
      const entry = appearConfig.find((a) => norm(a.match || a.exe || a.name) === base);
      const pid = nextPid++;
      if (entry && (entry.delayPolls ?? 0) > 0) pending.push({ name: entry.name, pid, depth: entry.delayPolls });
      else procs.push({ name: entry ? entry.name : base, pid });
      return { pid };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      // 每次 sleep 让"等待出现"的进程前进一步
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        pending[i].depth -= 1;
        if (pending[i].depth <= 0) {
          procs.push({ name: pending[i].name, pid: pending[i].pid });
          pending.splice(i, 1);
        }
      }
      await sleep();
    },
    env: {},
  };
  return { deps: fake, spawned, sleeps, procs, pending };
}

function baseFiles() {
  return [
    STEAM_EXE,
    STEAMVR_EXE,
    VRCHAT_EXE,
    STEAM_DIR + '\\steamapps\\libraryfolders.vdf',
  ];
}

async function main() {
  // ── ⑤/归一化：VDF 解析与路径归一化 ─────────────────────────────────────
  await check('normalizeWinPath: 正斜杠 → 反斜杠 + 盘符大写', () => {
    assert.equal(normalizeWinPath('d:/game/steam'), 'D:\\game\\steam');
    assert.equal(normalizeWinPath('  D:\\game\\steam\\  '), 'D:\\game\\steam');
    assert.equal(normalizeWinPath(''), '');
    assert.equal(normalizeWinPath(null), '');
  });
  await check('parseLibraryFolders: 解析转义路径', () => {
    const libs = parseLibraryFolders(VDF);
    assert.deepEqual(libs, ['D:\\game\\steam']);
    const multi = parseLibraryFolders('"0" { "path" "D:\\\\game\\\\steam" } "1" { "path" "E:\\\\SteamLibrary" }');
    assert.deepEqual(multi, ['D:\\game\\steam', 'E:\\SteamLibrary']);
  });
  await check('常量形状', () => {
    assert.deepEqual([...GAME_ORDER], ['steam', 'steamvr', 'vrchat']);
    assert.equal(DEFAULT_TIMEOUTS.steamMs, 20000);
    assert.equal(DEFAULT_TIMEOUTS.steamvrMs, 60000);
    assert.equal(DEFAULT_TIMEOUTS.vrchatMs, 45000);
  });

  // ── 探测：主库 ──────────────────────────────────────────────────────────
  await check('detectGameEnv: 主库三件套都能找到', () => {
    const { deps } = makeFakeDeps({ files: baseFiles(), steamPath: 'd:/game/steam', textFiles: { [norm(STEAM_DIR + '\\steamapps\\libraryfolders.vdf')]: VDF } });
    const env = detectGameEnv(deps);
    assert.equal(env.steam.found, true);
    assert.equal(env.steam.path, 'D:\\game\\steam');
    assert.equal(env.steam.exe, STEAM_EXE);
    assert.equal(env.steamvr.found, true);
    assert.equal(env.steamvr.exe, STEAMVR_EXE);
    assert.equal(env.steamvr.dir, STEAMVR_DIR);
    assert.equal(env.vrchat.found, true);
    assert.equal(env.vrchat.exe, VRCHAT_EXE);
    assert.equal(env.vrchat.dir, VRCHAT_DIR);
    assert.ok(Array.isArray(env.notes) && env.notes.length >= 1);
  });

  // ── ⑤ 多库：SteamVR / VRChat 在第二库 ──────────────────────────────────
  await check('detectGameEnv: libraryfolders.vdf 多库解析（SteamVR/VRChat 在 E 盘库）', () => {
    const lib2 = 'E:\\SteamLibrary';
    const steamvr2 = lib2 + '\\steamapps\\common\\SteamVR\\bin\\win64\\vrstartup.exe';
    const vrchat2 = lib2 + '\\steamapps\\common\\VRChat\\launch.exe';
    const multiVdf = '"libraryfolders"\n{\n "0" { "path" "D:\\\\game\\\\steam" }\n "1" { "path" "E:\\\\SteamLibrary" }\n}';
    const { deps } = makeFakeDeps({
      files: [STEAM_EXE, steamvr2, vrchat2, STEAM_DIR + '\\steamapps\\libraryfolders.vdf'],
      steamPath: 'd:/game/steam',
      textFiles: { [norm(STEAM_DIR + '\\steamapps\\libraryfolders.vdf')]: multiVdf },
    });
    const env = detectGameEnv(deps);
    assert.equal(env.steam.found, true);
    assert.equal(env.steamvr.exe, steamvr2);
    assert.equal(env.vrchat.exe, vrchat2);
    assert.ok(env.notes.some((x) => x.includes('非主库') || x.includes('E:\\SteamLibrary')));
  });

  await check('detectGameEnv: 注册表缺失时用兜底路径（本机无 C 盘 Steam → 找不到）', () => {
    const { deps } = makeFakeDeps({ files: [], steamPath: null });
    const env = detectGameEnv(deps);
    assert.equal(env.steam.found, false);
    assert.equal(env.steamvr.found, false);
    assert.equal(env.vrchat.found, false);
    assert.ok(env.notes.some((x) => x.includes('兜底')));
  });

  await check('detectGameEnv: deps 各种抛错也不抛异常', () => {
    const bad = {
      exists: () => { throw new Error('exists boom'); },
      readText: () => { throw new Error('read boom'); },
      regQuery: () => { throw new Error('reg boom'); },
    };
    const env = detectGameEnv(bad);
    assert.equal(env.steam.found, false);
    assert.equal(env.steamvr.found, false);
    assert.equal(env.vrchat.found, false);
    assert.ok(Array.isArray(env.notes));
  });

  await check('detectGameEnv: 返回契约字段齐全', () => {
    const { deps } = makeFakeDeps({ files: baseFiles(), textFiles: {} });
    const env = detectGameEnv(deps);
    assert.deepEqual(Object.keys(env).sort(), ['notes', 'steam', 'steamvr', 'vrchat']);
    for (const key of ['steam']) {
      assert.ok(Object.prototype.hasOwnProperty.call(env[key], 'found'));
      assert.ok(Object.prototype.hasOwnProperty.call(env[key], 'exe'));
      assert.ok(Object.prototype.hasOwnProperty.call(env[key], 'path'));
    }
    for (const key of ['steamvr', 'vrchat']) {
      assert.ok(Object.prototype.hasOwnProperty.call(env[key], 'found'));
      assert.ok(Object.prototype.hasOwnProperty.call(env[key], 'exe'));
      assert.ok(Object.prototype.hasOwnProperty.call(env[key], 'dir'));
    }
    assert.ok(Array.isArray(env.notes));
  });

  // ── ③ launch:false：只探测、不启动 ─────────────────────────────────────
  await check('ensureGameStack: launch:false 只探测（不 spawn、不 sleep、不等待）', async () => {
    const { deps, spawned, sleeps } = makeFakeDeps({ files: baseFiles(), textFiles: {}, procs: [] });
    const out = await ensureGameStack({ launch: false }, deps);
    assert.deepEqual(Object.keys(out).sort(), ['already', 'env', 'failed', 'notes', 'ok', 'started', 'waitedMs']);
    assert.equal(out.ok, true);
    assert.deepEqual(out.started, []);
    assert.deepEqual(out.already, []);
    assert.deepEqual(out.failed, []);
    assert.equal(spawned.length, 0);
    assert.equal(sleeps.length, 0);
    assert.equal(out.waitedMs, 0);
    assert.equal(out.env.steam.found, true);
    assert.ok(out.notes.some((x) => x.includes('launch=false')));
  });

  // ── ② 都开着：不 spawn、already 全填 ───────────────────────────────────
  await check('ensureGameStack: 全已在运行 → 不 spawn、already 填满、ok', async () => {
    const { deps, spawned } = makeFakeDeps({
      files: baseFiles(),
      textFiles: {},
      procs: [{ name: 'steam.exe' }, { name: 'vrserver.exe' }, { name: 'VRChat.exe' }],
    });
    const out = await ensureGameStack({ launch: true }, deps);
    assert.equal(out.ok, true);
    assert.equal(spawned.length, 0);
    assert.deepEqual(out.already, ['steam', 'steamvr', 'vrchat']);
    assert.deepEqual(out.started, []);
    assert.deepEqual(out.failed, []);
  });

  // ── ① 全没开 + launch:true → 顺序启动、三次轮询后 ok ───────────────────
  await check('ensureGameStack: 全没开 → Steam→SteamVR→VRChat 顺序启动，三轮询后 ok', async () => {
    const { deps, spawned, sleeps } = makeFakeDeps({
      files: baseFiles(),
      textFiles: {},
      procs: [],
      appearOnSpawn: [
        { match: 'steam.exe', name: 'steam.exe', delayPolls: 1 },
        { match: 'vrstartup.exe', name: 'vrserver.exe', delayPolls: 1 },
        { match: 'launch.exe', name: 'VRChat.exe', delayPolls: 1 },
      ],
    });
    const out = await ensureGameStack({ launch: true }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(out.failed, []);
    assert.deepEqual(out.started.map((s) => s.name), ['steam', 'steamvr', 'vrchat']);
    assert.deepEqual(spawned.map((s) => s.exe.split(/[\\/]/).pop().toLowerCase()), ['steam.exe', 'vrstartup.exe', 'launch.exe']);
    assert.equal(spawned.length, 3);
    assert.equal(sleeps.length, 3, '每个阶段各一次轮询 sleep');
    assert.ok(out.started.every((s) => typeof s.pid === 'number'));
    assert.equal(out.waitedMs >= 0, true);
  });

  // ── ④ SteamVR 起不来 → 超时失败（几十 ms）、不继续启 VRChat ─────────────
  await check('ensureGameStack: SteamVR 永不出现 → 超时失败、failed 含 steamvr、不启动 VRChat、notes 中文提示', async () => {
    const { deps, spawned, sleeps } = makeFakeDeps({
      files: baseFiles(),
      textFiles: {},
      procs: [],
      appearOnSpawn: [
        { match: 'steam.exe', name: 'steam.exe', delayPolls: 1 },
        // vrserver 永不出现（不放进 appearOnSpawn）
      ],
    });
    const out = await ensureGameStack(
      { launch: true, timeouts: { steamMs: 40, steamvrMs: 60, vrchatMs: 40 } },
      deps,
    );
    assert.equal(out.ok, false);
    assert.ok(out.failed.some((f) => f.name === 'steamvr'), JSON.stringify(out.failed));
    const steamvrFail = out.failed.find((f) => f.name === 'steamvr');
    assert.match(steamvrFail.reason, /SteamVR/);
    assert.match(steamvrFail.reason, /(没起来|手动)/);
    // 只启动 Steam 与 SteamVR（vrstartup），VRChat 被跳过
    assert.deepEqual(spawned.map((s) => s.exe.split(/[\\/]/).pop().toLowerCase()), ['steam.exe', 'vrstartup.exe']);
    assert.deepEqual(out.started.map((s) => s.name), ['steam']);
    assert.ok(out.notes.some((x) => x.includes('SteamVR') && /(没起来|手动)/.test(x)), JSON.stringify(out.notes));
    assert.ok(out.notes.some((x) => x.includes('跳过 VRChat')));
    assert.ok(sleeps.length >= 2, 'Steam 1 次 + SteamVR 超时轮询');
  });

  // ── ⑥ 边界：Steam 没装 → failed steam，不尝试后续 ─────────────────────
  await check('ensureGameStack: 没装 Steam → failed steam、ok:false、不 spawn', async () => {
    const { deps, spawned } = makeFakeDeps({ files: [], textFiles: {}, procs: [], steamPath: null });
    const out = await ensureGameStack({ launch: true }, deps);
    assert.equal(out.ok, false);
    assert.deepEqual(out.failed.map((f) => f.name), ['steam', 'steamvr', 'vrchat']);
    assert.equal(spawned.length, 0);
    assert.ok(out.notes.some((x) => x.includes('Steam')));
  });

  // ── ⑥ 部分已在运行：只启动缺的，already 只含已在跑的 ────────────────────
  await check('ensureGameStack: Steam 已在跑 → 只启动 SteamVR/VRChat，already=[steam]', async () => {
    const { deps, spawned } = makeFakeDeps({
      files: baseFiles(),
      textFiles: {},
      procs: [{ name: 'STEAM.EXE' }], // 大小写不敏感
      appearOnSpawn: [
        { match: 'vrstartup.exe', name: 'vrmonitor.exe', delayPolls: 1 },
        { match: 'launch.exe', name: 'VRChat.exe', delayPolls: 1 },
      ],
    });
    const out = await ensureGameStack({ launch: true }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(out.already, ['steam']);
    assert.deepEqual(out.started.map((s) => s.name), ['steamvr', 'vrchat']);
    assert.deepEqual(spawned.map((s) => s.exe.split(/[\\/]/).pop().toLowerCase()), ['vrstartup.exe', 'launch.exe']);
  });

  // ── ⑥ spawn 抛错：转成 failed，不抛异常 ────────────────────────────────
  await check('ensureGameStack: spawn 抛错 → failed(steam)、不抛异常', async () => {
    const { deps } = makeFakeDeps({
      files: baseFiles(),
      textFiles: {},
      procs: [],
      spawnHook: () => { throw new Error('spawn boom'); },
    });
    const out = await ensureGameStack({ launch: true, timeouts: { steamMs: 40 } }, deps);
    assert.equal(out.ok, false);
    assert.ok(out.failed.some((f) => f.name === 'steam' && /boom/.test(f.reason)));
  });

  // ── ⑥ listProcesses 抛错：不崩、按未运行处理 ───────────────────────────
  await check('ensureGameStack: deps.listProcesses 抛错 → 不抛异常（按未运行处理）', async () => {
    const bad = {
      listProcesses: () => { throw new Error('tasklist boom'); },
      exists: () => true,
      readText: () => null,
      regQuery: () => 'd:/game/steam',
      spawn: () => ({ pid: 1 }),
      sleep: async () => { /* noop */ },
    };
    const out = await ensureGameStack({ launch: true, timeouts: { steamMs: 20, steamvrMs: 20, vrchatMs: 20 } }, bad);
    assert.equal(typeof out.ok, 'boolean');
    assert.equal(out.ok, false);
    assert.ok(Array.isArray(out.failed));
    assert.ok(out.failed.some((f) => f.name === 'steam'));
  });

  // ── ⑥ 完整环境模拟本机路径（只探测，验证实机事实）──────────────────────
  await check('detectGameEnv: 模拟本机实机路径（D:/game/steam）', () => {
    const { deps } = makeFakeDeps({
      files: baseFiles(),
      steamPath: 'd:/game/steam',
      textFiles: { [norm(STEAM_DIR + '\\steamapps\\libraryfolders.vdf')]: VDF },
    });
    const env = detectGameEnv(deps);
    assert.equal(env.steam.path, 'D:\\game\\steam');
    assert.equal(env.steamvr.exe, 'D:\\game\\steam\\steamapps\\common\\SteamVR\\bin\\win64\\vrstartup.exe');
    assert.equal(env.vrchat.exe, 'D:\\game\\steam\\steamapps\\common\\VRChat\\launch.exe');
  });

  console.log(`PASS ${n} checks (launch)`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAIL', error && error.message ? error.message : error);
    if (error && error.stack) console.error(error.stack);
    process.exit(1);
  },
);
