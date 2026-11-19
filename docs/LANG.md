# Tickpack v0.1 — 语言与运行时规范

状态：**已在 slice 1 冻结**。如果某个实现细节不清楚，去问 Lead；
不要悄悄改语义。

Tickpack 是一门很小的语言，最终编译成真正的 Minecraft 数据包。
这门语言的重点在于：**控制流默认是跨时间的。**
一次 `over` 循环每次迭代消耗一个 tick；状态活在记分板上；
编译产物是一个每 tick 恢复一次的状态机。

## 1. 源语言

按行组织，用花括号表示块，`#` 开始注释（字符串之外）。
缩进不影响语义。语句以换行结束。

### 1.1 声明（仅顶层）

```
state x = 0                     # 整数状态 -> 记分板 tp 上的 #x
fn walk() { ... }               # 即时函数，编译成一个 mcfunction
fn turn(deg) { ... }            # 常量参数宏函数（见 1.6）
tick { ... }                    # 每个 tick 开始时运行（只允许即时代码）
when press { ... }              # 每次宿主 "press" 输入运行一次（只允许即时代码）
```

- `state` 的初始值是一个整数字面量。状态是全局的；表达式里的 `x`
  读的是记分板 `tp` 上的 `#x`。
- `now` 是内置表达式：到目前为止经过的 tick 数（从 0 开始）。
- 用户的状态/循环/fn 名字必须匹配 `[A-Za-z_][A-Za-z0-9_]*`。以 `__`
  开头的名字保留给编译器。
- 重名状态、重名 fn、未知名字 => 编译错误。

### 1.2 时间线语句（顶层，以及 `if` / `over` 体内）

这些语句跑在**主时间线**上：程序从 tick 0 开始，每 tick 恢复一次。

```
over 8 as i { ... }             # 时间线循环：循环体每 tick 执行一次，i = 0..7
wait 5                          # 让时间线挂起 5 个 tick
if cond { ... } else { ... }    # 分支（两个分支都可以包含跨时间的语句）
say "text"                      # 原样发送 /say（只支持字符串，不做插值）
run <raw command>               # 原样注入一条原版命令（本行剩余内容）
x = expr                        # 给状态赋值
walk()                          # 调用一个 fn（即时）
name(arg1, arg2)                # 调用一个宏 fn
brush(gold_block)               # 设置运行时画笔（见 1.7）
paint                           # 在笔尖处绘制当前画笔的方块
```

`over` 的语义：迭代 `k`（从 0 开始）**在一个新的 tick 上开始**；
一个只由即时语句组成的循环体，每次迭代恰好消耗一个 tick。
循环之后的语句，在最后一次迭代结束后的那个 tick 开始执行。
允许嵌套。

`wait N` 恰好消耗 N 个 tick；N 可以是 0（等价于“下一个 tick 恢复”；
在实际生成的机器里，`wait 0` 和 `wait 1` 都会在下一个 tick 恢复，
因为 yield 之后、dispatch 之后的递减是按 1 为基准的）。

`if/else` 的两个分支都可以包含 `over`/`wait`；时间线状态机会统一处理
两个分支。

### 1.3 即时语句（`fn`、`tick`、`when` 内，也可以用在任何地方）

```
x = expr
say "text"
run <raw command>
fnCall(...)
brush(gold_block)               # 设置运行时画笔（见 1.7）
paint                           # 在笔尖处绘制当前画笔的方块
if cond { ... } else { ... }    # 两个分支只能是即时代码
```

**硬性规则：**`fn`、`tick` 和 `when` 的函数体里不能包含 `over` 或 `wait`。
它们只属于时间线。尝试这样做是编译错误
（"… spans time; move it to the timeline"）。这条规则让函数保持为普通的
mcfunction 文件，也让「tick / 时间」的分界保持清晰。

### 1.4 表达式

```
expr   := or
or     := and ('or' and)*
and    := cmp ('and' cmp)*
cmp    := add (('=='|'!='|'<'|'<='|'>'|'>=') add)*
add    := mul (('+'|'-') mul)*
mul    := unary (('*'|'/'|'%') unary)*
unary  := ('-'|'not') unary | atom
atom   := INT | 'now' | IDENT | '$' PARAM | '(' expr ')' | 'ahead' '(' IDENT ')' | 'below' '(' IDENT ')'
```

