// test_vmtinput.mjs — 虚拟手柄输入通道单测（本地 UDP mock 收包解码，纯离线）
//
// 覆盖：trigger 自动归零 / b 键 idx 与 buttonIndex / stick 归零 / releaseAll /
// dryRun 不发包 / 非法名字与 side 抛错 / trigger 连续值 / touch 单发 / close 归零。
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { decodePacket, plainArgs } from '../lib/osc.js';
import { BUTTON_MAP, BUTTON_NAMES, SIDE_INDEX, createVmtInput } from '../lib/vmtinput.mjs';

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const received = [];
const server = dgram.createSocket('udp4');
server.on('message', (buffer) => {
  try {
    for (const message of decodePacket(Buffer.from(buffer))) {
      received.push({ address: message.address, args: plainArgs(message), types: message.args.map((arg) => arg.type) });
    }
  } catch {
    received.push({ address: '<decode-error>', args: [], types: [] });
  }
});
await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
const port = server.address().port;

const clear = () => { received.length = 0; };
async function waitFor(count, timeoutMs = 800) {
  const startedAt = Date.now();
  while (received.length < count && Date.now() - startedAt < timeoutMs) await sleep(10);
}

const input = createVmtInput({ port });

try {
  await check('BUTTON_MAP：按 VMT 源码 Index 分支的按键/组件映射', () => {
    assert.deepEqual(SIDE_INDEX, { left: 1, right: 2 });
    assert.equal(BUTTON_MAP.system.component, 0);
    assert.equal(BUTTON_MAP.a.component, 1);
    assert.equal(BUTTON_MAP.b.component, 3);
    assert.equal(BUTTON_MAP.trigger.component, 0);
    assert.equal(BUTTON_MAP.grip.component, 1);
    assert.equal(BUTTON_MAP.thumbstick.component, 1);
    assert.equal(BUTTON_MAP.trackpad.component, 0);
    assert.deepEqual([...BUTTON_NAMES].sort(), ['a', 'b', 'grip', 'system', 'thumbstick', 'trackpad', 'trigger']);
  });

  await check('press(trigger,right)：/VMT/Input/Trigger idx=2 [2,0,0,1] → 自动归零 [2,0,0,0]', async () => {
    clear();
    await input.press('trigger', { side: 'right', durationMs: 25 });
    await waitFor(2);
    assert.ok(received.length >= 2, `只收到 ${received.length} 条`);
    assert.equal(received[0].address, '/VMT/Input/Trigger');
    assert.deepEqual(received[0].args, [2, 0, 0, 1]);
    assert.deepEqual(received[0].types, ['i', 'i', 'f', 'f']);
    assert.equal(received[1].address, '/VMT/Input/Trigger');
    assert.deepEqual(received[1].args, [2, 0, 0, 0]);
  });

  await check('press(b,left)：/VMT/Input/Button idx=1 buttonIndex=3 [1,3,0,1] → 0', async () => {
    clear();
    await input.press('b', { side: 'left', durationMs: 25 });
    await waitFor(2);
    assert.ok(received.length >= 2);
    assert.equal(received[0].address, '/VMT/Input/Button');
    assert.deepEqual(received[0].args, [1, 3, 0, 1]);
    assert.deepEqual(received[1].args, [1, 3, 0, 0]);
  });

  await check('stick(left,{x:0.5,y:-0.5})：/VMT/Input/Joystick [1,1,0,0.5,-0.5] → 归零', async () => {
    clear();
    await input.stick('left', { x: 0.5, y: -0.5, durationMs: 25 });
    await waitFor(2);
    assert.ok(received.length >= 2);
    assert.equal(received[0].address, '/VMT/Input/Joystick');
    assert.deepEqual(received[0].args, [1, 1, 0, 0.5, -0.5]);
    assert.deepEqual(received[1].args, [1, 1, 0, 0, 0]);
    // 也支持位置参数写法 stick(side, x, y, opts)
    clear();
    await input.stick('right', -0.25, 0.75, { durationMs: 25 });
    await waitFor(2);
    assert.deepEqual(received[0].args, [2, 1, 0, -0.25, 0.75]);
  });

  await check('releaseAll：把所有按住的键/轴成对归零', async () => {
    clear();
    input.press('a', { side: 'left', durationMs: 5000 });
    input.press('grip', { side: 'right', durationMs: 5000 });
    await sleep(40);
    const released = input.releaseAll();
    assert.equal(released.released, 2);
    assert.equal(input.stats.held, 0);
    await waitFor(4);
    const zeros = received.filter((message) => message.args.at(-1) === 0 && message.args.at(-2) === 0);
    assert.ok(zeros.length >= 2, `归零消息不足: ${JSON.stringify(received.map((m) => [m.address, m.args]))}`);
    const buttonZero = received.find((message) => message.address === '/VMT/Input/Button' && message.args[1] === 1 && message.args[3] === 0);
    assert.ok(buttonZero, 'A 键应归零');
    const triggerZero = received.find((message) => message.address === '/VMT/Input/Trigger' && message.args[1] === 1 && message.args[3] === 0);
    assert.ok(triggerZero, 'Grip 应归零');
    assert.ok(input.stats.releases >= 2);
  });

  await check('dryRun：只计数、不建 socket、不发包', async () => {
    clear();
    const dry = createVmtInput({ port, dryRun: true });
    await dry.press('a', { side: 'left', durationMs: 20 });
    await sleep(80);
    assert.equal(received.length, 0, `dryRun 不应发包，实际 ${received.length}`);
    assert.equal(dry.stats.dryRun, true);
    assert.ok(dry.stats.pressed >= 1);
    dry.close();
  });

  await check('非法名字/side：抛清晰错误（输入校验，非传输异常）', () => {
    assert.throws(() => input.press('nope', 'left'), /unknown button/);
    assert.throws(() => input.press('a', 'middle'), /unknown side/);
    assert.throws(() => input.stick('middle', 0, 0), /unknown side/);
    assert.equal(input.stats.errors, 0, '校验错误不应计入传输 errors');
  });

  await check('trigger 连续值 + touch 单发（Touch 通道不自动归零）', async () => {
    clear();
    await input.trigger('right', 0.6, { durationMs: 25 });
    await waitFor(2);
    assert.equal(received[0].address, '/VMT/Input/Trigger');
    assert.deepEqual(received[0].args.slice(0, 3), [2, 0, 0]);
    assert.ok(Math.abs(received[0].args[3] - 0.6) < 1e-6);
    assert.equal(received[1].args[3], 0);

    clear();
    await input.press('a', { side: 'left', touch: true });
    await waitFor(1);
    assert.equal(received[0].address, '/VMT/Input/Button/Touch');
    assert.deepEqual(received[0].args, [1, 1, 0, 1]);
    await sleep(80);
    assert.equal(received.length, 1, 'touch 不应自动发归零');
  });

  await check('close()：先归零再关通道，幂等', async () => {
    clear();
    const closable = createVmtInput({ port });
    closable.press('b', { side: 'left', durationMs: 5000 });
    await sleep(40);
    closable.close();
    await waitFor(2);
    assert.ok(received.some((message) => message.address === '/VMT/Input/Button'
      && message.args[1] === 3 && message.args[3] === 0), 'close 前应按住的 B 键应归零');
    assert.equal(closable.stats.closed, true);
    assert.doesNotThrow(() => closable.close());
  });
} finally {
  input.close();
  await new Promise((resolve) => server.close(resolve));
  await sleep(30);
}

console.log(`PASS ${n} checks (vmtinput)`);
