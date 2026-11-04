# 位姿通道：`vrchat_head` / `vrchat_pose` / `vrchat_look`

> 状态（2026-11-01 深夜更新）：A 线自研 HMD 驱动（`dsh_hmd`）已接管 VRChat VR 会话，**头部位姿可以真控了**。
> 插件软件侧已实现 `vrchat_head`、`vrchat_look` 的 `auto/head/snap` 分流、`vrchat_status.head`，并通过离线单测；
> 真机（SteamVR + VRChat）端到端仍由 Lead 在占用窗口验证——按任务约定我没有自己开游戏。
>
> 三条位姿相关通道，全部"失败只降级、不报错"：
> - **头部**：A 线 `dsh_hmd`，`/dsh/head/pose` → UDP **39572**（OpenVR 右手系，无回包）
> - **手部**：自编译 VMT，`/VMT/Room/Unity` → UDP **39570**（Unity 左手系，回包 39571）
> - **转头兜底**：VRChat `/input/*` 的 snap turn（不需要任何驱动）
>
> 没有驱动时工具照常返回，只是带 `driver.alive=false|unknown` + `warning`；OSC-only 能力
> （说话 / `/input` / 参数）完全不受影响。

---

## 1. 为什么是"多条通道"

| 能力 | 通道 | 现状 |
| --- | --- | --- |
| 说话 / 按键 / 移动 / 跳 / 抓 | VRChat `/chatbox/*`、`/input/*`（UDP 9000） | ✅ 已实测 |
| **头部位姿（真转头/抬头）** | **A 线自研 HMD 驱动，`/dsh/head/pose`（UDP 39572，OpenVR 右手系）** | ✅ A 线已实测（yaw=90° 有效）；软件侧本轮补齐 |
| 手部位姿 | VMT 虚拟控制器（UDP 39570，Unity 左手系） | ✅ 驱动侧协议已验证，软件侧已实现 |
| 转头兜底 | `/input/LookHorizontal` 或 `/input/ComfortLeft/Right` 的 snap turn | ✅（桌面/VR 均可，近似） |
| 旧方案：VMT tracker 顶 `/user/head` | `TrackingOverrides` | ❌ 实测会让 `vrserver.exe` 崩，**已废弃，不要再走** |

定位：**输入与位姿解耦**。A 线驱动挂了 → `vrchat_head` 降级、`vrchat_look` 退回 snap；
VMT 挂了 → `vrchat_pose` 降级；两者都挂，说话/按键/参数/等待仍然可用。

---

## 2. A 线 HMD 头部通道（实现依据：`lib/head.js`）

来源：Lead 在 A 线接管后给出的事实 + 驱动实测；随包驱动目录 `drivers/dsh_hmd/`（dll 在 `bin/win64/driver_dsh_hmd.dll`）。

| 项 | 值 |
| --- | --- |
| 应用 → 驱动 | `127.0.0.1:39572`（UDP） |
| 地址 | `/dsh/head/pose` |
| 参数 | `(float)x, (float)y, (float)z, (float)qx, (float)qy, (float)qz, (float)qw`（**7 个 float**） |
| 坐标系 | **OpenVR 右手系**：+X 右、+Y 上、**-Z 前**、米制 |
| 频率 | 90Hz 流（插件默认按 90Hz 发；`hz` 可配 30–90） |
| 回包 | **没有**。驱动不回任何包，所以可用性只能启发式判断 |
| 头控原理 | 驱动直接把收到的位姿作为 HMD pose（不再经过 TrackingOverrides） |

### 2.1 坐标系换算（**别和手部 Unity 左手系搞混**）

`vrchat_head` 对 agent 暴露的坐标系与 `vrchat_pose` 一致 —— **Unity 左手系**
（+X 右、+Y 上、+Z 前、米，站立眼高 y≈1.6），内部发驱动前换算成 OpenVR 右手系：

```text
位置：position_openvr = ( x,  y, -z )
四元数：quat_openvr = normalize( qx, qy, -qz, -qw )      # 再把整体取成 w>=0（同一旋转）
```

- 这是"Z 轴翻转"的基变换，**自逆**（OpenVR→Unity 用同一公式），对应 VMT 驱动源码里
  Unity→OpenVR 的 `(x, y, -z, qx, qy, -qz, -qw)` 约定。
