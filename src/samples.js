// Ready-made programs shown in the browser app. Each sample must compile with the
// current language and is also used by tests / screenshots.
// Keep `source` user-facing: prelude (walk/turn/plot/...) is implicit.
// `brush(block)` sets the runtime brush (palette in the compiler); `paint` draws the
// current brush block at the pen. That is what makes in-game
// /function tp:brush/<block> able to change the colour of a running program.
export const SAMPLES = [
  {
    id: 'square',
    title: '正方形 · Square',
    description: '嵌套的时间循环：外层 4 条边，内层每条边 8 步，每步消耗 1 tick。',
    source: `# 一个 over 循环就是一个 tick 计数器
brush(stone)

over 4 as side {
  over 8 as step {
    walk
    paint
  }
  turn(90)
}
stamp
`,
  },
  {
    id: 'remix',
    title: '改这里 · Remix',
    description: '改下面三个数字，看画面怎么变，然后点「分享」把同一幅画发给朋友。',
    source: `# 改这里：圈的大小（45）、每步转角（8）
brush(emerald_block)

over 45 as i {
  walk
  paint
  turn(8)
}
stamp
`,
  },
  {
    id: 'spiral',
    title: '金色螺旋 · Golden Spiral',
    description: 'state 活在记分板上：count 和 arm 每 tick 变化，边长逐渐增加。',
    source: `# 状态存在记分板里，每一 tick 都看得见
state arm = 1
state count = 0
brush(gold_block)

over 120 as i {
  walk
  paint
  count = count + 1
  if count >= arm {
    count = 0
    arm = arm + 1
    turn(90)
  }
}
stamp
`,
  },
  {
    id: 'star',
    title: '五角星 · Star',
    description: '每次走 8 格、转 144°，5 笔画出五角星；每一格都是一个 tick。',
    source: `# 144° × 5 = 720°：五笔星形
brush(gold_block)

over 5 as arm {
  over 8 as step {
    walk
    paint
  }
  turn(144)
}
stamp
`,
  },
  {
    id: 'circle',
    title: '圆 · Circle',
    description: '每 tick 前进一格再转 8°，45 个 tick 走出半径约 7 格的大圆。',
    source: `# 45 × 8° = 360°
brush(lapis_block)

over 45 as i {
  walk
  paint
  turn(8)
}
stamp
`,
  },
  {
    id: 'rainbow',
    title: '彩虹圆 · Rainbow',
    description: '每三步换一支笔，红 / 绿 / 蓝交替；游戏里也能用 /function tp:brush/next 手动换。',
    source: `# 运行时换笔：brush(i) 只改一个记分板
over 90 as i {
  if i % 3 == 0 {
    brush(redstone_block)
  }
  if i % 3 == 1 {
    brush(emerald_block)
  }
  if i % 3 == 2 {
    brush(lapis_block)
  }
  walk
  paint
  turn(8)
}
stamp
`,
  },
  {
    id: 'endless',
    title: '无尽螺旋 · Endless',
    description: '永不结束：tick 块每 4 tick 走一格，边长逐渐增加。游戏里随时 /function tp:brush/redstone_block 换笔，/function tp:stop 暂停。',
    source: `# tick 块 + state：一个不会停的方形螺旋
state arm = 1
state count = 0
brush(gold_block)

tick {
  if now % 4 == 0 {
    walk
    paint
    count = count + 1
    if count >= arm {
      count = 0
      arm = arm + 1
      turn(90)
    }
  }
}
`,
  },
  {
    id: 'magic',
    title: '魔法螺旋 · Magic Spiral',
    description: '每一 tick 都留下粒子；方形螺旋越走越大，导出的数据包在 Minecraft 里也会一路冒光。',
    source: `# 每一 tick 都留下一颗 end_rod 粒子
state arm = 1
state count = 0
brush(purple_wool)

over 120 as i {
  walk
  paint
  particle(end_rod)
  count = count + 1
  if count >= arm {
    count = 0
    arm = arm + 1
    turn(90)
  }
}
stamp
`,
  },
  {
    id: 'senses',
    title: '沿墙 · Wall Follower',
    description: '给笔装上感官：先用 stone 画一段墙，再用 ahead(stone) 看正前方；碰到墙就 turn(90)，否则前进并留下金线。',
    source: `# 先用石头画一段墙
brush(stone)
over 4 as i {
  walk
  paint
}

# 回到玩家脚下，换成金色笔
home
brush(gold_block)

# ahead(stone) 读取正前方一格：有墙就转，没有就前进
over 24 as i {
  if ahead(stone) {
    turn(90)
  } else {
    walk
    paint
  }
}
stamp
`,
  },
  {
    id: 'wave',
    title: '挥手 · Wave',
    description: '一行意图：animate(@p, "wave", 20 ticks)。编译成可读的 tp:anim/tick，浏览器与 Minecraft 同时看到玩家周围的波浪粒子。',
    source: `# 先画一小段，给画面一个参照
brush(gold_block)
over 4 as i {
  walk
  paint
}

# 一行意图：在玩家周围做 20 tick 的 wave
animate(@p, "wave", 20 ticks)
wait 20
say "wave done"
`,
  },
  {
    id: 'helix3d',
    title: '3D 螺旋 · Helix 3D',
    description: 'pitch(-35) 让笔抬头（Minecraft 里负 pitch 向上），walk 沿视线方向前进：12 步边走边转，画出向上螺旋的三维螺旋。浏览器与 Minecraft 里形状一致。',
    source: `brush(emerald_block)
pitch(-35)
over 12 as i {
  walk
  paint
  turn(30)
}
stamp
`,
  },
  {
    id: 'metronome',
    title: '节拍器 · Metronome',
    description: '每 20 tick 响一声、闪一次；按 press 让笔掉头。浏览器里会听到短促的节拍。',
    source: `# tick 块每 tick 都执行，不消耗时间
state n = 0
brush(emerald_block)

tick {
  n = n + 1
  if now % 20 == 0 {
    stamp
    sound(block.note_block.hat, 1.0)
  }
}

over 64 as i {
  walk
  if i % 4 == 0 {
    turn(90)
  }
  paint
}

when press {
  turn(180)
}
`,
  },
  {
    id: 'hello',
    title: '你好 · Hello',
    description: '最小程序：说一句话，等 5 个 tick，再说一句。',
    source: `say "hello, tickpack"
wait 5
say "five ticks later"
`,
  },
];

export const DEFAULT_SAMPLE = 'square';

export function sampleById(id) {
  return SAMPLES.find((s) => s.id === id) || SAMPLES[0];
}
