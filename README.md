# dsh-VRChat-vplay

> ① **非官方项目**，与 VRChat Inc.、Valve Corporation 无任何关联，未获其背书或授权。
> ② **明确禁止**用本工具**骚扰他人、刷屏、冒充真人，或规避平台限制/封禁**。
> ③ 使用者违反上述规则的一切后果**与作者无关**，作者**不承担任何责任**。

`dsh-VRChat-vplay`（包名/目录：`dsh-vrchat-vplay`）是给 **DeepSeek Harness（DSH）** 用的一个 Host 插件：把 agent 接到**本机**运行中的 VRChat，通过 VRChat 官方 **OSC** 接口和 SteamVR **虚拟设备驱动**实现"说话 / 听参数 / 按输入 / 动头动手 / 启动虚拟玩家进程"。

> 自 **0.5.0** 起是**自包含**发布包：插件本体 + 配套 Phase 1 玩家工程（`player/`，含真感知、A* 导航、三维骨架监视器）一起分发；**0.6.0 起连两个 SteamVR 驱动也随包自带**（`drivers/dsh_hmd` + `drivers/vmt` + 安装/卸载脚本），并新增**本地按钮面板**（`http://127.0.0.1:8790/`）——不敲命令行也能体检、切挡、按键、截图、装驱动；**0.7.0 起 19 个能力可脱离 DSH 使用**——内置 **MCP stdio 服务器**（`mcp/server.mjs`，任意 MCP 宿主可用）+ **独立 daemon**（`tools/vplayd.mjs`，不开 DSH 也能起面板），并修复了"有窗口盖住 SteamVR Headset Window 时截到错误画面"的问题。
>
> 中文为主；文末有 ≤120 词的 English summary。
> 版本 **0.7.0** · 最后更新 **2026-11-04** · 许可 **MIT**（`LICENSE`）· 使用政策 **`AUP.md`**

---

## 它是什么 / 不是什么

**是：**

- 一个**本地运行**的 DSH Host 插件（`cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch`，Host-only bundle）；
- 通过 **VRChat 官方 OSC**（UDP 9000 发 / 9001 收）说话、读 avatar 参数、触发 `/input/*`；
- 可选地通过 **SteamVR 虚拟设备驱动**动头动手：头部走自研 HMD 驱动 `dsh_hmd`（UDP 39572），双手走自编译 VMT 驱动（UDP 39570/39571）；
- 可选地**启动配套的 Phase 1 虚拟玩家进程**（`vrchat-vr-driver/player/demo.mjs`）并查看它的监视器。

**不是：**

- ❌ 不是客户端注入/Mod/插件（不注入、不修改 VRChat 客户端）；
- ❌ 不是 EAC 绕过或反作弊规避工具；
- ❌ 不是账号代练、刷时长、批量多开、无人值守挂机工具；
- ❌ 不能读取聊天文字或语音（VRChat OSC 没有这个接口）。

---

## 工具清单（19 个）

| 工具 | 做什么（一句话） | 额外驱动 |
|---|---|---|
| `vrchat_doctor` | **体检**：只读、约 2 秒，告诉你现在能用哪一档（只对话 / 能转头抬手 / 完整虚拟玩家）和**下一步该做什么**；装完先跑它 | 无 |
| `vrchat_mode` | **一键切挡位**：`player` 真机虚拟玩家 / `demo` 演练（只喂三维监视器、不碰 VR）/ `chat` 只对话 / `stop` 关掉；`perception`、`nav`、`launch` 都在这一步里定 | 无（`player` 挡见 §依赖） |
| `vrchat_status` | 看链路状态：是否在听 VRChat、端口、当前 avatar、参数快照、头/手/转头通道状态；**先跑它** | 无 |
| `vrchat_say` | 通过 chatbox（角色头顶气泡）说话；自动分段、限速、排队 | 无 |
| `vrchat_events` | 读 VRChat 发来的 OSC 事件流（参数变化/avatar 变化等），支持游标与过滤 | 无 |
| `vrchat_wait` | 阻塞等一个匹配事件（挥手/跳跃/移动/语音/自定义参数），是 agent "在游戏里听"的关键 | 无 |
| `vrchat_list_params` | 列当前 avatar 参数（名字/最新值/类型/多久之前），用来感知玩家在干什么 | 无 |
| `vrchat_set_param` | 写一个 avatar 参数（`/avatar/parameters/<name>`，表情/自定义参数；内置参数只读） | 无 |
| `vrchat_input` | 按一次官方 `/input/*` 动作（跳/跑/移动/抓/用/放/菜单/舒适转身/语音/紧急按钮；轴自动归零） | 无 |
| `vrchat_move` | 像握着手柄一样按住 Vertical/Horizontal/LookHorizontal 走/转 durationMs，然后全部归零 | 无 |
| `vrchat_pose` | 驱动**双手**位姿：向 VMT 发 `/VMT/Room/Unity`（30–90Hz 平滑插值，可 hold、可打断、可交还真实手柄） | **VMT** |
| `vrchat_head` | 驱动**头部/HMD**位姿：向 `dsh_hmd` 发 `/dsh/head/pose`（30–90Hz，可抬头低头、可 hold 呼吸） | **dsh_hmd（A 线）** |
| `vrchat_look` | 转头：`auto` 时 A 线驱动在就真转头，否则退回 VRChat snap turn（45°/步，可 planOnly） | 无（head 模式需 dsh_hmd） |
| `vrchat_ui` | **虚拟手柄动作**：按 A/B/system/grip/trigger/thumbstick/trackpad、推摇杆、松开全部键；组合动作 `openQuickMenu` / `openActionMenu` / `select` / `grab` / `use`——这是 agent **真正点 VRChat 菜单、抓/用物体**的手（VMT 现报 knuckles，VRChat 自带 binding 生效） | **VMT（knuckles 模式）** |
| `vrchat_screenshot` | 截 SteamVR「Headset Window」把画面返回给 agent（回退 VRChat 桌面窗口，且只在 VRChat.exe 在跑时才回退）；**只读、不发输入**，是 agent 操作 UI 的"眼睛" | 无 |
| `vrchat_drivers` | `status` 只读检查随包驱动（`drivers/dsh_hmd` + `drivers/vmt`）是否已注册进 `openvrpaths.vrpath` 的 `external_drivers`；`install` / `uninstall` 跑随包 `drivers/install-drivers.ps1`（vrpathreg，幂等）——**装完要重启 SteamVR** | 无（它管的就是驱动） |
| `vrchat_osc_send` | 高级逃生口：直接发一条原始 OSC（`address` + 类型化 args），**优先用专用工具** | 无 |
| `vrchat_player` | 底层进程控制：启动/停止/查看/看日志（`start` 可带 `live`/`perception`/`nav`/`map`/时长/种子/监视器端口；异常退出会被**看门狗**自动重启） | 无（`live` 时依赖 dsh_hmd + VMT + VRChat VR） |
| `vrchat_player_preflight` | 实机前只读体检（检查 HMD/VMT/VRChat 端点与进程），**不启动游戏、不发位姿** | 无 |