- 直觉检查：Unity 里"朝 +Z 前方 1m"→ OpenVR `(0,1.6,-1)`（因为 OpenVR 前方是 -Z）；
  Unity yaw=+90（向右）→ OpenVR 四元数 `(0, -√½, 0, √½)`（绕 +Y 转 -90° 的右手系表示，同样朝 +X）。

### 2.2 旋转入参的语义（比手部更直观）

| 参数 | 语义 |
| --- | --- |
| `yaw` | 绕 Y 轴，**+ = 向右转** |
| `pitch` | 绕 X 轴，**+ = 抬头看**（内部夹到 ±89°） |
| `roll` | 绕 Z 轴，**+ = 向右歪头** |

也接受四元数 `{qx,qy,qz,qw}`（**Unity 左手系**世界旋转），内部反解成上面的欧拉角。
原因为 Unity 的 `Quaternion.Euler` 是 pitch+ 低头 / roll+ 左歪，直接暴露会很反直觉。

### 2.3 驱动可用性探测（启发式）

A 驱动没有回包，所以 `lib/head.js#HeadClient.probeDriver()` 用**端口占用探测**：
尝试 bind `127.0.0.1:39572`，不往驱动发任何包（不会移动头部），立即释放：

| 结果 | 含义 |
| --- | --- |
| `{alive:true, reason:"port-in-use"}` | 端口被占用 → 驱动在听 |
| `{alive:false, reason:"port-free"}` | 端口空着 → 驱动没起 |
| `{alive:null, reason:"probe-error"}` | 探测本身失败（权限/其他错误）→ 只能 best-effort |

- 结果缓存 `headProbeCacheMs`（默认 5s）；`vrchat_look` 与 `vrchat_head` 共用。
- 配置 `headDriverAssumed: true|false` 可跳过探测（确定环境下用；默认 `null` 自动）。
- 注意：若驱动绑的不是 `127.0.0.1:39572`（比如绑了别的地址），探测可能误判——此时用
  `headDriverAssumed:true` 强制认为在线。

---

## 3. `vrchat_head` 工具

### 3.1 语义

把目标头部位姿**带插值**发到 A 线驱动，内部 90Hz 定时器循环，**不是一次调用一个瞬移包**。

```text
调用 → 端口探活（启发式，失败只降级）→ 定时器循环（每帧插值 + 发 7 个 float）
     → 到达目标：hold ? 继续低频流 + 呼吸微动作 : 停流（驱动保持最后一帧）
```

- 发送循环 `setTimeout` 链 + 起始时间戳 drift 补偿；
- 新调用**抢占**旧调用：旧调用立刻返回 `interrupted:true`，新动作从当前实际位姿继续；
- `wait:false` 立即返回、后台继续；
- `hold:true` 默认：到达后以 `headHoldHz`（默认 30Hz）继续发当前位姿 + 呼吸/微动作
  （位置 ≤ ±4mm、旋转 ≤ ±0.3°，约 10s 周期，可 seed 复现）；
- `hold:false`：到达后停止发送，驱动保持最后命令的位姿（头部没有"交还真实追踪"的概念）；
- `cancel:true`：立即停（含 hold）。

### 3.2 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `target` | `{x,y,z}` | — | 头部位置（米，Unity 左手系）。**缺省轴保持当前值** |
| `rotation` | `{yaw,pitch,roll}` 或 `{qx,qy,qz,qw}` | 保持当前 | 欧拉语义见 §2.2；四元数是 Unity 左手系 |
| `durationMs` | int | `600` | 插值时长，0 = 单帧，最大 10000 |
| `easing` | `linear`/`easeOut`/`easeInOut` | `linear` | `easeOut` = 起步快收尾慢 |
| `hold` | bool | `true` | 到达后继续流 + 呼吸微动作 |
| `holdMs` | int | `0` | >0 时到点后自动停止维持（0 = 直到下次调用/cancel） |
| `hz` | int | 配置值 `90` | 30–90（Windows 定时器粒度下实际约 60–70Hz，见 §10） |
| `humanize` | bool | `true` | 时长 ±8% 抖动 + hold 呼吸 |
| `seed` | int | 配置值 `1` | 拟人层随机种子 |
| `wait` | bool | `true` | `false` = 立即返回后台播放 |
| `cancel` | bool | — | 停止当前头部动作（驱动保持最后位姿） |

