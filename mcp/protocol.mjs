// mcp/protocol.mjs — MCP 协议层的纯函数（无 I/O、无全局状态），方便单测。
//
// 只做四件事：
//   1) JSON-RPC 2.0 消息/错误构造 + 单行解析（换行分隔，不用 Content-Length）；
//   2) 插件工具定义（index.js 注册的 19 个 vrchat_*）→ MCP tools/list 条目；
//   3) 工具执行结果 → MCP content 列表（文本 / 图片；base64 只在 image block 里出现一次，
//      不会重复塞进文本 JSON）；
//   4) MCP 服务器的配置解析（CLI --config '<json>' / 环境变量 VPLAY_CONFIG）与参数校验。
//
// server.mjs 只负责传输和生命周期，所有可测逻辑都在这里。

export const JSONRPC_VERSION = '2.0';

/** 服务器身份：MCP initialize 会原样回给客户端。 */
export const SERVER_INFO = Object.freeze({ name: 'dsh-vrchat-vplay-mcp', version: '0.7.0' });

/** 支持的 MCP 协议版本（新的在前）；握手时未知版本回最新支持版本。 */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 标准错误码（MCP 沿用）。 */
export const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** MCP 服务器自己的默认配置：panel 默认关闭，避免和 DSH 插件的 8790 面板抢端口。 */
export const MCP_DEFAULT_CONFIG = Object.freeze({ panelEnabled: false });

const TYPE_NAMES = Object.freeze({
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔值',
  object: '对象',
  array: '数组',
  null: 'null',
});

/** 深拷贝 JSON 值（schema 来自 index.js，返回给客户端前复制一份，避免被外部改坏）。 */
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

// ── 版本协商 / initialize ────────────────────────────────────────────────────

/**
 * 协商 MCP 协议版本：客户端给的支持就原样返回，未知/缺失回最新支持版本。
 * @param {unknown} requested 客户端 initialize.params.protocolVersion
 * @returns {string}
 */
export function negotiateProtocolVersion(requested) {
  return typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/**
 * 构造 initialize 的 result。纯函数，server 直接发给客户端。
 * @param {unknown} requestedProtocolVersion
 */
export function buildInitializeResult(requestedProtocolVersion) {
  return {
    protocolVersion: negotiateProtocolVersion(requestedProtocolVersion),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...SERVER_INFO },
    instructions:
      '本机 VRChat 自动化工具（19 个 vrchat_*）：OSC 说话/参数/按键、虚拟手柄点击、位姿与头部、'
      + '截图、体检、虚拟玩家进程。stdio 传输，换行分隔 JSON-RPC；日志只走 stderr。',
  };
}

// ── JSON-RPC 信封 ───────────────────────────────────────────────────────────

/** @param {string|number|null} id @param {unknown} result */
export function createJsonRpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result: result === undefined ? {} : result };
}

/**
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
export function createJsonRpcError(id, code, message, data) {
  const error = { code: Number.isInteger(code) ? code : ERROR_CODES.INTERNAL_ERROR, message: String(message ?? 'error') };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/**
 * 解析一行输入（stdin 是按行分隔的 JSON-RPC，不是 Content-Length 帧）。
 * @param {string} line
 * @returns {{ok:true, message:unknown}|{ok:false, empty:boolean, error?:string}}
 */
export function parseJsonRpcLine(line) {
  const text = typeof line === 'string' ? line.replace(/\r$/, '').trim() : '';
  if (text.length === 0) return { ok: false, empty: true };
  try {
    return { ok: true, message: JSON.parse(text) };
  } catch (error) {
    return { ok: false, empty: false, error: String(error?.message ?? error) };
  }
}

// ── tools/list ──────────────────────────────────────────────────────────────

/**
 * 插件工具定义 → MCP tools/list 条目。
 * inputSchema 直接用 index.js 的 def.parameters（不复制工具逻辑，也不改 schema 语义）。
 * @param {object} definition index.js 注册的工具定义
 */
export function toMcpTool(definition) {
  const def = definition !== null && typeof definition === 'object' ? definition : {};
  const name = typeof def.name === 'string' ? def.name : '';
  const description = typeof def.description === 'string' ? def.description : '';
  let inputSchema = cloneJson(def.parameters ?? null);
  if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  }
  if (typeof inputSchema.type !== 'string') inputSchema.type = 'object';
  const outputSchema = cloneJson(def.output?.schema ?? { type: 'object', additionalProperties: true });
  return { name, description, inputSchema, outputSchema };
}

/**
 * tools/list 的 result。
 * @param {object[]} definitions
 */
export function toolsListResult(definitions) {
  const list = Array.isArray(definitions) ? definitions : [];
  return { tools: list.map(toMcpTool) };
}

// ── 工具结果 → MCP content ─────────────────────────────────────────────────

