// Ready-made programs shown in the browser app. Each sample must compile with the
// current language and is also used by tests / screenshots.
// Keep `source` user-facing: prelude (walk/turn/plot/...) is implicit.
export const SAMPLES = [
  {
    id: 'square',
    title: '正方形 · Square',
    description: '嵌套的时间循环：外层 4 条边，内层每条边 8 步，每步消耗 1 tick。',
    source: `# 一个 over 循环就是一个 tick 计数器
over 4 as side {
  over 8 as step {
    walk
    plot(stone)
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

over 120 as i {
  walk
  plot(gold_block)
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
    id: 'petals',
    title: '黄金角花瓣 · Petals',
    description: '每 tick 走一格、转 137°。90 个 tick 能开出什么？',
    source: `# 黄金角 137°：每走一步转一次
over 90 as i {
  walk
  plot(lapis_block)
  turn(137)
}
stamp
`,
  },
  {
    id: 'metronome',
    title: '节拍器 · Metronome',
    description: 'tick 块每 tick 都跑，now 是已经过的 tick 数；按 press 让笔掉头。',
    source: `# tick 块每 tick 都执行，不消耗时间
state n = 0

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
  plot(emerald_block)
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