> 名称以 `index.js` 注册的为准。日常**只需要记住两个**：`vrchat_doctor`（先看能不能用）和 `vrchat_mode`（切挡位）；要"用手点菜单"再记住 `vrchat_screenshot` + `vrchat_pose` + `vrchat_ui` 三件套；其余都是它切过去的挡位里自动干活的手脚。

---

## 小白三步走（不记参数版）

```text
① vrchat_doctor
   → 告诉你："现在只能对话挡 ✅ / 能转头抬手了 ⚠️ / 虚拟玩家可用 ✅"，以及下一步那一行。

② vrchat_mode({ preset: "demo" })
   → 演练挡：不碰游戏，只开三维骨架监视器（http://127.0.0.1:8765/），先看它走得像不像人。

③ vrchat_mode({ preset: "player" })
   → 真机挡：体检没过会直接告诉你缺什么（Steam / SteamVR / VRChat / 驱动）；
     想让它自己开游戏就加 launch: true（按 Steam → SteamVR → VRChat 的顺序启动并等待）。
```

换感知方式、开关导航也都在同一个工具里：`vrchat_mode({ preset: "player", perception: "vision", nav: "on" })`；正在跑的时候改，会自动按新挡位重启，不用先 stop。

---

## 本地面板（不敲命令行，0.6.0 新增）

不想让 agent 代劳、也不想记工具名时，用浏览器点：

```text
http://127.0.0.1:8790/
```

- **默认开启**（`panelEnabled: true`），只绑回环地址（`panelHost: 127.0.0.1`），不出本机。
- 一排按钮：**体检 / 演练 / 真机 / 停止 / 关掉 SteamVR 面板 / 显示 SteamVR 面板 / 松开所有键 / 开监视器 / 左·右 / A·B·Trigger·Grip / 摇杆四向**；右侧显示体检结果与最近操作日志（SSE 实时推）。
- 面板 API 的动作白名单还包含 `status` / `screenshot` / `driversStatus` / `installDrivers`（供页面/脚本调用；**当前页面模板未放"截图/装驱动"按钮**，需要时直接用 `vrchat_screenshot`、`vrchat_drivers` 工具，或后续补按钮）。
- 面板的 `POST /api/action` 有**动作白名单**（只接受上面的动作），越权/未知动作直接拒绝；它不读文件、不执行 shell。
- 面板只是调用同一套工具（`vrchat_doctor` / `vrchat_mode` / `vrchat_ui` / `vrchat_player` / `vrchat_screenshot`），所以行为和 agent 调用完全一致。
- 关掉：`panelEnabled: false` 或改 `panelPort`。
- **"关掉/显示 SteamVR 面板"按钮**：走 SteamVR 自带的 `vrcmd.exe --hidedashboard / --showdashboard`（客户端命令，实测可用，输出 `HideDashboard` / `ShowDashboard(  )`）；找不到 vrcmd 时退回向 `dsh_hmd` 发 `/dsh/dashboard/hide|show`（可选能力）。更彻底的做法是直接在 `steamvr.vrsettings` 关掉自动弹出，见 §已知限制。

