# src/lang —— Tickpack 编译器

`compile(source)` 把 Tickpack 源码（docs/LANG.md §1）编译成一个真实的
Minecraft 1.21 数据包（docs/LANG.md §2/§3），产物是一个虚拟文件映射。
它是纯 ESM、零依赖，浏览器和 Node 都通过 `src/api.js` 使用它。

```js
import { compile, PRELUDE } from '../src/api.js';

const { ok, files, diagnostics, meta } = compile('over 3 as i {\n  walk\n}\n');
// files: { 'pack.mcmeta': '...', 'data/tp/function/tick.mcfunction': '...' }
```

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `prelude.js` | `PRELUDE`，拼在每个程序前面的乌龟标准库源码（LANG.md §4） |
| `tokenize.js` | 按行工作的词法分析器；遇到 `run` 时切换到“原样命令”模式，吃掉该行剩余内容 |
| `parser.js` | tokens -> AST（声明、语句、表达式） |
| `compile.js` | 公共 API + 语义分析（名字、作用域、宏参数、时间规则、调用环、诊断） |
| `codegen.js` | 即时代码 lowering、时间线状态机 lowering、数据包组装 |
| `errors.js` | `TpError`（消息 + prelude/用户文本中的行号） |

## 生成的数据包

```
pack.mcmeta                                  pack_format 48, supported_formats 48..9999, 安装提示
data/minecraft/tags/function/load.json       {"values":["tp:load"]}
data/minecraft/tags/function/tick.json       {"values":["tp:tick"]}
data/tp/function/load.mcfunction             记分板、用户状态、循环下标、#__started=0、#__paused=0、#__brush=0
data/tp/function/start.mcfunction            笔放到玩家脚下，然后 tp:start/rewind
data/tp/function/start_at.mcfunction         笔放到命令执行位置，然后 tp:start/rewind
data/tp/function/stop.mcfunction             原地暂停（#__started 0、#__paused 1、sleep 0）+ 一行 say
data/tp/function/start/rewind.mcfunction     唯一的共享重置（记分板、用户状态、循环、画笔、暂停位）+ 一行 say
data/tp/function/status.mcfunction           聊天诊断（暂停？运行？画笔？笔？），/function tp:status
data/tp/function/tick.mcfunction             薄门：等玩家出现，然后调用 tp:tick/body
data/tp/function/tick/body.mcfunction        tick 块 -> press -> dispatch -> sleep-- -> now++
data/tp/function/main/dispatch.mcfunction    每个时间线状态一行
data/tp/function/main/s<id>.mcfunction       时间线状态机（每个 over/if/wait 一个状态）
data/tp/function/fn/<name>.mcfunction        零参数函数
data/tp/function/fn/paint.mcfunction         运行时画笔：对 #__brush 做 dispatch，在笔的位置 setblock
data/tp/function/brush/<block>.mcfunction    游戏内画笔选择器，每个调色板方块一个
data/tp/function/brush/next.mcfunction       循环切换画笔（到调色板末尾后绕回）
data/tp/function/snippet/<id>.mcfunction     即时 `if` 的分支（fn/tick/when 里的代码）
data/tp/function/event/press.mcfunction      `when press` 的函数体，仅当声明了才生成
```

每个生成的函数都以 `# Tickpack ...` 头注释开头，并带有 `# source line N`
注释，因此数据包可以和源码对照着读（`over` = init/head/body/latch 状态，
`wait` = sleep，`if` = condition/branch/join 状态）。

## 运行时画笔（改绘制方块，游戏里也能改）

编译器持有一个固定调色板；`brush(<block>)` 把它的序号写进保留记分板项
`#__brush`，`paint` 调用 `tp:fn/paint`，后者把选中的方块放到笔的位置：

```
stone(0), gold_block(1), redstone_block(2), emerald_block(3), lapis_block(4),
diamond_block(5), coal_block(6), glowstone(7), white_wool(8), purple_wool(9),
oak_planks(10), glass(11)
```

```tp
brush(gold_block)
over 90 as i {
  walk
  paint
  turn(8)
}
```

`brush(...)` 在编译期校验（未知方块 = 编译错误，错误里列出整个调色板），
并且任何能放语句的地方都能用（时间线、`fn`、`tick`、`when press`）；
`paint` 和 `paint()` 都接受。在游戏里，玩家不需要改代码就能给正在运行的程序
换画笔：

```
/function tp:brush/redstone_block   # 选择一个调色板方块
/function tp:brush/next             # 循环切换，绕回 stone
/function tp:status                 # 也会显示当前画笔
```

共享重绕会把画笔重置回 stone，所以每次 `/function tp:start` /
`start_at` 都从同一个状态开始。`brush` 和 `paint` 是保留名。

## 感官表达式（ahead / below）

`ahead(<block>)` / `below(<block>)` 是表达式内置，不是 prelude 函数；它们
生成真实的条件命令，模拟器和 Minecraft 都执行同一条：