- 只支持整数（记分板是 32 位整数）。除以/模以零 => 0。
- 比较的结果是 0/1。`and`/`or`/`not` 基于 0/1 值运算
  （`a and b` 当且仅当两者都非零时为 1）。
- 在 `if` 中，条件值非零即为真。
- 函数调用只能作为语句，不能出现在表达式里（v0.1）；`ahead(block)` /
  `below(block)` 是例外，它们是内置传感器表达式（§1.8）。

### 1.5 `run` 行

`run` 之后的文本是一条原版命令，会原样传递
（行尾的 `# 注释` 会被去掉）。它在出现的位置执行：
时间线状态里、fn 里、tick 块里。除了宏参数（1.6）之外不做任何插值。

### 1.6 常量参数宏函数

`fn turn(deg) { run ... ~$deg ~ }` —— 参数是**编译期常量**。
实参必须是整数字面量或裸标识符（例如 `gold_block`）。
在调用点，编译器会把 `run` 行里每个 `$param` 替换成实参的源文本。
整数参数也可以在表达式里当字面量使用（`x = $deg * 2`）。

- 宏展开是递归的（fn A 可以调用 fn B），出现环是编译错误。
- 一个参数如果用在表达式里，却收到了标识符实参，是错误。
- fn 体内出现 `$unknown` 是错误。
- 调用是语句，不是表达式。
- 为了方便组合，宏参数也可以作为实参传给另一个宏函数
  （如 `fn quad(b) { plot($b) }`）；普通实参仍然只允许整数字面量或
  裸标识符。

### 1.7 画笔与 paint（运行时方块调色板）

`brush` 和 `paint` 是**编译器内置**，不是 prelude 函数；这样方块名才能
在编译期被校验并映射成调色板序号。

- `brush(<裸方块 id>)` —— 设置运行时画笔：`scoreboard players set
  #__brush tp <index>`。任何可以写即时语句的地方都可以用（时间线、
  `fn`、`tick`、`when`）。`brush` 只接受字面量方块 id，不接受 `$param`。
  传入调色板之外的方块是编译错误，错误信息会列出整个调色板。
- `paint`（也接受 `paint()`）—— 在笔尖处绘制当前画笔的方块。编译成
  `function tp:fn/paint`，即一个针对调色板生成的 dispatch 函数。
- `brush` 和 `paint` 是保留名：用户的状态/fn 不能和它们重名。

### 1.8 感官（ahead / below）

`ahead(block)` 和 `below(block)` 是内置的**布尔表达式**，读取笔所在世界：

- `ahead(block)`：笔沿当前 yaw+pitch 的视线方向前一格是否有 `block`；
- `below(block)`：笔正下方一格是否有 `block`；
- 结果 0/1，可直接用于 `if`、`and`/`or`/`not` 或赋值；
- `block` 必须是 `air` 或调色板方块（§1.7 的 12 种），否则编译错误；
- 不是 `prelude` 函数，不生成 `fn` 文件；每条表达式编译成真实
  `execute ... if block ... run scoreboard players set <tmp> tp 1` 命令。

示例：

```
brush(gold_block)
if ahead(stone) {
  turn(90)
} else {
  walk
  paint
}
```

生成的“前方”探测使用笔的局部坐标，因此在 3D 中会跟随 pitch：

```
execute at @e[tag=pen] positioned ^ ^ ^1 if block ~ ~ ~ stone run scoreboard players set #__t0 tp 1
```

`below` 使用世界方向的 `~ ~-1 ~`。示例 `senses`（沿墙）演示了“先画墙，再感知并转向”。


调色板（固定顺序 = `#__brush` 的序号）：

| 序号 | 方块 | 序号 | 方块 |
| --- | --- | --- | --- |
| 0 | stone | 6 | coal_block |
| 1 | gold_block | 7 | glowstone |
| 2 | redstone_block | 8 | white_wool |
| 3 | emerald_block | 9 | purple_wool |
| 4 | lapis_block | 10 | oak_planks |
| 5 | diamond_block | 11 | glass |

这个调色板在游戏里同样存在：`/function tp:brush/<block>` 选择一种，
`/function tp:brush/next` 循环切换（到 12 后绕回 0）。画笔是运行时状态，
所以程序运行中改画笔会影响之后的 `paint`；程序里的 `brush(...)` 语句会
覆盖它。`tp:start` / `tp:start_at` 会把 `#__brush` 重置回 0（stone）。