---

## 给非 DSH 宿主：MCP 服务器（0.7.0 新增）

`mcp/server.mjs` 是一个**零依赖的 MCP stdio 服务器**，把 19 个 `vrchat_*` 能力以 MCP tools 暴露给 Claude Desktop / Cursor / 任意 MCP 宿主。它不复制工具逻辑——通过 `lib/host-shim.mjs` 直接复用本插件 `index.js` 注册的同一份工具定义（schema/描述/执行完全一致）。

```jsonc
// claude_desktop_config.json / .cursor/mcp.json
{
  "mcpServers": {
    "vrchat-vplay": {
      "command": "node",
      "args": ["<本插件目录>/mcp/server.mjs",
               "--config", "{\"listenEnabled\":false,\"panelEnabled\":false}"],
      "env": { "VPLAY_CONFIG": "{\"playerDir\":\"<配套 player 的父目录>\"}" }
    }
  }
}
```

- 详细配置（各宿主写法、19 工具对照、config 键、中文路径、已知限制）见 **[`docs/MCP.md`](docs/MCP.md)**。
- 默认 `panelEnabled:false`（避免和 DSH 插件抢 8790）；同一台机器上 DSH 插件与 MCP **只能有一方反向监听 9001**（VRChat 参数事件是单播），发送/截图/按键不受影响。

## 独立 daemon：不开 DSH 也能用（0.7.0 新增）

```powershell
node tools/vplayd.mjs                        # 起本地面板 http://127.0.0.1:8790/
node tools/vplayd.mjs --panel-port 8791 --no-listen   # 和 DSH 插件同时开时（避免端口冲突）
node tools/vplayd.mjs --self-check           # 不动端口：打印 19 工具 + 体检结论
```

- 复用同一套 `apply()` 接线（面板 12 个动作与插件内完全一致），只绑 `127.0.0.1`。
- 参数、退出码、HTTP/SSE 示例、与 DSH 插件并存的端口表见 **[`docs/DAEMON.md`](docs/DAEMON.md)**。

## 瞄准点击闭环（0.7.0 新增：离线核心 + 真机伺服）

`lib/aim.mjs` 把"截图里的像素"换算成"手/头的朝向"，并提供点击后的帧差确认：`pixelToAngles` / `anglesToPixel` / `handAimFromTarget` / `framesDiffer` / `planClickSequence`（零依赖，`node tools/test_aim.mjs` → 29 项）。
`lib/laser.mjs` 在真机截图里找**激光射线**并取瞄准端点：`detectLaser` / `fitLineRansac` / `pickFarEndpoint` / `pixelErrorToHandDelta`（`node tools/test_laser.mjs` → 19 项）。
`tools/aim-servo.mjs` 是**真机视觉伺服**脚本：`--probe` 看激光、`--calibrate` 扫角度网格测增益、`--target 196,575 --click` 伺服到目标像素后扳机点击（每次截图留证）。
`tools/aim-hover.mjs` 是**菜单状态/悬停扫描脚手架**：`--scan` 网格扫描，`--click --pose yaw,pitch` 单点，`--repeat 5 --pose ...` 连续验收；内置"暗蓝面板像素比例"检测菜单开关（关≈0.005 / 开≈0.234），并保证**左手一直发流**（否则挂在左手的快捷菜单会消失）。
真机实测（2026-11-04）：Headset Window 是**双眼并排 SBS**（1280×720 = 左右各 640×720，角度按单眼宽度算）；激光颜色随背景在 `rgb(95,178,189)`–`rgb(107,229,251)` 间变化；`rotation.yaw +` = 瞄准点往右、`rotation.pitch +` = 往下；一次伺服 4 步收敛到 14 px 并点击成功。**未完成**：连续 5 次选中同一菜单项——第二轮排查确认卡在"2D 激光端点对准 ≠ 3D 射线打中 UI 面板"（VRChat 绑定里 interact 确实绑的是模拟扳机），需要几何法/反馈法；细节与下一步见 **[`docs/C-瞄准方案.md`](docs/C-瞄准方案.md)** §11。

---

## 安装 / 启用

这是 **DSH Host bundle**：`package.json` 里声明

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 往 profile 里插入一行插件（row `id: vrchat-vplay`，`name` 指向本包），并注册 **19 个** `vrchat_*` 工具。

### 方式 A（推荐，最短）：用 DSH 的 bundle 机制安装

发布物是**自包含**的（插件本体 + `player/`），两种都能装：

```text
# A1. 直接指向解包目录（npm pack 解出来的 package/ 或仓库目录）
action: install_bundle
target: <本插件目录>        # 含 package.json 的那一层：解包后的 package/，或本仓库目录

# A2. 或指向发布 tgz（不用解包）
action: install_bundle
target: <本插件目录>/dist/dsh-vrchat-vplay-0.7.0.tgz    # 打好的包在 dist/ 下
```