```
execute at @e[tag=pen] positioned ^ ^ ^1 if block ~ ~ ~ stone run scoreboard players set #__t0 tp 1
execute at @e[tag=pen] if block ~ ~-1 ~ stone run scoreboard players set #__t0 tp 1
```

`ahead` 使用笔的局部坐标（含 pitch），`below` 是世界向下；`block` 必须是
`air` 或调色板方块。结果写入 `#__t0` 之类的临时记分板，可直接用于 `if`。
示例 `senses` 先画墙，再用 `ahead(stone)` 转向。

## 意图探针 `animate`

P1.5 的最小 intent 语句：

```tp
animate(@p, "wave", 20 ticks)
```

解析器接受 `@p` + `"wave"|"nod"|"spin"` + 正整数 ticks；codegen 写
`#__animKind/#__animLeft/#__animActive` 并生成 `tp:anim/tick`，由
`tp:tick/body` 每 tick 调用。`tp:anim/tick` 按 kind 是普通粒子 mcfunction；
浏览器模拟器执行同一份命令，因此数据包和预览一致。新 `animate` 重置同一槽
即覆盖旧动画（包括 kind）；`load`/`rewind` 清空槽。示例 `wave` 验收一行
语法/展开，`gestures` 验收 wave→nod→spin 与覆盖。

## 真实世界里的启动（把笔锚定在玩家身上）

`load.mcfunction` 在世界加载时运行，那时还没有玩家——而且在普通世界里
y=0 离地表很远。所以运行时在加载期间从不绘制：它等待。

* `#__started`（保留的编译器内部记分板项）在 load 之后为 0；`#__paused`
  （同样保留）区分“还没启动 / 在等玩家”（0）和显式的 `/function tp:stop`（1）。
* 每个 tick，`tp:tick` 先运行
  `execute if score #__started tp matches 0 if score #__paused tp matches 0 if entity @a run function tp:start`，
  然后运行 `execute if score #__started tp matches 1 run function tp:tick/body`。
* `tp:start` 杀掉旧的笔，在最近玩家脚下的地面上召唤新笔
  （`execute at @p run summon armor_stand ~ ~-1 ~ ...`），然后调用
  `tp:start/rewind`。
* `tp:start/rewind` 是唯一的共享重置：它重绕整个记分板状态机
  （`#__tick/#__pc/#__sleep/#__press/#__pressSeen/#__b/#__brush`、用户状态、
  循环下标），清掉 `#__paused`，设置 `#__started = 1`，并打印一行聊天。
  因为 start 和 body 在同一个 tick 运行，状态 0 会在检测到玩家的那个 tick
  执行，`now` 和“每 tick 一次迭代”的语义保持不变。
* `tp:start_at` 杀掉旧笔，把新笔生成在**命令自己的执行位置**
  （`summon armor_stand ~ ~ ~ ...`），然后调用同一个重绕。因此
  `/execute positioned 100 -60 100 run function tp:start_at` 可以把绘制
  锚定到明确的坐标（在 y=-60 的超平坦世界里很有用）。
* `tp:stop` 原地暂停：`#__started = 0`、`#__paused = 1`、`#__sleep = 0`，
  再打印一行聊天。笔和已经画出的方块留在原地，tick 块和时间线代码都不再
  运行，而门因为 `#__paused` 被设置而不会自动重启。之后 `tp:start` /
  `tp:start_at` 会清掉 `#__paused`，从重绕后的运行继续（对永不结束的
  `tick { ... }` 程序很有用，比如 *endless* 示例）。
* 任何玩家都可以输入 `/function tp:start` 把笔重新锚定到自己脚下并重画，
  用 `tp:start_at` 指定坐标，用 `tp:stop` 暂停，用
  `/function tp:status` 查看运行时是暂停 / 等待 / 运行中、当前画笔，以及
  笔是否存在。

## 时间线 lowering 是怎么做的

* `over N as i { body }` -> `init`（`#__i<k> = 0`）-> `head`（如果
  `#__i<k> < N` 就调用 body，否则去 after）-> `body` -> `latch`
  （`#__i<k> += 1`、`#__sleep = 1`、`#__pc = head`）。因此每次迭代恰好
  消耗一个 tick；状态函数在同一个 tick 内互相 chain，只有 latch 会让出。
* `wait N` -> `#__sleep = N; #__pc = resume-state; return`。`tp:tick` 在
  `#__sleep == 0` 时恢复；倒计时在 dispatch 之后运行，所以 `wait 2` 会在
  两个 tick 后恢复，`wait 0` 在下一个 tick 恢复。
* 时间线上的 `if c { A } else { B }` 变成 condition / true / false / join
  状态。缺失或空的分支直接跳到 join。fn/tick/when 里的即时 `if` 则变成
  `tp:snippet/<id>` 分支函数。