### 1.9 意图探针：animate

P1.5 只做最小探针，不是完整意图层：

```
animate(@p, "wave", 20 ticks)
```

- 语句级内置；目标目前只支持 `@p`，动画名只支持 `"wave"`，时长是
  正整数 + `ticks`；
- 编译器把它 lower 成 `#__animLeft` / `#__animActive` 两个记分板槽，并
  生成 `data/tp/function/anim/tick.mcfunction`；`tp:tick/body` 每 tick 在
  时间线 dispatch 之后调用它；
- `tp:anim/tick` 发出可读的 `particle` 命令，浏览器模拟器执行同一份
  mcfunction，因此预览和数据包一致；
- **覆盖机制**：全局只有一个动画槽；新的 `animate(...)` 会重置剩余
  ticks/active，旧动画不会继续；
- `load` 和 `start/rewind` 会把动画槽清空；
- 示例 `wave` 是“一行意图 + 等待 20 ticks”，用于验证语法、展开和覆盖。

## 2. 编译模型

### 2.1 记分板布局

只有一个 objective：**`tp`**（dummy）。假玩家（fake player）：

| 名字 | 含义 |
| --- | --- |
| `#__tick` | 已经过的 tick 数（`now`） |
| `#__pc` | 主时间线程序计数器（状态 id）；`-1` = 已结束 |
| `#__sleep` | 距离下次 dispatch 还要睡的 tick 数 |
| `#__started` | 0 = 等待玩家，1 = 运行中（由 `tp:start` 设置） |
| `#__paused` | 1 = 通过 `tp:stop` 显式暂停（用于压制自动启动门）；由 `tp:start` / `tp:start_at` 清零 |
| `#__brush` | 运行时画笔的调色板序号（0..11，见 1.7） |
| `#__animLeft` / `#__animActive` | P1.5 `animate` 单一动画槽的剩余 tick / 是否激活 |
| `#__press` | 宿主输入：模拟器每次按下时自增 |
| `#__pressSeen` | 事件处理器已经消费到的 press 计数 |
| `#__a` | press 差值 / 临时草稿 |
| `#__b` | dispatch/分支闩锁（见 2.3） |
| `#__t0`..`#__t9` | 表达式临时变量（编译器可能会用更多） |
| `#<state>` | 用户状态变量 |
| `#__i<k>` | 第 k 个 `over` 循环的循环下标（每个循环唯一） |

所有值都是有符号 32 位整数。

### 2.2 tick 顺序（`tp:tick`，注册在 `minecraft/tags/function/tick.json`）

`tp:tick` 本身只是一层薄门；真正的工作在 `tp:tick/body`。

0. **锚定并启动**：如果 `#__started == 0`、`#__paused == 0` 且世界里存在
   玩家（`if entity @a`），调用 `tp:start`（杀掉旧笔、在最近玩家脚下召唤
   新笔、重绕整次运行、打印一行聊天、设置 `#__started = 1`）。
   随后 body 会在同一个 tick 里运行，所以状态 0 就在检测到玩家的那个
   tick 上执行。`tp:stop` 会设置 `#__started = 0` + `#__paused = 1`，因此
   显式暂停不会被这个门覆盖；再次 `tp:start` 会清掉暂停。
1. 用户 `tick {}` 块，按源码顺序
2. `when press` 处理器（用 press 计数的差值做保护）
3. 时间线 dispatch，仅当 `#__sleep == 0`
4. 如果 `#__sleep >= 1`：`#__sleep -= 1`
5. `#__tick += 1`

步骤 1–5 只在 `#__started == 1` 时运行。顺序很重要，是可观察行为的一部分。
数据包在玩家出现之前会刻意什么都不做——在真实世界里，否则时间线会在
世界加载期间、在玩家看不到的地方就跑完。

### 2.3 时间线状态机

每个状态是一个函数 `tp:main/s<id>`。一个状态包含一段直线排列的命令，
并且以恰好以下三种方式之一结束：

- **chain**：把 `#__pc` 设为下一个状态 id，并用 `function` 调用它；
- **yield**：把 `#__sleep` 设为 >= 1、`#__pc` 设为要恢复的状态，然后返回；
- **finish**：把 `#__pc` 设为 `-1`，返回。