`install_bundle` 会把包登记到当前 profile（依赖 + bundle 列表）并持久化；装完重启 DSH（或等热加载）后，每个 agent 的工具列表里会出现 `vrchat_*`（19 个）。
> 该操作需要 Full access / 用户批准；不要手工去写 profile 的 `package.json`。
> 装完第一件事：让 agent 调 `vrchat_doctor`，它会告诉你这台机器现在到哪一档、还差什么。
> **A1 适合开发者本机**（源码目录靠兄弟工程 `vrchat-vr-driver` 提供 `player/`）；**发给别人用 A2**，tgz 里已经自带 `player/`。

### 从 0.4.x 升级（重要）

1. 用 0.6.0 的包替换旧的（`remove_bundle` 旧的再 `install_bundle` 新的，见上一节）。
2. 如果旧配置里手填过 `playerDir`（指向某个 `<工作目录>\vrchat-vr-driver` 之类的绝对路径），**删掉它或留空**——0.5.0+ 默认自动探测（包内 `player/` 优先），不用再手填路径。
3. 新增的可选配置见 §配置在哪（挡位默认值、自动启动游戏等），不填也能用。

### 方式 B（开发者：本地 link 安装，最短 4 步）

> 仓库根就是这个插件目录；profile 位于 `%USERPROFILE%\.dsh\profiles\<profile>`。
> 手工改 profile 需要 Full access；能用方式 A 就优先方式 A。

1. 在 profile 的 `package.json` 的 `dependencies` 里，把本插件指向新目录（已有旧 link 就改目标；键名随包名）：
   ```json
   "dsh-vrchat-vplay": "link:/absolute/path/to/dsh-vrchat-vplay"
   ```
2. 确认 `dsh.profile.bundles` 数组里包含同一个名字（`dsh-vrchat-vplay`）；如果 profile 里还挂着旧条目（旧包名 `dsh-vrchat-osc` / 旧目录 `<工作目录>\vrchat-osc-plugin`），把旧条目替换掉，**不要两份同时启用**（会注册两套同前缀工具）。
3. 在 profile 目录执行 `pnpm install`（已有 `link:` 且 node_modules 已就绪时可跳过）。
4. 重启 DSH / 重载 profile；用 `plugin_manager list_bundles` 或 `list_plugins` 确认已加载。

### 从 0.5.x 升级到 0.6.0（重要）

0.6.0 多了两个随包驱动、本地面板和虚拟手柄输入，升级后建议按顺序做一次：

1. `remove_bundle` 旧的 0.5.x → `install_bundle` 新的 0.6.0（不要两份同时启用）。
2. **装驱动**：`vrchat_drivers({ action: "install" })`，或手工跑 `powershell -NoProfile -ExecutionPolicy Bypass -File drivers\install-drivers.ps1`；装完**重启 SteamVR**（见 §装驱动）。
3. 打开 `http://127.0.0.1:8790/` 点一次"体检"，确认识别到新驱动；再用 `vrchat_ui` 试一次按键。
4. 新配置都有默认值，不填也能用；想改见 §配置在哪。

### 装驱动（0.6.0：随包自带，不用另下）

`drivers/` 里已经带好两个驱动和安装/卸载脚本：

| 驱动 | 作用 | 目录 |
|---|---|---|
| `dsh_hmd` | 虚拟 HMD（头部 6DoF，`/dsh/head/pose`，UDP 39572） | `drivers/dsh_hmd/` |
| `vmt` | 虚拟手柄/追踪器（手部位姿 + `/VMT/Input/*` 按键；现报 **knuckles** 类型） | `drivers/vmt/` |

三种安装方式，任选一种：

```text
# A. 让 agent 装（推荐，幂等；装完重启 SteamVR）
vrchat_drivers({ action: "install" })

# B. 命令行装（纯 ASCII、幂等；自动找 SteamPath；-Force 处理旧路径，-WhatIf 干跑）
powershell -NoProfile -ExecutionPolicy Bypass -File drivers\install-drivers.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File drivers\install-drivers.ps1 -WhatIf   # 只看会改什么
powershell -NoProfile -ExecutionPolicy Bypass -File drivers\install-drivers.ps1 -Force    # 覆盖旧路径

# C. 卸载
vrchat_drivers({ action: "uninstall" })
# 或 powershell -NoProfile -ExecutionPolicy Bypass -File drivers\uninstall-drivers.ps1
```

- 安装脚本用 `vrpathreg` 把驱动目录写进 `openvrpaths.vrpath` 的 `external_drivers`；**装完必须重启 SteamVR** 才会加载。
- `vrchat_drivers({action:"status"})` 可以随时只读检查：`driversRoot`、每个驱动的 `present/registered/dll`、以及 `external_drivers` 里有没有它们。
- 驱动目录默认 `<插件根>/drivers`，可以用 `driversDir` 改。

### 配置在哪

全部配置在 **`cordis.patch.yml` 的 `config`**（改完重载/重启生效）。常用键：