### 3.3 返回

```json
{
  "ok": true,
  "space": "unity-lh",
  "from": { "position": [0, 1.6, 0], "rotation": [0,0,0,1], "orientation": { "yaw": 0, "pitch": 0, "roll": 0 } },
  "to":   { "position": [0.2, 1.6, 0.5], "rotation": [0,0.7071,0,0.7071], "orientation": { "yaw": 90, "pitch": 0, "roll": 0 } },
  "openvr": {
    "from": { "position": [0, 1.6, 0], "rotation": [0,0,0,1] },
    "to":   { "position": [0.2, 1.6, -0.5], "rotation": [0,-0.7071,0,0.7071] }
  },
  "durationMs": 600, "effectiveDurationMs": 638, "easing": "linear", "hz": 90,
  "frames": 38, "sequence": 1, "hold": true, "holdMs": 0, "holdActive": true,
  "humanize": true,
  "driver": { "alive": true, "reason": "port-in-use", "port": 39572, "lastProbeMsAgo": 12, "sendErrors": 0 },
  "warning": null,
  "started": true, "finished": true, "interrupted": false, "cancelled": false,
  "elapsedMs": 655, "totalFramesSent": 76
}
```

- `from/to` 是 **Unity 左手系**（与入参一致）；`openvr` 是**实际发出去的值**（便于对照驱动/真机）。
- `frames` = 动画帧数（一次 tick 一帧）；`totalFramesSent` = 累计发包数（含 hold）。
- `driver.alive`：`true`（端口被占用）/`false`（端口空闲）/`null`（探测失败）。
- `warning`：降级提示，否则 `null`。**工具永远不因为没驱动而抛错。**

`cancel` 返回 `{ ok:false, cancelled:true, hadMotion, holdActive, sequence, totalFramesSent, state }`。

### 3.4 失败模式

| 现象 | 原因 | 表现 / 处理 |
| --- | --- | --- |
| `driver.alive=false` + warning | `dsh_hmd` 没装/没起 / SteamVR 没起 / VRChat 不在 VR | 工具照常返回，包发出去没人收；OSC 工具正常。检查 `dsh_hmd` 驱动是否已注册并加载（见 §9.0 的 `vrserver.txt` 判据）、39572 是否在听 |
| `driver.alive=null` + warning | 端口探测失败（权限/地址不符） | 仍 best-effort 发包；确定驱动在时可设 `headDriverAssumed: true` |
| 头不动 | 驱动没收到 / VRChat 没进 VR / 驱动加载失败 | 先看 `vrchat_status.head.driver`；再确认 VRChat log `StartVRSDK: OpenVRLoader` |
| 转头方向反了 | 对 OpenVR 右手系理解错误（应在工具层用 Unity 语义） | 本插件已做 Z 翻转换算；若真机方向相反，先记录 `vrchat_head` 返回的 `openvr` 值与截图，再决定是否改换算 |
| 动作有轻微阶梯 | Windows 定时器粒度（~15.6ms）下 90Hz 实际约 60–70Hz | 属预期；需要更平滑可降 `hz`，或接受 drift 补偿后的平均帧率 |

---

## 4. VMT 手部协议（实现依据：`lib/vmt.js`）

来源：本机驱动的工具链实测记录（`vrchat-vr-driver/tools/README.md`、`vmt_probe.mjs`、`motion.mjs`）。

| 项 | 值 |
| --- | --- |
| 应用 → 驱动 | `127.0.0.1:39570`（UDP） |
| 驱动 → 应用 | `127.0.0.1:39571`（UDP；`/VMT/Out/Alive`、`/VMT/Out/Unavailable`） |
| 位姿地址 | `/VMT/Room/Unity` |
| 参数 | `(int)idx, (int)enable, (float)timeOffset, (float)x,y,z, (float)qx,qy,qz,qw` |
| `idx` | 设备槽位：**1 = 左手，2 = 右手**；0 = tracker（头部，本插件不用） |
| `enable` | **0 = 关闭**；**5 = 左手 Index 兼容、6 = 右手 Index 兼容**（默认）；2/3 = 普通手柄；1/7 = tracker 模式 |
| 坐标系 | Unity 左手系：X 右、Y 上、Z 前，米制；四元数 `(x,y,z,w)` |
| RoomMatrix | 不装 VMT Manager 时必须先发 `/VMT/SetRoomMatrix/Temporary`（12 个 float 的 4×3 矩阵），否则驱动 `RejectTracking`。插件默认第一次发位姿前发一次单位矩阵 |
| 探活 | 驱动 `RunFrame()` 周期性发 `/VMT/Out/Alive`；SteamVR 进 standby 时 RunFrame 暂停，Alive 也停 |

