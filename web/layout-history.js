// Bounded in-memory layout undo stack. Snapshots are cloned by the caller.
export function createUndoStack(limit = 50) {
  const entries = [];
  return {
    push(state, label) {
      entries.push({ state, label: label || '布局操作' });
      while (entries.length > limit) entries.shift();
    },
    pop() { return entries.pop() || null; },
    clear() { entries.length = 0; },
    get size() { return entries.length; },
    get canUndo() { return entries.length > 0; },
    labels() { return entries.map((entry) => entry.label); },
  };
}