| 配置键 | 默认 | 说明 |
|---|---|---|
| `sendPort` / `listenPort` | `9000` / `9001` | VRChat OSC 接收/发送端口（与 VRChat `osc.json` 对齐） |
| `listenEnabled` | `true` | 是否监听 VRChat 输出 |
| `chatboxMinIntervalMs` / `chatboxMaxChars` | `1500` / `140` | chatbox 限速/单段字符 |
| `vmtEnableMode` | `index` | VMT 设备模式：`index` = enable 5/6（Index 兼容手），`controller` = 2/3 |
| `poseHz` / `poseHoldHz` | `60` / `20` | 手部位姿频率（30–90）/hold 维持频率 |
| `headHz` / `headHoldHz` | `90` / `30` | 头部位姿频率（30–90）/hold 维持频率 |
| `headDriverAssumed` | `null` | `null`=端口占用自动探测；`true`/`false`=强制认为驱动在/不在 |
| `lookMode` / `lookStepDeg` | `auto` / `45` | 转头策略（auto/head/snap）与 snap 步长 |
| `playerDir` | `''`（自动） | 玩家工程位置。**留空即自动探测**：包内 `player/` → 兄弟目录 `../vrchat-vr-driver/player` → 旧路径。只有放在奇怪位置才需要手填（填仓库根、`player` 目录、甚至 `demo.mjs` 文件路径都认） |
| `playerNode` | `node` | 启动玩家进程用的 node（可填全路径） |
| `playerMonitorPort` / `playerLogLines` | `8765` / `300` | 监视器 HTTP 端口 / 子进程日志环形缓冲行数 |
| `playerPerception` | `vision` | `vrchat_mode` 的实机默认感知：`off` / `vision`（只截图、绝不读日志）/ `log`（只读日志、绝不截图）/ `hybrid` |
| `playerNav` | `on` | `vrchat_mode` 的实机默认导航（A* 绕障） |
| `playerMapPath` | `''` | 地图文件；空 = `player/maps/home.json` |
| `playerDefaultSeconds` / `demoDefaultSeconds` | `300` / `60` | 真机挡 / 演练挡的默认时长 |
| `playerAutoLaunch` | `false` | `true` = `player` 挡发现 Steam/SteamVR/VRChat 没开时自动按顺序启动（等同于每次带 `launch: true`） |
| `doctorTimeoutMs` / `steamVrLogPath` | `9000` / `''` | 体检总预算；SteamVR 日志路径（空 = 自动找） |
| `vmtInputEnabled` | `true` | 虚拟手柄输入（`vrchat_ui`）总开关；关掉后 `vrchat_ui` 只干跑不发包 |
| `uiPressMs` | `140` | 虚拟手柄按键默认按住时长（ms） |
| `uiReleaseAllOnUnload` | `true` | 插件卸载时自动松开所有按下的键/扳机（避免"键一直按着"） |
| `screenshotTimeoutMs` / `screenshotFallbackProcess` | `4000` / `VRChat.exe` | `vrchat_screenshot` 超时；回退 VRChat 窗口的前提进程名（VRChat.exe 在跑才回退） |
| `panelEnabled` / `panelHost` / `panelPort` | `true` / `127.0.0.1` / `8790` | 本地面板：是否开启、绑定地址（非回环会被强制回退到 127.0.0.1）、端口 |
| `driversDir` / `driversInstallTimeoutMs` | `''` / `120000` | 随包驱动目录（空 = `<插件根>/drivers`）；`vrchat_drivers install` 的超时（ms） |

---

## 快速开始（三个场景）

### ① 只发 chatbox（不需要任何驱动）

前置：Steam/SteamVR 可以不开；VRChat 已启动并登录进世界；VRChat 的 OSC 已启用（Action Menu → Options → OSC，一般默认开）。

```text
vrchat_status                     → listening=true, connected=true
vrchat_say({ text: "你好，我是接进来的 AI" })
vrchat_list_params                → 看 GestureLeft/Grounded/Voice 等
vrchat_wait({ param: "GestureLeft", timeoutMs: 20000 })   → 等玩家挥手
```

> chatbox 同世界可见，注意隐私；VRChat 有发送冷却，插件已按 1.5s 排队。

### ② 转头 / 抬手（需要 A 线 HMD 或 VMT 驱动 + SteamVR + VRChat VR）

```text
vrchat_head({ rotation: { yaw: 90 }, durationMs: 1000 })      # 真转头（需 dsh_hmd）
vrchat_pose({ hand: "right", target: { x: 0.4, y: 1.3, z: 0.35 }, durationMs: 800 })
vrchat_look({ angleDeg: 90 })                                  # auto：有 A 线就真转头，否则 snap
```

- 没装驱动时：工具**不报错**，返回 `driver.alive=false|unknown` + `warning`，包照常发（best-effort），OSC-only 能力不受影响。
- 先看一眼 `vrchat_status` 的 `head.driver` / `pose.driver`，确认 `driverAlive`。

### ③ 启动 Phase 1 虚拟玩家（**包内自带** `player/`，不用另下）

日常用 `vrchat_mode` 就够（见 §小白三步走）；要更细控制再用底层工具：

