# 独立 daemon：`tools/vplayd.mjs`（不启动 DSH 也能开控制台）

`vplayd` 是一个**零依赖的独立进程**：它复用插件自己的 `index.js` / `lib/`，在不启动 DSH 的情况下
把本地按钮控制台（默认 `http://127.0.0.1:8790/`）和 HTTP 动作接口跑起来。面板上的按钮和 DSH 里
看到的是**同一套 12 个动作**，底层能力（OSC、VMT 虚拟手柄、截图、体检、玩家进程）也完全一样。

---

## 1. 什么时候用它

| 场景 | 用哪个 |
|---|---|
| 在 DSH 对话框里让模型操作 VRChat | DSH 插件（正常启用即可，面板会随插件自动起在 8790） |
| **没有 DSH / 不想启 DSH**，只想用浏览器点按钮 | **`node tools/vplayd.mjs`** |
| 脚本/自动化想用 HTTP 调 12 个动作 | `node tools/vplayd.mjs` + `POST /api/action` |
| 非 DSH 宿主（Claude Desktop / Cursor）让模型用 19 个工具 | MCP 包装（见 `docs/MCP.md`） |
| 只想检查插件是否完好、不看界面 | `node tools/vplayd.mjs --self-check` |

`vplayd` 和 DSH 插件、MCP 包装三者共用同一份工具定义（`lib/host-shim.mjs` 跑 `index.js` 的
`apply()`），所以**不会漂移**；区别只在"谁来调"：人点浏览器 / 脚本发 HTTP / 模型调 MCP。

---

## 2. 快速开始（Windows）

前提：Node ≥ 20 在 PATH（`node -v` 能输出版本；本机实测 v24.21.0）。**不需要** `npm install`，
本仓库零 npm 依赖。

```powershell
cd <插件目录>            # 含 index.js、tools/、lib/ 的那个目录
node tools/vplayd.mjs
```

看到下面这样的摘要就说明面板真的起来了（不是"应该起来了"）：

```
[插件] vrchat-vplay: control panel at http://127.0.0.1:8791/

vplayd 启动完成（独立 daemon · 不依赖 DSH）
  面板      http://127.0.0.1:8791/ · action 12/12
  OSC       127.0.0.1 · 发送 9000 · 监听 已关闭（--no-listen）
  工具      19 个（vrchat_*）· playerDir=(自动探测)
  玩家      未运行 · 监视器 http://127.0.0.1:8765/
  体检      verdict=not-ready（chat=false pose=false player=false）
            下一步：启动 SteamVR 后再启动 VRChat

  浏览器打开上面的面板地址即可（所有按钮都走 POST /api/action）。
  退出：本窗口 Ctrl+C；脚本拉起时可用 --exit-on-stdin-close（stdin 关闭 = 优雅退出）。
        POSIX 上 SIGTERM 也会优雅退出；Windows 上 SIGTERM 是强制终止（Node/libuv 限制，见 docs/DAEMON.md）。
```

（上面是 2026-11-04 在本机、SteamVR/VRChat 都没启动时 `node tools/vplayd.mjs --panel-port 8791 --no-listen`
的真实输出；`verdict=not-ready` 是预期的——没开 VR 栈时体检本来就是这条。）

然后浏览器打开摘要里的 URL。退出按 `Ctrl+C`，会打印退出摘要（运行时长、面板请求/动作数、释放了哪些通道）。

**只检查、不开面板**：

```powershell
node tools/vplayd.mjs --self-check
# 打印 19 个工具名 + doctor verdict 后退出 0；不 bind 任何端口、不留进程
```

**看帮助**：

```powershell
node tools/vplayd.mjs --help     # 中文用法，退出码 0
```

---

