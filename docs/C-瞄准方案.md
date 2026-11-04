# C 线：激光瞄准点击闭环（离线核心）方案

> 目标（HANDOFF §8-C）：「打开菜单 → 激光指向某菜单项 → 扳机点击 → 截图确认选中」。
> 本文是 C 线的**离线核心**交付说明：像素↔朝向数学、手部激光约定、帧差确认、真机标定流程。
>
> **状态声明（诚实优先）**：
> * 已完成并离线单测：`lib/aim.mjs`（29 项单测全绿）、`tools/aim-lab.mjs`（对 15 张真实截图跑通）。
> * **尚未在真机验证任何一条手部激光方向结论**（本轮约束：不启动 SteamVR/VRChat、不发真实位姿包）。
> * 文中凡未真机测过的结论都标「**未验证，待真机标定**」；真机流程只是可执行清单，不是已执行记录。

---

## 0. 交付物与命令

| 文件 | 作用 | 是否随包 |
| --- | --- | --- |
| `lib/aim.mjs` | 纯函数：像素↔角度、手部瞄准位姿、SBS 单眼换算、帧指纹/帧差、点击序列计划 | 是（`package.json` files 含 `lib`） |
| `tools/test_aim.mjs` | 离线单测（零依赖，29 项） | 否（tools 不随包） |
| `tools/aim-lab.mjs` | 离线实验 CLI：真实截图 → 像素/角度/建议 `vrchat_pose` JSON；两图差异比 | 否 |
| `docs/C-瞄准方案.md` | 本文 | 是（files 含 docs） |

```powershell
# 单测（全绿）
node tools/test_aim.mjs

# 真实截图实验（相对路径会去兄弟工程 vrchat-vr-driver 下找）
node tools/aim-lab.mjs --png shots/live/20-quickmenu-open.png --target 0.8,0.9
node tools/aim-lab.mjs --png shots/live/02-hands.png --target 0.65,0.6
node tools/aim-lab.mjs --diff shots/live/20-quickmenu-open.png shots/live/21-dashboard-hidden.png
node tools/aim-lab.mjs --help
```

本轮没有修改 `index.js`、`package.json`、`lib/` 已有文件、README、其它队友文件；没有启动 SteamVR/VRChat、没有发任何位姿包、没有 git 操作、没有装包。

---

## 1. 关键事实：Headset Window 截图是**双眼并排（SBS）**

用 `player/src/perception/png.mjs`（兄弟工程零依赖解码器）解码 `vrchat-vr-driver/shots/live/*.png` 实测：

* 15 张截图全部 **1280×720**，其中 14 张左右两半内容高度相似（左右各 **640×720** 的一只眼视图）；
* 左半与右半的平均亮度差（SAD，0..255，越小越像同一场景的两只眼）：

| 截图 | SAD（左半 vs 右半） | 判定 |
| --- | --- | --- |
| `01-before.png` | ≈7.6 | SBS 双眼 |
| `02-hands.png` | ≈8.6 | SBS 双眼 |
| `03-trigger.png` | ≈8.8 | SBS 双眼 |
| `04-system.png` | ≈8.7 | SBS 双眼 |
| `05-aim180.png` | ≈7.9 | SBS 双眼 |
| `06-aim0.png` | ≈8.6 | SBS 双眼 |
| `07-click.png` | **≈72.3** | **单幅**（dashboard 桌面视图截图，非双眼） |
| `08-after-system.png` | ≈8.5 | SBS 双眼 |
| `09-system2.png` | ≈8.6 | SBS 双眼 |
| `10-aim-x.png` | ≈8.7 | SBS 双眼 |
| `11-aim-x2.png` | ≈8.3 | SBS 双眼 |
| `12-b-back.png` | ≈8.3 | SBS 双眼 |
| `19-vrchat-home.png` | ≈7.5 | SBS 双眼 |
| `20-quickmenu-open.png` | ≈19.0 | SBS 双眼（Robot 头占满中央、视差大，SAD 偏高） |
| `21-dashboard-hidden.png` | ≈19.9 | SBS 双眼 |

> 数据来自 `aim-lab` 的自动判定采样（每行/列抽样），与全像素统计（20 号约 20.0、07 号约 71.9）相差 <1，属采样误差。
> 肉眼复核 `20-quickmenu-open.png`、`02-hands.png`：整图里左右各是一个完整眼视图（Robot 头分别位于两半的中央偏左/右）。

**结论（对代码的硬约束）**：

1. 像素→角度**必须用单眼视图尺寸（640×720）** 计算 `fx`；用整图宽 1280 会让 `fx` 翻倍、角度大约差 **2.74 倍**（见 §6 示例）。
2. 整图坐标 → 单眼坐标用 `mapImagePointToEye()`：`eyePixel.x = fullPixel.x - (eye === 'right' ? 640 : 0)`。
3. **不是所有截图都同样布局**：`07-click.png` 是单幅桌面视图。`aim-lab` 默认用左右两半相似度自动判断（SAD ≤ 30 → SBS，否则 mono），并在 JSON 的 `image.layout` 里打印判定依据；真机遇到新截图源时用 `--layout sbs|mono` 强制覆盖。
4. 单眼分界是否精确在 `width/2`：现有 1280×720 截图可确认（两半各自完整、特征对称）；换分辨率/裁剪方式后**未验证，待真机标定**。

