// host-shim.mjs — 脱离 DSH 宿主，复用插件自己的工具定义（给 MCP 包装 / 独立 daemon 用）。
//
// index.js 的 apply(ctx, config) 只依赖宿主的三样东西：
//   ctx.logger、ctx.get('tools').register(def)、ctx.get('attachments').saveImage(...)、ctx.effect(fn)
// 这里提供一个最小假宿主，把 19 个工具定义原样捕获下来。这样：
//   * 工具的 schema / 描述 / 执行逻辑只有 index.js 一份（不会和插件漂移）；
//   * MCP 服务器和 vplayd 都不需要 import DSH SDK，也不需要改 index.js；
//   * 图片走内存附件（写临时目录 + base64），MCP 可以直接转成 image content。
//
// 注意：
//   * apply() 会真的启动 UDP bridge 监听（9001）和（可选）面板。MCP 默认关面板；
//     同一台机器上 DSH 插件正跑着时 9001 只能被一方占用，另一方会降级（发送仍然可用）。
//   * dispose() 会按 apply() 的卸载顺序释放：手柄归零 → 面板 → socket → 玩家子进程。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { apply } from '../index.js';

/** 图片附件：落盘到临时目录（便于排查/测试取证）并同时返回 base64（MCP 用）。 */
export function createMemoryAttachments({ dir = join(tmpdir(), `vplay-attachments-${process.pid}-${randomUUID().slice(0, 8)}`) } = {}) {
  let created = false;
  return {
    dir,
    async saveImage({ data, mediaType = 'image/png', name = 'image.png' } = {}) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'base64');
      if (buffer.length === 0) throw new Error('saveImage: empty image data');
      if (!created) {
        mkdirSync(dir, { recursive: true });
        created = true;
      }
      const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'image.png';
      const path = join(dir, safeName);
      writeFileSync(path, buffer);
      return {
        path,
        name: safeName,
        mediaType,
        bytes: buffer.length,
        data: buffer.toString('base64'),
      };
    },
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * 最小 DSH 宿主。
 * @param {{logger?: object, attachments?: object|null}} options
 */
export function createHostShim({ logger = console, attachments = null } = {}) {
  const captured = [];
  const disposers = [];
  const toolsService = {
    register(definition) {
      captured.push(definition);
      // 真实宿主返回注销函数；这里由 dispose() 统一处理。
      return () => {};
    },
  };
  const ctx = {
    logger,
    attachments,
    get(name) {
      if (name === 'tools') return toolsService;
      if (name === 'attachments') return attachments;
      return undefined;
    },
    effect(fn) {
      if (typeof fn !== 'function') return () => {};
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
  };
  return {
    ctx,
    captured,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose(); } catch { /* ignore，卸载路径不抛 */ }
      }
    },
  };
}

/**
 * 用假宿主跑一遍 apply()，拿到 19 个工具定义和生命周期。
 *
 * @param {{config?: object, logger?: object, attachments?: object|null, attachmentDir?: string}} options
 * @returns {{tools: Map<string, object>, list: () => object[], get: (name: string) => object|undefined,
 *            call: (name: string, args?: object) => Promise<any>, attachments: object, dispose: () => void}}
 */
export function createToolset({ config = {}, logger = console, attachments = null, attachmentDir } = {}) {
  const ownAttachments = attachments ?? createMemoryAttachments(attachmentDir ? { dir: attachmentDir } : {});
  const shim = createHostShim({ logger, attachments: ownAttachments });
  let disposed = false;
  apply(shim.ctx, config);

  const tools = new Map();
  for (const definition of shim.captured) {
    const name = definition?.name;
    if (typeof name === 'string' && name.length > 0) tools.set(name, definition);
  }
  if (tools.size === 0) {
    // 不抛：让调用方决定怎么报错（例如 MCP 仍可起服务，只是 tools/list 为空）。
    logger?.warn?.('host-shim: apply() 没有注册任何工具（tools 服务不可用？）');
  }

  return {
    tools,
    list: () => [...tools.values()],
    get: (name) => tools.get(name),
    has: (name) => tools.has(name),
    async call(name, args = {}) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`unknown tool: ${name}`);
      if (typeof tool.execute !== 'function') throw new Error(`tool ${name} has no execute()`);
      return tool.execute(args ?? {}, {});
    },
    attachments: ownAttachments,
    dispose() {
      if (disposed) return;
      disposed = true;
      shim.dispose();
      if (typeof ownAttachments.cleanup === 'function') ownAttachments.cleanup();
    },
  };
}
