// Standalone codec self-test. Run: node tools/osc-selftest.mjs
import assert from 'node:assert/strict';
import {
  encodeMessage, encodeBundle, decodePacket, decodeMessage, encodeOscString,
} from '../lib/osc.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

check('string padding is 4-byte aligned', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd', '/avatar/parameters/VRCEmote', '你好，VRChat']) {
    const b = encodeOscString(s);
    assert.equal(b.length % 4, 0, `length for ${JSON.stringify(s)}`);
    assert.equal(b[b.length - 1], 0);
  }
});

check('round-trips a chatbox message with UTF-8 text', () => {
  const raw = 'Hello VRChat 你好 🎉\n第二行';
  const buf = encodeMessage('/chatbox/input', [
    { type: 's', value: raw },
    { type: 'b', value: true },
    { type: 'b', value: false },
  ]);
  const [msg] = decodePacket(buf);
  assert.equal(msg.address, '/chatbox/input');
  assert.equal(msg.args[0].value, raw);
  assert.equal(msg.args[1].value, true);
  assert.equal(msg.args[2].value, false);
});

check('round-trips avatar parameter numbers and booleans', () => {
  const floatBuf = encodeMessage('/avatar/parameters/GestureLeft', [{ type: 'i', value: 3 }]);
  const [f] = decodePacket(floatBuf);
  assert.equal(f.address, '/avatar/parameters/GestureLeft');
  assert.equal(f.args[0].value, 3);

  const vBuf = encodeMessage('/avatar/parameters/Voice', [0.7331]);
  const [v] = decodePacket(vBuf);
  assert.ok(Math.abs(v.args[0].value - 0.7331) < 1e-6);

  const bBuf = encodeMessage('/avatar/parameters/Grounded', [true]);
  const [, b] = [null, decodePacket(bBuf)[0]];
  assert.equal(b.args[0].value, true);
});

check('decodes a bundle with two messages', () => {
  const a = encodeMessage('/avatar/change', [{ type: 's', value: 'avtr_1234' }]);
  const b = encodeMessage('/avatar/parameters/VelocityX', [0.25]);
  const packet = encodeBundle([a, b]);
  const msgs = decodePacket(packet);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].address, '/avatar/change');
  assert.equal(msgs[0].args[0].value, 'avtr_1234');
  assert.equal(msgs[1].address, '/avatar/parameters/VelocityX');
});

check('decodes an integer sent as a float32 (VRChat mixes these)', () => {
  const buf = encodeMessage('/input/Jump', [1]);
  const [msg] = decodePacket(buf);
  assert.equal(msg.args[0].type, 'i');
});

check('rejects malformed packets', () => {
  assert.throws(() => decodeMessage(Buffer.from('not-an-osc-message\0\0\0\0', 'utf8')));
});

// Show one real-world sized packet in hex for eyeballing.
const sample = encodeMessage('/chatbox/input', ['hi', true, false]);
console.log(`\nsample packet (${sample.length}B): ${sample.toString('hex')}`);
console.log(`\n${passed} checks passed`);
