/**
 * VRChat OSC bridge (host side, framework independent).
 *
 * Owns the two UDP directions:
 *   out: our ephemeral UDP socket -> VRChat OSC input port (default 127.0.0.1:9000)
 *   in : our UDP listener           <- VRChat OSC output port (default 127.0.0.1:9001)
 *
 * Input model (see the OSC reference in docs/ (research notes live in the archive)):
 *   - chatbox text: one message <= ~144 UTF-16 units, lines separated by \v (0x0B)
 *   - /input buttons: int 1 = pressed, 0 = released; must return to 0 before re-pressing
 *   - /input axes: float -1..1, must return to 0 when not in use (watchdog releases them)
 *
 * Nothing here depends on DSH, so it can be exercised by the standalone tests under
 * tools/ (they use local mock peers) without installing the plugin.
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { encodeMessage, decodePacket } from './osc.js';

/** VRChat chatbox line separator: a vertical tab, not \n. */
export const CHATBOX_NEWLINE = '\u000b';

/** Official OSC input axes (float -1..1, return to 0 when idle). */
export const INPUT_AXES = new Set([
  'Vertical', 'Horizontal', 'LookHorizontal', 'UseAxisRight', 'GrabAxisRight',
  'MoveHoldFB', 'SpinHoldCwCcw', 'SpinHoldUD', 'SpinHoldLR',
]);

/** Official OSC input buttons (int 1/0). */
export const INPUT_BUTTONS = new Set([
  'MoveForward', 'MoveBackward', 'MoveLeft', 'MoveRight',
  'LookLeft', 'LookRight', 'Jump', 'Run',
  'ComfortLeft', 'ComfortRight',
  'DropRight', 'UseRight', 'GrabRight',
  'DropLeft', 'UseLeft', 'GrabLeft',
  'PanicButton', 'QuickMenuToggleLeft', 'QuickMenuToggleRight', 'Voice',
]);

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  sendPort: 9000,
  listenPort: 9001,
  listenEnabled: true,
  chatbox: {
    maxChars: 140,
    minIntervalMs: 1500,
    notificationSound: false,
    sendImmediately: true,
    showTyping: true,
  },
  events: {
    bufferSize: 600,
    ignoreParams: ['Viseme', 'Voice', 'VelocityX', 'VelocityY', 'VelocityZ'],
  },
  debug: false,
};

function mergeConfig(base, override = {}) {
  return {
    ...base,
    ...override,
    chatbox: { ...base.chatbox, ...(override.chatbox ?? {}) },
    events: { ...base.events, ...(override.events ?? {}) },
  };
}

/**
 * Split text into chatbox-sized chunks.
 * VRChat limits one chatbox message to roughly 144 characters total; lines are
 * separated by \v. We measure UTF-16 code units (what VRChat/C# `string.Length`
 * counts) and never split a surrogate pair.
 */