---

## 2. 推导：FOV → fx → 角度

### 2.1 相机模型

单眼视图宽 `W`、高 `H`，水平视场角 `fovDeg`（HANDOFF 线索 90°），方形像素：

```text
fx = (W / 2) / tan(fovDeg / 2)          # 焦距（像素）
fy = fx                                 # 方形像素
dx = px - W/2                           # 屏幕 x 向右为正；px 是单眼视图内坐标
dy = py - H/2                           # 屏幕 y 向下为正
yaw        = atan2(dx, fx)              # + = 向右
pitchUp    = atan2(-dy, fy)             # + = 向上（相机系）
hand pitch = -pitchUp                   # hand 约定 + = 向下（未验证，待真机标定）
head pitch = +pitchUp                   # head 约定 + = 向上（lib/head.js 语义）
```

反函数（不做钳制，保证 round-trip）：

```text
dx = fx * tan(yaw)
dy = -fy * tan(pitchUp)
px = W/2 + dx
py = H/2 + dy
```

代码：`pixelToAngles()` / `anglesToPixel()` / `focalLengthPx()`；单测 round-trip 误差 < 0.01°。

### 2.2 实例（真实截图 `20-quickmenu-open.png`，`--target 0.8,0.9`）

```text
整图 1280×720 → 自动判 SBS，目标落在右眼
fullImagePixel = (0.8×1280, 0.9×720) = (1024, 648)
右眼视图 640×720，eyePixel = (1024-640, 648) = (384, 648)
fx = (640/2)/tan(45°) = 320
dx = 384-320 = 64        dy = 648-360 = 288
yaw   = atan2(64, 320)  = 11.3099°   （目标在中心右侧）
pitch = atan2(288, 320) = 41.9872°   （hand 约定：向下）
建议 vrchat_pose：{ hand:"right", target:{0.25,1.2,0.18}, rotation:{yaw:11.31, pitch:41.99, roll:0} }
```

（以上数字是 `aim-lab` 的真实输出，见 §8。）

### 2.3 角分辨率与距离换算

单眼 640 宽、fov=90°、fx=320 时，每像素对应角度约：

| 位置 | 角度/像素 | 1m 处横向误差 | 0.5m 处横向误差 |
| --- | --- | --- | --- |
| 画面中心 | atan(1/320) ≈ **0.179°/px** | ≈3.1 mm | ≈1.6 mm |
| 画面边缘（dx=320） | fx/(fx²+dx²) ≈ **0.0895°/px** | ≈1.6 mm | ≈0.8 mm |

> 这些是**几何下限**（像素量化误差），不是命中误差；真机还有 FOV、激光偏移、手抖等系统误差。

---

## 3. 符号约定表（写进代码、别靠记忆）

| 量 | `axis:'hand'` | `axis:'head'` | 依据 |
| --- | --- | --- | --- |
| 屏幕坐标 | 左上原点，x 右、y 下 | 同左 | 截图/图像常识 |
| `yaw` | **+ = 向右** | **+ = 向右** | Unity 左手系 yaw+ 绕 +Y 右转；`lib/head.js` 已验证头部 yaw=90 有效（HANDOFF §6） |
| `pitch` | **+ = 向下** | **+ = 向上** | hand：HANDOFF §8-C 经验值，**未验证，待真机标定**；head：`lib/head.js` 的直观语义（内部取反交给 Unity） |
| 输出 `rotation` | 直接给 `vrchat_pose`（Unity 欧拉 `qYaw*qPitch*qRoll`，pitch+ 下） | 直接给 `vrchat_head`（直观 pitch+ 上） | `lib/vmt.js:quatFromEuler` / `lib/head.js:orientationToQuat` |
| 钳制 | 默认 ±85°（`AIM_DEFAULTS.maxYawDeg/maxPitchDeg`），可传 `null` 关闭 | 同左 | 防万向锁/手腕反关节；83–89° 区间的可用性**未验证** |
| 手部静止位姿 | `HAND_REST_POSES`（position 抄 `lib/vmt.js:DEFAULT_POSES`，rotation=0） | — | 位置是合理默认值，**未真机标定** |
| 旋转基座（reach 模式） | `HAND_PIVOTS`（肩/胸前猜测值） | — | **未真机标定** |
| 标定偏移 | `yawOffsetDeg` / `pitchOffsetDeg`（默认 0） | 同左 | 真机实测后填；`aim-lab` 有 `--yaw-offset/--pitch-offset` |

---

## 4. 手部激光方向：待实测项清单

> 每项格式：**预期 → 如何验证 → 失败怎么改**。全部「未验证，待真机标定」，本轮一条都没测。
> 「怎么改」都指向 `lib/aim.mjs` 的精确位置，改完必须重跑 `node tools/test_aim.mjs`。