```text
vrchat_player_preflight                        # 只读体检（HMD/VMT/VRChat）
vrchat_player({ action: "start", live: true, perception: "vision", nav: "on", seconds: 300, seed: 7 })
# → 返回 pid + 监视器 URL：http://127.0.0.1:8765/
vrchat_player({ action: "status" })            # alive / 动作 / 位置 / yaw / fps / 玩家目录
vrchat_player({ action: "log", lines: 40 })
vrchat_player({ action: "stop" })
```

- `live:false`（默认）是演练：只喂三维骨架监视器，不碰 SteamVR/VRChat。
- `playerDir` **默认留空自动探测**（包内 `player/` → 兄弟目录 `../vrchat-vr-driver/player`）；`status` 的 `paths` 会告诉你它到底用了哪个目录、从哪找到的。
- 感知/导航（名字牌检测、A* 绕障）以及三维骨架监视器都在包内 `player/` 里；`--perception` 四挡语义见 §感知的开关在哪。

### ④ 用手点菜单 / 抓东西（需要随包驱动 + SteamVR + VRChat VR）

先按 §装驱动 装好驱动并重启 SteamVR。standard loop（agent 的"眼睛 + 手"）：

```text
vrchat_screenshot                       # 先看：当前画面/菜单长什么样
vrchat_pose({ hand:"right", target:{x:0.25,y:1.35,z:0.45} })   # 把手移到菜单前
vrchat_ui({ action:"select" })          # 扣右扳机 = 点击
vrchat_screenshot                       # 再看：点中了没有
```

`vrchat_ui` 的动作：

| action | 做什么 |
|---|---|
| `press` | 按一个键：`button` = `system` / `a` / `b` / `grip` / `trigger` / `thumbstick` / `trackpad`，`side` 选左右手 |
| `stick` | 推摇杆：`x` / `y` = -1..1（`side` 选左右手） |
| `release` | 松开所有按住的键/扳机/摇杆 |
| `openQuickMenu` | 快捷菜单（左手 B） |
| `openActionMenu` | Action Menu（**当前实现发左手 A**，与"长按 B"的游戏内分流不同，见 §已知限制） |
| `select` / `use` | 右扳机（点击 / 使用） |
| `grab` | 右 grip（抓/放） |
| `hideDashboard` / `showDashboard` / `dashboardStatus` | 用 `vrcmd.exe --hidedashboard/--showdashboard` 收起/显示 SteamVR dashboard（实测可用）；`dashboardStatus` 依赖驱动回包，通常返回 unknown |

- 以上是 VMT `/VMT/Input/*` 通道；`value` 可给扳机/握把 0..1 的模拟量（默认 1 = 扣到底）。
- VMT 现在报 **knuckles** 类型，所以 VRChat 自带的 `bindings_knuckles.json` 生效（实测日志见 §已知限制/`docs/联调清单.md`）。

---

## 依赖与降级（准确说明）

**随包驱动（`drivers/`，0.6.0 新增）**：`dsh_hmd`（虚拟 HMD）+ `vmt`（虚拟手柄/追踪器）已经随包分发，用 `vrchat_drivers` 或 `drivers/install-drivers.ps1` 安装（见 §装驱动）。

- `vrchat_drivers({action:"status"})` 只读检查：看 `driversRoot`、每个驱动的 `present/registered/dll` 与 `external_drivers`；两个都 `present && registered` 时 `ready=true`。
- 没装/没注册：`vrchat_head` / `vrchat_pose` / `vrchat_ui` 仍**不报错**（包照发，best-effort），但游戏里看不到头/手/按键效果；先跑 `vrchat_drivers({action:"install"})` + 重启 SteamVR。
- 驱动被 safe mode 拉黑时（`steamvr.vrsettings` 的 `blocked_by_safe_mode`）需要按 Phase 0 报告 §8.7.5 恢复；装完驱动后建议先跑一次 `vrchat_doctor`。

**VRChat OSC**：VRChat 默认接收 `127.0.0.1:9000`、发送 `127.0.0.1:9001`；本插件默认 `sendPort=9000`、`listenPort=9001`。端口被别的 OSC 工具占用时 `vrchat_status.listening=false` + `listenError`，改端口并同步 VRChat 的 `osc.json`。

**VMT（手部，UDP 39570/39571）**：插件通过**监听 39571 等 `/VMT/Out/Alive`** 探活。

- 有驱动：`pose.driver.driverAlive=true`，位姿平滑发送；首次发位姿前自动发一次单位 `RoomMatrix`。
- 没驱动：`driverAlive=false` + `warning`，包仍发（best-effort），**不报错**，其他工具完全可用。
- 39571 已被别的程序占用：`driverAlive=null` + `warning`（unknown）；插件空闲 30s 会释放该端口（`vmtListenerIdleMs`）。

**dsh_hmd（头部，UDP 39572）**：驱动**没有回包**，插件用"尝试 bind 39572：`EADDRINUSE`=驱动在，bind 成功=不在"来推断。

