# Tickpack Web UI 交接清单

> **用途**：把此前多轮 UI / 交互审查的全部结论交接给实际写代码的人。
> **范围**：`web/**` 工作台、根目录落地页、图标资产；不涉及 `src/**` 的编译器/模拟器核心。
> **当前状态**：此前所有界面与交互建议均未落地；`web/icons/` 中的 34 个单文件 SVG + 1 个 sprite 已存在，但**尚未被任何 HTML/CSS/JS 引用**。
> **本文件**：是这一轮唯一新增的文件；没有修改任何其它文件。
> **设计基线**：延续 [docs/WHY.md:55](docs/WHY.md#L55) 的扁平、无渐变/发光、只保留有信息量反馈的原则。动效只服务状态变化，不做“炫技”。

> **实现状态（2026-11-08）**：本清单的 **P0 已全部落地**（图标 sprite/方向/aria、1024 紧凑顶栏、草稿/beforeunload/切样例/重置撤销、编译失败清空旧视图、去掉每 tick chip flash + reduced-motion + press 反馈）。仍未做的是 **P1/P2**，已整理到 [docs/UI-FOLLOWUP.md](docs/UI-FOLLOWUP.md) 并写明了后续实现时需要调整的要求。下面的 `[x]` 只标记 P0；P1/P2 保留 `[ ]`。

## 0. 背景与判断

整体底子很好：布局持久化、诊断跳行、时间轴回放、分栏拖拽、剧场分享已经形成产品辨识度。问题主要集中在三类：

1. **图标**：控件图标是 Unicode 字符拼贴，跨平台字形、视觉重量、语义方向、可访问名称都不稳定。
2. **动效**：没有统一的时间和曲线；有一处每 tick 重启的背景闪烁（过噪）；真正该有的操作反馈（按钮、菜单、状态切换）反而缺失。
3. **操作**：很多动作需要精确点击或多次菜单跳转；日志/执行徽标等“可导航的信息”目前不可点击；键盘与焦点支持不完整；少数操作会静默丢数据。

### 0.1 必须保留的现有交互

不要在改造中破坏这些已经成立的手感：

- 时间轴点击/拖动 seek + 悬停读数；
- 世界滚轮缩放、拖动平移、双击适配、双指缩放；
- 诊断点击跳到源码行；
- 分栏分隔条拖拽；
- 标签双击重命名；
- Space 暂停/继续、←/→ 单步、F 适配、R 重置、Ctrl+Enter 运行；
- 布局持久化、主题持久化、分享链接/剧场模式；
- toast、复制、下载 `.zip` 的现有流程。

### 0.2 非目标（不要顺手加）

- 不引入新运行时依赖；保持零依赖、单文件构建可用。
- 不修改 `src/**` 的编译/模拟/会话语义。
- 不做渐变、发光、视差、扫光、弹簧回弹、hover 抬升。
- 不做每 tick 闪烁、面板宽高 tween、播放头插值、日志平滑滚动。
- 不做 command palette、手势迷宫、隐藏双击/中键而没有可见替代入口。
- 不重绑已经形成肌肉记忆的快捷键。

---

## 1. 图标系统

### 1.1 现状

- **已有资产**：`web/icons/` 下有 34 个单文件 SVG 和 `tickpack-icons.svg` sprite；规格为 16×16 viewBox、`stroke-width="1.6"`、圆角端点/连接处、`currentColor`、无硬编码颜色。`play`/`pause` 为填充，其余为描边。
- **版本控制提醒**：`web/icons/` 目前是 git 未跟踪目录；提交实现时一并 `git add web/icons/`，否则接入后会 404。
- **未接入**：`web/index.html` / `web/style.css` / `web/layout.js` / `web/app.js` 仍然使用字符图标。不要重新画图标；按 1.2 接入。
- **当前字符图标清单**（以当前版本为准）：
  - `▶` 运行（[web/index.html:47](web/index.html#L47)，`.btn-icon` 9px，[web/style.css:231](web/style.css#L231)）；
  - `❚❚` / `▶` / `↺` 暂停/继续/重播（[web/app.js:699](web/app.js#L699)）；
  - `«` / `»` 面板折叠（[web/index.html:118-121](web/index.html#L118-L121)，[web/layout.js:655](web/layout.js#L655)）；
  - `□` 最大化、`⋯` 更多（每个面板头，见 [web/index.html:117-121](web/index.html#L117-L121) 等）；
  - `−` / `＋` 缩放（[web/index.html:156-158](web/index.html#L156-L158)）；
  - `‹` / `›` 时间轴前后（[web/index.html:259-260](web/index.html#L259-L260)）；
  - `⌃` 剧场手柄（[web/index.html:277](web/index.html#L277)）、`▾` 收起抽屉（[web/index.html:118](web/index.html#L118)）；
  - `×` 标签关闭 / 提示关闭（[web/layout.js:265](web/layout.js#L265)，[web/index.html:283](web/index.html#L283)）；
  - `▾` / `▸` 文件树（[web/datapack.js:75](web/datapack.js#L75)）；
  - `＋` 新建标签页（[web/index.html:95](web/index.html#L95)）；
  - `✦` 日志粒子计数（[web/app.js:678](web/app.js#L678)）；
  - `▶` 样例下拉箭头：仍是第三套图标语言，data URI 写死颜色（[web/style.css:180](web/style.css#L180)）。
- **唯一成体系的 SVG**：主题太阳/月亮（[web/index.html:70-71](web/index.html#L70-L71)，15px、1.4 描边）。本次统一到 `web/icons/`。

### 1.2 接入方式

- [x] **P0 · 内联 sprite**：在 `<body>` 顶部内联 `tickpack-icons.svg` 的 `<symbol>` 集合（用 `width="0" height="0"` 隐藏，不要 `display:none`），或同源外链 `<use href="web/icons/tickpack-icons.svg#i-play">`。单文件构建必须内联，不能依赖外链。
- [x] **P0 · 图标尺寸**：`.icon { width:16px; height:16px; display:block; flex:0 0 auto; }`；`.btn .icon { width:14px; height:14px; }`；`.btn-sm .icon { width:13px; height:13px; }`；标签关闭 12px。
- [x] **P0 · 禁止 `<img>` 直接吃 currentColor**：SVG 通过 `<use>`/内联继承颜色；如果必须用 `<img>`，改用 CSS `mask` + `background: currentColor`。
- [x] **P0 · 替换所有字符控件图标**（保留中文文字标签，除非本来就是纯图标按钮）：

| 位置 | 现在 | 替换 |
|---|---|---|
| 运行 | `▶` | `i-play` + “运行” |
| 暂停 / 继续 | `❚❚` / `▶` | `i-pause` / `i-play` + 文字 |
| 重播 | `↺` | `i-replay` + “重播” |
| 重置 | 文字 | `i-rotate-ccw` + “重置” |
| 单步 | 文字 | `i-step-forward` + “单步” |
| 时间轴前后 | `‹` `›` | `i-chevron-left` / `i-chevron-right` |
| 面板折叠 | `«` / `»` | 按位置用 `i-chevrons-left/right/up/down` |
| 最大化 / 还原 | `□` | `i-maximize` / `i-minimize` |
| 更多 | `⋯` | `i-more-horizontal` |
| 缩放 | `−` / `＋` | `i-zoom-out` / `i-zoom-in`（或 `i-minus` / `i-plus`） |
| 适配 | 文字 | `i-fit` + “适配” |
| 样例下拉 | data URI | sprite 或 CSS mask 的 `i-chevron-down`，颜色跟随主题 |
| 主题 | 内联 sun/moon | `i-sun` / `i-moon` |
| 导入 / 导出 | 文字 | `i-upload` / `i-download`（可选，保留文字） |
| 分享 / 复制 / 下载 .zip | 文字 | `i-share` / `i-copy` / `i-archive`（可选，保留文字） |
| 新建标签页 | `＋` | `i-plus` |
| 标签关闭 / 提示关闭 | `×` | `i-x` |
| 文件树 | `▾` / `▸` | `i-chevron-down` / `i-chevron-right`，展开时旋转 90° |
| 剧场手柄 | `⌃` | `i-chevron-up` |
| 收起抽屉 | `▾` | `i-chevron-down` |
| 触发 | 文字 | `i-pointer`（可选，保留文字） |
| 粒子日志 | `✦` | `i-sparkle` 或一个色点 |

- [x] **P0 · 折叠方向按位置计算**，不要写死 `«/»`：
  - 左侧列折叠 → `chevrons-left`；展开 → `chevrons-right`；
  - 右侧列折叠 → `chevrons-right`；展开 → `chevrons-left`；
  - 底部 dock 折叠 → `chevrons-down`；展开 → `chevrons-up`；
  - 折叠后的竖栏，展开按钮放到竖排标题下方（或整条竖栏可点展开），不要只留在最底部。
- [x] **P0 · 图标按钮的可访问名称**：纯图标按钮必须有 `aria-label`（折叠、最大化、更多、关闭、主题、时间轴前后等）；装饰性 `<svg>` 加 `aria-hidden="true"`；`title` 只做补充提示。
- [x] **P0 · 状态语义**：折叠按钮加 `aria-expanded`；最大化按钮加 `aria-pressed`，并在最大化时把图标/名称切换为“还原”；文件树文件夹加 `aria-expanded`；当前标签加 `aria-selected`/`aria-current`。
- [ ] **P1 · 命中区**：标签关闭从 17px 提到 20–22px；分享提示关闭从 22px 提到 24px；图标按钮保持 27–28px 左右。关闭按钮只在 hover / active / focus-within 时显示，避免每个标签都挂一个 ×。
- [ ] **P1 · 主题切换**：用 `i-sun` / `i-moon` 替换现有内联 SVG；两枚 SVG 叠放，140ms 交叉淡入；不要旋转飞入。
- [ ] **P1 · 样例下拉箭头**：移除写死 `%237c8b9e` 的 data URI，改用 `mask-image` + `background: var(--muted)` 或 sprite，确保 light/dark 都跟随主题。
- [ ] **P2 · 落地页**：根目录 [index.html:83](index.html#L83) 的 `▶ 在线试玩` 换成 `play` 图标；“下载单文件版 / 下载 zip”可配 `download`/`archive`；落地页 accent token 与工作台统一（见 8.1）。

### 1.3 图标验收

- 页面中不再有作为控件使用的 `▶`、`❚❚`、`↺`、`«`、`»`、`□`、`⋯`、`‹`、`›`、`⌃`、`▾`、`▸`、`×`、`＋`、`−`；正文里的数学符号（如 `×2.2`）不算。
- 深/浅色主题下所有图标颜色正确，无黑色残留。
- 折叠方向与面板位置一致；右下/底部面板不再出现横向箭头。
- 所有纯图标按钮都有可读的 `aria-label`；键盘 Tab 可见 focus ring。
- 单文件构建 `dist/tickpack.html` 中图标仍可用（sprite 已内联）。

---

## 2. 动效系统

### 2.1 原则

- 动效只表达：状态变化、操作反馈、空间关系；不做装饰。
- 动效时长以 90–180ms 为主；大面板/浮层最多 200ms。
- 同时只允许一处持续动画；如果保留运行态 LED，它是唯一例外。
- 任何“每 tick 都会重启”的动画都不允许。

### 2.2 现有动效评估

| 现有 | 位置 | 判断 |
|---|---|---|
| 方块 pop 140ms `easeOutBack`（约 10% 回弹） | [web/world.js:25-33](web/world.js#L25-L33) | 保留；把回弹降到约 0.8–1.0，或 120ms `easeOutCubic` |
| 粒子 760ms | [web/world.js:26](web/world.js#L26) | 保留但收敛：生命约 500ms，数量上限 30–90，低透明度 |
| 相机指数缓动 | `CAM_EASE 6.5` | 保留；暂停/完成/拖时间轴仍按 [docs/WHY.md:50](docs/WHY.md#L50) 立即框好 |
| toast 150ms | [web/style.css:810](web/style.css#L810) | 保留；补 reduced-motion |
| 分隔条 hover 120ms | [web/style.css:395](web/style.css#L395) | 保留 |
| **分数 chip 450ms 背景闪烁** | [web/style.css:680](web/style.css#L680)、[web/app.js:548-552](web/app.js#L548-L552) | **必须改**：每 tick 重启，运行中背景长期挂 accent；移除此背景动画 |
| 没有 reduced-motion | 全局 | **必须补** |
| `press-hint` / `press-flash` 没有任何 CSS | [web/app.js:728-740](web/app.js#L728-L740)、[web/app.js:955](web/app.js#L955) | 要么补一次性反馈，要么删掉死代码 |

### 2.3 动效任务

- [x] **P0 · 分数 chip**：删除 `chip-flash` 的 450ms 背景动画。只在**暂停/单步**时给数值一个 140ms 的文字色/1px 位移反馈；同一 chip 至少间隔 150ms；运行中不动。不要每 tick 强制 `offsetWidth` 重排。
- [x] **P0 · reduced-motion**：
  - 全局 `@media (prefers-reduced-motion: reduce)` 把动画/过渡压到 0.001ms，并关闭 LED 呼吸；
  - 在 [web/world.js](web/world.js) 里使用已有但未使用的 `prefersReducedMotion()`：跳过关卡 pop、粒子、相机缓动（按项目需要）；
  - 在 [web/app.js](web/app.js) 里跳过 chip 反馈；
  - [web/util.js:57](web/util.js#L57) 的 helper 目前无人使用，必须接上。
- [x] **P0 · “触发”按钮反馈**：`press-hint` / `press-flash` 目前无样式。要么补一个 600ms 一次性边框/底色提示，要么删除 class 与定时器；程序不含 `when press` 时按钮应置灰并说明。
- [ ] **P1 · 控件过渡**：`.btn`、`.icon-btn`、`.tab`、`.tree-row`、`.panel-menu-item` 加 90ms 的 `background-color / border-color / color` 过渡；不要加位移、缩放、阴影。
- [ ] **P1 · 菜单入场**：100ms opacity + `translateY(-3px)→0`；作为新建节点直接播放。
- [ ] **P1 · toast / 分享提示**：160ms opacity + 6px 上浮；`prefers-reduced-motion` 下关闭位移。
- [ ] **P1 · 面板重排**：折叠/最大化/切标签时，给 `.pane-root` 一个 120ms `opacity .6→1` 的 settle；**不要 tween 宽高**（canvas 会逐帧 resize）。
- [ ] **P1 · 主题切换**：sun/moon 140ms 交叉淡入；不做整页 flash。
- [ ] **P1 · 世界操作提示**：首次交互后让“滚轮缩放…”200ms 淡出，减少长期遮挡。
- [ ] **P2 · 剧场抽屉**：打开/关闭 200ms `translateY + opacity`，背景 160ms 淡入；不要用 `display` 瞬切。
- [ ] **P2 · 运行 LED**：可选，仅 running 时 opacity 1↔0.55、2.4s ease-in-out；这是唯一允许的无限循环。不想加就保持静态。
- [ ] **P2 · 用户主动“适配”**：按钮/F/双击时相机 160ms 缓动；暂停/完成/拖时间轴仍保持 instant；`?snap=1` 调试路径保持 instant。

### 2.4 动效参数表

| 场景 | 效果 | 时长/曲线 |
|---|---|---|
| 控件 hover/active | 背景/边框/文字色 | 90ms ease-out |
| 分数值（暂停/单步） | 文字色 accent→text，可加 1px 上移 | 140ms ease-out，节流 ≥150ms |
| 菜单 | opacity + 3px 上浮 | 100ms ease-out |
| toast / 分享提示 | opacity + 6px 上浮 | 160ms ease-out |
| 面板重排 | `.pane-root` opacity .6→1 | 120ms ease-out |
| 用户主动适配 | 相机缓动 | 160ms；pause/scrub/snap 保持 instant |
| 主题 | sun/moon 交叉淡入 | 140ms |
| 世界提示 | opacity 1→0 | 200ms |
| 剧场抽屉 | translateY + opacity | 200ms；背景 160ms |
| 运行 LED（可选） | opacity 1↔.55 | 2.4s ease-in-out，仅 running |

### 2.5 明确不要做

- 不做 hover 抬升卡片、按钮 3D、spring/bounce。
- 不做渐变扫光、发光、背景呼吸、视差。
- 不做每 tick 闪烁：分数、执行行、状态点、日志。
- 不 tween 面板宽高；canvas 的 ResizeObserver 会抖动。
- 不插值时间轴播放头——会显示错误的 tick。
- 不做日志平滑滚动；每 tick 都在追加。
- 无限循环只允许运行态 LED 一处（且可选），其它动效都必须有明确结束。

### 2.6 动效验收

- 运行 60 tick/s 时，分数 chip 不出现持续闪烁或背景色残留。
- 系统开启“减少动画”后，pop/粒子/菜单/toast/主题都基本静止。
- 没有因为动画导致的布局抖动、canvas 模糊或 CPU 持续飙高。
- 折叠/最大化/切标签仍即时完成，只是内容淡入，不拖慢操作。

---

## 3. 视觉、可访问性、排版

- [ ] **P1 · 暗色小字对比度**：`--dim`（#64748b）在 #11161d 上约 **3.82:1**，`--dimmer`（#4b5a6b）约 **2.57:1**（[web/style.css:30-31](web/style.css#L30-L31)），却用于 9–10.5px 的 `tick/方块`、Ctrl+Enter、chip 的 `t…`。建议 `--dim` 提到约 5:1（如 #7c8ba0），`--dimmer` 提到约 4.5:1（如 #75859a）；日间主题目前达标，不要一起调暗。
- [ ] **P1 · 字号下限**：8.5–9px 的元信息（chip-kind、ro、kbd-hint、view-hint、file-path 等）建议下限提到 10px；不要靠缩小字号解决密度。
- [ ] **P1 · 焦点可见**：`.tab`、`.tab-close`、`.tree-row`、`.panel-menu-item` 补 `:focus-visible`，与 `.btn` 一致使用 accent 外圈。
- [ ] **P1 · 标签键盘**：`role="tab"` 的 div 不可聚焦，也没有方向键（[web/layout.js:251](web/layout.js#L251)）。改为 roving tabindex；←/→ 切换、Home/End、Enter/Space 激活；关闭按钮 `aria-label="关闭标签页"`；Tab 进入关闭按钮。
- [ ] **P1 · 菜单键盘**：打开后聚焦第一项；↑/↓/Home/End/Enter；Esc 关闭并把焦点还给触发按钮（[web/layout.js:478](web/layout.js#L478)）；补 `role="menuitem"` 和 `aria-haspopup`。
- [ ] **P1 · 焦点恢复**：`renderAll()` 会清空工作区（[web/layout.js:750](web/layout.js#L750)）。折叠/最大化/切标签/移动面板后，焦点会丢到 body。记录 `data-focus-key`（tab id、panel id + action），重排后恢复。
- [ ] **P1 · 最大化状态**：`makeSlot` 只更新折叠按钮，最大化按钮的 title 仍是“最大化”，图标也不变（[web/layout.js:644-652](web/layout.js#L644-L652)）。按状态切换 `minimize` 图标 + “还原” title + `aria-pressed`；Esc 可还原。
- [ ] **P1 · 手动视口色**：`[data-auto="0"]` 当前用 `--warn`（[web/style.css:628-629](web/style.css#L628-L629)）。手动缩放/平移是正常状态，建议中性色或“手动”文字；amber 留给真正异常。
- [ ] **P1 · 时间轴空白**：默认 dock 150px（[web/layout.js:55](web/layout.js#L55)），柱高 `4 + count*2.3`（[web/timeline.js:100](web/timeline.js#L100)），大多数 tick 只有 6–11px，下半部分大量空白。建议默认降到 110–120px，或按当前可见最大 count 归一化柱高。
- [ ] **P1 · 两个 ▶ 并列**：暂停后“运行”和“继续”都是 ▶，语义冲突。建议运行按钮在已有会话时显示“重跑 / 重新运行”（restart 图标），把 play 只留给“继续”；或者把传输控制做成分组，避免两个同形主按钮。
- [ ] **P1 · 重复的“已运行”**：世界左下角、world chip、顶栏 tick、时间轴四处重复（[web/world.js:624](web/world.js#L624)、[web/app.js:610-626](web/app.js#L610-L626)、[web/timeline.js:64-71](web/timeline.js#L64-L71)）。至少去掉一处，建议保留顶栏 tick + 时间轴。
- [ ] **P1 · 截断文字**：chip 名、文件树名、文件路径、面板 meta、样例描述被省略后没有完整提示。加 `title`；不要为每个都做自定义 tooltip。
- [ ] **P1 · 标签关闭按钮**：17px 且常驻（[web/style.css:327](web/style.css#L327)）；hover/active/focus 才显示，命中区 20–22px。
- [ ] **P2 · 新建标签位置**：`＋ 新建标签页` 在标签栏最右（[web/index.html:95](web/index.html#L95)），离最后一个标签很远。建议把紧凑 `+` 放到标签尾部，把宽文字按钮移除。
- [ ] **P2 · 文档标题**：`document.title` 静态；可显示当前样例名 + dirty 的 `•`，多标签时有用。
- [ ] **P2 · theme-color / 系统主题**：补 `<meta name="theme-color">`；没有手动保存偏好时监听 `prefers-color-scheme` 变化；已有 `tickpack.theme` 持久化保持不变。

---

## 4. 微交互：让已有动作更跟手

- [ ] **P1 · 分隔条**（[web/layout.js:512](web/layout.js#L512)、[web/style.css:394-399](web/style.css#L394-L399)）：
  - 6px 命中区扩到 10–12px 透明区域；视觉仍是 1px 线；
  - hover 显示 3 点 grip；拖动时浮出“38% / 62%”小读数；
  - 双击恢复该组分栏 1:1；
  - 补 `role="separator"`、方向键微调、`aria-valuenow`；拖动阈值 2px。
- [ ] **P1 · 面板头**：双击空白处最大化/还原；右键空白处打开同一个 ⋯ 菜单；折叠竖栏整条可点展开。按钮区域内的点击不能触发头部的双击/右键。
- [ ] **P1 · 标签**：关闭按钮 hover 才显示；中键关闭；滚轮在标签栏横向滚动；双击空白标签栏新建；拖动排序（见 5.4）；右键菜单（重命名/关闭/关闭其他）。
- [ ] **P1 · 复制 / 分享**：按钮内就地显示“已复制 ✓”约 1.2s 后还原，复制不再弹右下 toast；分享保留 toast；给按钮加 `role="status"` 或隐藏 live 区域。按钮宽度固定，避免工具栏抖动。
- [x] **P0 · 重置布局**：执行前快照当前布局；toast 提供 5 秒“撤销”；可逆操作不要用 confirm。渲染后焦点不要丢。
- [ ] **P1 · 焦点恢复**：见 3 节；微交互层要求切标签、折叠、最大化、菜单关闭后焦点回到等价位置。
- [ ] **P1 · 面板菜单**：见 3 节；打开聚焦第一项，Esc 关闭并回焦。
- [ ] **P1 · 速度**：记住上次速度（通过 host storage，[web/host-web.js:155](web/host-web.js#L155)）；双击滑块恢复 10；补 `aria-valuetext="10 tick/秒"`；不要改变现有 1–60 范围。
- [ ] **P2 · 截断文字 tooltip**：见 3 节；优先原生 title。
- [ ] **P2 · 自定义 tooltip**：只有在原生 title 明显不够时才做；不要阻断点击、不要动画炫技。

---

## 5. 增强交互：把菜单操作变成直接操作

### 5.1 日志 / 执行徽标 → 时间轴 / 源码

- [ ] **P1 · 日志 tick 可点击**：把 `tNN`（或整行）做成可点击跳转；hover 高亮、`cursor:pointer`、`title="跳到 t19"`；点击 `seekTo(tNo)`。用事件委托监听 `.console-lines`，**不要给 180 行每行加 tabindex**；键盘跳转交给时间轴。
- [ ] **P1 · 执行徽标可点击**：`exec-badge` 已包含 `fn:line/tick/sourceLine`（[web/datapack.js:185-199](web/datapack.js#L185-L199)）。把它改成按钮/可点击元素：点击 seek 到该 tick，并 `editor.revealLine(sourceLine)`；补 `title` 和 `aria-label`。

### 5.2 时间轴键盘化

- [ ] **P1**：`#timeline-canvas` 加 `tabindex="0"`、`role="slider"`、`aria-valuemin/max/now`、`aria-valuetext="t 20 / 40"`（[web/index.html:270](web/index.html#L270)、[web/timeline.js:238](web/timeline.js#L238)）。
- [ ] **P1**：←/→ ±1，Shift+←/→ ±10，Home/End 到首尾，PageUp/PageDown 跳 10；点击后 canvas 获得焦点；补 focus ring；拖动时同步 aria。

### 5.3 拖放 `.tpk` 导入

- [ ] **P1**：window 级 `dragover`/`drop`；只在 `dataTransfer.types` 含 `Files` 时显示虚线遮罩“松开导入 .tpk”。
- [ ] **P1**：校验 `.tpk/.tp/.txt`；读取第一个文件；复用现有 `importProgram` 的 dirty 确认；不要覆盖未编译源码；`preventDefault` 防止浏览器直接打开文件。

### 5.4 标签拖拽与键盘

- [ ] **P2 · 标签拖拽排序**：左/右拖动排序，显示 1px 插入线；更新 `doc.tabs` 顺序并保存；拖动阈值 2px。
- [ ] **P1 · 标签键盘 / 右键**：Ctrl+PageUp/PageDown 切换；F2 重命名；Delete 关闭；右键菜单（重命名/关闭/关闭其他）；焦点在重排后不丢。
- [ ] **P2**：新标签的 `+` 靠近标签尾部。

### 5.5 剧场模式轻量控制

- [ ] **P1**：剧场隐藏 toolbar/status（[web/style.css:828-833](web/style.css#L828-L833)），目前只能靠空格暂停且没有重播按钮。加入自动隐藏的小控制条：播放/暂停、重播、进度。
- [ ] **P1**：鼠标移动/聚焦时出现，2.5s 后淡出；完成状态可点击 chip 重播；首次提示“空格暂停 / 继续”。
- [ ] **P1**：不要放完整工具栏；保持剧场画面干净。

### 5.6 日志跟随 / 过滤

- [ ] **P1**：当前每追加一行就 `scrollTop = scrollHeight`（[web/app.js:640-652](web/app.js#L640-L652)）。只当用户本来就在底部时自动跟随；向上滚动后自动关闭；离开底部时显示“回到底部”小按钮。
- [ ] **P1**：日志头加“跟随”开关；加“仅错误/仅方块”等过滤；连续相同 tick 摘要可折叠，减少重复。
- [ ] **P2**：可选过滤 chip（全部/错误/方块/函数/输入），不要增加过多视觉噪音。

### 5.7 快捷键帮助与编辑器 keymap

- [ ] **P1**：`?` 打开轻量快捷键面板：Space、←/→、Shift+←/→、Home/End、F、R、Ctrl+Enter、Ctrl+O/S、F8。
- [ ] **P1**：给运行/暂停/步进/适配补 `aria-keyshortcuts`；保留现有 Space/←→/F/R/Ctrl+Enter。
- [ ] **P2**：编辑器补 `Ctrl+O` 导入、`Ctrl+S` 导出 `.tpk`、`F8` 下一个诊断、`Shift+F8` 上一个、`Ctrl+/` 切换注释；不要重绑已形成肌肉记忆的键。
- [ ] **P2**：快捷键面板用 `<dialog>` 或等价浮层，Esc 关闭，焦点陷阱，结束后回到触发点。

### 5.8 面板拖拽换栏（较大增强）

- [ ] **P2**：目前移动面板要经过 ⋯ → “移动到标签页 →” → 目标（[web/layout.js:478-510](web/layout.js#L478-L510)）。可拖住面板头到另一列/标签，显示落点高亮；布局引擎已有 `movePanel`，主要成本在拖拽命中区和视觉反馈。菜单保留作为备用入口。

### 5.9 样例切换 / 草稿（防错交互）

- [x] **P0 · 源码草稿**：布局和主题持久化了，但源码没有（[web/layout.js:188-196](web/layout.js#L188-L196)、[web/theme.js:37-43](web/theme.js#L37-L43)）。在 host storage 里保存草稿（建议 `tickpack.draft.v1`，输入防抖 500ms，含 sampleId/source/time），启动时若与样例不同，给“恢复上次编辑 / 丢弃”的轻提示。
- [x] **P0 · beforeunload**：`state.dirty` 时提示离开；不要只在内存里留 `dirty`（[web/app.js:709-714](web/app.js#L709-L714)）。
- [x] **P0 · 样例切换**：`sampleSelect` 直接 `setValue`，没有 dirty 检查（[web/app.js:1011-1020](web/app.js#L1011-L1020)）；导入流程是有的（[web/app.js:789](web/app.js#L789)）。切换前确认或提供撤销；草稿恢复优先。
- [x] **P0 · 重置布局**：合并 4 节的撤销逻辑；不要静默丢掉自定义标签页。

---

## 6. 布局 / 响应式

- [x] **P0 · 1024px 顶部栏重叠**：在 1024×768 下，样例选择框被“运行”按钮压住，右侧下拉箭头消失；“速度”标签被隐藏但滑块仍在。当前 1320px 断点只隐藏标签和提示（[web/style.css:948-958](web/style.css#L948-L958)、[web/index.html:39-59](web/index.html#L39-L59)）。
  - 方案 A：≤1180px 进入紧凑模式——样例选择收进下拉/菜单，文件按钮变图标，状态区只留阶段；
  - 方案 B：明确最低窗口宽度 1280，低于时显示“请扩大窗口”的提示，而不是让元素重叠；
  - 不要用 `flex-wrap` 把顶栏变两行而不调整 `--topbar-h`。
- [ ] **P1 · 1280 / 1024 验收**：1280 当前正常；1024 必须不重叠、不裁剪、不出现横向滚动条。1440 为设计基准。
- [ ] **P1 · 标签栏 / 面板头**：1024 下 source meta、文件路径会省略；保留 title；不要让按钮覆盖文字。
- [ ] **P2 · 状态区在窄屏**：tick/方块/阶段可只保留阶段或缩成图标+数字；不要让状态区挤压主操作。

---

## 7. 数据安全与错误状态

- [x] **P0 · 编译失败保留旧画面**：`startRun` 失败只 `setPhase('error')` 并追加日志（[web/app.js:238-249](web/app.js#L238-L249)），没有走 `beginSessionView`；上一个成功运行的世界、方块数、计分板、数据包执行行仍残留，用户会误认为新程序产生了它。建议失败时清空这些视图，或给它们加明显的“上次成功运行”stale 标记。
- [x] **P0 · 草稿 / 离开提示**：见 5.9。
- [x] **P0 · 样例切换丢源码**：见 5.9。
- [x] **P0 · 重置布局丢自定义标签**：见 4 节的撤销；不要确认弹窗拦截可逆操作。
- [ ] **P1 · 导入覆盖**：现有 dirty 确认保留（[web/app.js:789-794](web/app.js#L789-L794)）；拖放导入必须复用。
- [ ] **P1 · 错误诊断**：点击诊断跳行已存在；补 F8 / Shift+F8 在诊断间跳转（编辑器层）；错误行/gutter 标记保留。
- [ ] **P2 · 分享版本提示**：旧版本分享链接会同时弹 toast + 常驻 share notice（[web/app.js:831-846](web/app.js#L831-L846)）；保留常驻提示即可，避免重复。
- [ ] **P2 · 失败时的 dirty 状态**：编译失败后 dirty 徽标/源码行/执行徽标要一致；不要显示“已编译”的状态。

---

## 8. 落地页 / 文档 / 性能

### 8.1 落地页与工作台的一致性

- [ ] **P2**：根目录 [index.html:83](index.html#L83) 的 `▶ 在线试玩` 用 `play` 图标；下载类按钮用 `download`/`archive` 图标。
- [ ] **P2**：落地页 accent token 与工作台统一。当前落地页是 `#0f9d78`（light）/`#2fd6a8`（dark），工作台是 `#0f766e`/`#2dd4bf`（[index.html:10-30](index.html#L10-L30)、[web/style.css:66-110](web/style.css#L66-L110)）。
- [ ] **P2**：`docs/img/tickpack.png` 是 10 月 31 日的旧截图，仍显示 `.tp` 扩展名和老 UI（[docs/img/tickpack.png](docs/img/tickpack.png)）。换成当前 `.tpk` 工作台截图；如果换图，注意 README/落地页引用。
- [ ] **P2**：落地页按钮补 hover/focus 过渡（90ms 色彩），不要加位移。

### 8.2 性能 / 其它

- [ ] **P2 · 空闲 rAF**：`frame()` 一直 `requestAnimationFrame`，并每帧 `world.render`（[web/app.js:488-505](web/app.js#L488-L505)）。空闲、无相机缓动、无 pop/粒子、无播放时可以停掉渲染；对笔记本续航明显有帮助。不要为此破坏播放/拖拽。
- [ ] **P2 · 重复读数**：见 3 节的“已运行”去重。
- [ ] **P2 · 静态标题 / theme-color / 系统主题**：见 3 节。

---

## 9. 实施顺序与优先级

优先级是建议，不是硬性排期；P0 是“不做会明显影响正确性/体验”，P1 是“手感与可访问性”，P2 是“增强/打磨”。

| 阶段 | 任务 | 说明 |
|---|---|---|
| **P0** | 图标接入 + 折叠方向 + aria | 资产已存在；先让视觉语言统一，后面的截图 QA 才有意义 |
| **P0** | 1024 顶部栏重叠 | 明确紧凑模式或最低宽度；不要让控件叠在一起 |
| **P0** | 源码草稿 / beforeunload / 样例切换 / 重置撤销 | 数据丢失类；先做 storage + 恢复提示 |
| **P0** | 编译失败清空/标记旧视图 | 避免错误状态与旧世界混淆 |
| **P0** | 移除每 tick chip flash + reduced-motion + press 死代码 | 唯一明确“过噪”的动效 + 无障碍基线 |
| **P1** | 暗色小字对比度、字号下限、焦点可见 | 视觉可读性；与图标一起做 |
| **P1** | 标签/菜单键盘 + 焦点恢复 + 最大化还原 | 键盘用户的核心路径 |
| **P1** | 分隔条 / 面板头 / 标签中键/滚轮 / 复制分享状态 | 低成本高感知的微交互 |
| **P1** | 日志 tick / 执行徽标跳转；时间轴键盘 | 把“可读信息”变成“可导航” |
| **P1** | 拖放导入；剧场轻控制；日志跟随；速度记忆；快捷键 `?` 面板 | 直接操作与分享体验 |
| **P2** | 标签拖拽排序；编辑器 keymap；面板拖拽换栏 | 增强交互，成本较高 |
| **P2** | 落地页刷新；tooltip；idle rAF；title/theme-color | 收尾打磨 |

**依赖关系建议**：

1. 先接入图标（第 1 节），否则所有视觉截图都会反复返工；
2. 再做 P0 数据安全与错误状态（第 5.9 / 7 节），这些改动独立；
3. 再做 reduced-motion / chip flash（第 2 节），避免和后续动效叠加；
4. 再做键盘、焦点、微交互（第 3 / 4 节），最后做增强交互（第 5 节）；
5. 每完成一组，在 1440 / 1280 / 1024 三档截图，light/dark 各一次。

---

## 10. 验收清单（Definition of Done）

### 10.1 功能与回归

- [ ] `npm test` 全部通过；不修改 `src/**`。
- [ ] `npm run build` 通过；`dist/tickpack.html` 单文件可离线打开，图标不依赖网络。
- [ ] 现有时间轴 seek/拖动、世界缩放/平移/双击适配、诊断跳行、布局持久化、分享/剧场、复制/下载全部保持。
- [ ] 没有新的控制台报错或 404。

### 10.2 视觉

- [ ] 1440 / 1280 / 1024 三档；light / dark；正常 / 暂停 / 完成 / 错误。
- [ ] 工作台 / 观察两个标签；折叠 / 最大化 / 菜单 / 剧场 / 拖拽时间轴。
- [ ] 1024 不重叠、不裁剪；面板头/标签栏/顶部栏都没有元素叠压。
- [ ] 不再有作为控件的字符图标；图标视觉重量一致。
- [ ] 分数 chip 运行中不持续闪烁。
- [ ] 暗色小字对比度达到约 4.5:1；无“看不见的提示”。

### 10.3 可访问性 / 键盘

- [ ] Tab 能到达所有图标按钮/标签/树/菜单；focus ring 清晰。
- [ ] 标签 roving tabindex；←/→ 切换；F2 重命名；Delete 关闭（按 5.4 实现）。
- [ ] 面板菜单 Esc 关闭并回焦；方向键可用。
- [ ] 时间轴可聚焦，←/→/Home/End 工作，aria 值同步。
- [ ] 所有纯图标按钮有 `aria-label`；折叠/最大化状态有 `aria-expanded`/`aria-pressed`。
- [ ] `prefers-reduced-motion: reduce` 下动画基本静止。
- [ ] 键盘操作切标签/折叠/最大化后焦点不丢。

### 10.4 数据安全

- [ ] 刷新/关闭 dirty 源码有提示；草稿可恢复。
- [ ] 切样例/重置布局不静默丢内容；可撤销。
- [ ] 编译失败不会把旧世界当新结果；画面有明确的错误/上次状态。
- [ ] 拖放导入遵守 dirty 确认；不会覆盖未保存内容。

### 10.5 性能

- [ ] 空闲时无持续重绘（若实现 8.2）。
- [ ] 没有每 tick 强制同步布局/重排；60 tick/s 下操作仍跟手。
- [ ] 面板折叠/最大化不 tween 宽高导致 canvas 抖动。

---

## 11. 明确不要做 / 风险提示

- **不要引入新依赖**：图标直接用 `web/icons/`；不要为了图标/动画加 npm 包。
- **不要碰 `src/**`**：编译、模拟、会话、导出语义是核心，UI 层只消费接口。
- **不要加装饰动效**：hover 抬升、发光、渐变扫光、视差、弹簧回弹都不符合项目基调。
- **不要每 tick 动画**：分数、执行行、状态点、日志都不行。
- **不要隐藏入口**：双击/中键/右键必须同时有可见按钮或键盘路径。
- **不要给日志 180 行加 tab stop**；用容器级委托或时间轴键盘。
- **不要用 confirm 拦可逆操作**：undo toast 更顺手；只有数据丢失才 confirm。
- **不要自动隐藏主线控制**：只有剧场可以。
- **不要重绑已学的快捷键**：Space/←→/F/R/Ctrl+Enter 保留。
- **不要破坏单文件/离线**：sprite 要能内联；不要依赖 CDN。

---

## 附录 A：图标清单与用途

`web/icons/` 现有文件（34 个）与 sprite ID `#i-<name>`：

| 组 | 文件 / ID | 建议用途 |
|---|---|---|
| 播放/时间 | `play` / `pause` / `step-back` / `step-forward` / `rotate-ccw` / `replay` | 运行、暂停、单步、重置、重播 |
| 方向/折叠 | `chevron-left/right/up/down`、`chevrons-left/right/up/down` | 时间轴、面板折叠（按位置）、剧场手柄 |
| 面板/视图 | `maximize` / `minimize` / `fit` / `zoom-in` / `zoom-out` / `more-horizontal` / `x` / `plus` / `minus` | 最大化/还原、适配、缩放、菜单、关闭、新建、数值 |
| 主题 | `sun` / `moon` | 主题切换 |
| 文件/动作 | `upload` / `download` / `share` / `copy` / `archive` / `file` / `folder` | 导入、导出、分享、复制、zip、文件树 |
| 其它 | `pointer` / `sparkle` | 触发按钮、日志粒子计数/装饰 |

规格：16×16、`stroke-width="1.6"`、`currentColor`、无硬编码颜色；`play`/`pause` 填充，其余描边。不要给图标加固定 fill/stroke；不要重新画。

如果接手时 `web/icons/` 缺失或与上表不符，按本表的命名与规格补齐；`tickpack-icons.svg` 的 symbol ID 必须与 `i-<name>` 一致。

## 附录 B：当前代码锚点（实现时先读这些文件）

| 文件 | 关注点 |
|---|---|
| [web/index.html](web/index.html) | 顶栏、面板头、图标、样例/主题、剧场手柄、分享提示 |
| [web/icons/](web/icons/) | 34 个 SVG + sprite（已存在，未接入） |
| [web/style.css](web/style.css) | 主题 token、控件、面板、菜单、时间轴、toast、剧场、媒体查询 |
| [web/layout.js](web/layout.js) | 标签、分栏、拖拽、菜单、折叠/最大化、重置、renderAll |
| [web/app.js](web/app.js) | 运行/暂停、日志、分数、分享、速度、快捷键、frame 循环 |
| [web/world.js](web/world.js) | 方块 pop/粒子、相机、render、交互 |
| [web/timeline.js](web/timeline.js) | 时间轴绘制、点击/拖动、hover |
| [web/datapack.js](web/datapack.js) | 文件树、执行徽标、复制 |
| [web/editor.js](web/editor.js) | Tab/Enter/Ctrl+Enter、诊断跳行 |
| [web/host-web.js](web/host-web.js) | 导入/导出/复制/持久化 |
| [web/util.js](web/util.js) | toast、`prefersReducedMotion()` |
| [web/theme.js](web/theme.js) | 初始主题、持久化、canvas 调色板 |
| [index.html](index.html) | 落地页 |
| [docs/WHY.md](docs/WHY.md) | 设计原则与“暂停/完成立即框好”的决策 |
| [docs/img/tickpack.png](docs/img/tickpack.png) | 落地页旧截图 |

## 附录 C：建议来源对照

| 来源轮次 | 主要内容 | 本清单对应章节 |
|---|---|---|
| 第一轮：UI 审查 | 图标系统、动效、对比度、时间轴、标签/菜单、样例/重置等 | 1、2、3、6、7 |
| 第二轮：图标绘制 + 追加审查 | `web/icons/` 资产、1024 顶栏、草稿、错误残留、日志滚动、剧场、最大化、落地页 | 1、3、5、6、7、8 |
| 第三轮：操作手感 | 分隔条、面板头、标签、复制/分享、撤销、焦点、日志跳转、时间轴键盘、拖放、剧场控制、快捷键 | 4、5、6、7 |
| 第四轮：优先级/不做 | 实施顺序、不要做的反模式 | 9、10、11 |

> 如果实现过程中发现本文与当前代码有冲突，以“不改变核心语义、不引入新依赖、不做装饰动效”三条底线为准，并在 PR 描述中记录偏差。