| # | 待测项 | 预期（HANDOFF/代码假设） | 如何验证（真机） | 失败怎么改 |
| --- | --- | --- | --- | --- |
| L1 | 激光朝前 = 控制器本地 +Z | `yaw=0,pitch=0` 时激光指向正前方（画面中心） | `vrchat_pose({hand:"right", rotation:{yaw:0,pitch:0,roll:0}, hold:true})` → 截图看激光/准星是否在眼视图中心 | 若偏常量角度：用 `yawOffsetDeg/pitchOffsetDeg` 标定；若偏在手/腕位置：标定 `restPose` |
| L2 | `yaw` 正 = 向右 | `rotation:{yaw:+10}` → 激光/准星向右移 | 只改 yaw ±10°，截图对比（见 §5 Phase 1） | 若反向：`pixelToAngles` 里 hand 分支的 yaw 取反（或调用方传负值），并改单测方向断言 |
| L3 | `pitch` 正 = 向下（与头相反） | `rotation:{pitch:+10}` → 激光向下移 | 只改 pitch ±10°，截图对比；同时对比 `vrchat_head({pitch:10})`（应为抬头） | 若 hand 实际是上：把 `pixelToAngles` 里 `axis==='hand'` 的 `pitchRaw = -pitchUpRaw` 改成 `+pitchUpRaw`（单测「上半屏 hand pitch<0」需同步反过来） |
| L4 | 水平 FOV = 90° | fx=(W/2)/tan45°=320（单眼 640） | 用已知角度差测像素位移：`fx_measured = Δpx / (tan(yaw2)-tan(yaw1))`，`fov = 2·atan((W/2)/fx_measured)`（见 §5 Phase 2） | 把实测 `fovDeg` 传给 `pixelToAngles/handAimFromTarget/aim-lab --fov`；若 FOV 是**垂直**而非水平，需按高度换 fx（改公式 + 单测） |
| L5 | 单眼分界 = 整图宽/2 | 1280×720 → 左右各 640×720 | 现有截图已确认（§1）；换分辨率/裁剪后重新确认 | 改 `stereoLayout()` 的分界；或 `aim-lab --layout mono` 按整幅处理 |
| L6 | 手部静止位姿 = `[±0.25,1.2,0.18]`、rotation 0 | 与 `lib/vmt.js DEFAULT_POSES` 一致 | 发默认位姿 → 截图看手的位置/朝向；用 `handHeightM` 微调高度 | 改 `HAND_REST_POSES`（或调用时传 `restPose`）；reach 模式改 `HAND_PIVOTS` |
| L7 | 激光命中点 = 手部原点方向 | 激光从手部沿 +Z 发射 | 同一旋转下把手的 position 前后移动 10cm，看画面准星是否跟着平移 | 若准星不动（aim pose 与 grip pose 不同）：记录固定偏移，用 `yawOffsetDeg/pitchOffsetDeg` 补偿；偏移随角度变化则需改 `handAimFromTarget` 的输出模型 |
| L8 | 左右手镜像 | 左手默认位姿 x 取反，其余同右手 | 重复 L1–L3 用左手 | 改 `HAND_REST_POSES.left/HAND_PIVOTS.left`；若 VMT 左手坐标系不同需单独处理 |
| L9 | 视线中心 = 眼视图中心 | fov 模型的 principal point 在 `(W/2,H/2)` | 转头/看已知世界点，比较屏幕中心与视线中心是否重合 | 采用主点偏移（改公式，加 `cx/cy` 参数）；多数渲染视角主点就在中心 |
| L10 | 点击后画面稳定时间 | settle 350ms / verify 500ms 是估计值 | 连拍截图，量 diffRatio 随时间衰减到噪声底所需帧数 | 改 `planClickSequence` 的 `settleMs/verifyDelayMs` 默认值 |
| L11 | 扳机点击阈值 | 压下 ≥0.70、释放 ≤0.55（HANDOFF §4，已验证扳机被 SteamVR 接收） | 点击后截图看菜单项是否选中 | 若未响应用 `lib/vmtinput.mjs` 调 `pressMs/trigger value` 或用 `vrchat_ui` 的 hold 时长 |

> 另外注意：VRChat 里不同菜单/世界的激光（射线）长度、准星位置可能不同；本方案只控制**手部旋转**，不控制射线终点（终点由游戏/UI 决定）。

---

## 5. 真机标定流程（待真机执行；本轮未执行）

> 前置：Steam → SteamVR → VRChat 已启动、dashboard 已隐藏（见 HANDOFF §5.3/§5.4）；
> 每步截图用 `vrchat_screenshot`（或 `player/tools/capture_frame.ps1`），**不要删改 `shots/live/` 现有截图**，
> 新截图请另存到新目录（例如 `shots/aim-calib/`）。
> 下面命令是「真机时用 DSH 工具」的写法，不是本轮执行过的记录。

### Phase 0：记录基线（5 分钟）

1. `vrchat_status` / `vrchat_doctor`：确认驱动在线、VMT knuckles 绑定生效。
2. 截图一张“静止手势”基线 → 这是后续所有 diff 的比较基准。
3. 记录当前手部静止位姿的截图（作为 L6 标定素材）。