`tp:main/dispatch` 里每个状态一行：
`execute if score #__b tp matches 1 if score #__pc tp matches <id> run function tp:main/s<id>`。
`tp:tick` 只在 `#__sleep == 0` 时调用 dispatch。

**实现注记（dispatch 闩锁）。** 天真写法
`execute if score #__pc tp matches <id> run function tp:main/s<id>` 在真实的
Minecraft（以及模拟器）里是*错的*：一个函数里的行是按顺序执行的，而状态
会在 dispatch 返回之前修改 `#__pc`，于是同一个 dispatch 函数的后面几行会
在同一个 tick 里再跑一个状态。因此编译器会生成一个闩锁：dispatch 先把
`#__b = 1` 设置一次，每个状态 / 分支判定函数在进入时把 `#__b = 0` 清掉。
每一行 dispatch 都带有 `if score #__b tp matches 1` 的保护。可观察语义与
§2.2/§2.3 完全一致——每 tick 一次状态转移、`over` 每 tick 一次迭代——
只是保护条件的形状不同。（`#__b` 是编译器保留的记分板项；`#__a` 存
press 差值。）

`over N as i { body }` 的规范化 lowering（id 只是示意）：

```
init   : set #__i 0; pc=next; call next
head   : if #__i matches 0..N-1 -> body entry, else -> after   (通过 execute if/unless)
body...: ...
after body: #__i += 1; sleep=1; pc=head; return        # 恰好让出一个 tick
after  : continue with the following statement
```

`wait N` 的规范化 lowering：
`#__sleep = N; pc = resume-state; return`。

`if c { A } else { B }` 的规范化 lowering：先把 c 求值进临时记分板 `<tmp>`，
然后执行两条命令：`execute if score #__b tp matches 1 if score <tmp> tp matches 0
run function <B entry>`（0 = 假）以及 `execute if score #__b tp matches 1 unless
score <tmp> tp matches 0 run function <A entry>`（开头的 `#__b` 是分支闩锁，
理由同上面的实现注记：第一个分支执行时会把它清掉，第二行就不会重复进入）。
两个分支入口最后都 chain 到 join 状态。缺少 `else` 时，假分支直接指向 join。
即时分支和时间线分支都适用。

### 2.4 即时代码 lowering

一段段即时语句会变成直线排列的函数。
即时代码里的 `if` 降级成 `tp:snippet/<id>` 分支函数：只有一个分支时是一行
`execute if/unless score <条件值> matches 0 run function tp:snippet/<id>`；
两个分支都存在时，两行调用前会先 `scoreboard players set #__b tp 1`，两行都
带上 `if score #__b tp matches 1` 保护，并且 snippet 进入时把 `#__b` 清 0——
这样先执行的分支即使改写了条件用的 `#__t*` 临时变量，后面的行也不会再触发
另一个分支。snippet 结束时直接返回，就回到了调用点。
表达式会编译成临时记分板：

- 字面量 `n` -> `scoreboard players set #__t0 tp n`
- 变量 `x` -> `scoreboard players operation #__t0 tp = #x tp`
- `a + b` -> 先把 a、b 分别求值到 t0、t1，再 `operation #__t0 tp += #__t1 tp`
- 比较：两个动态值比较时先相减，再
  `execute if score <tmp> tp matches <range> run
  scoreboard players set <dst> tp 1`（dst 预先置 0）。
  与字面量比较时则省掉临时变量和减法，直接使用平移后的 `matches`
  区间（例如 `x >= 3` -> `matches 3..`）。
- `ahead(block)` / `below(block)`：dst 先置 0，再用
  `execute at @e[tag=pen] positioned ^ ^ ^1 if block ~ ~ ~ <block>` /
  `execute at @e[tag=pen] if block ~ ~-1 ~ <block>` 置 1。
- 给变量赋值：先求值进临时变量，再 `operation #<var> tp = #__t<tmp>`

优化（`x = x + 1` -> `scoreboard players add #x tp 1`，以及
`x = <int>`、`x = y` 的直写形式）已经实现，用来让生成代码更好读。
正确性优先，可读性其次：每一条生成的命令都必须是真实、可加载的
Minecraft 语法。

## 3. 数据包输出布局