## 3. 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--panel-port <端口>` | `8790` | 面板 HTTP 端口。被占用时启动会明确报错（见 §6） |
| `--panel-host <地址>` | `127.0.0.1` | 面板绑定地址。**只允许回环**：`127.0.0.1` / `localhost`（归一成 127.0.0.1）/ `::1` |
| `--send-port <端口>` | `9000` | 发往 VRChat 的 OSC 端口（VRChat 的 receiver 端口） |
| `--listen-port <端口>` | `9001` | 接收 VRChat OSC 的端口（VRChat 的 sender 端口） |
| `--listen-enabled` | 开启 | 显式启用反向监听（默认就是开） |
| `--no-listen` | — | 关闭反向监听：只发送、不接收参数/事件。**和 DSH 插件同时跑时建议加** |
| `--player-dir <目录>` | 自动探测 | 玩家工程 `player/` 的**父目录**（不是 `player` 本身）。留空 = 插件自带 `player/` → 兄弟工程 → 旧路径 |
| `--player-node <可执行>` | `node` | 跑玩家进程用的 Node（可用绝对路径，解决 PATH 问题） |
| `--monitor-port <端口>` | `8765` | 玩家监视器 HTTP 端口（面板"开监视器"按钮打开的地址） |
| `--config '<json>'` | — | 覆盖 `index.js` 的插件配置，JSON 对象（见 §4） |
| `--self-check` | — | 只建工具集，打印 19 工具名 + doctor verdict 后退出 0 |
| `--exit-on-stdin-close` | — | 脚本/测试用：stdin 关闭时优雅退出（退出码 0） |
| `-h`, `--help` | — | 打印中文帮助后退出 0 |

退出码约定：

| 码 | 含义 |
|---|---|
| `0` | 正常退出（Ctrl+C / SIGINT / stdin 关闭 / `--help` / `--self-check` 完成） |
| `1` | 启动或运行期失败：面板端口被占用、面板 8 秒内没就绪、`apply()` 抛错、未捕获异常 |
| `2` | 用法错误：未知参数、端口不是 1..65535、`--config` / `VPLAY_CONFIG` 不是 JSON 对象 |

---

## 4. 配置：`--config` 与 `VPLAY_CONFIG`

`--config` 的值直接对应插件配置（即 `cordis.patch.yml` 里 `vrchat-vplay` 那一段的键），
可以覆盖端口、监听、玩家路径等任意一项。常见键：

| 键 | 默认 | 作用 |
|---|---|---|
| `sendPort` / `listenPort` / `listenEnabled` | `9000` / `9001` / `true` | OSC 收发（同 §3） |
| `panelPort` / `panelHost` | `8790` / `127.0.0.1` | 面板（同 §3） |
| `playerDir` / `playerNode` | `''` / `node` | 玩家工程位置/Node（同 §3） |
| `playerMonitorPort` | `8765` | 玩家监视器端口（同 `--monitor-port`） |
| `doctorTimeoutMs` | `9000` | 体检总预算（vplayd 启动时的体检摘要也受它约束） |
| `vmtSendPort` / `headPort` | `39570` / `39572` | VMT 位姿·输入 / A 线头部 UDP 端口（一般不用改） |
| `vmtInputEnabled` / `uiPressMs` | `true` / `140` | 虚拟手柄按键开关 / 按住时长 |
| `debug` | `false` | 打开后会把收到的每个 avatar 参数打日志（默认不打扰） |

优先级：**内置默认值 < 环境变量 `VPLAY_CONFIG` < `--config` < 单项参数**。

```powershell
# 环境变量（比 --config 低）：
$env:VPLAY_CONFIG = '{"sendPort":19030,"listenPort":19031}'
node tools/vplayd.mjs --panel-port 8791 --no-listen

# 单项参数覆盖 --config（生效的是 8792）：
node tools/vplayd.mjs --config '{"panelPort":8791}' --panel-port 8792
```

> 提示：`--config` 是 JSON，PowerShell 里用单引号包住最省事；不要用双引号（PowerShell 会先吃掉引号）。
> 只想改一两个端口时，优先用 `--panel-port` / `--send-port` / `--monitor-port` 这类单项参数。

---

## 5. 面板动作清单（12 个）

页面只做参数校验，动作由插件内部接线（和 DSH 插件里的面板是同一份代码）。HTTP 接口：

| 方法/路径 | 用途 |
|---|---|
| `GET /` | 按钮页面（内联 HTML/CSS/JS，无 CDN、无外部资源） |
| `GET /api/status` | 面板状态 + 已接线动作 + 玩家状态（`player`）+ 最近 10 条操作日志 |
| `GET /api/events` | SSE，推送每次动作日志 |
| `POST /api/action` | 执行动作，body：`{"name":"<动作>","args":{...}}` |

`POST /api/action` 只接受白名单里的 12 个动作，未知动作返回 `400 {"ok":false,"error":"unknown action: ..."}`：