### Phase 1：小步 10° 验证方向（L1–L3）

每次只改一个轴、±10°，截图后用 `aim-lab --diff` 或肉眼比较激光/准星位移方向：

| 序号 | 位姿 | 期望现象 | 实际（填） | 结论 |
| --- | --- | --- | --- | --- |
| P1 | `rotation:{yaw:+10,pitch:0}` | 准星/激光向右移 | | |
| P2 | `rotation:{yaw:-10,pitch:0}` | 向左移 | | |
| P3 | `rotation:{pitch:+10}` | 向下移（hand 假设） | | |
| P4 | `rotation:{pitch:-10}` | 向上移 | | |
| P5 | `vrchat_head({pitch:10})` 对照 | 头部**抬头**（与 hand 相反） | | |

**判定**：P1/P2 方向错 → 按 L2 改；P3/P4 方向错 → 按 L3 改。
**记录像素位移**：从截图里量准星移动的 Δpx，代入 §5 Phase 2 可同时反推 FOV。

### Phase 2：标定 FOV（L4）

已知两组 yaw（例如 -20°、+20°），量准星在**单眼视图**里的像素 x（记为 `x1/x2`）：

```text
fx_measured = (x2 - x1) / (tan(20°) - tan(-20°))
fov_measured = 2 * atan((W_eye/2) / fx_measured)      # 度
# 例：若 fx_measured≈320 → fov≈90°；若 fx_measured≈293 → fov≈95°
```

把 `fov_measured` 记录到本表，并在后续调用里显式传 `--fov` / `fovDeg`（不要改默认值，除非所有真机都同一头盔）。

| 位姿 | 准星像素 x（单眼） | 实测 fx | 实测 FOV | 与 90° 的差 |
| --- | --- | --- | --- | --- |
| yaw=-20° | | | | |
| yaw=+20° | | | | |

同样方法可测 pitch（用 `y` 方向），交叉验证 fx=fy 是否成立。

### Phase 3：标定手部原点与激光偏移（L6/L7）

1. 发 `rotation:{yaw:0,pitch:0,roll:0}`，`hold:true`，截一张图；
2. 在**单眼视图**里标出激光/准星像素 `(px0,py0)`；用 `aim-lab` 反算该像素对应角度：
   `node tools/aim-lab.mjs --png <截图> --target <px0,py0> --pixels --eye right --layout mono`
   （截图已是右眼视图时用 `--layout mono`；整图 SBS 时用默认 auto + 整图像素）。
3. 得到 `yaw0/pitch0` = 该像素的角度 → **标定偏移 = 该角度（因为期望是 0）**：
   `yawOffsetDeg = yaw0`，`pitchOffsetDeg = pitch0`。
4. 用新偏移重发 `yaw:0,pitch:0`，截图确认准星回到眼视图中心（误差目标 ≤ 1°）。
5. 若准星随 position 移动而平移（L7），记录平移量：`Δ准星角度 / Δposition`，用于判断是否需要 aim pose 补偿。

| 项 | 记录值 |
| --- | --- |
| 准星像素 `(px0, py0)` | |
| 反算角度 `(yaw0, pitch0)` | |
| `yawOffsetDeg / pitchOffsetDeg` | |
| 补偿后残差（°） | |

### Phase 4：闭环点击 5 次（HANDOFF §8-C 验收）

目标：在 VRChat Home 里连续 5 次选中**同一个菜单项**（例如 Quick Menu 的某个按钮），记录每次耗时。

```text
for i in 1..5:
  1) 截图 → 找到目标菜单项像素 (px,py)（先人工标定固定布局/人工点选）
  2) node tools/aim-lab.mjs --png <点击前截图> --target <归一化或像素> --eye right \
       [--yaw-offset <Phase3值>] [--pitch-offset <Phase3值>]
  3) 按输出的 poseInput 调 vrchat_pose（moveMode=rotate，默认只转不移动）
  4) settle（先用 350ms，按 L10 测出的值调整）→ 截图 → 确认激光落在目标上
  5) 调 vrchat_ui({action:"press", key:"trigger", side:"right", durationMs:120})
  6) 等 verifyDelay（先用 500ms）→ 截图 → aim-lab --diff 点击前 vs 点击后（区域=目标附近）
  7) 记录：命中/未命中、diffRatio、总耗时
```

记录表（真机填写）：

| 次数 | 目标菜单项（固定） | 瞄准位姿 yaw/pitch | 点击前截图 | 点击后截图 | diffRatio | 是否选中 | 耗时（ms） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |

**通过标准**：5/5 选中同一菜单项；记录每步耗时；截图留档（不放回 `shots/live/`，避免改动既有证据）。

### Phase 5：把实测值写回

* 方向/偏移类：确认后把 `yawOffsetDeg/pitchOffsetDeg` 作为默认值或文档推荐值，并**删除对应「未验证」标记**（只删真测过的项）。
* FOV：若与 90° 差 >2°，考虑把默认 `fovDeg` 改成实测值（需考虑多头盔兼容，建议仍由调用方传）。
* 把真机截图/耗时表补到本文件末尾（新增一节「真机标定记录」），不要改历史结论。