命名空间 `tp`，数据包格式 48（Minecraft 1.21+；`supported_formats` 为
48..9999）。所有路径都相对于数据包根目录：

```
pack.mcmeta
data/minecraft/tags/function/load.json     {"values":["tp:load"]}
data/minecraft/tags/function/tick.json     {"values":["tp:tick"]}
data/tp/function/load.mcfunction
data/tp/function/tick.mcfunction           门：检测到玩家后启动，然后交给 body
data/tp/function/tick/body.mcfunction      每 tick 的实际工作（步骤 1-5）
data/tp/function/start.mcfunction          tp:start（笔在玩家脚下，然后重绕）
data/tp/function/start_at.mcfunction       tp:start_at（笔在命令执行位置，然后重绕）
data/tp/function/start/rewind.mcfunction   唯一共享的重置逻辑 + 一行 say
data/tp/function/stop.mcfunction           tp:stop（原地暂停）
data/tp/function/status.mcfunction         tp:status（聊天诊断，含当前画笔）
data/tp/function/fn/paint.mcfunction       `paint` 的调色板 dispatch
data/tp/function/anim/tick.mcfunction       `animate(@p, "wave", N ticks)` 的每 tick 粒子/计数（仅当使用 animate）
data/tp/function/brush/<block>.mcfunction  x12，每种调色板方块一个选择器
data/tp/function/brush/next.mcfunction     循环切换画笔（到 12 后绕回）
data/tp/function/main/dispatch.mcfunction
data/tp/function/main/s<id>.mcfunction
data/tp/function/fn/<name>.mcfunction
data/tp/function/snippet/<id>.mcfunction
data/tp/function/event/press.mcfunction        （仅当存在 `when press`）
```

`load.mcfunction`（在 /reload 和世界加载时运行）：

```
# Tickpack load — generated by Tickpack; do not edit
scoreboard objectives add tp dummy
scoreboard players set #__tick tp 0
scoreboard players set #__pc tp <first state id or -1>
scoreboard players set #__sleep tp 0
scoreboard players set #__press tp 0
scoreboard players set #__pressSeen tp 0
scoreboard players set #__brush tp 0
scoreboard players set #__started tp 0
scoreboard players set #__paused tp 0
scoreboard players set #x tp <init>      # 每个声明过的状态一行
scoreboard players set #__i0 tp 0        # 如果用到循环下标
kill @e[tag=pen]
```

`start.mcfunction`（`/function tp:start`，tick 门也会自动调用）：

```
kill @e[tag=pen]
execute at @p run summon armor_stand ~ ~-1 ~ {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}
function tp:start/rewind
```

`start_at.mcfunction`（`/execute positioned X Y Z run function tp:start_at`）：

```
kill @e[tag=pen]
summon armor_stand ~ ~ ~ {Tags:["pen"],Invisible:1b,NoGravity:1b,Marker:1b}
function tp:start/rewind
```

`start/rewind.mcfunction`——唯一共享的重置逻辑：`#__tick 0`、`#__pc`
首个状态/-1、`#__sleep 0`、`#__press 0`、`#__pressSeen 0`、`#__b 1`、
`#__brush 0`、每个用户状态回到初始值、每个循环下标归 0、`#__paused 0`，
然后 `#__started 1`，最后一行 `say` 解释 `/function tp:start` 和
`/execute positioned ... tp:start_at`。

`stop.mcfunction`（`/function tp:stop`）：

```
scoreboard players set #__started tp 0
scoreboard players set #__paused tp 1
scoreboard players set #__sleep tp 0
say Tickpack: 已暂停（/function tp:start 重新开始；/function tp:status 查看状态）
```

笔和已经画出的方块都会留在原地。`tp:status` 会报告三种状态之一：
`未运行（等玩家，或 /function tp:start 开始）` / `已暂停（/function tp:start 继续）` /
`运行中（/function tp:start 可重画）`，外加当前画笔，以及笔是否存在。

关于世界：浏览器现在支持 `x,y,z` 三维，默认的 2D 示例仍按 y=0 的俯视平面渲染；
3D 示例（如 `helix3d`）使用正交投影的正等轴视图，绘制范围可以延伸到任意坐标
（具体视口/缩放属于外壳的渲染细节）。笔就是那只乌龟实体（armor stand，
 tag `pen`，yaw 0 = 朝向 +Z；pitch 为 Minecraft 角度，正值低头、负值抬头）。
