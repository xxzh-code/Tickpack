# Tickpack UI 后续计划（P1 / P2）

> 来源：[UI-REVIEW-CHECKLIST.md](../UI-REVIEW-CHECKLIST.md)。本轮先完成其 **P0**（图标系统、折叠方向/aria、1024 顶栏、数据安全、编译失败旧视图、减少每 tick 闪烁）；P1/P2 不在本轮范围，记录在这里，等后续 UI 打磨轮再动。
>
> 原则不变：零依赖、单文件可离线、不碰 `src/**`、不做装饰动效、不重绑已有快捷键。
>
> **排期注**：3D（x,y,z + 正交投影）排在 P0.5 之后、本清单 P1/P2 之前，见 [docs/3D-PLAN.md](3D-PLAN.md)；本清单的 P1/P2 仍在其后。

## 0. 本轮已完成（代码事实）

- 图标：`web/icons/tickpack-icons.svg` 内联 sprite + `icon()` helper；控件字符图标全部替换；折叠方向按位置；最大化/还原、主题 sun/moon、样例箭头改成主题色。
- 无障碍：纯图标按钮 `aria-label`，折叠 `aria-expanded`，最大化 `aria-pressed`，标签 `aria-selected`，文件树 `aria-expanded`；基础 focus ring。
- 1024 顶栏：≤1180px 紧凑模式，不重叠/不横向滚动。
- 数据安全（P0-B）：源码草稿、beforeunload、切样例 dirty 确认、重置布局撤销、编译失败不残留旧视图。
- 动效（P0-B）：删除每 tick chip 闪烁；`prefers-reduced-motion` 接入；press 提示不再是死代码；控制项/菜单/toast/面板 settle 按参数表收敛。

实现细节以最终 diff 与 Release 说明为准。

## 1. 后续 P1（优先于 P2，但仍排在 P0.5 之后）

### P1-a 可读性与焦点
- 暗色 `--dim` / `--dimmer` 提到约 5:1 / 4.5:1（日间不动）；9px 元信息下限 10px。
- `.tab`、`.tab-close`、`.tree-row`、`.panel-menu-item` 的 `:focus-visible` 与 `.btn` 统一。
- **调整**：P0-A 已引入统一 `.icon` 尺寸与 focus ring，这一项应直接复用现有 token，不再单独定义 ring；截图需覆盖 1024 紧凑模式。

### P1-b 键盘与焦点恢复（合并原 §3/§4/§5.4）
- 标签 roving tabindex：←/→ 切换、Home/End、Enter/Space 激活、F2 重命名、Delete 关闭、Ctrl+PageUp/PageDown 切换。
- 面板菜单：打开聚焦第一项、↑/↓/Home/End/Enter、Esc 关闭并回焦、`role=menuitem` + `aria-haspopup`。
- `renderAll()` 后按 `data-focus-key` 恢复焦点（tab/panel/action）。
- 时间轴 `role=slider`、tabindex、方向键/Home/End/PageUp/PageDown、aria 值同步。
- **调整**：与 P0 的标签 `aria-selected`、折叠 `aria-expanded`、最大化 `aria-pressed` 合并实现，避免二次改 DOM；焦点恢复要在折叠竖轨/紧凑顶栏下也成立。

### P1-c 微交互
- 分隔条：10–12px 命中区、hover 3 点 grip、拖动显示比例、双击恢复 1:1、方向键微调 + `aria-valuenow`。
- 面板头：双击空白最大化/还原、右键菜单、折叠竖轨整条可点展开（P0-A 已有按钮位置，**不要重复实现**）。
- 标签：关闭按钮 hover 显示、中键关闭、滚轮横滚、双击空白新建、右键菜单。
- 复制/分享：按钮内“已复制 ✓”1.2s；固定宽度避免抖动。
- 速度：host storage 记忆、双击恢复 10、`aria-valuetext`。
- **调整**：P0-A 已把标签关闭命中区做到 20–22px 并 hover 显示，这一项只需补中键/滚轮/复制反馈，不要改尺寸。

### P1-d 导航与直接操作
- 日志 tick 可点跳时间轴（事件委托），执行徽标跳到 tick + 源码行。
- 拖放 `.tpk` 导入（校验 `.tpk/.tp/.txt`，复用 dirty 确认）。
- 剧场轻控制条（播放/暂停/重播/进度，2.5s 淡出）。
- 日志跟随开关 + “回到底部”；快捷键 `?` 面板（`<dialog>`，Esc + 焦点陷阱）。
- **调整**：P0-B 的草稿/确认逻辑必须先复用（`importProgram`/draft），不要新增第二套 dirty 判断；快捷键面板需列 P0.5 之后新增的 particle/sound 相关键（若有）并保持既有 Space/←→/F/R/Ctrl+Enter。

## 2. 后续 P2（更晚，先不做）

- 标签拖拽排序；编辑器 Ctrl+O/S、F8、Shift+F8、Ctrl+/；面板拖到另一列/标签。
- 落地页（根 `index.html`）：play/download/archive 图标、accent token 与工作台统一、hover/focus 90ms、旧截图 `docs/img/tickpack.png` 更新。
- 原生 `title` 截断提示；暂停后“运行/继续”同形按钮的语义整理；“已运行”四处重复去重。
- 空闲 rAF 停止；`document.title` 显示样例 + dirty；`theme-color` / 系统主题变化监听。
- 运行 LED 呼吸（唯一允许的无限动画）与用户主动适配 160ms 相机缓动（pause/scrub/snap 仍 instant）。

## 3. 以后做这些任务时的统一注意事项

1. **先跑 P0.5**：`particle` / `sound` 会加控件与提示；UI 改动要预留/复用同一套 icon/aria，不要为它们另造一套。
2. **每次 UI 改动后**：`node --check` 全部 web 模块、`node test/run-all.mjs` 149+、`node scripts/build-html.mjs`，并看 `dist/tickpack.html` 里图标是内联的。
3. **截图矩阵**：1440 / 1280 / 1024 × light/dark；正常/暂停/完成/错误；折叠/最大化/菜单/剧场。
4. **不引入新依赖**；SVG 只走 sprite/`icon()`；不往 HTML 里塞第二份图标。
5. **先检查现有实现再补**：P0 已经把图标、折叠方向、草稿、失败视图、reduced-motion 做掉，后续条目不要重复实现或回退。