| action | args | 作用 |
|---|---|---|
| `doctor` | `{}` | 11 项只读体检（返回 `verdict` + `checks`） |
| `mode` | `{"preset":"demo"\|"dry"\|"player"\|"live"}` | 切换玩家挡位（演练/真机） |
| `stop` | `{}` | 停止玩家子进程（没在跑也不报错） |
| `status` | `{}` | 玩家进程 + 监视器状态（`/api/status` 里的 `player` 就是它） |
| `press` | `{"key":"a"\|"b"\|"trigger"\|"grip"\|"system"\|"thumbstick"\|"trackpad","side":"left"\|"right"}` | 按一次虚拟手柄键（自动归零） |
| `stick` | `{"side":"left"\|"right","x":-1..1,"y":-1..1}` | 推摇杆（自动回中） |
| `release` | `{}` | 立即松开所有按住的键 |
| `screenshot` | `{}` | 截 SteamVR「Headset Window」；成功返回 `dataUrl`，失败返回 `{ok:false,error}`（HTTP 仍是 200，页面会提示原因） |
| `dashboardHide` | `{}` | 关掉 SteamVR dashboard（`vrcmd --hidedashboard`） |
| `dashboardShow` | `{}` | 显示 SteamVR dashboard |
| `driversStatus` | `{}` | 两个随包驱动（dsh_hmd / VMT）的文件 + 注册状态 |
| `installDrivers` | `{}` | 跑 `drivers/install-drivers.ps1`（**真装驱动，需重启 SteamVR 后生效**） |

PowerShell 调示例：

```powershell
# 体检
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8790/api/action `
  -ContentType 'application/json' -Body '{"name":"doctor","args":{}}'

# 右手扳机点一下（真机才有游戏内效果）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8790/api/action `
  -ContentType 'application/json' -Body '{"name":"press","args":{"key":"trigger","side":"right"}}'

# 看状态
Invoke-RestMethod http://127.0.0.1:8790/api/status
```

`curl` 同理（`curl.exe` 是 Windows 自带的）：

```powershell
curl.exe -s -X POST http://127.0.0.1:8790/api/action -H "content-type: application/json" `
  -d "{\"name\":\"status\"}"
