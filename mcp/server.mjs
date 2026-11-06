#!/usr/bin/env node
// mcp/server.mjs — dsh-vrchat-vplay 的零依赖 MCP stdio 服务器。
//
// 用法：
//   node mcp/server.mjs --config '{"listenEnabled":false,"panelEnabled":false}'
//   VPLAY_CONFIG='{"playerDir":"D:/path/to/player"}' node mcp/server.mjs
//
// 传输：**换行分隔的 JSON-RPC 2.0**（每行一条消息，绝不用 Content-Length 头）。
// stdout 只写协议消息；所有日志/帮助/错误都走 stderr。
// stdin 关闭（EOF）或收到 SIGINT/SIGTERM → toolset.dispose() 后 exit 0。
//
// 工具定义与执行逻辑全部来自 index.js（通过 lib/host-shim.mjs 的 createToolset()），
// 这里不复制任何工具逻辑；协议细节在 mcp/protocol.mjs（纯函数、可单测）。
import process from 'node:process';
import { format } from 'node:util';
import { createToolset } from '../lib/host-shim.mjs';
import * as proto from './protocol.mjs';

const HELP = `dsh-vrchat-vplay MCP 服务器（stdio，换行分隔 JSON-RPC）

用法:
  node mcp/server.mjs [--config '<json>']

配置:
  --config '<json>'     传给 index.js 的 config（JSON 对象字符串）
  环境变量 VPLAY_CONFIG  同上；命令行优先于环境变量
  常用键: sendPort / listenPort / listenEnabled / panelEnabled / playerDir /
          monitorPort 叫 playerMonitorPort / vmtListenPort / headPort / debug
  默认 panelEnabled=false（避免和 DSH 插件的 8790 面板冲突）
  playerDir 留空 = 自动探测（插件自带 player/ → 兄弟工程 vrchat-vr-driver/player）

示例:
  node mcp/server.mjs --config '{"listenEnabled":true,"playerDir":"<配套工程目录>"}'

本进程自己不该被终端直接使用：请配置到 MCP 宿主里（见 docs/MCP.md）。
`;

function createLogger(debugEnabled) {
  const write = (level, args) => {
    try {
      process.stderr.write(`[vplay-mcp ${level}] ${format(...args)}\n`);
    } catch {
      // stderr 写不出去也不能影响协议主循环。
    }
  };
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => {
      if (debugEnabled) write('debug', args);
    },
  };
}

// ── 配置 ────────────────────────────────────────────────────────────────────

const resolved = proto.resolveMcpConfig({ argv: process.argv.slice(2), env: process.env });
if (!resolved.ok) {
  process.stderr.write(`[vplay-mcp error] 配置错误：${resolved.error}\n`);
  process.stderr.write('[vplay-mcp error] 用 --help 查看用法。\n');
  process.exit(1);
}
if (resolved.help) {
  process.stderr.write(HELP);
  process.exit(0);
}
if (resolved.version) {
  process.stderr.write(`${proto.SERVER_INFO.name} ${proto.SERVER_INFO.version}\n`);
  process.exit(0);
}

const logger = createLogger(resolved.config.debug === true);
for (const warning of resolved.warnings) logger.warn(warning);

// ── 工具集（跑一遍 index.js 的 apply()，拿到 19 个工具定义）──────────────────

let toolset;
try {
  toolset = createToolset({ config: resolved.config, logger });
} catch (error) {
  logger.error(`初始化工具集失败：${String(error?.stack ?? error?.message ?? error)}`);
  process.exit(1);
}
logger.info(
  `dsh-vrchat-vplay MCP ${proto.SERVER_INFO.version} 已启动（pid=${process.pid}，`
  + `stdio 换行分隔 JSON-RPC，${toolset.tools.size} 个工具）`,
);
if (toolset.tools.size !== 19) {
  logger.warn(`工具数量异常：期望 19 个，实际 ${toolset.tools.size} 个（检查 index.js 是否正常加载）`);
}
if (resolved.config.panelEnabled === true) {
  logger.warn('panelEnabled=true：本机面板会占端口（默认 8790），与 DSH 插件同时运行可能冲突');
}

// ── JSON-RPC 发送 ───────────────────────────────────────────────────────────