```js
VMT_ENABLE = { disable: 0, tracker: 1, leftController: 2, rightController: 3,
               leftIndex: 5, rightIndex: 6, viveTracker: 7 }
VMT_HAND_SLOTS = { left: 1, right: 2 }
```

配置 `vmtEnableMode: "index" | "controller"` 切换 5/6 与 2/3，默认 `index`。

---

## 5. `vrchat_pose` 工具（手部）

### 5.1 语义

把指定手的目标位姿**带插值**发到 VMT，内部定时器循环 30–90Hz，**不是一次调用一个瞬移包**。

```text
调用 → 探活（≤1200ms，失败则降级）→ 可选 reaction 延迟 → 定时器循环（每帧插值 + 发包）
     → 到达目标：hold ? 继续低频喂位姿 + 微动作 : 发 enable=0 交还手柄
```

- 发送循环由 `setTimeout` 链驱动，按**起始时间戳**补 drift（不累积误差）；
- 新调用**抢占**旧调用：旧调用立刻返回 `interrupted:true`，新动作从当前实际位姿继续，不瞬移；
- `wait:false` 时工具立即返回，动作在后台继续；
- `hold:true` 时到达后以 `poseHoldHz`（默认 20Hz）继续喂位姿，并叠加 idle 微动作
  （位置 ≤ ±1.2cm、旋转 ≤ ±0.4°，可 seed 复现）；
- `hold:false` 时结束后发 `enable=0`，真实手柄/追踪接管；
- `cancel:true` 立即停（可带 `disable:true` 交还双手）。

### 5.2 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `hand` | `left`/`right`/`both` | `both` | 移动哪只手；只给 `left`/`right` 对象时会自动推断 |
| `target` | `{x,y,z}` | — | 目标位置（米，Unity 左手系）。**缺省的轴保持当前值** |
| `rotation` | `{yaw,pitch,roll}` 或 `{qx,qy,qz,qw}` | 保持当前 | Unity 顺序 `qYaw*qPitch*qRoll` |
| `left` / `right` | `{target, rotation}` | — | `hand:"both"` 时按手覆盖；target 按轴覆盖顶层 `target` |
| `durationMs` | int | `600` | 插值时长，0 = 单帧，最大 10000 |
| `easing` | `linear`/`easeOut`/`easeInOut` | `linear` | `easeOut` = 起步快收尾慢（伸手手感） |
| `hold` | bool | `true` | 到达后继续维持位姿 + 微动作 |
| `holdMs` | int | `0` | >0 时到点后自动停止维持 |
| `hz` | int | 配置值 `60` | 30–90 |
| `humanize` | bool | `true` | 动作时长 ±8% 抖动 + hold 微动作 |
| `reaction` | bool | `false` | 开始前加对数正态反应延迟（120–1600ms） |
| `seed` | int | 配置值 `1` | 拟人层随机种子 |
| `wait` | bool | `true` | `false` = 立即返回后台播放 |
| `roomMatrix` | bool | 自动一次 | 强制重发单位 RoomMatrix（SteamVR 重启后需要） |
| `cancel` / `disable` | bool | — | 停止动作 / 顺带交还双手 |

### 5.3 返回

```json
{
  "ok": true, "hand": "right", "sides": ["right"],
  "from": { "right": { "position": [-0.25, 1.2, 0.18], "rotation": [0,0,0,1] } },
  "to":   { "right": { "position": [0.3, 1.4, 0.2],   "rotation": [0,0,0,1] } },
  "durationMs": 600, "effectiveDurationMs": 638, "easing": "linear", "hz": 60,
  "frames": 38, "sequence": 1, "hold": true, "holdActive": true, "humanize": true, "reactionMs": 0,
  "driver": { "alive": true, "reason": "alive", "listenError": null, "lastAliveMsAgo": 42, "lastUnavailable": 0 },
  "warning": null,
  "started": true, "finished": true, "interrupted": false, "cancelled": false,
  "elapsedMs": 655, "totalFramesSent": 76
}
```