---

## 6. 误差来源与阈值

| 来源 | 量级（估计/几何） | 影响 | 缓解/阈值 |
| --- | --- | --- | --- |
| 像素量化 | 0.18°/px（中心）～0.09°/px（边缘） | 菜单按钮通常 30–80px 高 → 角尺寸 5–14°，量化可忽略 | 目标点取按钮中心；不用边缘像素 |
| 单眼/整图混用 | 整图宽算 fx → 示例角度 30.96° vs 正确 11.31°（约 2.74 倍） | **致命**，必偏 | 固定用 `stereoLayout/mapImagePointToEye`；`aim-lab` 输出里核对 `view.width=640` |
| FOV 假设错 | 实际 95° 按 90° 算：半宽处角度误差 ≈2.5°；FOV 若其实是垂直 90°：误差 ≈3.4° | 菜单边缘偏差数度 | Phase 2 标定；误差目标 ≤1° |
| 激光/手部偏移 | 未知，可能数度（取决于 aim pose） | 系统偏差，重复性高 | Phase 3 标定 `yawOffsetDeg/pitchOffsetDeg`；残差目标 ≤1° |
| hold 微动作/手抖 | `vrchat_pose` hold 旋转抖动 ≤±0.4°（`docs/vmt-pose.md` §5.1） | 点击瞬间轻微漂移 | 点击前 settle；必要时 `humanize:false`/`seed` 固定 |
| 时延 | settle/verify 默认 350/500ms，**未实测** | 点太早 → 未对准；点后过早截图 → 误判 | 按 L10 标定；初值先用默认，再按实测调 |
| 帧差噪声 | 渲染/动画会让整帧大量像素变化；示例 20 vs 21 两图 diffRatio=56.47%（不同状态，不是噪声基线） | 误判“画面变了=选中了” | 用**目标附近固定区域**；先测两次“无操作”截图的 diffRatio 作噪声底，`threshold = max(噪声底×3, 0.0005)`；differ=true 只作弱证据 |
| 菜单动画/激光闪烁 | 激光本身在动、菜单有淡入淡出 | 点击后必然有差异 | 多次重复 + 区域限制 + 人工/OCR 复核选中态（后续工作） |
| 截图源变化 | 07-click 是单幅（SAD≈72） | 按 SBS 算会错一半 | `--layout` 覆盖 + `image.layout` 输出核对 |

**阈值建议（初始值，待真机复核）**：

* `framesDiffer.threshold = 0.0005`（0.05%）+ `minChangedPixels = 1`：点击区域（约 192×216=41472 px）里只要 ≥21 px 变化就过阈值；
* 真机先跑“无操作/等待”基线若干次，若噪声底 >0.0005，则提高到 `3×噪声底`；
* `tolerance` 默认 0（无损 PNG）；若以后改传 JPEG/有压缩噪声，设 2–5。

---

## 7. 代码接口速查（`lib/aim.mjs`）

```js
import {
  AIM_DEFAULTS, UNVERIFIED_ASSUMPTIONS,
  focalLengthPx, pixelToAngles, anglesToPixel,
  stereoLayout, stereoEyeRect, mapImagePointToEye,
  handForward, headForward,
  HAND_REST_POSES, HAND_PIVOTS, handAimFromTarget,
  frameSignature, framesDiffer, planClickSequence,
} from './lib/aim.mjs';

// 像素 → 角度（单眼视图；hand pitch+ 下 / head pitch+ 上；默认钳制 ±85°）
pixelToAngles({ px: 384, py: 648, width: 640, height: 720, fovDeg: 90, axis: 'hand' });
// → { yawDeg: 11.3099, pitchDeg: 41.9872, pitchUpDeg: -41.9872, fx: 320, ... }

// 反函数（round-trip < 0.01°）
anglesToPixel({ yawDeg: 11.3099, pitchDeg: 41.9872, width: 640, height: 720, axis: 'hand' });

// 目标像素 → vrchat_pose 位姿（rotate 只转不移动；reach 额外按 pivot+距离给位置）
handAimFromTarget({ target: { x: 384, y: 648 }, width: 640, height: 720, hand: 'right' });
// → { target: {x:0.25,y:1.2,z:0.18}, rotation: {yaw:11.31,pitch:41.99,roll:0}, ... }

// 帧指纹 / 帧差（RGBA 缓冲；signature 持有原缓冲引用，不复制）
const sig = frameSignature(rgba, { width, height, region: { x, y, width, height }, step: 1 });
framesDiffer(sigA, sigB, { threshold: 0.0005, tolerance: 0, region, step: 1 });
// → { diffRatio, changedPixels, totalPixels, differ, identical, ... }

// 点击序列（纯数据，不执行 IO）
planClickSequence({ target, width, height, hand: 'right', settleMs, pressHoldMs, verifyDelayMs });
// → { steps: [pose, settle, press, settle, verify], aim, assumptions }
```

真机脚本消费方式：

