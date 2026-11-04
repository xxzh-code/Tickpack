# Tickpack 命名与标识

> P0 定稿。原则：**对外统一全名，需要短标识时用 `tpk`；`tp` 只做默认数据包命名空间，不做项目缩写。**

## 1. 对外标识

| 用途 | 值 | 说明 |
| --- | --- | --- |
| 正式名 | `Tickpack` | 仓库、文档标题、页面标题、README 统一用全名 |
| CLI 命令 | `tickpack`（短别名 `tpk`） | `bin/tickpack.mjs`；`package.json` 的 `bin` 同时注册两个名字 |
| 程序文件扩展名 | `.tpk` | 不用 `.tp`（与 Minecraft `/tp` 传送命令混淆）；导入仍兼容旧的 `.tp` |
| npm 包名 | `tickpack` | 当前仓库 `private: true`；将来发布若被占用则用 scope（如 `@xxzh-code/tickpack`） |
| 环境变量前缀 | `TICKPACK_` | 例如 `TICKPACK_PORT`、`TICKPACK_OUT`；旧 `PORT` 仅作兼容回退 |
| 代码内短标识 | `tpk` | 新的内部变量/前缀用 `tpk`；不新引入 `tp` 作为项目缩写 |
| 数据包命名空间 | `tp`（默认）/ `tp_<name>` | 见 §2；`tp` 只表示默认命名空间 |

页面标题统一：`Tickpack · <页面>`；页脚/对话框里的品牌名用 `Tickpack`。命令、方块 ID、文件名保持英文原样。

## 2. 数据包命名空间规则（P0 只定设计，暂不实现）

源码顶部可以写一行：

```
pack "my_wall"
```

- 没有 `pack` 行 → 命名空间 `tp`，与现在完全一致：
  `/function tp:start`、`/function tp:status`、`/function tp:tick` 继续有效。
- 有 `pack "名字"` → 命名空间 `tp_<sanitized_name>`：
  - 名字只保留 `[a-z0-9_]`，转小写；非法字符折叠为 `_`；首字符非法则加前缀 `p_`。
  - 例：`pack "My Wall!"` → `tp_my_wall`。
- 派生规则（稳定，由名字唯一决定）：

| 对象 | 默认（无 pack 行） | 有 `pack "name"` |
| --- | --- | --- |
| 数据包命名空间 | `tp` | `tp_<sanitized_name>` |
| 函数入口 | `tp:load` / `tp:tick` / `tp:start` / `tp:start_at` / `tp:stop` / `tp:status` | `<ns>:load` 等 |
| 记分板 objective | `tp` | `<ns>`（整个字符串作为 objective 名） |
| 笔实体 tag | `pen` | `pen_<ns>` |
| 标准库/画笔函数 | `tp:fn/*`、`tp:brush/*` | `<ns>:fn/*`、`<ns>:brush/*` |
| tick/load 注册 | `data/minecraft/tags/function/{load,tick}.json` 的 `values:["tp:..."]` | 每个包写自己的 values 条目（如 `"tp_my_wall:load"`），互不覆盖 |

- 同名（sanitize 后相同）冲突：导出时提示用户，由用户改名；不自动加后缀。
- 生成的 mcfunction 内部引用一律使用自己的命名空间，不引用 `tp` 的固定路径。
- 示例/Remix 默认 **不带** `pack` 行（保持 `tp` 兼容）；多包是高级用法，手动加。
- MC 版本声明：数据包产物不承诺跨版本兼容，导出即冻结；`pack.mcmeta` 继续用 `supported_formats` 声明支持的版本区间。

## 3. 版本与分享标识

- 分享链接统一带 `v=1`（schema 版本）。版本不匹配时提示「此链接来自旧版本，行为可能不同」，不假装无事发生。
- 每次 break change：Release notes 写清楚「改了什么、旧代码怎么迁移」；示例和提示卡同版本更新。
- Git tag 每阶段一枚，例如 `v0.1.0`（P0）、`v0.1.1`/`v0.2.0`（P0.5/P1）。