- `driver.alive`：`true` = 收到过 Alive；`false` = 探活超时（降级，照发包）；`null` = 39571 被占无法判断。
- `warning`：降级提示，否则 `null`。**工具永远不因为没驱动而抛错。**

### 5.4 失败模式

| 现象 | 原因 | 表现 / 处理 |
| --- | --- | --- |
| `driver.alive=false` + warning | VMT 驱动没装 / SteamVR 没起 / standby / safe mode 拉黑 | 工具照常返回，位姿发出去没人收。按 `vrchat-vr-driver/tools/README.md` §8 排查 |
| `driver.alive=null` + `listenError` | 39571 被别的工具占用（如 `motion.mjs`） | 无法探活但照发；等插件空闲 30s 释放端口，或改配置 |
| 驱动在线但手不动 | RoomMatrix 未设置 / standby / VRChat 没进 VR / enable 模式不匹配 | 看 `pose.driver.lastUnavailable`（0=OK）；换 `vmtEnableMode:"controller"` 试 2/3 |
| 手指/手腕朝向不对劲 | 四元数约定与游戏内实际朝向有差 | 先 `rotation:{yaw:0,pitch:0,roll:0}` 校零，再逐步加角度；真机截图对比 |
| `EADDRINUSE` 警告 | 端口冲突 | `vmtListenEnabled:false` 可让插件完全不监听 39571（只发包不探活） |

---

## 6. `vrchat_look` 工具（auto / head / snap）

### 6.1 分流逻辑

```text
mode:auto（默认）→ A 线头部可用？ ──是──→ vrchat_head 真转头（精确角度 + pitch）
                                   └否──→ snap turn（VRChat /input）
mode:head          → 强制真转头；不可用时**降级 snap** 并在结果里标 fallback:true + warning
mode:snap          → 强制 snap；additional snapMode:axis|comfort
旧值 axis/comfort  → 视为 mode:snap + 对应 snapMode（兼容）
```

- 头部可用 = 端口 39572 被占用（`alive===true`）；`auto` 只在确定为 true 时用头部，`null/false` 都退回 snap。
- 真转头模式下：`angleDeg` 是相对 yaw；`target {x,y,z}` 按头到目标点的方向算 yaw/pitch；
  `pitchDeg` 追加相对抬头/低头；`durationMs` 不给时按角度估算（200–1500ms）。
- 真转头后会把 snap 的 yaw 估计同步到头部位姿，便于驱动消失后 snap 回退接续。
  `currentYawDeg` 在 head 模式下用于**校准头部估计朝向**（插件重载后建议先用一次）。
- snap 模式细节见下文 §6.4。

### 6.2 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `angleDeg` | number | — | 相对 yaw，正 = 向右。与 `target` 二选一 |
| `target` | `{x,z}` / `{x,y,z}` | — | 面向世界点：head 模式会同时算 pitch；snap 模式只用 yaw |
| `pitchDeg` | number | 0 | 相对 pitch（+ = 抬头），head 模式才有意义 |
| `durationMs` | int | 按角度估算 | head 模式的转身时长 |
| `mode` | `auto`/`head`/`snap`/`axis`/`comfort` | 配置值 `auto` | 见 §6.1 |
| `snapMode` | `axis`/`comfort` | `axis` | snap 子模式：axis = `/input/LookHorizontal`（桌面/VR 都行）；comfort = `ComfortLeft/Right` 按钮（仅 VR） |
| `stepDeg` | number | 45 | snap 每格度数（1–180） |
| `gapMinMs`/`gapMaxMs` | int | 180/320 | 两次 snap 之间的人类式随机间隔 |
| `holdMs` | int | 90 | snap 按下保持时长（±15% 抖动）；head 模式下是 hold 时长 |
| `maxSnaps` | int | 16 | snap 单次安全上限 |
| `currentYawDeg` | number | — | 校准当前 yaw（head 模式会同步头部估计朝向） |
| `seed` | int | 1 | 抖动种子 |
| `planOnly` | bool | false | 只算计划不发包 |

### 6.3 返回

