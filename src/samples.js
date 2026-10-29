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
    id: 'metronome',
    title: '节拍器 · Metronome',
    description: 'tick 块每 tick 都跑，now 是已经过的 tick 数；按 press 让笔掉头。',
    source: `# tick 块每 tick 都执行，不消耗时间
state n = 0
brush(emerald_block)

tick {
  n = n + 1
  if now % 20 == 0 {
    stamp
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