在真实的 Minecraft 里，笔会锚定在最近玩家脚下那块方块上
（`execute at @p` 之后的 `~ ~-1 ~`），于是图案出现在玩家周围的地面上，
而不是某个固定的世界坐标；`tp:start` 会重新锚定并重绕，
`tp:start_at` 则使用命令本身的执行位置。在模拟器里，一个虚拟宿主
`player` 实体站在 `(0.5, 1, 0.5)`，所以锚定召唤出的笔正好落在
`(0.5, 0, 0.5)`，所有示例的方块坐标都保持不变。方块会放在笔所在的
y 层；在 `execute at @e[tag=pen]` 之后执行 `setblock ~ ~ ~`，落点就是
笔所在的方块。（模拟器做方块命令时会对坐标向下取整。）

每个生成的函数都以一个 `# Tickpack ...` 头注释开头，并且可能带有
`# source line N` 注释用于追溯。注释不得影响执行。

## 4. 标准库（prelude）

编译器总是在用户源码之前拼上 `src/lang/prelude.js`（`PRELUDE`，一段
`.tpk` 语法的字符串）。它定义下面的乌龟 API。用户不能重定义 prelude 里
的函数名（编译错误），但可以添加自己的 fn。
如果示例需要更多能力，编译器负责人也可以扩展 `prelude.js`。

必需的 prelude 函数（实现注记：`walk`、`walk2`、`stamp`、`clear_ground`、
`home` 会编译成真正的 `tp:fn/*` 函数；`turn(deg)` 和 `plot(block)` 是
常量参数宏，因此在调用点内联，所以数据包里没有 `fn/turn.mcfunction`）：

```
fn walk()                 # 笔向前走 1 格（^ ^ ^1）
fn walk2()                # 向前走 2 格
fn turn(deg)              # yaw 旋转 deg 度（宏，例如 turn(90)、turn(-45)）
fn plot(block)            # 在笔所在方块位置 setblock 成 `block`（宏，字面量）
fn plot_under(block)      # 同上，但放在笔下方一格（宏，字面量）
fn stamp()                # 在笔的位置放粒子（视觉上的小闪光）
fn particle(type)         # 在笔的位置放指定粒子（宏；type 是原版粒子 id）
fn sound(name, pitch)     # 在笔的位置播放声音（宏；name 是原版声音 id，pitch 是音高）
fn clear_ground()         # 把玩家周围 33x33 的地面层填回 air
fn home()                 # 把笔送回玩家脚下的方块，yaw 归 0
fn up(n)                  # 笔的 y 增加 n 格（宏，例如 up(1)、up(3)）
fn down(n)                # 笔的 y 减少 n 格（宏）
fn pitch(deg)             # 笔的 pitch 增加 deg 度（宏；负值抬头、正值低头）
```

`brush(<block>)` 和 `paint` 是编译器内置（§1.7），不是 prelude 函数：
编译器必须校验方块 id 并知道调色板序号。`plot(block)` 仍然是绘制
调色板之外方块的“字面量逃生口”。`ahead(block)` / `below(block)` 也是
编译器内置表达式（§1.8），不占 prelude 函数名。

实现注记：
- `walk`：`execute as @e[tag=pen] at @s run tp @s ^ ^ ^1`
- `turn(deg)`：`execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~$deg ~`
- `plot(block)`：`execute at @e[tag=pen] run setblock ~ ~ ~ $block`
  （同方块替换没有问题；模拟器会在 trace 里忽略没有变化的 setblock，
  这样时间线仍然有意义）
- `stamp`：`execute at @e[tag=pen] run particle happy_villager ~ ~ ~ 0 0 0 0 1`
- `particle(type)`：`execute at @e[tag=pen] run particle $type ~ ~ ~ 0 0 0 0 1`
- `sound(name, pitch)`：`execute at @e[tag=pen] run playsound $name master @a ~ ~ ~ 0.8 $pitch`
- `clear_ground`：`run execute at @p run fill ~-16 ~-1 ~-16 ~16 ~-1 ~16 air`
- `home`：`run execute at @p run tp @e[tag=pen] ~ ~-1 ~ 0 0`
- `up(n)`：`execute as @e[tag=pen] at @s run tp @s ~ ~$n ~`
- `down(n)`：`execute as @e[tag=pen] at @s run tp @s ~ ~-$n ~`
- `pitch(deg)`：`execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~ ~$deg`
  （7 个 token：yaw 为 `~`，pitch 为相对 `~$deg`，没有把 pitch 塞进 yaw 槽）