head 模式（在 `vrchat_head` 的结果上追加）：

```json
{
  "mode": "head", "headAvailable": true, "fallback": false,
  "requestedDeg": 90, "actualDeg": 90, "pitchDeg": 0,
  "startYawDeg": 0, "endYawDeg": 90, "startPitchDeg": 0, "endPitchDeg": 0,
  "frames": 42, "effectiveDurationMs": 640, "driver": { "alive": true, "reason": "port-in-use", "port": 39572 },
  "...": "以及 vrchat_head 的 from/to/openvr/holdActive 等字段"
}
```

snap 模式（在 `SnapTurner.turn` 的结果上追加）：

```json
{
  "mode": "snap", "snapMode": "axis", "headAvailable": false, "fallback": true,
  "requestedDeg": 90, "actualDeg": 90, "snaps": 2, "stepDeg": 45, "direction": 1,
  "startYawDeg": 0, "endYawDeg": 90, "gapsMs": [263],
  "packetsSent": 4,
  "warning": "A-line head driver not available (port-free); fell back to snap turn."
}
```

- `fallback:true` 只表示"想要 head 但降级了"（仅 `mode:"head"` 不可用时）。
- `planOnly` 时 head 模式返回 `{mode:"head", requestedDeg, pitchDeg, durationMs, targetOrientation}`，
  snap 模式返回 snap 计划；都不发包。

### 6.4 snap 模式的行为与限制

- 发送序列严格 `1 → 0 → (间隔) → 1 → 0 …`（轴 float、按钮 int；不回 0 不会触发下一次）。
- 间隔/按压时长带 seed 可复现抖动，**不会像节拍器**；`signal` 中断时保证补发一次 0，不会让视角一直转。
- **朝向只能估计**：snap 模式下 VRChat 不暴露头/身体 yaw，插件维护"自己转过的累计 yaw"；
  玩家手动转头后会偏，可用 `currentYawDeg` 校准。这是兜底方案的硬限制（真转头模式没这个问题）。
- 桌面模式 `axis` 是平滑转，按住 90ms 只转一小段，**不等于 45°**；snap 语义只在 VR 且开启
  Comfort Turning 时成立。真机验证时必须先确认这一点。
- 推荐"看向玩家"：`vrchat_look({target:{x,y,z}})`（auto→head 时含 pitch）→ `vrchat_pose` 抬手 → `vrchat_say`。

---

## 7. 拟人层 `lib/humanize.js`

纯函数 + 可 seed 的 mulberry32 随机源，不依赖 socket/定时器，单测见 `tools/test_humanize.mjs`。

| 函数 | 用途 |
| --- | --- |
| `createRng(seed)` | 可复现随机源（`float/int/chance/pick/gaussian`） |
| `lognormalSample(rng,{median,sigma})` | 对数正态采样 |
| `reactionDelay({medianMs,sigma,minMs,maxMs,rng/seed})` | 反应延迟（默认中位 400ms、σ=0.35，夹 120–1600ms） |
| `jitterMs(baseMs,{relative,...})` | 动作时长抖动（默认 ±12%） |
| `humanIntervals({count,minMs,maxMs,rng/seed})` | 人类式间隔序列，**相邻不相等**（避免节拍器） |
| `microMotionAt(tMs,{seed,amplitude,frequency})` | idle 微动作：由 (seed,t) 决定、平滑、严格有界 |
| `easeProgress(t,easing)` | `linear` / `easeOut` / `easeInOut` |
| `createHumanizer({seed,...})` | 带 seed 的拟人层实例（三个 Controller/Turner 共用） |

原则：**决策层只给意图，拟人化是原语层的属性**；所有随机都能用 `seed` 复现，方便回归测试。

---

## 8. 离线单测（不需要 SteamVR / VRChat）

```powershell
cd <插件目录>        # 含 index.js / lib / tools 的那一层；仓库根就是这个目录
node tools/test_humanize.mjs        # 13 checks：分布/边界/可复现/微动作/缓动
node tools/test_head.mjs            # 16 checks：OpenVR 换算/7-float 编码/插值/hold/抢占/abort/降级
node tools/test_pose.mjs            # 14 checks：VMT 字节布局/插值/帧率/hold/抢占/abort/降级
node tools/test_look.mjs            # 12 checks：mode 归一/snap 换算/发送序列/间隔抖动/yaw/target/comfort/abort
node tools/plugin-offline-test.mjs  # 21 checks：真实 apply() + mock VRChat + mock VMT + mock A 线 HMD
node tools/osc-selftest.mjs         # 编解码回归
node tools/bridge-integration-test.mjs
```