```jsonc
// vrchat_pose 参数直接取 poseInput
{ "hand": "right", "target": {"x":0.25,"y":1.2,"z":0.18},
  "rotation": {"yaw":11.31,"pitch":41.99,"roll":0}, "durationMs":600, "easing":"easeOut", "hold":true }
```

---

## 8. 离线验收记录（本轮真实输出）

### 8.1 单测

```text
$ node tools/test_aim.mjs
...
test_aim: 29 passed, 0 failed
```

覆盖点：fx 推导、中心/右/上/下象限符号、round-trip <0.01°、FOV 与宽高变化、±85 钳制、标定偏移、
SBS 左右眼换算、`handAimFromTarget` rotate/reach、restPose/handHeightM、帧指纹（纯色/1 像素/区域外）、
`framesDiffer`（阈值/tolerance/step/尺寸不一致）、`planClickSequence` 步骤顺序。

### 8.2 `aim-lab` 对真实截图（20-quickmenu-open.png，`--target 0.8,0.9`）摘录

```json
{
  "ok": true,
  "file": "D:\\中转站API\\vrchat-vr-driver\\shots\\live\\20-quickmenu-open.png",
  "decoder": { "path": "...\\vrchat-vr-driver\\player\\src\\perception\\png.mjs", "source": "sibling" },
  "image": { "width": 1280, "height": 720,
             "layout": { "type": "side-by-side", "detected": true, "sad": 18.96,
                         "reason": "左右两半平均亮度差 19.0 <= 30，按 SBS 双眼图处理（启发式）" } },
  "target": { "input": { "x": 0.8, "y": 0.9, "unit": "normalized" },
              "fullImagePixel": { "x": 1024, "y": 648 },
              "eye": "right", "eyePixel": { "x": 384, "y": 648 } },
  "view": { "width": 640, "height": 720, "fovDeg": 90, "fxPixels": 320, "fyPixels": 320 },
  "angles": { "yawDeg": 11.3099, "pitchDeg": 41.9872, "pitchUpDeg": -41.9872,
              "clamped": { "yaw": false, "pitch": false },
              "convention": "yaw+ 右；hand pitch+ 下（head pitch+ 上）" },
  "poseInput": { "hand": "right",
                 "target": { "x": 0.25, "y": 1.2, "z": 0.18 },
                 "rotation": { "yaw": 11.3099, "pitch": 41.9872, "roll": 0 } }
}
```

### 8.3 `aim-lab` 对第二张真实截图（02-hands.png，`--target 0.65,0.6`）摘录

```json
{ "image": { "layout": { "type": "side-by-side", "sad": 8.56 } },
  "target": { "fullImagePixel": { "x": 832, "y": 432 }, "eye": "right", "eyePixel": { "x": 192, "y": 432 } },
  "view": { "width": 640, "height": 720, "fxPixels": 320 },
  "angles": { "yawDeg": -21.8014, "pitchDeg": 12.6804 },
  "poseInput": { "rotation": { "yaw": -21.8014, "pitch": 12.6804, "roll": 0 } } }
```

### 8.4 自动布局的边界案例（07-click.png，单幅）

```json
{ "image": { "layout": { "type": "mono", "detected": true, "sad": 72.3,
                          "reason": "左右两半平均亮度差 72.3 > 30，按单幅图处理（启发式）" } },
  "view": { "width": 1280, "height": 720, "fxPixels": 640 },
  "notes": ["该图按单幅处理（07-click.png 这类 dashboard 桌面截图就是单幅）：像素→角度只是近似参考，不是头显双眼映射"] }
```

### 8.5 `--diff` 真实输出（20 vs 21）

```json
{ "ok": true, "mode": "diff",
  "image": { "width": 1280, "height": 720 },
  "totalPixels": 921600, "changedPixels": 520418,
  "diffRatio": 0.56469, "diffRatioPct": 56.469,
  "meanAbsDiff": 2.499, "threshold": 0.0005, "tolerance": 0,
  "differ": true, "identical": false }
```

> 说明：两图是不同状态（quickmenu 打开 vs dashboard 隐藏），56% 是真实画面差异，**不是噪声基线**；
> 点击确认的阈值要按“同状态无操作”的实测噪声底来定（见 §6）。

### 8.6 未破坏既有门禁

```text
$ node tools/plugin-offline-test.mjs
21 offline plugin checks passed
```

---

## 9. 待真机验证清单（汇总勾选表）

- [ ] L1 激光朝本地 +Z（yaw=0/pitch=0 指向眼视图中心）
- [ ] L2 hand yaw 正 = 右
- [ ] L3 hand pitch 正 = 下（与 head 相反）
- [ ] L4 水平 FOV 实测值（默认 90° 是否成立；水平/垂直）
- [ ] L5 单眼分界（换分辨率/裁剪后）
- [ ] L6 手部静止位姿与实际手部位置的偏差
- [ ] L7 激光源 vs 手部原点（aim pose 偏移）
- [ ] L8 左手镜像
- [ ] L9 principal point 是否在眼视图中心
- [ ] L10 settle/verify 时延实测
- [ ] L11 扳机点击阈值与 hold 时长
- [ ] Phase 4：连续 5 次选中同一菜单项，记录耗时