这两个函数（`clear_ground`、`home`）刻意做成相对于玩家的：在真实世界里
`(0.5, 0, 0.5)` 通常位于很深的地下或很高的空中。在模拟器里，虚拟玩家站在
`(0.5, 1, 0.5)`，所以它们解析出的坐标和旧坐标完全一致。

## 5. 模拟器契约

`src/sim/sim.js` 导出 `class Simulator`。它加载一个虚拟数据包
（`{ [path]: text }`），执行**生成的 mcfunction**（不是 AST）。

```js
const sim = new Simulator(files);   // files = compile(...).files
sim.reset();                        // 清空记分板/世界，运行 tp:load
const events = sim.step();          // 恰好运行一个 tick（tp:tick），然后 tick++
sim.press();                        // 宿主输入；让 #__press 自增
sim.getTick();                      // 已经过的 tick 数
sim.getWorld();                     // { blocks: [{x,y,z,block}], entities: [{id,type,x,y,z,yaw,pitch,tags}] }
sim.getScores();                    // { [objective]: { [fakePlayer]: value } }
sim.snapshot();                     // 可 structured-clone 的完整状态
sim.restore(snapshot);              // 恢复状态（不重新加载 tag）
```

`step()` 返回的 trace 事件（必须保持稳定；UI 依赖它们）：

```js
{ type:'command', tick, file:'data/tp/function/main/s0.mcfunction', line:3,
  fn:'tp:main/s0', text:'scoreboard players ...' }
{ type:'say', tick, text:'hello' }
{ type:'particle', tick, x,y,z, particle:'happy_villager' }
{ type:'sound', tick, sound:'block.note_block.hat', pitch:1.0, volume:0.8, x,y,z }
{ type:'error', tick, message, file?, line? }
```

`file` 是数据包内的相对路径；`line` 是该文件中从 1 开始的行号。
`say` / `particle` / `sound` 事件也可能附带 `file`/`line`/`fn` 这些定位字段。
`getWorld()` 里的方块只包含非空气方块；坐标是整数。
`snapshot()` 必须能通过 `structuredClone`（纯对象/数组/字符串/数字）。
`^` 局部坐标使用完整的 yaw+pitch 基（forward/left/up），与 Minecraft 一致；
pitch 为 0 时退化为旧的平面 2D 行为。`restore()` 兼容旧的 `[x,z,block]` /
`{x,z,block}` 快照，缺失的 y 按 0 处理。

`reset()` 还会创建一个**虚拟宿主玩家**：`{type:'player', x:0.5, y:1.0,
z:0.5, yaw:0, pitch:0, tags:[]}`（实体 id 为 1）。选择器遵循原版语义：
`@a` = 只有玩家，`@p` = 最近的玩家，`@e` = 所有实体（笔和玩家），
`@s` = 当前执行实体。正因如此，生成的“等玩家再启动”运行时
（`if entity @a` → `tp:start` → `execute at @p ... ~ ~-1 ~`）在浏览器里
才能和 Minecraft 里完全一致：笔落在 `(0.5, 0, 0.5)`，所有示例保持原来的
坐标，并且第一次 `reset()` 之后 `if entity @a` 就为真。

v0.1 支持的命令子集（未知命令产生 `error` 事件，绝不崩溃）：

- `scoreboard objectives add|remove <obj> dummy ...`
- `scoreboard players set|add|remove <target> <obj> <int>`
- `scoreboard players reset <target> [<obj>]`
- `scoreboard players operation <t> <obj> (=|+=|-=|*=|/=|%=) <src> <obj>`
- `execute [as <sel>] [at <sel>] [positioned <x> <y> <z>] [rotated <yaw> <pitch>]
   [if score <t> <obj> matches <range>] [unless score ...]
   [if block <x> <y> <z> <block>] [unless block ...]
   [if entity <sel>] [unless entity <sel>] run <command>`