测试原理：

- `test_head.mjs` 起本地 UDP socket 当 **mock A 线驱动**（收 19080，无回包），用真实 `HeadController` 发包，
  逐包解码验证：`/dsh/head/pose` 的 7 个 float、`,fffffff` 标签、大端、Unity→OpenVR 换算
  （位置 z 取反、四元数 qz/qw 取反 + w≥0）、插值单调、末帧精确、帧率/时长、hold 呼吸幅度、
  抢占/wait:false/abort、无驱动（端口空闲 → `driver.alive=false`）与 `assumed` 覆盖。
- `test_pose.mjs` 起 **mock VMT 驱动**（收 19090、周期回 Alive 到 19091），验证 `,iiffffffff`、
  `idx/enable`、插值、hold、抢占、abort、无驱动/端口被占两种降级。
- `test_look.mjs` 起 **mock VRChat**（19095），验证 snap 发送序列 `[1,0,1,0]`、间隔、comfort 按钮、
  中断释放、`normalizeLookMode` 的 auto/head/snap + 旧值兼容。
- `plugin-offline-test.mjs` 在假 DSH context 上挂真实 `apply()`，同时 mock VRChat（19010/19011）、
  VMT（19070/19071）、A 线 HMD（19072），验证 16 个工具注册（0.5.0 新增 `vrchat_doctor`/`vrchat_mode`）、`vrchat_head` 端到端、
  `vrchat_look` 的 auto→head、强制 snap、驱动消失后 fallback、status.head 等；玩家目录用临时假仓库，
  永不 spawn 真实 demo。

---

## 9. 真机验证步骤（给 Lead / 有 SteamVR 的机器）

> 前提：这些步骤会**真实驱动 SteamVR 的 HMD 与虚拟手柄**。按任务约定我没有自己开游戏；
> 请在 VRChat / SteamVR 空闲窗口执行，并盯住 `vrserver.exe`。
> 顺序建议：**先验头部（A 线）→ 再验手部（VMT）→ 最后验 auto 分流与长跑**。

### 9.0 前置检查（人来做）

1. SteamVR 已启动，VRChat 已用 A 线方式进入 VR（`dsh_hmd.DSH_HMD`），log 里有 `StartVRSDK: OpenVRLoader`。
2. `drivers\dsh_hmd\bin\win64\driver_dsh_hmd.dll` 已加载，UDP **39572** 在听（`netstat -ano -p UDP | findstr 39572`）。
3. 手部要验的话：VMT 驱动已加载（`vrserver.txt` 有 `Loaded server driver vmt`），UDP 39570 在听。
4. DSH 已**重载插件**（link 安装，改了 `index.js`/`lib/*` 需要重载才生效——由 Lead 决定时机）。
5. 先跑 §8 离线单测全绿。

### 9.1 头部（A 线）验证

| # | 动作 | 判据 / 失败处理 |
| --- | --- | --- |
| 1 | `vrchat_status` 或调一次 `vrchat_head` 后看 `status.head.driver` | `alive:true, reason:"port-in-use", port:39572`；`alive:false` = 驱动没起/端口不对 |
| 2 | `vrchat_head({rotation:{yaw:90}, durationMs:1000, hold:false})` | 画面**平滑**转向右 90°（返回里 `openvr.to.rotation` 约 `(0,-0.707,0,0.707)`） |
| 3 | `vrchat_head({rotation:{yaw:0}, durationMs:800, hold:false})` | 转回正前方；无跳变、无回弹 |
| 4 | `vrchat_head({rotation:{pitch:30}, durationMs:800})` | **抬头看天**（不是低头）；再 `pitch:-30` 看地 |
| 5 | `vrchat_head({target:{x:0,y:1.6,z:0.5}, rotation:{yaw:0}, durationMs:600})` | 头部前移 0.5m（Unity +Z），画面靠近；位置换算方向正确 |
| 6 | `vrchat_head({rotation:{yaw:90}, durationMs:2000, wait:false})` 后立刻 `vrchat_head({rotation:{yaw:-90}, durationMs:300})` | 第一次返回 `interrupted:true`，头部从当前位置平滑转向 -90，不瞬移 |
| 7 | `hold:true` 等 10 秒 | 头部保持朝向，有极轻微呼吸漂移（≤4mm/0.3°，不该肉眼明显晃）；`status.head.holdActive=true` |
| 8 | `vrchat_head({cancel:true})` | 停流；驱动保持最后位姿；`status.head.holdActive=false` |

