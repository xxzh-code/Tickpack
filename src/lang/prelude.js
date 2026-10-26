// Tickpack standard library (docs/LANG.md §4).
//
// The compiler prepends this text to every user program, so all of it is in the
// normal `.tp` language. Zero-parameter functions become real functions in the
// pack (`tp:fn/<name>`); parameterised ones are compile-time macros and are
// inlined at each call site.
//
// Keep this file faithful to LANG.md §4. Extending it is allowed when samples
// need more turtle API; changing the existing functions is not.

export const PRELUDE = `# Tickpack standard library — the turtle API (docs/LANG.md §4).
# The compiler prepends this file to your program; these names may not be redefined.

fn walk() {
  # move the pen one block forward (local +Z of the pen)
  run execute as @e[tag=pen] at @s run tp @s ^ ^ ^1
}

fn walk2() {
  # move the pen two blocks forward
  run execute as @e[tag=pen] at @s run tp @s ^ ^ ^2
}

fn turn(deg) {
  # rotate the pen's yaw by deg degrees; deg is a compile-time constant
  run execute as @e[tag=pen] at @s run tp @s ~ ~ ~ ~$deg ~
}

fn plot(block) {
  # place a block at the pen's block position; block is a bare block id
  run execute at @e[tag=pen] run setblock ~ ~ ~ $block
}

fn plot_under(block) {
  # place a block one block below the pen
  run execute at @e[tag=pen] run setblock ~ ~-1 ~ $block
}

fn stamp() {
  # a little visual sparkle at the pen
  run execute at @e[tag=pen] run particle happy_villager ~ ~ ~ 0 0 0 0 1
}

fn clear_ground() {
  # wipe the visible 33x33 ground plane back to air
  run fill -16 0 -16 16 0 16 air
}

fn home() {
  # send the pen back to the origin, facing +Z
  run tp @e[tag=pen] 0.5 0 0.5 0 0
}
`;
