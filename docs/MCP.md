# MCP 包装：把 19 个 `vrchat_*` 工具接到任意 MCP 宿主

`dsh-VRChat-vplay` 原本是 DeepSeek Harness 插件。这个目录（`mcp/`）提供一个**零依赖**的
[MCP](https://modelcontextprotocol.io) stdio 服务器，把插件里同一份工具定义（`index.js` 注册的
19 个 `vrchat_*`）原样暴露给 Claude Desktop / Cursor / Codex 或任何 MCP 客户端。

- 工具 schema、描述、执行逻辑**只有一份**：全部来自 `index.js`，通过 `lib/host-shim.mjs` 的
  `createToolset()` 跑一遍插件的 `apply()` 拿到。MCP 层不复制、不改写任何工具逻辑。
- 传输是 **stdio + 换行分隔 JSON-RPC 2.0**（每行一条消息，**不用** `Content-Length` 头）。
- stdout 只写协议消息；日志/帮助/错误全部走 stderr。
- npm 依赖 0 个，要求 Node.js ≥ 20（本机实测 Node v24.21.0），Windows 11 可用（含中文路径）。

```
mcp/
  server.mjs     # stdio MCP 服务器（传输 / 生命周期 / 请求分发）
  protocol.mjs   # 纯函数：JSON-RPC 信封、工具→MCP tool、结果→content、参数校验、配置解析
tools/
  test_mcp.mjs   # 自测：协议单测 + 真实子进程集成测试（不碰 SteamVR/VRChat）
```

---

## 1. 快速验证（不接宿主，30 秒）

```powershell
cd D:\中转站API\dsh-vrchat-vplay

# 自测：25 项全绿（协议纯函数 + 真子进程握手/工具清单/错误/在线与离线降级/退出码）
node tools/test_mcp.mjs

# 手工发一条 initialize 看响应（发完 stdin 关闭，服务器 dispose 后 exit 0）
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' |
  node mcp/server.mjs --config '{"listenEnabled":false,"panelEnabled":false}'
```

> 直接 `node mcp/server.mjs` 会一直等 stdin（这是 MCP 服务器正常的等待状态）。
> `--help` / `--version` 的输出也走 stderr，不污染协议通道。

### 1.1 官方 SDK 兼容性验证（2026-11-04 实测，独立于自测客户端）

用官方 `@modelcontextprotocol/sdk` 当客户端（临时目录安装，**不污染本包的零依赖**）连本服务器，实测通过：

| 步骤 | 结果 |
|---|---|
| `initialize` | `serverInfo = {"name":"dsh-vrchat-vplay-mcp","version":"0.7.0"}` |
| `tools/list` | **19** 个，全部有 `inputSchema.type=object` |
| `vrchat_status` | `isError=false`，text |
| `vrchat_doctor` | `isError=false`，text（当时真机 `player-ready`） |
| `vrchat_screenshot` | `isError=false`，**image/png content**，base64 约 1.72 MB |
| `vrchat_ui openQuickMenu` | `isError=false`，text「按键：左手 b 按下 140ms」 |

复跑方式（临时目录，任意位置；npm 源可用 npmmirror）：

```powershell
mkdir $env:TEMP\mcp-sdk-check; cd $env:TEMP\mcp-sdk-check
'{"name":"mcp-sdk-check","private":true,"type":"module"}' | Set-Content package.json
npm --registry=https://registry.npmmirror.com install @modelcontextprotocol/sdk
# 写一个 Client + StdioClientTransport 脚本，command=node，args=[<插件目录>/mcp/server.mjs, '--config', '{"listenEnabled":false,"panelEnabled":false}']
```

---

## 2. 宿主配置示例

三种宿主配置的核心都是同一件事：**用 `node` 跑 `mcp/server.mjs`，需要时传 `--config` 或
`VPLAY_CONFIG`**。下面的路径按本机实际位置写；换机器要改成自己的路径。

### 2.1 Claude Desktop（`%APPDATA%\Claude\claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "vrchat-vplay": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "D:\\中转站API\\dsh-vrchat-vplay\\mcp\\server.mjs",
        "--config",
        "{\"listenEnabled\":true,\"panelEnabled\":false}"
      ],
      "env": {
        "VPLAY_CONFIG": "{\"playerDir\":\"D:/中转站API/vrchat-vr-driver\"}"
      }
    }
  }
}
```

### 2.2 Cursor（项目内 `.cursor/mcp.json`，或全局 `~/.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "vrchat-vplay": {
      "command": "node",
      "args": ["D:/中转站API/dsh-vrchat-vplay/mcp/server.mjs"],
      "env": {
        "VPLAY_CONFIG": "{\"listenEnabled\":true,\"panelEnabled\":false,\"playerDir\":\"D:/中转站API/vrchat-vr-driver\"}"
      }
    }
  }
}
```

### 2.3 通用 `command + args + env`（Codex / 自研宿主 / MCP Inspector）

| 字段 | 值 |
|---|---|
| `command` | `node`（建议写绝对路径，某些宿主不继承 PATH） |
| `args` | `["D:/中转站API/dsh-vrchat-vplay/mcp/server.mjs"]`，需要时追加 `--config '<json>'` |
| `env` | `VPLAY_CONFIG='<json>'`（可选） |

### 2.4 配置从哪来：CLI `--config` 或环境变量

两种方式都接收**一个 JSON 对象**，键名与插件 `cordis.patch.yml` 里的 `config` 完全相同
（映射 `index.js` 的 `config`）。**优先级：`--config` > `VPLAY_CONFIG` > MCP 默认值。**

```jsonc
{
  "sendPort": 9000,          // 发往 VRChat 的 OSC 端口
  "listenPort": 9001,        // 从 VRChat 收参数的端口（events/wait 需要它）
  "listenEnabled": true,     // false = 只发不收（可避免和 DSH 插件抢 9001）
  "panelEnabled": false,     // MCP 默认 false；true 会起本地面板
  "panelPort": 8790,         // 面板端口（默认 8790，与 DSH 插件冲突时改掉）
  "playerDir": "",           // 空 = 自动探测（插件 player/ → 兄弟工程 vrchat-vr-driver/player）
  "playerMonitorPort": 8765, // 玩家监视器 HTTP 端口（不是 monitorPort）
  "vmtSendPort": 39570,      // VMT 位姿/输入（虚拟手柄）发送端口
  "vmtListenPort": 39571,    // VMT 回包监听端口
  "headPort": 39572,         // A 线 dsh_hmd 头部通道
  "doctorTimeoutMs": 9000,   // vrchat_doctor 预算
  "debug": false             // true = 把更详细的日志打到 stderr
}
```

MCP 服务器只覆盖了一个默认值：**`panelEnabled:false`**（避免 DSH 插件的 8790 面板冲突）；
其余键缺省时沿用 `index.js` 的 `DEFAULT_OPTIONS`。

PowerShell 直接跑时注意引号：

```powershell
$env:VPLAY_CONFIG='{"listenEnabled":false,"panelEnabled":false}'
node mcp/server.mjs