- 有驱动：`head.driver.driverAlive=true`、`reason:"port-in-use"`；`vrchat_look` 的 `auto` 会走真转头。
- 没驱动：`driverAlive=false` + `warning`，`vrchat_head` 仍发 best-effort；`vrchat_look` 自动退回 snap turn。
- 探测失败/不确定：`driverAlive=null`，可用 `headDriverAssumed: true|false` 强制指定。
- **已知误判**：`dsh_hmd` 绑 `0.0.0.0` 且带 `SO_REUSEADDR`，此时从别的进程 bind `127.0.0.1` 可能照样成功 → 可能**误报"驱动不在"**；确定驱动在时请 `headDriverAssumed: true`。

**Phase 1 玩家进程**：`vrchat_player start` / `vrchat_mode` 会 `spawn node <playerDir>/player/demo.mjs`（自包含包的 `playerDir` 就是插件根）。

- `playerDir` 解析顺序：显式配置 → 包内 `player/` → 兄弟目录 `../vrchat-vr-driver/player` → 旧路径兜底。找不到时 start 直接报错并**列出所有尝试过的路径**（`tried`），照着放或改配置即可。
- 监视器没起/端口不同：`status` 会优雅报告（读 `/health`、`/state` 失败不抛错）。
- `vrchat_doctor` 的 `player-files` 一项会直接显示解析来源（`config` / `plugin` / `sibling` / `legacy` / `missing`）。

### 感知的开关在哪（四挡语义）

| 挡 | 行为 | 适合 |
|---|---|---|
| `off` | 零 IO：不截图、不读日志 | 省资源 / 隐私最保守 |
| `vision`（实机默认） | 只截 SteamVR「Headset Window」→ 纯 Node 解 PNG → 名字牌检测；**绝不读日志** | 日常"纯视觉" |
| `log` | 只增量读 VRChat `output_log_*.txt` 的进出/换世界事件；**绝不截图** | 不想截屏时 |
| `hybrid` | 日志常轮询 + 有事件时按 `hybridRefreshMs`(600ms) 触发一次截图 | 要"既知道谁进来、又看得见" |

三个入口都能切：`vrchat_mode({ perception: "log" })`、`vrchat_player({ action:"start", perception:"log" })`、或直接跑 `node player/demo.mjs --live --perception log`。检测阈值在 `player/src/perception/sources/vision.mjs` 的 `DETECT_DEFAULTS` / `VISION_DEFAULTS`。

---

## 已知限制

- **位姿率**：`poseHz` 默认 **60Hz**（可配 30–90），`headHz` 30–90（默认 90）；实际受本机定时器与 VRChat/SteamVR 帧率限制。位姿是**插值驱动**，不是物理仿真。
- **虚拟手柄按键：0.6.0 实测已打通**。VMT 驱动报 `Prop_ControllerType_String="knuckles"`（compatible 控制器模式）后，vrserver 出现 `[Workshop] Successfully loaded binding file ...bindings_knuckles.json... for app 'steam.app.438100'`；真机验证：**左摇杆推前进 → 角色真的走了**（走到自己 avatar 面前）、**B 键 → VRChat 快捷菜单出现**、`/VMT/Input/Trigger` 的点击被 SteamVR 接收（在 dashboard 桌面视图点出过 Windows 右键菜单）。完整的"激光指向菜单项再扳机点击"还需要按 `docs/联调清单.md` §7 逐项过一遍（菜单是激光交互，指向依赖手部姿态）。
- **SteamVR dashboard 自动盖住画面：已解决（两种方式）**。① 推荐：在 `%SteamRoot%\config\steamvr.vrsettings` 里设 `steamvr.startDashboardFromAppLaunch=false` 与 `dashboard.enableDashboard=false`（改前备份；重启 SteamVR 生效，本机实测有效）；② 运行时：`vrchat_ui({action:"hideDashboard"})` 或面板按钮（走 `vrcmd --hidedashboard`，实测输出 `HideDashboard`）。`vrchat_mode({preset:"player"})` 启动时会自动调一次 hide。
- **`openActionMenu` = 长按 B（600ms，推断值）**：VRChat 的 knuckles 绑定里 B（左右手）→ `/actions/global/in/menu`，Action Menu 由游戏内长按分流；右手 A 是跳跃、左手 A 是麦克风。这属于"推断值"，真机按需微调（见 `docs/联调清单.md` §7）。
- **Steam 未启动**时 VRChat 的 SteamAPI 初始化失败，游戏内会弹"Steam 无法启动"模态并挡住视野/吃掉输入；请**先启动 Steam**，再启动 SteamVR/VRChat。
- **VR 轴输入行为待确认**：部分 `/input/*` 轴（Vertical/LookHorizontal 等）在 VR 模式下不一定让视角/位置变化（按键类通常有效）；菜单/模态打开时会屏蔽移动输入。
- **感知/导航在包内 `player/`**：真感知（名字牌检测）、A* 碰撞导航、三维骨架监视器都在包里，通过 `vrchat_mode` 切；它们**只靠插件配置**，默认 `playerDir` 自动探测，不需要手改路径。
- **感知的验证程度**：名字牌检测目前只在**负样本 + 合成图**上校准过（101 张真实截图 0 误报）；**正面样本（世界里另有真人）还没标定**，`distanceEstimate` 的 `stats.calibrated` 为 `false`，用前先看一眼监视器里的框是否对。
- **读不到聊天/语音**：VRChat OSC 没有读取聊天文字与语音的接口；agent 只能读 avatar 参数、写 chatbox。
- **chatbox 限制**：有字符/行数上限与发送冷却（插件已分段+排队，默认 1.5s/条）。
- **头部探活启发式**：见 §依赖与降级 的 `SO_REUSEADDR` 误判说明。
- **与旧版迁移**：旧插件（包名 `dsh-vrchat-osc`、目录 `<工作目录>\vrchat-osc-plugin`）与本包**二选一**；两份同时启用会注册两套 `vrchat_*` 工具（同名冲突）。迁移步骤：停用旧 bundle → 按 §安装 启用本包 → 重启 DSH。