/**
 * 附件对象（lib/host-shim.mjs 的 saveImage 返回值）→ MCP image content。
 * MCP 图片 content 只有三个字段：{type:'image', data:<base64>, mimeType}。
 * @param {object|null|undefined} attachment
 */
export function attachmentToImageContent(attachment) {
  if (attachment === null || typeof attachment !== 'object') return null;
  let data = attachment.data;
  if (Buffer.isBuffer(data)) data = data.toString('base64');
  if (typeof data !== 'string' || data.length === 0) return null;
  const mimeType = typeof attachment.mediaType === 'string' && attachment.mediaType.length > 0
    ? attachment.mediaType
    : (typeof attachment.mimeType === 'string' && attachment.mimeType.length > 0 ? attachment.mimeType : 'image/png');
  return { type: 'image', data, mimeType };
}

/** 工具结果里可能挂着一个图片附件（screenshot 的 value.image）；取出第一个。 */
function extractImageAttachment(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value.image;
  if (candidate !== null && typeof candidate === 'object') return attachmentToImageContent(candidate);
  return null;
}

/**
 * 把带 base64 的附件对象替换成元数据，避免同一个 base64 既进 image block 又进文本 JSON。
 * 递归处理，保持其余字段原样。
 */
export function publicValue(value) {
  return stripBinary(value);
}

function stripBinary(value) {
  if (Array.isArray(value)) return value.map((item) => stripBinary(item));
  if (value !== null && typeof value === 'object') {
    const isAttachment = typeof value.data === 'string'
      && (typeof value.mediaType === 'string' || typeof value.mimeType === 'string' || value.type === 'image');
    if (isAttachment) {
      const { data, ...rest } = value;
      return { ...rest, base64Chars: data.length };
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = stripBinary(item);
    return out;
  }
  return value;
}

/** 值 → 文本（对象走 JSON 美化；undefined 也保证产出字符串）。 */
function valueToText(value) {
  const publicResult = publicValue(value);
  if (typeof publicResult === 'string') return publicResult;
  try {
    const text = JSON.stringify(publicResult, null, 2);
    return typeof text === 'string' ? text : String(publicResult);
  } catch {
    return String(publicResult);
  }
}

/**
 * 通用回退：任意工具结果 → content 列表（一个 text + 可选 image）。
 * 也是 index.js 各工具 render 抛错时的兜底。
 */
export function valueToContent(value) {
  const content = [{ type: 'text', text: valueToText(value) }];
  const image = extractImageAttachment(value);
  if (image !== null) content.push(image);
  return content;
}

/** render 返回的 block → MCP content（text / image only，其余降级成文本）。 */
function contentFromRenderBlock(block) {
  if (block === null || block === undefined) return null;
  if (typeof block === 'string') return { type: 'text', text: block };
  if (typeof block === 'object' && !Array.isArray(block)) {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    if (block.type === 'image') {
      if (block.attachment !== undefined) return attachmentToImageContent(block.attachment);
      if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
        return { type: 'image', data: block.data, mimeType: block.mimeType };
      }
    }
    if (typeof block.text === 'string') return { type: 'text', text: block.text };
  }
  try {
    return { type: 'text', text: JSON.stringify(block) };
  } catch {
    return null;
  }
}

/**
 * 宿主 render block 列表 → MCP content 列表。
 * @param {unknown} blocks
 */
export function normalizeContentBlocks(blocks) {
  const out = [];
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    const content = contentFromRenderBlock(block);
    if (content !== null) out.push(content);
  }
  return out;
}

/**
 * 工具结果 → MCP content 列表：优先用 index.js 自己的 output.render（和 DSH 里看到的一致），
 * render 不存在/抛错时退回 JSON + 图片。
 * @param {object} definition
 * @param {object} args
 * @param {unknown} value execute() 的返回值
 */
export function renderToolContent(definition, args, value) {
  try {
    const render = definition?.output?.render;
    if (typeof render === 'function') {
      const content = normalizeContentBlocks(render(args ?? {}, value));
      if (content.length > 0) return content;
    }
  } catch {
    // render 只是给人看的；失败不影响工具结果本身，退回结构化 JSON。
  }
  return valueToContent(value);
}

/**
 * 成功调用 tools/call 的 result。
 * structuredContent 给 MCP 宿主提供机器可读结果（base64 已剔除），
 * 没有 outputSchema 的客户端会忽略它，不影响兼容性。
 * @param {object} definition
 * @param {object} args
 * @param {unknown} value
 */
export function buildToolCallResult(definition, args, value) {
  const result = { content: renderToolContent(definition, args, value), isError: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = publicValue(value);
  }
  return result;
}

/** 工具级错误 → tools/call result（isError=true，而不是 JSON-RPC error）。 */
export function toolErrorResult(message) {
  return {
    content: [{ type: 'text', text: String(message ?? '未知错误') }],
    isError: true,
  };
}