全部通过后，才可以把本文对应条目的「未验证」改成「已实测（日期/截图）」。

---

## 10. 后续工作建议（不属于本轮离线核心）

1. **接入插件工具层**：等真机标定完成后，新增/扩展现有工具（由 Lead 决定）把 `aim-lab` 的逻辑变成一次调用
   `aim → pose → press → verify` 的闭环；`lib/aim.mjs` 已零依赖、可直接随包。
2. **目标自动定位**：目前目标像素靠人工/固定布局；可接 VRChat UI 布局先验或 OCR（HANDOFF §8-F 的感知线）。
3. **闭环增益**：一次点击若未命中，用“点击前后 diff 区域 + 准星位置”做在线修正（P 控制）而不是重标定整机。
4. **多头盔兼容**：把 `fovDeg`、`yawOffsetDeg`、`pitchOffsetDeg` 存成 per-headset 配置，避免改默认值。
5. **帧差确认升级**：`framesDiffer` 只能证明“画面变了”；要证明“选中了”需要菜单高亮/文字识别或已知状态图模板。

---

## 11. 真机实测记录（2026-11-04，本次会话；只写做过的）

环境：`vrserver` + `VRChat` 真机运行，HMD 为 `dsh_hmd.DSH_HMD`，虚拟手柄走 VMT（knuckles binding 已加载），快捷菜单打开。截图 1280×720 SBS（左右眼各 640×720）。

### 11.1 已验证（有截图/输出可复跑）

- **SBS 确认**：Headset Window 截图是双眼并排；角度必须按单眼 640 宽算（用整图宽会差 ~2.74×）。
- **激光可见且可检测**：快捷菜单打开后，右手出现淡青色激光射线。实测颜色随背景变化：
  * 暗地板背景 `rgb(95,178,189)`，亮地板背景 `rgb(107,229,251)`；
  * 菜单图标青 `rgb(43,171,194)`、镜面高光 `rgb(157,207,240)` 与激光可区分（颜色窗口 + RANSAC）。
  实现：`lib/laser.mjs`（`detectLaser` = 颜色候选 → RANSAC 直线 → 离群点剔除 → 取离手远端为瞄准点）。
  离线单测：`node tools/test_laser.mjs` → **19 passed**。
- **朝向符号（实测）**：`vrchat_pose` 的 `rotation.yaw +` = 激光瞄准点在画面里往**右**；`rotation.pitch +` = 往**下**（与 HANDOFF §8-C 的推断一致；头部 pitch 仍相反）。
- **视觉伺服能收敛**：`tools/aim-servo.mjs` 用"测瞄准点像素 → 像素误差→角度增量（默认 3.6 px/deg yaw、5.8 px/deg pitch）→ 再摆位"迭代。
  实测一次（head pitch -25°、目标像素 `196,575`）：瞄准点 `348,451 → 276,608 → 200,601 → 182,572`，**4 步收敛到 14.3 px**，随后扳机点击成功（`vrchat_ui select` ok）。证据：`shots/live/aim-servo-2026-11-04T14-50-45-*.png` + 同名 `.json`。
- **截图修复（副作用但关键）**：修复 `player/tools/capture_frame.ps1` —— 原先当别的窗口（浏览器/编辑器）盖住 Headset Window 时，`SetForegroundWindow` 被 Windows 前台锁拒绝，截到的是遮挡窗口（本次真机复现）。现用 `AttachThreadInput + HWND_TOPMOST` 临时置顶、截完还原，实测在浏览器全屏遮挡下仍能截到干净 VRChat 画面。

### 11.2 未完成 / 未验证（不要当成已验证）

- **Phase 4（连续 5 次选中同一菜单项）未达成**：伺服能收敛到像素目标，但**快速菜单图标区**的激光检测不稳定（菜单面板/动画/淡青杂物多，RANSAC 有时锁到静态亮线，实测单步误差会跳变；试过一个目标点，4 步后仍差 55 px）。已试的目标是镜面上的 "1/8" 翻页箭头（伺服收敛到 14 px 但点击无反应，判断该处不是可交互 UI）。
- 手部激光的**绝对**标定（手部原点、激光偏移、FOV 是否严格 90°）仍未做；当前用"像素伺服"绕过了绝对标定，但伺服增益是经验值，只在头 pitch -25° 附近实测过。
- 目标像素目前靠人工给（未做 UI 元素自动识别/OCR）。
- `framesDiffer` 只能证明"画面变了"（本次点击前后 diff 56–61% 主要来自菜单广告轮播），**不能**单独证明"选中了"。

### 11.3 下一步（建议）

1. 换一个**大而稳定的可交互目标**做验收（例如快速菜单底部的"设置"标签，选中后会整页切换；或世界里的明显按钮），并用"菜单区域限制 diff"排除广告轮播。
2. 提高检测稳定性的两个方向：给激光换成**高对比颜色/更粗的交互射线**（如 VRChat 设置里调 UI 颜色/指针），或做**两帧差分**（同一姿态连拍两帧，激光因抗锯齿会轻微抖动 → 分离静态淡青杂物）。
3. 伺服改成带滞后的 P 控制 + 每步多帧中值，减少单帧误检导致的跳变。