- 选择器：`@s`、`@p`、`@a`、`@e[...]`，支持 `tag=`、`limit=`、`type=`、
  `sort=`、`distance=`、`name=`（未知参数会被忽略）
- `tp <targets> <x> <y> <z> [<yaw> <pitch>]`（绝对坐标、`~` 偏移、`^` 局部坐标，
  相对旋转 `~N` = 目标 yaw + N）
- `setblock <x> <y> <z> <block> [replace|destroy|keep]`
- `fill <x1> <y1> <z1> <x2> <y2> <z2> <block> [replace|destroy|keep]`
- `summon <type> <x> <y> <z> [<nbt>]`（只读取 `Tags:[...]`，其他 NBT 忽略）
- `kill <targets>`、`tag <targets> add|remove <tag>`
- `say <text>`、`function <ns:path>`、`particle <name> <x> <y> <z> ...`
- `playsound <sound> <source> <targets> [x y z] [volume] [pitch] [minVolume]`
- 注释（`#...`）和空行

语义注记：
- 未知记分板值 = 0。记分板是 32 位有符号整数，`/` 向零截断。
- `matches` 区间语法：`5`、`5..`、`..5`、`5..10`、`..`（总是真）。
- `setblock`/`fill`/`if block` 的方块坐标会从浮点数向下取整。
- yaw 0 朝 +Z；方向 = (-sin(yaw), 0, cos(yaw))；`tp` 上的 `~N` 旋转会把 N
  加到目标自己的 yaw 上。pitch 未使用（平面世界）。
- 执行预算：每 tick 约 10 万条命令的硬上限，用来抓住死循环；
  触发时发出 `error` 事件并停止该 tick。
- 体积上限：`fill` 最多 4096 个方块。
- 允许函数递归；深度上限 256（超过时发出 error 事件）。

## 6. 浏览器应用契约

`web/**` 是唯一的 UI（`web/index.html` 由静态服务器挂在 `/`，无构建步骤）。
外壳（`web/boot.js` 等）只通过 `src/api.js` 使用核心能力。
`src/api.js`（Lead 负责）暴露：

```js
export { compile } from './lang/compile.js';
export { Simulator } from './sim/sim.js';
export { PRELUDE } from './lang/prelude.js';
export { SAMPLES } from './samples.js';   // [{ id, title, description, source }]
export { packToZip } from './zip.js';     // (files) -> Uint8Array，真实 store-only .zip
export {
  TickpackSession, MAX_SNAPSHOTS,         // 与宿主无关的「一次运行」控制器
  isOnboardingSay, pickExecuting,
  directSourceLine, looseSourceLine,
} from './session.js';
```

`compile(source) -> { ok, files, diagnostics, meta }`
- `files`：`{ 'pack.mcmeta': '...', 'data/tp/function/load.mcfunction': '...' }`
- `diagnostics`：`[{ severity:'error'|'warning', line, message }]`，`line` 是从
  1 开始的**用户源码**行号（prelude 的偏移已经减掉）。
- `meta`：`{ preludeLines, variables:[{name,initial}], stateCount, functionCount, hasTickBlocks }`
  —— `hasTickBlocks` 当且仅当用户程序声明了 `tick { ... }` 块时为真；UI 用它
  让这类“环境型”程序在时间线已经结束（`#__pc == -1`）时继续运行。

`TickpackSession` 是核心层里“一次运行”的宿主无关控制器（详见
`docs/ARCH.md`）：`load(source)`、`reset()`、`step()`、`seek(index)`、
`view()`、`press()`、`exportBundle({ filename })`；只读属性有 `ok`/`files`/
`meta`/`diagnostics`/`tick`/`cursor`/`total`/`finished`/`capped`/
`snapshotsCount`/`hasTickBlocks`/`lastSay`。`step()` 返回的 TickResult 包含
`tick`、`index`、`total`、`events`、`world`、`scores`、`changes`、`exec`、
`lastSay`、`finished`、`runtimeError`、`errors`、`capped`。
播放计时（rAF、速度）、渲染、输入以及平台副作用（下载/剪贴板/文件）属于
外壳，由外壳自己的 host 适配器实现。

UI 组件不得依赖编译器内部或模拟器内部，只能使用上面这两个契约。
UI 不得加在 `web/**` 之外的仓库里（`src/api.js` 由 Lead 集成）。