export function splitChatboxText(text, { maxChars = 144 } = {}) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, CHATBOX_NEWLINE)
    .trim();
  const limit = Math.max(1, Math.floor(maxChars));
  const chunks = [];
  let current = '';
  let units = 0;
  for (const char of normalized) {
    const size = char.length;
    if (units + size > limit && current.length > 0) {
      chunks.push(current);
      current = '';
      units = 0;
    }
    if (char === CHATBOX_NEWLINE && current.length === 0) continue;
    current += char;
    units += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class VRChatBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.sender = null;
    this.listener = null;
    this.listening = false;
    this.listenError = null;
    this.avatarId = null;
    this.params = new Map();
    this.events = [];
    this.seq = 0;
    this.lastHeardAt = 0;
    this.firstHeardAt = 0;
    this.recvPackets = 0;
    this.sendPackets = 0;
    this.sendErrors = 0;
    this.chatQueue = [];
    this.chatTimer = null;
    this.chatBusy = false;
    this.typing = false;
    this.waiters = new Set();
    this.heldButtons = new Map(); // action -> release timer
    this.heldAxes = new Map();    // action -> last set value
    this.lastSentChatAt = 0;
    this.startedAt = 0;
    this.watchdog = null;
  }

  /** Bind the listen socket (if enabled) and create the send socket. */
  async start() {
    if (this.startedAt !== 0) return;
    this.sender = dgram.createSocket('udp4');
    this.sender.on('error', (error) => {
      this.sendErrors += 1;
      this.emit('error', error);
    });
    if (this.config.listenEnabled) {
      await this._startListener();
    }
    this.watchdog = setInterval(() => this._releaseStaleAxes(), 2000);
    this.watchdog.unref?.();
    this.startedAt = Date.now();
  }

  _startListener() {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.listener = socket;
      socket.on('message', (packet, rinfo) => {
        try {
          this._handlePacket(packet, rinfo);
        } catch (error) {
          this.emit('error', error);
        }
      });
      socket.once('error', (error) => {
        this.listenError = error;
        this.listening = false;
        this.emit('listen-error', error);
        resolve();
      });
      socket.bind(this.config.listenPort, this.config.host, () => {
        this.listening = true;
        this.listenError = null;
        this.emit('listening', this.config.listenPort);
        resolve();
      });
    });
  }

  stop() {
    this._releaseAllInputs();
    if (this.chatTimer !== null) {
      clearTimeout(this.chatTimer);
      this.chatTimer = null;
    }
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    for (const item of this.chatQueue.splice(0)) item.resolve({ dropped: true });
    for (const waiter of [...this.waiters]) waiter.cancel(new Error('bridge stopped'));
    this.waiters.clear();
    const listener = this.listener;
    const sender = this.sender;
    this.listener = null;
    this.sender = null;
    try { listener?.close(); } catch { /* already closed */ }
    // Give the release datagrams queued by _releaseAllInputs() a chance to flush.
    if (sender !== null) {
      setTimeout(() => {
        try { sender.close(); } catch { /* already closed */ }
      }, 60);
    }
    this.listening = false;
    this.startedAt = 0;
  }

  send(address, args = []) {
    if (this.sender === null) throw new Error('VRChat bridge is not started');
    const packet = encodeMessage(address, args);
    this.sendPackets += 1;
    this.sender.send(packet, this.config.sendPort, this.config.host, (error) => {
      if (error !== null && error !== undefined) {
        this.sendErrors += 1;
        this.emit('error', error);
      }
    });
    return packet.length;
  }

  // ── chatbox ────────────────────────────────────────────────────────────────

  /** Queue a chatbox message. Resolves once every chunk has been written. */
  say(text, options = {}) {
    const cfg = this.config.chatbox;
    const chunks = splitChatboxText(text, {
      maxChars: options.maxChars ?? cfg.maxChars,
    });
    if (chunks.length === 0) return Promise.resolve({ sent: [], skipped: true, chunks: 0 });
    const sent = [];
    const jobs = chunks.map((chunk) => new Promise((resolve) => {
      this.chatQueue.push({
        text: chunk,
        immediate: options.immediate ?? cfg.sendImmediately,
        sound: options.sound ?? cfg.notificationSound,
        resolve: (result) => { if (!result.dropped) sent.push(chunk); resolve(result); },
      });
    }));
    this._pumpChat();
    return Promise.all(jobs).then(() => ({ sent, skipped: false, chunks: chunks.length }));
  }

  _pumpChat() {
    if (this.chatBusy) return;
    const next = this.chatQueue.shift();
    if (next === undefined) return;
    this.chatBusy = true;
    const cfg = this.config.chatbox;
    const now = Date.now();
    const wait = Math.max(0, (this.lastSentChatAt || 0) + cfg.minIntervalMs - now);
    if (wait > 0) {
      this.chatTimer = setTimeout(() => {
        this.chatTimer = null;
        this._deliverChat(next);
      }, wait);
      return;
    }
    this._deliverChat(next);
  }

  _deliverChat(job) {
    if (this.typing === false && this.config.chatbox.showTyping) {
      try { this.send('/chatbox/typing', [{ type: 'b', value: true }]); this.typing = true; } catch { /* send socket gone */ }
    }
    try {
      this.send('/chatbox/input', [
        { type: 's', value: job.text },
        { type: 'b', value: job.immediate },
        { type: 'b', value: job.sound },
      ]);
      this.lastSentChatAt = Date.now();
      this.emit('chatbox-sent', { text: job.text, immediate: job.immediate });
      job.resolve({ sent: true, text: job.text });
    } catch (error) {
      job.resolve({ sent: false, error: String(error) });
    }
    this.chatBusy = false;
    if (this.chatQueue.length > 0) {
      this._pumpChat();
    } else if (this.typing) {
      try { this.send('/chatbox/typing', [{ type: 'b', value: false }]); } catch { /* ignore */ }
      this.typing = false;
    }
  }

  // ── avatar parameters ──────────────────────────────────────────────────────

  /** Write a custom avatar parameter (built-in params are read-only in VRChat). */
  setParam(name, value) {
    const type = typeof value === 'boolean' ? 'b' : Number.isInteger(value) ? 'i' : 'f';
    this.send(`/avatar/parameters/${name}`, [{ type, value }]);
  }

  // ── /input ─────────────────────────────────────────────────────────────────

  static isAxis(action) {
    return INPUT_AXES.has(action);
  }

  static isButton(action) {
    return INPUT_BUTTONS.has(action);
  }

  /** Press a button: int 1, released to int 0 after holdMs. */
  pressButton(action, holdMs = 120) {
    const previous = this.heldButtons.get(action);
    if (previous !== undefined) clearTimeout(previous);
    this.send(`/input/${action}`, [{ type: 'i', value: 1 }]);
    const timer = setTimeout(() => this.releaseButton(action), clamp(holdMs, 0, 10_000));
    timer.unref?.();
    this.heldButtons.set(action, timer);
    return { action, kind: 'button', holdMs };
  }

  releaseButton(action) {
    const timer = this.heldButtons.get(action);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.heldButtons.delete(action);
    try { this.send(`/input/${action}`, [{ type: 'i', value: 0 }]); } catch { /* socket gone */ }
  }

  /** Set an axis value (float -1..1). 0 releases it. */
  setAxis(action, value) {
    const clamped = clamp(Number(value) || 0, -1, 1);
    this.send(`/input/${action}`, [{ type: 'f', value: clamped }]);
    if (clamped === 0) this.heldAxes.delete(action);
    else this.heldAxes.set(action, Date.now());
    return clamped;
  }

  /** Hold axes for a duration, then release every one of them back to 0. */
  async move({ forward = 0, right = 0, look = 0, durationMs = 400 } = {}) {
    const duration = clamp(Math.round(durationMs), 50, 10_000);
    this.setAxis('Vertical', forward);
    this.setAxis('Horizontal', right);
    this.setAxis('LookHorizontal', look);
    await sleep(duration);
    this.setAxis('Vertical', 0);
    this.setAxis('Horizontal', 0);
    this.setAxis('LookHorizontal', 0);
    return { forward, right, look, durationMs: duration };
  }

  _releaseStaleAxes() {
    const now = Date.now();
    for (const [action] of this.heldAxes) {
      // A caller is expected to release within 10s; otherwise stop moving.
      if (now - (this.heldAxes.get(action) ?? 0) > 10_000) {
        try { this.setAxis(action, 0); } catch { /* ignore */ }
      }
    }
    for (const action of [...this.heldButtons.keys()]) {
      const timer = this.heldButtons.get(action);
      if (timer === undefined) this.releaseButton(action);
    }
  }

  _releaseAllInputs() {
    for (const action of [...this.heldButtons.keys()]) {
      this.releaseButton(action);
    }
    for (const action of [...this.heldAxes.keys()]) {
      try { this.setAxis(action, 0); } catch { /* socket gone */ }
    }
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  _handlePacket(packet) {
    const messages = decodePacket(packet);
    this.recvPackets += 1;
    const now = Date.now();
    if (this.firstHeardAt === 0) this.firstHeardAt = now;
    this.lastHeardAt = now;
    for (const message of messages) this._handleMessage(message, now);
    this.emit('packet', messages.length);
  }

  _handleMessage(message, now) {
    const { address } = message;
    const first = message.args[0]?.value;
    if (address === '/avatar/change') {
      this.avatarId = typeof first === 'string' ? first : null;
      const event = this._pushEvent({ kind: 'avatar', address, value: this.avatarId });
      this.emit('avatar', this.avatarId, event);
      return;
    }
    const prefix = '/avatar/parameters/';
    if (address.startsWith(prefix)) {
      const name = address.slice(prefix.length);
      const value = first;
      this.params.set(name, { type: message.args[0]?.type ?? '?', value, at: now });
      const event = this._pushEvent({ kind: 'param', address, name, value, valueType: message.args[0]?.type });
      this.emit('param', name, value, event);
      return;
    }
    const event = this._pushEvent({ kind: 'osc', address, value: first });
    this.emit('osc', address, message.args, event);
  }

  _pushEvent(partial) {
    const event = { seq: ++this.seq, time: Date.now(), ...partial };
    this.events.push(event);
    const limit = this.config.events.bufferSize;
    if (this.events.length > limit) this.events.splice(0, this.events.length - limit);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
    return event;
  }

  /** Wait for one event matching `predicate`; resolves event or {timeout:true}. */
  waitForEvent(predicate, timeoutMs, signal) {
    return new Promise((resolve) => {
      const waiter = {
        predicate: (event) => {
          try { return predicate(event); } catch { return false; }
        },
        resolve: (event) => {
          cleanup();
          resolve(event);
        },
        cancel: (reason) => {
          cleanup();
          resolve({ cancelled: true, reason: String(reason?.message ?? reason) });
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        cleanup();
        resolve({ timeout: true });
      }, Math.max(0, timeoutMs));
      const onAbort = () => waiter.cancel(signal?.reason);
      const cleanup = () => {
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener?.('abort', onAbort);
      };
      if (signal !== undefined) {
        if (signal.aborted) { waiter.cancel(signal.reason); return; }
        signal.addEventListener?.('abort', onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  listParams(filter = '') {
    const out = [];
    for (const [name, entry] of this.params) {
      if (filter !== '' && !name.toLowerCase().includes(filter.toLowerCase())) continue;
      out.push({ name, value: entry.value, type: entry.type, at: entry.at });
    }
    return out;
  }

  state() {
    const now = Date.now();
    return {
      listening: this.listening,
      listenError: this.listenError === null ? null : String(this.listenError.message ?? this.listenError),
      sendPort: this.config.sendPort,
      listenPort: this.config.listenPort,
      host: this.config.host,
      avatarId: this.avatarId,
      paramCount: this.params.size,
      packetsReceived: this.recvPackets,
      packetsSent: this.sendPackets,
      sendErrors: this.sendErrors,
      lastHeardMsAgo: this.lastHeardAt === 0 ? null : now - this.lastHeardAt,
      connected: this.lastHeardAt !== 0 && now - this.lastHeardAt < 10_000,
      queuedChat: this.chatQueue.length,
      lastChatSentAt: this.lastSentChatAt === 0 ? null : this.lastSentChatAt,
      heldInputs: { buttons: [...this.heldButtons.keys()], axes: [...this.heldAxes.keys()] },
      chatbox: { ...this.config.chatbox },
      eventSeq: this.seq,
    };
  }
}