# 或者
node mcp/server.mjs --config '{"listenEnabled":false,"panelEnabled":false}'
```

---

## 3. 协议行为（宿主开发者关心的部分）

| 项 | 实现 |
|---|---|
| 传输 | stdin/stdout，**每行一条** JSON-RPC 2.0；无 `Content-Length`；stdout 无其它字符 |
| 协议版本 | 支持 `2024-11-05` / `2025-03-26` / `2025-06-18`；未知版本回最新支持版本 `2025-06-18` |
| `initialize` | 返回 `serverInfo` = `{name:"dsh-vrchat-vplay-mcp", version:"0.7.0"}`、`capabilities.tools`、一段 `instructions` |
| `notifications/initialized` | 只记日志，不回复 |
| `ping` | 返回 `{}` |
| `tools/list` | 19 个工具；`inputSchema` = `index.js` 的 `def.parameters`（另附通用 `outputSchema`） |
| `tools/call` | `content` = text（+ 截图时的 image block）；成功结果另带 `structuredContent`（机器可读，base64 已剔除） |
| 工具级错误 | `result.isError = true`（未知工具、参数不合法、执行抛错都走这条，不是 JSON-RPC error） |
| JSON-RPC 错误 | 解析失败 `-32700`、未知方法 `-32601`、`tools/call` 缺 `name` 等 `-32602` |
| 图片 | `{"type":"image","data":"<base64 PNG>","mimeType":"image/png"}`；base64 只在 image block 里出现一次 |
| 退出 | stdin EOF 或终端 Ctrl+C（SIGINT）→ `toolset.dispose()`（手柄归零 / socket / 玩家进程）→ `exit 0` |

`tools/call` 是**串行**处理的：一个慢工具（如 `vrchat_doctor` 约 1 秒、截图几秒、安装驱动更久）
会阻塞同一连接上的后续请求；每个工具按 `index.js` 里的 `timeoutMs` 有超时兜底（1s–600s）。

---

## 4. 19 个工具一句话说明

| # | 工具 | 作用 |
|---|---|---|
| 1 | `vrchat_status` | 查看 OSC bridge 状态、端口、当前 avatar、参数表、位姿/头部控制器状态。先调它确认链路活着。 |
| 2 | `vrchat_say` | 通过 chatbox 说话（表情气泡）；超长自动分段 + 限速，可带提示音。 |
| 3 | `vrchat_list_params` | 列出当前 avatar 的 OSC 参数最新值（手势、语音、移动速度、自定义参数）。 |
| 4 | `vrchat_events` | 读取缓冲的 OSC 事件流（参数变化 / avatar 切换 / 其它端点），可分页。 |
| 5 | `vrchat_wait` | 阻塞等待某个参数/前缀/类型的事件（如等对方挥手、等跳跃）。 |
| 6 | `vrchat_set_param` | 写一个 avatar 参数（自定义 Expression 参数 + `VRCEmote`；内置参数只读）。 |
| 7 | `vrchat_input` | 按一个官方 OSC 输入动作（Jump / Run / MoveForward / Voice / PanicButton…），轴自动归零。 |
| 8 | `vrchat_move` | 推摇杆走路/侧移/转向一段时间，然后释放所有轴。 |
| 9 | `vrchat_pose` | 驱动虚拟手柄（VMT）双手位姿：平滑移动、抬手/挥手、保持/取消，可只动一只手。 |
| 10 | `vrchat_head` | 驱动头部/HMD（A 线 `dsh_hmd`）位姿与朝向：转头、抬头、点头，带呼吸微动。 |
| 11 | `vrchat_look` | 转头：相对角度或面向世界坐标点；`auto` = 有 HMD 驱动就真转头，否则 snap turn。 |
| 12 | `vrchat_player` | 管理虚拟玩家进程：`start` / `stop` / `status` / `log`（含看门狗、监视器 URL）。 |
| 13 | `vrchat_player_preflight` | 真实玩家启动前体检（驱动端点 / 进程是否就绪）。 |
| 14 | `vrchat_doctor` | 只读整机体检：返回 `verdict`（`chat-ready`/`pose-ready`/`player-ready`/`not-ready`）、`summary`、`nextSteps`。 |
| 15 | `vrchat_mode` | 一键挡位：`player`（真机虚拟玩家）/ `demo`（只喂 3D 监视器，不碰 VR）/ `chat` / `stop`。 |
| 16 | `vrchat_ui` | 虚拟手柄按键：A/B/system/grip/扳机/摇杆，以及开快捷菜单、选中、抓取等组合动作。 |
| 17 | `vrchat_screenshot` | 截 SteamVR「Headset Window」（桌面模式退回 VRChat 窗口）并返回图片，是 agent 的眼睛。 |
| 18 | `vrchat_drivers` | 随包两个 SteamVR 驱动（`dsh_hmd` + `vmt`）的状态 / 安装 / 卸载。 |
| 19 | `vrchat_osc_send` | 逃生通道：直接发一条原始 OSC 消息（地址 + 类型化参数）。 |

> 违规使用（绕过反作弊、多开挂机、代练等）与作者无关；使用前请读仓库根目录的 `AUP.md`。

---

## 5. Windows / 中文路径注意事项

1. **JSON 里的反斜杠要转义**：`"D:\\中转站API\\dsh-vrchat-vplay\\mcp\\server.mjs"`；
   或者统一用正斜杠 `"D:/中转站API/dsh-vrchat-vplay/mcp/server.mjs"`（Windows 上 Node 接受）。
2. **路径含中文时不建议经过 shell 拼接**：MCP 配置的 `args` 是数组，直接写完整路径即可；
   `--config` 的 JSON 也作为一个参数整体传入，不要在中间再套 `cmd /c`、`%变量%`、引号拼接。
3. **`command` 用 Node 绝对路径**（如 `C:\\Program Files\\nodejs\\node.exe`）最稳：
   部分宿主以服务/其它用户身份启动，不继承你终端里的 PATH。
4. `VPLAY_CONFIG` 的值必须是一段**字符串化的 JSON**（外层引号属于宿主配置语法）；
   写坏了服务器会直接报配置错误并 exit 1，错误信息在宿主的 MCP 日志/stderr 里。
5. 不要给这个服务器配 `cwd` 依赖的相对路径：源码里 `player/` 不存在（发布包才有），
   开发期靠自动探测兄弟目录 `..\vrchat-vr-driver\player`；不确定时显式配 `playerDir`。
6. 中文日志在宿主日志面板里可能显示为乱码（编码问题），不影响协议；本机 PowerShell 用
   `Get-Content` 看 UTF-8 无 BOM 文件也可能乱码，别据此判断文件坏了。

---

## 6. 已知限制 / 坑

1. **和 DSH 插件抢 9001**：同一台机器 DSH 插件正在跑时已经监听了 `listenPort=9001`，MCP 再监听会失败
   （stderr 里一条 `cannot listen ...` 警告，工具本身不崩）。此时 **发送类**工具（say / set_param /
   input / move / ui / pose / head）仍然可用，**接收类**（events / wait / status 里的参数表）收不到事件。
   解决办法：给 MCP 配 `"listenEnabled":false`（只发不收），或把 MCP 的 `listenPort` 改到别的端口，
   并让 VRChat 的 OSC 发送端口指到同一端口（VRChat 启动参数 `--osc=<port>`）。
2. **panel 默认关闭**：MCP 默认 `panelEnabled:false`，避免和 DSH 插件的 `8790` 面板冲突。
   要面板就显式开 `panelEnabled:true`，并保证同一时间只有一个进程用它。
3. **截图需要 SteamVR 运行**（「Headset Window」窗口）。SteamVR 不在时 `vrchat_screenshot` 返回
   `ok:false` 的**文本说明**且 `isError=false`（优雅降级，不打断模型）；桌面模式下只有检测到
   `VRChat.exe` 在跑才允许退回 VRChat 窗口截图。
4. **真机动作需要驱动**：`vrchat_pose` / `vrchat_head` / `vrchat_ui` 在没装 `dsh_hmd` / `vmt` 时
   发包到没人听的 UDP，工具照样返回成功（降级），但游戏里不会有反应；先调 `vrchat_doctor` 看 `verdict`。
5. **本机同时跑 DSH 插件 + MCP**：除端口外没有共享状态，`vrchat_player` 的子进程互相看不见；
   同一时间只建议一方管理玩家进程（两边都可能 spawn `player/demo.mjs`）。
6. **Windows 上外部 `SIGTERM` 无法被 JS 捕获**：宿主/任务管理器用 TerminateProcess 杀掉时，
   Node 的 `process.on('SIGTERM')` 不会执行（这是 Node on Windows 的信号模拟限制）。
   stdin 被宿主关闭（正常退出路径）和终端 Ctrl+C（SIGINT）会正常 `dispose()` 并 `exit 0`。
7. **一次只服务一个宿主连接**：这是 stdio 服务器，一个进程对应一个 MCP 客户端；多个宿主请各配一个实例
   （注意上面的端口错开问题）。
8. **`structuredContent` 是可选扩展**：不识别它的宿主会忽略；工具结果的人类可读文本始终在 `content` 里。
9. **`vrchat_player` 相关工具会 spawn 子进程**：`start` 真正启动 `player/demo.mjs`；MCP 退出时
   `dispose()` 会停掉它。若宿主强杀进程，可能残留 demo 子进程，用任务管理器结束即可。
10. **`npm pack` 产物里暂时没有 `mcp/`**：`package.json` 的 `files` 目前只含插件本体（`index.js`/`lib`/
    `player`/`drivers`/`docs`…），没有 `mcp`；所以从 tgz 安装的副本里没有 MCP 服务器，MCP 场景请直接从
    源码目录运行（本文件 §2 的路径就是源码目录）。要把 MCP 一起发进包，需要把 `"mcp"` 加进
    `package.json` 的 `files`——那是发布决策，不在这次改动范围内。

---

## 7. 与 DSH 插件的关系

- 同一份 `index.js` 工具定义、同一份 `lib/` 实现；`mcp/` 只是换了一个宿主壳。
- 改工具行为请只改 `index.js` / `lib/`，MCP 会自动跟着变，**不要**在 `mcp/` 里复制工具逻辑。
- 插件用 `cordis.patch.yml` 配置；MCP 用 `--config` / `VPLAY_CONFIG`，键名一致。
- 回归测试：`node tools/test_mcp.mjs` 全绿，同时 `node tools/plugin-offline-test.mjs` 仍须 21 项全绿
  （MCP 改动不应影响插件本身）。