---

### 11.4 第二轮真机排查（2026-11-04 23:00–23:16）：卡在"射线与面板的 3D 相交"

本轮在真实 VRChat Home 里继续，新增三个有用的实测事实和一个仍未知的点：

**（1）快速菜单挂在左手上，左手必须一直跟随发流。**
之前只给右手发 `vrchat_pose` 时，左手的 VMT 数据停更 → 左手控制器失效 → 挂在左手的快捷菜单直接消失，后续所有"悬停/点击"都落空。修正：每次摆右手时用 `hand:'both'` 同时给左手发一个固定位姿（`(-0.32,1.30,0.35)`、yaw 10/pitch -20）。这解释了本轮前半段"按 B 没反应/菜单时有时无"的现象。

**（2）菜单开/关可以只用截图检测。** 在单眼坐标 `region=[120,330,500,540]` 里统计"暗蓝导航面板像素比例"：菜单关 ≈ **0.005**，菜单开 ≈ **0.234**；阈值 0.1 可靠（`tools/aim-hover.mjs` 的 `ensureMenu()` 用的就是它）。

**（3）VRChat 的 knuckles 绑定里，interact 就是模拟扳机。**
`bindings_knuckles.json` 中 `/user/hand/{left,right}/input/trigger` 以 `mode:"button"`、阈值 `click_activate_threshold:0.7 / click_deactivate_threshold:0.55` 绑到 `/actions/global/in/interact`（没有单独的 `triggerclick` 输入）。所以"扳机=点击"的假设在**绑定层**成立，`/VMT/Input/Trigger`（analog 0→1→0）理论上应该能触发 interact。

**（4）但是：射线在画面里"看上去指到面板"不等于 3D 里真的打到面板。**
- 用 `tools/aim-servo.mjs` 在菜单打开时把激光端点伺服到"设置"页签像素 `(307,500)`：**2 步收敛到 8.9 px**（`315,504`），随后扳机点击 `vrchat_ui select` 返回 ok；
- 点击前后 **菜单区域变化 0 像素**（全屏 2% 只是广告轮播），没有任何选中；
- 直接手发 `/VMT/Input/Trigger`(1→0) + `/VMT/Input/Trigger/Click`(1→0) 也一样没有任何 UI 变化。

判断：激光线在画面里可能"穿"过面板（VRChat 的激光渲染不做深度裁剪/或面板比射线还远），**2D 像素对齐 ≠ 3D 射线与 UI 面板平面相交**。因此仅靠"测激光 2D 端点"无法保证点中 3D UI；需要：

1. 用几何法：从左手位姿估计面板平面（或标定一次面板相对左手的偏移），把右手射线的 3D 方向与平面求交，反解所需 yaw/pitch；
2. 或用反馈法：点击后**用页面状态变化**判定是否命中，再在线修正角度（黑盒梯度），但要先找到至少一次能命中的姿态；
3. 或者换一个"一定在射线路径上"的目标：把面板/目标挪到射线当前命中的位置（移动左手让面板穿过射线），命中后再点。

**结论：C 仍未达成 Phase 4（连续 5 次选中同一菜单项）。** 已经做到：激光可检测、2D 伺服能收敛、点击指令能发出、菜单开关可控；差的是 3D 命中判定/反解。

**已备好下一步的几何工具（离线、有单测，未真机标定）**：`lib/aim3d.mjs`（`node tools/test_aim3d.mjs` → **26 项通过**）提供
`anglesToDirection` / `directionToAngles` / `rayPlaneIntersection` / `solveHandAim` / `intersectHandRayWithMenu`，
可以直接算"右手射线是否与左手菜单平面相交"和"手位置→目标点该摆的 yaw/pitch"。
下一次真机只需标定两个量：菜单相对左手的**平面偏移**（`menuOffset`）与**倾角**（`menuTiltDeg`），然后就能用 3D 求交替代 2D 像素伺服。

建议下一步优先做 (1) 或 (3)，并保留 `tools/aim-hover.mjs` 作为菜单状态/扫描脚手架。

---

## 附录 A：`anglesToPixel` 与 round-trip 的自检公式

```text
pixel = anglesToPixel(angles); angles2 = pixelToAngles(pixel)
max |angles2 - angles| < 0.01°  （单测已覆盖 ±80° 内多组、hand/head 两轴）
```

## 附录 B：`framesDiffer` 判定规则

```text
differ = totalPixels > 0
      && changedPixels >= minChangedPixels
      && changedPixels / totalPixels >= threshold
changedPixels：区域内至少一个 RGBA 通道差 > tolerance 的采样像素数
```

---

*本文所有「实测」数字均来自本机 `D:\中转站API\vrchat-vr-driver\shots\live\` 的真实截图与本仓库命令输出；*
*第 11 节是 2026-11-04 真机实测记录（已实测/未完成分开写）；其余真机标定相关条目一律「未验证，待真机标定」。*