---

## 离线自测（真实数字，不编造）

```powershell
node tools/osc-selftest.mjs            # OSC 编解码
node tools/plugin-offline-test.mjs     # 插件端到端（mock VRChat/VMT/A 线 HMD）
node tools/test_player.mjs             # 玩家进程编排 + playerDir 自动探测 + 看门狗
node tools/test_doctor.mjs             # 体检模块（假 deps，5 种环境场景）
node tools/test_launch.mjs             # 一键启动（假进程表/注册表，含超时）
node tools/test_vmtinput.mjs           # 虚拟手柄输入协议（/VMT/Input/*、归零、释放）
node tools/test_panel.mjs              # 本地面板（白名单/绑定回环/动作分发）
node tools/test_head.mjs               # 头部通道（无需 SteamVR）
node tools/test_pose.mjs               # 手部通道（无需 SteamVR）
node tools/test_look.mjs               # 转头分流/降级
node tools/test_humanize.mjs           # 拟人层
node tools/smoke-staged.mjs <包根>      # 从打好的包里装载插件：19 工具 + doctor + 演练挡 + 停止
```

- 当前实测：OSC 自检 **6**、插件端到端 **21**、head **16**、pose **14**、look **12**、humanize **13**、玩家编排 **39**、体检 **7**、一键启动 **17**、虚拟手柄输入 **9**、面板 **8**；全部离线、不需要 VRChat/SteamVR。
- 打包：`node tools/build-dist.mjs`（把 `player/` 一起拼进暂存树再 `npm pack`，产出 `dist/dsh-vrchat-vplay-<ver>.tgz`）。
- 配套 `player/` 自己的门禁：**13/13 组**（11 个单测文件 + OSC 回归 + 冒烟；含 `sinks_input` **43**、`controls` **67**、监视器自测 **27**、nav 92 / perception 36 / voice 34 等），随源码仓库提供。
- 真机验证清单见 `docs/联调清单.md`（含 §7 UI 操作清单）、协议细节见 `docs/原理与用法.md`、`docs/vmt-pose.md`。

---

## 许可与合规

- 代码许可：**MIT**（`LICENSE`，随仓库发布）。
- 使用政策（可接受使用政策）：**[`AUP.md`](AUP.md)** —— 必须随包分发，禁止清单/允许用途/责任划分都在里面。
- 非官方声明、免责条款（配套工程版本，已随包）：[`docs/使用条款与免责声明草案.md`](docs/使用条款与免责声明草案.md)。
- 第三方许可：VMT 自编译驱动的 MIT 声明与 `3rd_licence.txt` 已随包放在 `drivers/vmt/`（VMT 为 MIT，要求保留版权声明）。
- 本 README 与 AUP 均**不构成法律建议**。

---

## 反馈

- Issues / Discussions：**待开启**（占位）。
- 想先看内部实测记录：配套工程 `docs/可行性调研.md` §8（Phase 0/1 实测）与 `player/README.md`、`player/docs/Phase1-实现说明.md`。

---

## English summary (≤120 words)

`dsh-VRChat-vplay` is an unofficial DeepSeek Harness host plugin that lets an agent interact with a locally running VRChat client. It uses VRChat's official OSC interface (UDP 9000/9001) to speak through the chatbox, read avatar parameters, and trigger `/input/*` actions, and drives head/hand poses plus virtual-controller input through two bundled SteamVR drivers (`dsh_hmd` virtual HMD, `vmt` virtual knuckles controllers) with a `drivers/install-drivers.ps1` installer. Version 0.6.0 adds 19 tools in total: `vrchat_ui` (press/stick/trigger/grab/menu/dashboard commands), `vrchat_screenshot` (see the headset before aiming), `vrchat_drivers` (status/install/uninstall), plus a local button panel at `http://127.0.0.1:8790/` and the self-contained Phase 1 virtual player (perception, A* navigation, 3D skeleton monitor, watchdog). It does **not** inject or modify the VRChat client and does not bypass EAC. Licensed MIT; usage is governed by `AUP.md`. Not affiliated with VRChat Inc. or Valve.