function writeMessage(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    logger.error(`写 stdout 失败：${String(error?.message ?? error)}`);
  }
}

function sendResult(id, result) {
  writeMessage(proto.createJsonRpcResult(id, result));
}

function sendError(id, code, message, data) {
  writeMessage(proto.createJsonRpcError(id, code, message, data));
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let shuttingDown = false;
let shutdownPromise = null;
/** 串行处理队列：保证响应顺序稳定，EOF 时也能等当前工具调用收尾。 */
let queue = Promise.resolve();

function shutdown(reason, { graceMs = 3000 } = {}) {
  if (shutdownPromise !== null) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    logger.info(`收到关闭信号（${reason}），等待当前调用收尾…`);
    if (graceMs > 0) {
      try {
        await Promise.race([queue.catch(() => {}), sleep(graceMs)]);
      } catch {
        // 收尾等待失败不影响退出码。
      }
    }
    try {
      toolset.dispose();
      logger.info('toolset.dispose() 完成（手柄归零 / socket / 玩家进程已释放），退出 0');
    } catch (error) {
      logger.warn(`toolset.dispose() 出错（仍然退出 0）：${String(error?.message ?? error)}`);
    }
    process.exit(0);
  })();
  return shutdownPromise;
}

// ── 请求处理 ────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolNameList() {
  return toolset.list().map((definition) => definition?.name).filter((name) => typeof name === 'string');
}