* `when press` 在 `tp:tick` 里用 `#__press - #__pressSeen` 的差值做保护。

### 实现注记 / 刻意保留的细节

* **Dispatch 闩锁（`#__b`）。** Minecraft 会顺序执行一个函数里的各行，而
  chain 或 yield 的状态会在 dispatch 返回之前**修改** `#__pc`。没有保护的话，
  同一个 dispatch 里后面的 `#__pc matches <id>` 行会在同一个 tick 再跑一个
  状态。所以 dispatch 把 `#__b` 闩锁设为 1，每个状态进入时清掉它；第一个进入
  的状态获胜，dispatch 其余部分被跳过。同一个闩锁也保护 `head`/分支判定
  状态——否则在被选中的分支改掉循环下标之后，那两行 `execute` 会同时触发。
  这是字面上的 §2.3 dispatch 形状唯一需要额外保护的地方；除此之外语义与规范
  完全一致。
* **`#__b` 由 dispatch 初始化，而不是由 `load`。** `#__a/#__b` 这两个草稿
  假玩家由 §2.1 保留；`#__a` 存 press 差值，共享重绕会把 `#__b` 设为 1。
* **赋值优化**（§2.4 允许、这里为了可读性采用）：
  `x = <int>` -> `scoreboard players set`，`x = x +- <int>` -> `add`/`remove`，
  `x = y` -> `operation =`。其他表达式都会求值进 `#__t<n>` 临时变量。
* **即时 `if` 的分支闩锁（`#__b`）。** 当 `if` 的两个分支都存在时，两行分支
  调用前会先把 `#__b` 置 1，两行都带上 `if score #__b tp matches 1` 保护，
  并且所有 snippet 进入时把 `#__b` 清 0。否则先执行的分支会复用条件用的
  `#__t*` 临时变量，可能让第二行 `unless` 误触发另一个分支（曾经的真实 bug）。
  只有一个分支时无需闩锁，只有一行调用。
* **与字面量比较**（`if count >= arm` 对 `if i % 4 == 0`）：省掉临时变量和
  减法，改用平移后的 `matches` 区间。两个动态值之间的比较仍用规范的
  “先相减再判断” lowering。
* **除以/模以零**直接输出 `scoreboard players operation /=`/`%=`：原版
  Minecraft 和模拟器都把除数为零的结果定义为 0，这正是语言规则（§1.4）。
* **宏函数**：零参数 `fn` 会变成真正的函数文件，调用形式是
  `function tp:fn/<name>`。带参数的 `fn` 没有独立文件：它的函数体会在每个
  调用点内联，并把 `$param` 替换成实参（递归进行）。作为一个小扩展，宏参数
  也可以继续传给另一个宏函数（`fn quad(b) { plot($b) }`），这样组合起来更
  易读；普通实参仍然只允许整数字面量或裸标识符（§1.6）。
* **循环下标**按编译顺序是 `#__i0`、`#__i1`、……，并在 `load.mcfunction`
  里初始化。循环下标名字是词法作用域；下标只读（对它赋值是编译错误）。
* **`meta`**：`preludeLines` 是 `PRELUDE` 中换行符的个数（用户源码第 1 行 =
  `preludeLines + 1`）；`variables` 列出声明的状态；`stateCount` 是
  `tp:main/s*` 状态的数量；`functionCount` 是生成的 `.mcfunction` 文件数
  （与 UI dev fixture 的定义相同）；`hasTickBlocks` 当且仅当程序至少声明了
  一个 `tick { ... }` 块时为真，这样 UI 就知道：一个纯 tick 程序即使时间线
  一开始就结束（`#__pc == -1`）也仍在持续运行。

## 错误

`compile()` 从不抛异常。诊断是 `{ severity, line, message }`，其中 `line`
是从 1 开始的**用户**源码行号（prelude 偏移已经减掉）。出现任何错误时
`ok` 为 false，`files` 为空。§1.2/§1.6 的所有规则都会被强制执行：
未知名字、重复声明、fn/tick/when 里出现 `over`/`wait`
（“… spans time; move it to the timeline”）、未知 `$params`、宏调用环、
给用在表达式里的参数传标识符实参、保留字、`__` 开头的名字，以及调色板之外
的 `brush(...)` 方块（错误信息会列出所有合法方块）。

## 测试

`test/lang.test.js` 里有黄金数据包测试（精确断言生成的状态机，以及
load/tick/dispatch 的顺序），还有一个仅测试用的小型步进器，可以逐 tick
运行生成的数据包。运行方式：

```
node test/lang.test.js
# 或者，当 Node test runner 能 spawn 子进程时：
node --test test/lang.test.js
```

在 DSH 文件沙箱里 `node --test <file>` 无法 spawn 它的隔离子进程
（`spawn EPERM`）；`node --test --test-isolation=none test/lang.test.js`
会在同一进程里运行同样的测试。整个仓库的验收命令是 `node test/run-all.mjs`。
