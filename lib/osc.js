/**
 * Minimal, dependency-free OSC 1.0 codec.
 *
 * Used by the VRChat bridge plugin for both directions:
 *   - encode: build messages VRChat accepts on UDP (chatbox, input, avatar params)
 *   - decode: parse messages VRChat emits on UDP (avatar params, avatar change, tracking)
 *
 * Design notes
 *   - Strings are UTF-8 (VRChat accepts/emits UTF-8; plain ASCII is a subset). They are
 *     NUL-terminated and padded with zero bytes to a 4-byte boundary.
 *   - Numbers are big-endian: float32 for OSC 'f', int32 for OSC 'i'.
 *   - Booleans use the type tags 'T' (true) / 'F' (false) with no payload, which is what
 *     VRChat uses for its boolean avatar parameters and accepts for /chatbox and /input.
 *   - Bundles ("#bundle") are decoded recursively; encoding is supported for completeness.
 */

const TYPE_TAG_NO_DATA = new Set(['T', 'F', 'N', 'I']);

/** @typedef {{ type: string, value?: any }} OscArg */

function paddedLength(n) {
  return (n + 3) & ~3;
}

/** Encode a UTF-8 OSC string (including its NUL terminator) padded to 4 bytes. */
export function encodeOscString(value) {
  const raw = Buffer.from(String(value ?? ''), 'utf8');
  const total = paddedLength(raw.length + 1);
  const out = Buffer.alloc(total);
  raw.copy(out, 0);
  return out;
}

/** Read one OSC string starting at `offset`; returns [string, nextOffset]. */
export function decodeOscString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  const text = buffer.toString('utf8', offset, end);
  return [text, Math.min(buffer.length, paddedLength(end + 1))];
}

function normalizeArg(arg) {
  if (arg !== null && typeof arg === 'object' && typeof arg.type === 'string') {
    return { type: arg.type, value: arg.value };
  }
  if (typeof arg === 'boolean') return { type: 'b', value: arg };
  if (typeof arg === 'number') {
    return Number.isInteger(arg) ? { type: 'i', value: arg } : { type: 'f', value: arg };
  }
  if (typeof arg === 'string') return { type: 's', value: arg };
  if (arg instanceof Uint8Array) return { type: 'blob', value: arg };
  throw new TypeError(`osc: unsupported argument ${String(arg)}`);
}

/**
 * Encode one OSC message.
 * @param {string} address e.g. '/chatbox/input'
 * @param {Array<any|OscArg>} args
 * @returns {Buffer}
 */
export function encodeMessage(address, args = []) {
  const tags = [','];
  const chunks = [encodeOscString(address)];
  for (const raw of args) {
    const { type, value } = normalizeArg(raw);
    switch (type) {
      case 'i': {
        tags.push('i');
        const b = Buffer.alloc(4);
        b.writeInt32BE(Math.trunc(value), 0);
        chunks.push(b);
        break;
      }
      case 'f': {
        tags.push('f');
        const b = Buffer.alloc(4);
        b.writeFloatBE(value, 0);
        chunks.push(b);
        break;
      }
      case 'b': {
        tags.push(value ? 'T' : 'F');
        break;
      }
      case 's': {
        tags.push('s');
        chunks.push(encodeOscString(value));
        break;
      }
      case 'blob': {
        tags.push('b');
        const bytes = Buffer.from(value);
        const size = Buffer.alloc(4);
        size.writeInt32BE(bytes.length, 0);
        const padded = Buffer.alloc(paddedLength(bytes.length));
        bytes.copy(padded, 0);
        chunks.push(size, padded);
        break;
      }
      case 'T': {
        tags.push('T');
        break;
      }
      case 'F': {
        tags.push('F');
        break;
      }
      default:
        throw new TypeError(`osc: unsupported type tag ${type}`);
    }
  }
  chunks.splice(1, 0, encodeOscString(tags.join('')));
  return Buffer.concat(chunks);
}

/** Encode a #bundle. `timetag` defaults to 1 ("immediately"). */
export function encodeBundle(elements, timetag = 1n) {
  const parts = [Buffer.from('#bundle\0', 'ascii')];
  const tt = Buffer.alloc(8);
  tt.writeBigUInt64BE(BigInt(timetag), 0);
  parts.push(tt);
  for (const el of elements) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(el.length, 0);
    parts.push(size, el);
  }
  return Buffer.concat(parts);
}

/**
 * Decode one OSC packet (message or bundle) into a flat list of messages.
 * @param {Buffer|Uint8Array} packet
 * @returns {{ address: string, args: OscArg[], time?: number }[]}
 */
export function decodePacket(packet) {
  const buffer = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  if (buffer.length >= 8 && buffer.toString('ascii', 0, 7) === '#bundle') {
    const timetag = buffer.readBigUInt64BE(8);
    const out = [];
    let offset = 16;
    while (offset + 4 <= buffer.length) {
      const size = buffer.readInt32BE(offset);
      offset += 4;
      if (size < 0 || offset + size > buffer.length) break;
      out.push(...decodePacket(buffer.subarray(offset, offset + size)));
      offset += size;
    }
    for (const m of out) if (m.time === undefined) m.time = Number(timetag);
    return out;
  }
  return [decodeMessage(buffer)];
}

/** Decode exactly one non-bundle OSC message. */
export function decodeMessage(buffer) {
  const [address, afterAddress] = decodeOscString(buffer, 0);
  if (!address.startsWith('/')) throw new Error(`osc: invalid address '${address}'`);
  const [tagString, afterTags] = decodeOscString(buffer, afterAddress);
  if (!tagString.startsWith(',')) throw new Error(`osc: invalid type tag '${tagString}'`);
  const args = [];
  let offset = afterTags;
  for (const tag of tagString.slice(1)) {
    if (TYPE_TAG_NO_DATA.has(tag)) {
      args.push({ type: tag, value: tag === 'T' ? true : tag === 'F' ? false : undefined });
      continue;
    }
    switch (tag) {
      case 'i':
        args.push({ type: 'i', value: buffer.readInt32BE(offset) });
        offset += 4;
        break;
      case 'f':
        args.push({ type: 'f', value: buffer.readFloatBE(offset) });
        offset += 4;
        break;
      case 'd': {
        const v = buffer.readDoubleBE(offset);
        offset += 8;
        args.push({ type: 'd', value: v });
        break;
      }
      case 'h': {
        const v = buffer.readBigInt64BE(offset);
        offset += 8;
        args.push({ type: 'h', value: Number(v) });
        break;
      }
      case 's':
      case 'S': {
        const [v, next] = decodeOscString(buffer, offset);
        offset = next;
        args.push({ type: 's', value: v });
        break;
      }
      case 'b': {
        const size = buffer.readInt32BE(offset);
        offset += 4;
        const end = offset + Math.max(0, size);
        args.push({ type: 'blob', value: buffer.subarray(offset, end) });
        offset = paddedLength(Math.max(end, offset));
        break;
      }
      default:
        throw new Error(`osc: unsupported type tag '${tag}' in '${tagString}'`);
    }
  }
  return { address, args };
}

/** Convenience: turn decoded args into plain JS values. */
export function plainArgs(message) {
  return message.args.map((a) => a.value);
}