function runWithTimeout(promise, timeoutMs, label) {
  const budget = Math.max(1000, Math.min(600_000, Number.isFinite(timeoutMs) ? timeoutMs : 120_000));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} 超时（${budget}ms）：宿主没有在预算内返回；检查 SteamVR/VRChat/驱动是否在跑`));
    }, budget);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function handleToolsCall(id, params) {
  if (!isPlainObject(params)) {
    sendError(id, proto.ERROR_CODES.INVALID_PARAMS, 'tools/call 的 params 必须是对象（含 name / arguments）');
    return;
  }
  const toolName = typeof params.name === 'string' ? params.name.trim() : '';
  if (toolName.length === 0) {
    sendError(id, proto.ERROR_CODES.INVALID_PARAMS, 'tools/call 缺少工具名 name');
    return;
  }
  const definition = toolset.get(toolName);
  if (definition === undefined) {
    // 未知工具走工具级 isError（不是 JSON-RPC error），模型能看懂并改调别的工具。
    sendResult(id, proto.toolErrorResult(`未知工具：${toolName}。可用工具：${toolNameList().join(', ')}`));
    return;
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  const validation = proto.validateToolArgs(definition, args);
  if (!validation.ok) {
    sendResult(id, proto.toolErrorResult(`参数错误（${toolName}）：${validation.problems.join('；')}`));
    return;
  }
  logger.info(`tools/call ${toolName}${args !== null && typeof args === 'object' ? ` ${JSON.stringify(args).slice(0, 300)}` : ''}`);
  try {
    const value = await runWithTimeout(
      toolset.call(toolName, args),
      definition.timeoutMs,
      `工具 ${toolName}`,
    );
    sendResult(id, proto.buildToolCallResult(definition, args, value));
  } catch (error) {
    const message = String(error?.message ?? error);
    logger.error(`工具 ${toolName} 执行失败：${message}`);
    if (error?.stack) logger.debug(error.stack);
    sendResult(id, proto.toolErrorResult(`工具执行失败（${toolName}）：${message}`));
  }
}

async function handleMessage(message) {
  if (Array.isArray(message)) {
    // MCP stdio 一次一行一条消息；2025-06-18 已移除 JSON-RPC 批量。
    sendError(null, proto.ERROR_CODES.INVALID_REQUEST, '不支持 JSON-RPC 批量请求；每行发送一条消息');
    return;
  }
  if (!isPlainObject(message)) {
    sendError(null, proto.ERROR_CODES.INVALID_REQUEST, 'JSON-RPC 消息必须是对象');
    return;
  }
  if (message.jsonrpc !== undefined && message.jsonrpc !== proto.JSONRPC_VERSION) {
    sendError(null, proto.ERROR_CODES.INVALID_REQUEST, `不支持的 jsonrpc 版本：${String(message.jsonrpc)}（应为 "2.0"）`);
    return;
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
  const id = hasId ? message.id : null;
  const params = message.params;

  // 通知（无 id）：按规范不回响应。
  if (!hasId) {
    if (method === 'notifications/initialized') {
      logger.info('收到 notifications/initialized（握手完成）');
    } else if (method === 'notifications/cancelled') {
      logger.warn('收到 notifications/cancelled：当前实现是串行处理，无法中断已在执行的工具调用');
    } else {
      logger.warn(`忽略未知通知：${method || '(无 method)'}`);
    }
    return;
  }

  if (method.length === 0) {
    sendError(id, proto.ERROR_CODES.INVALID_REQUEST, '请求缺少 method');
    return;
  }

  switch (method) {
    case 'initialize': {
      const requestedVersion = isPlainObject(params) ? params.protocolVersion : undefined;
      const clientName = isPlainObject(params?.clientInfo) ? params.clientInfo.name : undefined;
      const result = proto.buildInitializeResult(requestedVersion);
      logger.info(
        `initialize：客户端 ${typeof clientName === 'string' ? clientName : '(未命名)'} `
        + `请求协议 ${typeof requestedVersion === 'string' ? requestedVersion : '(缺省)'} → 使用 ${result.protocolVersion}`,
      );
      sendResult(id, result);
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list': {
      logger.info(`tools/list：返回 ${toolset.tools.size} 个工具`);
      sendResult(id, proto.toolsListResult(toolset.list()));
      return;
    }
    case 'tools/call':
      await handleToolsCall(id, params);
      return;
    default:
      sendError(id, proto.ERROR_CODES.METHOD_NOT_FOUND, `未知方法：${method}`);
  }
}

// ── stdin 主循环（换行分隔）────────────────────────────────────────────────

process.stdin.setEncoding('utf8');
let buffer = '';

/** 处理一行输入（不含换行符）：解析 → 入队串行执行。 */
function ingestLine(line) {
  if (shuttingDown) return; // 关闭流程开始后不再接新请求（已在队列里的会跑完）
  const parsed = proto.parseJsonRpcLine(line);
  if (parsed.empty) return;
  if (!parsed.ok) {
    // 解析失败按 JSON-RPC -32700；id 未知用 null。
    logger.warn(`stdin JSON 解析失败：${parsed.error}`);
    sendError(null, proto.ERROR_CODES.PARSE_ERROR, 'JSON 解析失败', parsed.error);
    return;
  }
  // 串行化：慢工具（doctor/截图）不会打乱响应顺序，也避免并发写 stdout。
  queue = queue
    .then(() => handleMessage(parsed.message))
    .catch((error) => {
      logger.error(`处理请求失败：${String(error?.stack ?? error?.message ?? error)}`);
    });
}

process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf('\n');
    ingestLine(line);
  }
});

process.stdin.on('end', () => {
  // 容错：最后一条消息可能没有结尾换行（规范要求有，但别因此丢请求）。
  if (buffer.trim().length > 0) {
    const pendingLine = buffer;
    buffer = '';
    ingestLine(pendingLine);
  }
  logger.info('stdin 已关闭（EOF）');
  void shutdown('stdin-eof', { graceMs: 3000 });
});
process.stdin.on('error', (error) => {
  logger.error(`stdin 出错：${String(error?.message ?? error)}`);
  void shutdown('stdin-error', { graceMs: 500 });
});

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') {
    logger.warn('stdout 通道已断（EPIPE），准备退出');
    void shutdown('stdout-epipe', { graceMs: 0 });
  } else {
    logger.error(`stdout 出错：${String(error?.message ?? error)}`);
  }
});

process.on('SIGINT', () => {
  void shutdown('SIGINT', { graceMs: 0 });
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM', { graceMs: 0 });
});

process.on('uncaughtException', (error) => {
  logger.error(`未捕获异常：${String(error?.stack ?? error?.message ?? error)}`);
  try {
    toolset.dispose();
  } catch {
    // 退出路径不再抛。
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // 工具执行错误都在 handleToolsCall 里捕获；这里兜住其它 fire-and-forget 的拒绝，不退出。
  logger.warn(`未处理的 Promise 拒绝：${String(reason?.stack ?? reason?.message ?? reason)}`);
});