```

注意：`press` / `stick` / `screenshot` / `mode` / `installDrivers` 是**真动作**，不是演示按钮。
没有 SteamVR/VRChat 时它们大多会优雅降级（返回 `{ok:false,error}` 或空操作），但不会崩溃、也不会
伪造成功。

---

## 6. 和 DSH 插件同时跑：端口冲突

同一台机器上，DSH 插件和 `vplayd` 是**两个独立进程**，各自会绑定端口。DSH 插件启用时面板会自动
起在 8790、OSC 反向监听 9001；`vplayd` 默认也用这两个，所以要错开：

| 资源 | 默认端口 | 冲突后果 | 建议 |
|---|---|---|---|
| 控制台面板 | `8790` | 后启动的一方面板起不来；`vplayd` 会**明确报错退出 1** | `vplayd --panel-port 8791` |
| OSC 反向监听 | `9001` | 后启动的一方监听失败（`vplayd` 摘要会提示；发送仍可用） | `vplayd --no-listen`（推荐）；或把 DSH 插件的 `listenEnabled` 改 `false` |
| OSC 发送 | `9000` | 无冲突（UDP 谁都能发） | 不用管 |
| 玩家监视器 | `8765` | 两个玩家进程不能同时用同一端口 | 只让一方起玩家；或给 `vplayd --monitor-port 8766` |
| VMT/头部 UDP | `39570` / `39572` | 发送不占端口，可同时发 | 不用管 |

**推荐组合**（DSH 插件已经在跑，再用 vplayd 当第二个控制台）：

```powershell
node tools/vplayd.mjs --panel-port 8791 --no-listen
```

**反过来只想用 vplayd**：在 DSH 插件配置里把 `panelEnabled` 改成 `false`（`cordis.patch.yml`），
用 `plugin_manager` 重载插件，然后 `node tools/vplayd.mjs` 独占 8790。

`vplayd` 启动时会先探测面板端口：被占用就直接打印原因和建议并退出 1，**不会静默成功**。
查占用者：

```powershell
Get-NetTCPConnection -LocalPort 8790 | Select-Object LocalAddress,LocalPort,State,OwningProcess
Get-Process -Id <OwningProcess>
```

---

## 7. Windows 注意事项

1. **Node 必须在 PATH**：`node -v` 能出版本。没有 PATH 时用 `--player-node "C:\Program Files\nodejs\node.exe"`
   （只影响玩家子进程；vplayd 本身当然得由 node 启动）。
2. **驱动要先装**：`press` / `stick` / `mode player` 这些按键动作只有装了随包驱动
   （`drivers/install-drivers.ps1`，装完重启 SteamVR）并运行 SteamVR + VRChat 才有效果。
   用面板的「体检」/`driversStatus` 确认；没驱动时按钮能点，但游戏里没反应是正常的。
3. **dashboard 会盖画面**：本机已通过 `steamvr.vrsettings` 关掉自动弹出；换机器如果又出现，先点面板
   「关掉 SteamVR 面板」（或 `vrcmd.exe --hidedashboard`）。
4. **SIGTERM 在 Windows 上是强制终止**：Node/libuv 在 Windows 用 `TerminateProcess` 实现"发信号"，
   目标进程的 `SIGTERM` 处理器**不会执行**（实测退出码 `null`、signal `SIGTERM`，无退出摘要）。
   要优雅退出（释放手柄、关 socket、停玩家子进程、退出码 0）请用：
   - 本窗口 `Ctrl+C`（控制台 SIGINT，可被捕获）；或
   - 脚本拉起时加 `--exit-on-stdin-close`，父进程关闭 stdin 即可；或
   - POSIX 上直接 `kill -TERM <pid>`（会走同一个优雅退出路径）。
5. **中文路径**：vplayd 用 Node 的路径 API，不拼 shell 字符串，中文目录可用（本机插件目录就是中文路径）。
   如果控制台里中文输出乱码，先 `chcp 65001` 再跑（只影响显示，不影响功能）。
6. **不要用 PowerShell 5.1 的 `Set-Content` 重写仓库里的 `.js/.mjs`**（会带 BOM）；用编辑器/本仓库工具改。
7. **防火墙不会弹窗**：面板只绑 `127.0.0.1`，不监听局域网；`panel.mjs` 会把非回环地址强制改回 `127.0.0.1`。

---

## 8. 安全边界

- **只绑回环**：面板 host 只允许 `127.0.0.1` / `localhost` / `::1`，传 `0.0.0.0` 之类会被 `lib/panel.mjs`
  强制改回 `127.0.0.1`；vplayd 在参数层就拒绝非回环地址。
- **动作白名单**：`POST /api/action` 只接受 §5 的 12 个动作；未知动作 400。参数在面板层做类型/范围校验
  （`mode.preset`、`press.key/side`、`stick.x/y` 等）。
- **不读文件、不执行任意 shell**：面板不提供文件读取/命令执行接口。唯一会跑外部脚本的是
  `installDrivers`（固定调用随包的 `drivers/install-drivers.ps1`）和 `screenshot`（固定调用
  `player/tools/capture_frame.ps1`），脚本路径来自插件/玩家目录，不接受请求方传入。
- **没有鉴权，但仅本机**：任何本机进程/用户都能调面板（等同本机用户权限）。不要在共享机器上
  把它当安全边界；需要隔离时用独立 Windows 用户/虚拟机。
- **不做的事**：不注入/不修改 VRChat 客户端、不绕 EAC、不提供多开/挂机/代练能力（见 `AUP.md`）。

---

## 9. 常见问题

**面板起不来 / 启动直接退出 1**

- 输出 `[错误] 面板端口 127.0.0.1:8790 已被占用`：DSH 插件面板或另一个 vplayd 占着。换
  `--panel-port 8791`，或按 §6 查占用者。
- 输出 `[错误] 面板在 8 秒内没有就绪`：端口预检通过但 apply 内部面板没起来，看上面的插件日志；
  通常是端口在探测后被抢占，或插件文件不完整。换端口再试。

**`verdict=not-ready`**

体检结果取决于 SteamVR/VRChat/驱动/OSC 端口。没开 VR 栈时这条是正常的；先启动 SteamVR → VRChat
再点「体检」，目标是 `player-ready`（`chat-ready` = 只能发 OSC 说话/参数，`pose-ready` = 位姿通道可用）。

**点「截图」返回 `ok:false`**

面板返回 `{"ok":true,"result":{"ok":false,"error":"截图脚本不存在：..."}}` = 玩家工程没找到
（`playerDir` 指错/发布包缺 `player/`）；`找不到 SteamVR「Headset Window」` = SteamVR 没启动。

**点按键没反应**

先确认：驱动已装且 SteamVR 在跑 → VRChat 在 VR 模式（直接跑 `launch.exe`）→ 体检通过。
`press` 的 UDP 包发出去没有回执，游戏内效果只能靠截图/眼睛确认。

**面板动作返回 500**

`/api/action` 的动作抛异常时返回 `500 {"ok":false,"name":...,"error":"..."}`；按 error 排查，
或看 `/api/events` 的 SSE 日志。动作超时上限 30 秒。

---

## 10. 自动化与测试

`tools/test_vplayd.mjs` 是**真进程验收**（spawn 真的 `node tools/vplayd.mjs`，不是单测桩）：

```powershell
cd <插件目录>
node tools/test_vplayd.mjs     # 期望最后一行：PASS 16 checks (vplayd)
```

它用隔离端口（面板 18792、OSC 发送 19030、监听 19031、监视器 18770、VMT 19070、头部 19072）+ 临时
假玩家仓库（`player/demo.mjs`、`player/tools/preflight.mjs` 桩，避免 spawn 真实 demo），断言：

- `--help` 退出 0、`--self-check` 退出 0 且打印 19 工具名与 verdict、参数/配置优先级；
- 面板真就绪（轮询 `GET /api/status`）、`GET /` 返回 HTML、`/api/status` 有面板监听信息 + 12 动作
  （含 `driversStatus` / `installDrivers`）+ 玩家监视器地址；
- `POST /api/action` 的 `doctor`（verdict + 11 项检查）、`press`、`screenshot`（无 SteamVR 优雅 `ok:false`）、
  `stop`（不崩）、未知动作 400；
- SIGTERM 后进程终止 + 面板端口释放；`--exit-on-stdin-close` 优雅退出码 0 + 退出摘要 + 端口释放；
- 面板端口被占用时明确报错、退出 1、不打印"启动完成"；非法参数退出 2。

测试结束会杀干净子进程、删临时目录、确认端口释放。它**不启动 SteamVR/VRChat**，可随时跑。

想手工验同样思路：

```powershell
# 1) 起一个隔离实例（不碰 DSH 的 8790/9001）
node tools/vplayd.mjs --panel-port 18792 --config '{"sendPort":19030,"listenPort":19031,"playerMonitorPort":18770}'
# 2) 另一个窗口打接口
Invoke-RestMethod http://127.0.0.1:18792/api/status
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18792/api/action -ContentType 'application/json' -Body '{"name":"doctor"}'
# 3) 回第一个窗口 Ctrl+C
```

---

## 11. 实现说明（为什么这么薄）

```
tools/vplayd.mjs          参数/配置解析、端口预检、面板就绪轮询、启动摘要、信号与退出、self-check
tools/test_vplayd.mjs     上面的真进程验收
lib/host-shim.mjs         ← 已有支点：假宿主跑 index.js 的 apply()，拿到 19 个工具 + 面板生命周期
lib/panel.mjs             ← 已有支点：127.0.0.1 面板、12 动作白名单、SSE（vplayd 不碰它）
index.js                  ← 已有支点：panelEnabled:true 时 apply() 自己起面板，12 动作内部接线
```

`vplayd` **不重写面板、不复制动作接线**：`createToolset({config, logger})` 跑一遍 `apply()` 后，
面板就随 `ctx.effect` 起来了；`vplayd` 只用 HTTP 确认它真的可访问（最多 8 秒轮询
`GET /api/status`），再通过 `vrchat_status` / `vrchat_doctor` 两个工具读启动摘要。所以 DSH 插件、
MCP、vplayd 三边的行为只由 `index.js` 决定，改一处三边同步。

`dispose()` 的释放顺序由 `index.js` 注册 effect 的顺序决定（假宿主 `dispose()` 反序执行）：
面板关闭 → 工具注销 → 玩家子进程 → 位姿/头部通道 → OSC bridge → 手柄归零/关闭。
vplayd 只负责调用并打印摘要。