// ── 参数校验（按 index.js 的 JSON Schema 子集）─────────────────────────────

function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true; // 不认识的类型不拦，交给工具自己判断
  }
}

function schemaAccepts(schema, value) {
  if (schema === null || typeof schema !== 'object') return true;
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : (Array.isArray(schema.anyOf) ? schema.anyOf : null);
  if (alternatives !== null) return alternatives.some((sub) => schemaAccepts(sub, value));
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type)
    ? schema.type
    : (typeof schema.type === 'string' ? [schema.type] : []);
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) return false;
  return true;
}

function describeSchema(schema) {
  if (schema === null || typeof schema !== 'object') return '任意值';
  if (Array.isArray(schema.enum)) return `枚举(${schema.enum.join('|')})`;
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : (Array.isArray(schema.anyOf) ? schema.anyOf : null);
  if (alternatives !== null) return alternatives.map((sub) => describeSchema(sub)).join(' 或 ');
  const types = Array.isArray(schema.type)
    ? schema.type
    : (typeof schema.type === 'string' ? [schema.type] : []);
  return types.length > 0 ? types.map((type) => TYPE_NAMES[type] ?? type).join(' 或 ') : '任意值';
}

function valueTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return TYPE_NAMES[typeof value] ?? typeof value;
}

/**
 * 轻量参数校验（只查顶层）：必填、类型、枚举、oneOf，以及 additionalProperties:false 时的未知键。
 * 返回 {ok, problems}，由 server 决定把 problems 变成 isError 文本。
 * @param {object} definition
 * @param {unknown} args
 */
export function validateToolArgs(definition, args) {
  const schema = definition?.parameters !== null && typeof definition?.parameters === 'object'
    ? definition.parameters
    : {};
  const value = args === undefined ? {} : args;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['arguments 必须是 JSON 对象'] };
  }
  const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const problems = [];
  for (const key of required) {
    if (value[key] === undefined) {
      problems.push(`缺少必填参数 ${key}（应为 ${describeSchema(properties[key])}）`);
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema === undefined) {
      if (schema.additionalProperties === false) problems.push(`未知参数 ${key}`);
      continue;
    }
    if (!schemaAccepts(propertySchema, item)) {
      problems.push(`参数 ${key} 应为 ${describeSchema(propertySchema)}，实际是 ${valueTypeName(item)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── 配置解析（CLI --config / 环境变量 VPLAY_CONFIG）────────────────────────

function parseConfigObject(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `${label} 不是合法 JSON：${String(error?.message ?? error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${label} 必须是 JSON 对象（键值对），例如 {"listenEnabled":false}` };
  }
  return { ok: true, value: parsed };
}

/**
 * 解析 MCP 服务器配置。优先级：CLI --config > 环境变量 VPLAY_CONFIG > MCP 默认值。
 * 内容原样映射给 index.js 的 config（sendPort/listenPort/listenEnabled/panelEnabled/playerDir/...）。
 *
 * @param {{argv?: string[], env?: Record<string,string|undefined>}} options
 * @returns {{ok:true, config:object, warnings:string[], help:boolean, version:boolean}
 *          |{ok:false, error:string}}
 */
export function resolveMcpConfig({ argv = [], env = {} } = {}) {
  const args = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  const warnings = [];
  let help = false;
  let version = false;
  let cliConfig = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }
    if (arg === '--config') {
      if (index + 1 >= args.length) return { ok: false, error: '--config 需要一个 JSON 字符串参数' };
      const parsed = parseConfigObject(args[index + 1], '--config');
      if (!parsed.ok) return { ok: false, error: parsed.error };
      cliConfig = parsed.value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const parsed = parseConfigObject(arg.slice('--config='.length), '--config');
      if (!parsed.ok) return { ok: false, error: parsed.error };
      cliConfig = parsed.value;
      continue;
    }
    warnings.push(`忽略未知命令行参数：${arg}（只支持 --config / --help / --version）`);
  }

  if (help || version) {
    return { ok: true, config: { ...MCP_DEFAULT_CONFIG }, warnings, help, version };
  }

  let envConfig = null;
  const envRaw = typeof env?.VPLAY_CONFIG === 'string' ? env.VPLAY_CONFIG.trim() : '';
  if (envRaw.length > 0) {
    const parsed = parseConfigObject(envRaw, 'VPLAY_CONFIG');
    if (!parsed.ok) return { ok: false, error: parsed.error };
    envConfig = parsed.value;
  }

  return {
    ok: true,
    config: { ...MCP_DEFAULT_CONFIG, ...(envConfig ?? {}), ...(cliConfig ?? {}) },
    warnings,
    help: false,
    version: false,
  };
}
