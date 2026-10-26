# Tickpack

**一门把 tick 当一等公民的语言。编译成真正的 Minecraft Java 版数据包，并配一个逐 tick 运行的浏览器模拟器。**

> 你写下 6 行循环，按下 Run，然后看见**循环变成了时间**：
> 每一个 tick 跑一次迭代，记分板里的 `i` 一格一格地加一，
> 生成的 mcfunction 一行一行地亮起来，世界里的笔一格一格地往前走。
> 拖时间轴往回走，世界会倒带。

这就是这个项目存在的理由。详细版见 [docs/WHY.md](docs/WHY.md)。

---

## 快速开始

```powershell
node server.mjs            # 启动静态服务器（零依赖）
# 打开 http://127.0.0.1:8123/
```

浏览器里：左边写代码，中间看世界，右边看这份代码**真正生成出来的数据包**，底部拖时间轴。
改几行，按 Run，看它怎么变。

## 语言长什么样

```
over 4 as side {
  over 8 as step {
    walk
    plot(stone)
  }
  turn(90)
}
```

- `over N as i { ... }` 是**时间循环**：每次迭代花 1 个 tick，`i` 存在记分板里。
- `state x = 0` 是显式状态，编译成记分板 `#x`。
- `tick { ... }` 里的代码每个 tick 都跑；它不能花时间。
- `when press { ... }` 响应模拟器里的按钮。
- 函数是编译期宏：`plot(gold_block)`、`turn(45)`、`walk` 来自内置的乌龟标准库。
- `run <命令>` 原样注入一条 vanilla 命令 —— 语言永远给你留了后门。

完整语法与编译模型：[docs/LANG.md](docs/LANG.md)。

## 它到底怎么工作

```
main.tp ──compile──▶ 真正的数据包文件（pack.mcmeta / mcfunction / tags）
                          │
                          ├──▶ 模拟器直接执行这些 mcfunction（不是另一套解释器）
                          │         │
                          │         └──▶ 每 tick 的 trace：文件 + 行号 + 命令
                          ▼
                    浏览器：编辑器 / 世界 / 数据包高亮 / 时间轴
```

- **编译产物是真的**：`data/tp/function/tick.mcfunction` 被注册进 `minecraft/tags/function/tick.json`，
  丢进 Minecraft 1.21 存档的 `datapacks/` 里就能跑。
- **模拟器不解释 AST**：它执行编译出来的 mcfunction 子集（记分板、execute、setblock、tp、summon……），
  所以你在浏览器里看到的行为就是数据包的行为。
- **时间轴是快照**：每个 tick 存一份世界快照，可以随意回放、倒带。

## 目录

| 路径 | 内容 |
| --- | --- |
| `docs/WHY.md` | 这个项目的「有趣的那一刻」和关键取舍记录 |
| `docs/LANG.md` | 语言 + 编译模型 + 模拟器契约（已冻结） |
| `src/lang/` | 词法/语法/语义检查/状态机代码生成/数据包组装/标准库 |
| `src/sim/` | 微型 Minecraft 命令解释器：记分板、execute、实体、方块、trace |
| `web/` | 浏览器应用（无框架、无构建、无 CDN） |
| `src/api.js` | UI 唯一允许 import 的集成缝 |
| `test/` | 编译器单元测试 / 模拟器单元测试 / 端到端集成测试 |
| `scripts/shot.ps1` | Edge headless 截图（QA 用） |

## 测试

```powershell
node --test test/          # 全部（编译器 + 模拟器 + 端到端）
node --test test/integration.test.js
```

## 把数据包放进 Minecraft

1. 在应用右侧把生成的文件导出来（或直接复制文件树）；
2. 建一个 1.21 世界，把 `pack.mcmeta` 和 `data/` 放进 `saves/<世界>/datapacks/tickpack/`；
3. `/reload`，然后 `/function tp:load`。

## 这一刀里有什么

- [x] 语言：`state` / `fn`（常量参数宏）/ `tick` / `when press` / `over` / `wait` / `if` / `else` /
      `say` / `run` / 表达式（算术、比较、`and`/`or`/`not`、`now`）
- [x] 编译成结构完整的数据包（load/tick tags、主时间轴状态机、函数、宏展开、诊断信息）
- [x] 模拟器：记分板、execute 链、选择器、`~`/`^` 坐标、tp 旋转、setblock/fill、summon/kill/tag、
      say/particle、tick trace、快照回放
- [x] 浏览器：三栏同屏、逐 tick 运行、代码行高亮、记分板观察面板、时间轴拖动回放、示例程序
- [x] 一键下载真正的数据包 `.zip`（零依赖 zip 写入器，可直接丢进 `datapacks/`）
- [ ] 分享链接、积木视图（与文本共享 AST）
- [ ] 更多事件源（按钮、`/trigger`、玩家动作）、数组、`after N ticks` 语法糖
- [ ] 红石 / schematic 输出

## 一些刻意的取舍

- 函数里不能 `wait` / `over` —— 函数是即时 mcfunction，只有**时间轴**上的代码才生成状态机。
  这条规则让「什么会花时间」在源码里是显式的。
- 世界暂时是固定的一只笔（armor stand, `tag=pen`）在一块 33×33 的平面上，够用来画图案、
  也够把 tick 语义讲清楚。等语言更稳再换更通用的世界。
- 参数是编译期常量（`$param` 直接替换进 `run` 行）。没有运行时参数、没有闭包。
  以后也许会有，但不会以牺牲「循环就是时钟」为代价。
