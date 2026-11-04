# Tickpack 分层说明（架构，不是工业规范）

> 目的只有一个：**让「日后想换运行环境」不变成推倒重来**，从而保护「能玩」这件事不被技术债拖垮。
> 判断标准始终是「换 Electron/Tauri/CLI 时要不要改它」，不是抽象的“可维护性”。

## 三层

| 层 | 文件 | 职责 | 规则 |
| --- | --- | --- | --- |
| **核心** | `src/lang/**`（tokenize/parser/compile/codegen/prelude/errors） | 源码 → AST → 诊断 → mcfunction / 数据包结构 | 纯函数；同一份代码在浏览器/Node/Worker 行为一致 |
| **核心** | `src/sim/**`（sim/syntax） | 执行 mcfunction 子集：状态 + 输入 → 下一 tick | 纯；不依赖 DOM/Node |
| **核心** | `src/session.js` | 一次运行的语义：compile → 模拟器 → 每 tick 快照 → seek/回放 → 完成判定 → trace→源码行映射 → 导出包 | **不知道窗口、文件、下载、localStorage 是什么** |
| **核心** | `src/zip.js` | 纯字节进出：文件表 → zip | 纯 |
| **核心** | `src/samples.js` / `src/api.js` | 示例数据；核心对外的唯一门面 | `api.js` 是外壳 import 核心的唯一入口 |
| **外壳** | `web/**`（app/boot/editor/world/datapack/timeline/blocks/util/theme/layout/host-web） | DOM、Canvas、事件、rAF/speed、URL 查询参数、主题、标签页/分栏、渲染 | 可以碰 `window/document/navigator` |
| **外壳** | `web/host-web.js` | 平台副作用的唯一实现：下载/导入文件、写剪贴板、偏好持久化 | 未来桌面端/CLI 换一个实现，`app.js`/`layout.js` 不变 |
| **外壳** | `server.mjs`、`scripts/*.mjs` | 静态服务器；CLI：打印/打包数据包到磁盘 | Node 专属，注入平台能力 |
| **测试** | `test/**` | 核心验收标准 + 边界守卫 | 见下 |

依赖方向单向：`web/** → src/api.js → src/session.js → {lang, sim, zip}`。核心不 import 外壳。

## 边界判断法

> 把某个函数搬到 CLI，要不要改它的代码？
> —— 不用改 = 核心；要改 = 外壳；两者都要改 = 混在一起了，那才是要处理的。

## 这一轮拆了什么（为什么值得现在拆）

1. **`src/session.js`（新核心层）**：原先 `web/app.js` 里同时住着「一次运行的语义」和 DOM：
   编译、创建模拟器、每 tick 快照、`cursor/total`、完成判定（时间轴结束 vs `tick {}` 持续运行）、
   Minecraft 提示行过滤、trace→「当前执行命令/源码行」映射、快照上限。
   这些换到任何平台都要一模一样，所以抽成无平台依赖的 `TickpackSession`；
   网页只负责「拿到 TickResult 去画」。
2. **`web/host-web.js`（窄接口的第一个实现）**：导出 zip 从 `app.js` 里硬编码 Blob+`<a download>`
   变成 `host.exportDatapack(bundle)`；剪贴板从 `datapack.js` 直接 `navigator.clipboard` 变成
   `host.copyText(text)`。桌面端换成「写目录」「系统剪贴板」即可，业务代码不动。
3. **删除重复实现**：`web/datapack.js` 原本自带一份 `# source line` 扫描 + `pickExecuting`，
   与核心重复；改为直接渲染 `session` 给出的 `exec`（含 `sourceLine`）。

**先放着没拆的**（不影响换平台，或本来就属于外壳）：
- `web/world.js` 相机/渲染/滚轮输入、`web/editor.js` 高亮、`web/timeline.js` 绘制：
  它们天然与 Canvas/DOM 绑定，且换平台也大概率要重写渲染层，抽出去只会多一层转发。
- `web/boot.js` 与 URL 查询参数（`?src/?sample/?auto/?t`）：平台入口，放外壳正好。
- `server.mjs`、`scripts/pack.mjs`、`scripts/dump.mjs`：Node 外壳已各自完成平台工作。
- 分享链接、桌面菜单、文件关联还没有；等真做的时候按下面的 host 契约加方法，不提前发明扩展点。

## 外壳层窄接口（Host contract）

核心不调用它；外壳在核心算完之后执行平台副作用：

```js
// web/host-web.js
export function createWebHost() {
  return {
    // bundle = session.exportBundle() -> { filename, files, zip: Uint8Array }
    // 浏览器：Blob + <a download>；桌面端：写目录；CLI：fs.writeFile
    exportDatapack(bundle) {},                  // -> Promise<string>（实际交付的文件名）
    // 打开 .tpk：浏览器 File System Access API / <input type=file>；桌面端：原生打开对话框
    importTextFile({ accept }) {},              // -> Promise<{name,text}|null>（取消为 null）
    // 保存 .tpk：浏览器 Blob 下载；桌面端：写文件
    exportTextFile({ filename, text, mime }) {},// -> Promise<string>
    // 浏览器：navigator.clipboard（带退化路径）；桌面端：系统剪贴板
    copyText(text) {},                          // -> Promise<boolean>
    // 偏好持久化（主题/布局）：浏览器 localStorage；桌面端：配置文件
    storageGet(key) {}, storageSet(key, value) {}, storageRemove(key) {},
    canExport: true, canImport: true, canPersist: true, // 能力标志，UI 据此隐藏不可用按钮
  };
}
```

现有 CLI 的等价实现就是 `scripts/pack.mjs`（`fs.writeFileSync` 到 `dist/`），
它不需要 DOM，也不经过 `host-web.js`——这正是接口存在的意义：同一份数据，不同落盘方式。

`web/app.js`、`web/layout.js` 等业务外壳不直接碰 `localStorage` / `<input type=file>` /
`URL.createObjectURL`，一律走 host。

## 边界守卫（自动化）

`test/purity.test.js` 会扫描 `src/**`，出现以下任一项就失败：

- `window` / `document` / `localStorage` / `navigator` / `requestAnimationFrame` / `fetch`
- `new Blob` / `URL.createObjectURL` / `performance.now`
- `process.*` / `require()` / `__dirname` / `node:` 或 fs/path/os 等 Node 内置模块
- `isElectron` / `isDesktop` / `isWeb` 环境分支
- 任何非相对 import（核心只能 import 自己）

另外断言 `src/api.js` 的公开面、`web/host-web.js` 的接口形状。
这条测试是「屎山前兆」的自动提醒，不是形式主义。

## 测试就是验收标准

- 驱动编译器/模拟器的测试是防回归工具，也是未来万一重写的验收标准：
  `test/lang.test.js`（编译器/运行时结构）、`test/sim.test.js`（命令语义）、
  `test/integration.test.js`（端到端：源码→数据包→模拟器）、
  `test/session.test.js`（核心会话：tick/快照/seek/完成规则/导出包）、
  `test/zip.test.js`、`test/purity.test.js`。
- 外壳（网页）用截图 + 手工玩验证；不把 DOM 细节写进核心测试。
- 当前：**145 个测试全绿**（`npm test`）。

## 现在需要重写吗？

不需要。核心层（语言/模拟器/zip）本来就是平台无关的，测试齐全；
混在一起的主要是 `app.js` 的会话语义，已机械抽到 `src/session.js`。
剩下的渲染层绑 DOM 是合理的。真正要重写时，先保 `src/**` 的行为测试和这份分层，
外壳可以整个扔掉换掉。
