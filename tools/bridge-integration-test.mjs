// Integration test for lib/bridge.js against an in-process mock VRChat peer.
// Run: node tools/bridge-integration-test.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { VRChatBridge, splitChatboxText, CHATBOX_NEWLINE } from '../lib/bridge.js';
import { encodeMessage, decodePacket } from '../lib/osc.js';

const VRCHAT_IN = 19000;  // where the bridge sends (VRChat's OSC input)
const VRCHAT_OUT = 19001; // where VRChat sends (bridge listens)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function bindMock(port) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const packets = [];
  socket.on('message', (buf) => packets.push(...decodePacket(buf)));
  await new Promise((resolve) => socket.bind(port, '127.0.0.1', resolve));
  return { socket, packets };
}

const mock = await bindMock(VRCHAT_IN);
const bridge = new VRChatBridge({
  host: '127.0.0.1',
  sendPort: VRCHAT_IN,
  listenPort: VRCHAT_OUT,
  chatbox: { minIntervalMs: 30 },
});
await bridge.start();
await sleep(50);

await check('bridge listens', () => {
  assert.equal(bridge.listening, true);
  assert.equal(bridge.state().connected, false);
});

await check('say() sends one /chatbox/input with 3 args and UTF-8 text', async () => {
  mock.packets.length = 0;
  await bridge.say('\u4f60\u597d VRChat');
  await sleep(40);
  const chat = mock.packets.filter((m) => m.address === '/chatbox/input');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].args[0].value, '\u4f60\u597d VRChat');
  assert.equal(chat[0].args[1].value, true);
  assert.equal(chat[0].args[2].value, false);
  assert.ok(mock.packets.some((m) => m.address === '/chatbox/typing' && m.args[0].value === true));
});

await check('multi-line chat uses vertical tabs, not \\n', async () => {
  mock.packets.length = 0;
  await bridge.say('\u7b2c\u4e00\u884c\n\u7b2c\u4e8c\u884c');
  await sleep(40);
  const chat = mock.packets.find((m) => m.address === '/chatbox/input');
  assert.ok(chat);
  assert.ok(chat.args[0].value.includes(CHATBOX_NEWLINE));
  assert.ok(!chat.args[0].value.includes('\n'));
});

await check('long text is split into <=maxChars chunks (UTF-16 units)', async () => {
  mock.packets.length = 0;
  const long = 'A'.repeat(400);
  const result = await bridge.say(long, { maxChars: 140 });
  await sleep(150);
  const chats = mock.packets.filter((m) => m.address === '/chatbox/input');
  assert.ok(chats.length >= 3, `expected >=3 chunks, got ${chats.length}`);
  for (const chat of chats) assert.ok(chat.args[0].value.length <= 140);
  assert.equal(chats.map((c) => c.args[0].value).join(''), long);
  assert.equal(result.chunks, chats.length);
});

await check('splitChatboxText keeps surrogate pairs intact', () => {
  const chunks = splitChatboxText('\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}', { maxChars: 4 });
  assert.ok(chunks.every((chunk) => chunk.length <= 4));
  assert.equal(chunks.join(''), '\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}');
  assert.ok(!chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk)), 'no dangling high surrogate');
});

await check('inbound avatar change + parameters update bridge state', async () => {
  const sender = dgram.createSocket('udp4');
  const send = (address, args) => sender.send(encodeMessage(address, args), VRCHAT_OUT, '127.0.0.1');
  send('/avatar/change', [{ type: 's', value: 'avtr_test-1' }]);
  send('/avatar/parameters/GestureLeft', [{ type: 'i', value: 2 }]);
  send('/avatar/parameters/Voice', [{ type: 'f', value: 0.75 }]);
  send('/avatar/parameters/Grounded', [{ type: 'b', value: true }]);
  send('/avatar/parameters/VelocityX', [{ type: 'f', value: -1.5 }]);
  send('/avatar/parameters/Seated', [{ type: 'b', value: false }]);
  await sleep(120);
  sender.close();
  assert.equal(bridge.avatarId, 'avtr_test-1');
  const params = Object.fromEntries(bridge.listParams().map((p) => [p.name, p.value]));
  assert.equal(params.GestureLeft, 2);
  assert.equal(params.Grounded, true);
  assert.equal(params.Seated, false);
  assert.ok(Math.abs(params.Voice - 0.75) < 1e-6);
  assert.ok(Math.abs(params.VelocityX + 1.5) < 1e-6);
  assert.equal(bridge.state().connected, true);
});

await check('events are buffered with a cursor', () => {
  const events = bridge.events;
  assert.ok(events.length >= 5);
  assert.equal(events.at(-1).kind, 'param');
  assert.equal(events.at(-1).name, 'Seated');
});

await check('waitForEvent resolves on the next matching parameter', async () => {
  const sender = dgram.createSocket('udp4');
  setTimeout(() => {
    sender.send(encodeMessage('/avatar/parameters/GestureRight', [{ type: 'i', value: 1 }]), VRCHAT_OUT, '127.0.0.1');
  }, 40);
  const event = await bridge.waitForEvent((e) => e.kind === 'param' && e.name === 'GestureRight', 2000);
  sender.close();
  assert.equal(event.name, 'GestureRight');
  assert.equal(event.value, 1);
});

await check('waitForEvent times out cleanly', async () => {
  const result = await bridge.waitForEvent((e) => e.name === 'NeverSent', 60);
  assert.equal(result.timeout, true);
});

await check('waitForEvent honours an AbortSignal', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancelled by test')), 30);
  const result = await bridge.waitForEvent((e) => e.name === 'NeverSent', 5000, controller.signal);
  assert.equal(result.cancelled, true);
});

await check('buttons are int 1 then 0', async () => {
  mock.packets.length = 0;
  bridge.pressButton('Jump', 60);
  await sleep(20);
  let sent = mock.packets.filter((m) => m.address === '/input/Jump');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args[0].type, 'i');
  assert.equal(sent[0].args[0].value, 1);
  await sleep(80);
  sent = mock.packets.filter((m) => m.address === '/input/Jump');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].args[0].value, 0);
});

await check('axes are float and return to 0 after move()', async () => {
  mock.packets.length = 0;
  await bridge.move({ forward: 0.5, right: -0.25, look: 0, durationMs: 80 });
  await sleep(30);
  const vertical = mock.packets.filter((m) => m.address === '/input/Vertical');
  assert.equal(vertical.length, 2);
  assert.equal(vertical[0].args[0].type, 'f');
  assert.equal(vertical[0].args[0].value, 0.5);
  assert.equal(vertical[1].args[0].value, 0);
  const horizontal = mock.packets.filter((m) => m.address === '/input/Horizontal');
  assert.equal(horizontal[0].args[0].value, -0.25);
  assert.equal(horizontal[1].args[0].value, 0);
});

await check('stop() releases held inputs before closing', async () => {
  mock.packets.length = 0;
  bridge.setAxis('Vertical', 1);
  bridge.pressButton('MoveForward', 500);
  await sleep(20);
  bridge.stop();
  await sleep(200);
  const releases = mock.packets.filter((m) => m.address === '/input/Vertical' || m.address === '/input/MoveForward');
  assert.ok(releases.some((m) => m.address === '/input/Vertical' && m.args[0].value === 0));
  assert.ok(releases.some((m) => m.address === '/input/MoveForward' && m.args[0].value === 0));
  mock.socket.close();
});

console.log(`\n${passed} integration checks passed`);