### 9.2 手部（VMT）验证（如果本轮也验）

| # | 动作 | 判据 / 失败处理 |
| --- | --- | --- |
| 1 | `vrchat_pose({hand:"right", target:{x:0.4,y:1.3,z:0.35}, durationMs:800, hold:false})` | 游戏里右手**平滑**移到该点；`driver.alive=true` |
| 2 | 两次相反目标（`wait:false` 抢断） | 第二次打断第一次，旧调用 `interrupted:true`，无跳变 |
| 3 | `hold:true` 等 10 秒 → `vrchat_pose({cancel:true,disable:true})` | 轻微漂移后交还手柄 |
| 4 | 崩溃看门狗 | 发位姿期间盯 `vrserver.exe` 与 `<Steam 安装目录>\dumps`；有 dump 立即 `cancel` 并记录参数/时间点 |

### 9.3 `vrchat_look` 分流验证

| # | 动作 | 判据 |
| --- | --- | --- |
| 1 | A 线在线时 `vrchat_look({angleDeg:90})` | 返回 `mode:"head"`，视线**平滑**转 90°；没有 `/input/LookHorizontal` 包 |
| 2 | `vrchat_look({angleDeg:90, pitchDeg:20})` | 转头 + 抬头 20° |
| 3 | `vrchat_look({target:{x:1,y:1.6,z:0}})` | 面向 +X 方向（yaw 90°） |
| 4 | `vrchat_look({mode:"snap", angleDeg:90})` | 返回 `mode:"snap"`；VR 下是 2 次 45° snap |
| 5 | 停掉 A 线驱动后再 `vrchat_look({angleDeg:90})`（auto） | 自动退回 snap（`mode:"snap"`, `headAvailable:false`） |
| 6 | `vrchat_look({mode:"head", angleDeg:90})`（A 线停掉时） | 返回 `mode:"snap"`, `fallback:true` + warning |

### 9.4 长跑与回滚

- 10 分钟：循环 `head yaw ±30 / pitch ±15 / hold 3s / cancel`，再穿插手部动作；判据：无 dump、
  `/VMT/Out/Alive` 不断流、`vrchat_status` 计数持续增长、VRChat 画面无异常。
- 回滚：`vrchat_head({cancel:true})` + `vrchat_pose({cancel:true,disable:true})`；不会改 SteamVR/VMT/A 线配置。
  需要动系统配置/重启 DSH 时交给 Lead。

### 9.5 端口占用注意

- 头部通道：**39572** 是 A 线驱动的，插件只**读探测**（bind 后立即释放），不会长期占用。
- 手部通道：插件只在第一次 `vrchat_pose` 时绑 39571 听 Alive，空闲 30s 释放；与
  `vrchat-vr-driver/tools/motion.mjs`（固定 bind 39571）同跑时需错开或改配置。

---

## 10. 已知限制 / 下一步

1. **A 线驱动没有回包**：可用性只能靠端口占用启发式；误判时用 `headDriverAssumed` 强制。
2. **Windows 定时器粒度**：请求 90Hz，实际通常 60–70Hz（`frames`/`elapsedMs` 可估）；这是 OS 限制，不是丢包。
3. **没有手臂 IK / 关节限位**：`vrchat_pose` 给的是手（腕）目标点，手肘由游戏侧 IK 猜；大幅抬手可能穿模。
4. **头部位置需要可信的当前值**：真转头模式下插件以"自己最后命令的位姿"为当前值；插件重载后
   建议先用一次绝对 `vrchat_head`（或 `vrchat_look({currentYawDeg})`）重新对齐。
5. **snap 兜底的 yaw 只能估计**：玩家手动转头后会偏，`currentYawDeg` 可校准。
6. **真机未验**：见 §9；验证结果请回写本文档。
