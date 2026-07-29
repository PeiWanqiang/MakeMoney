import type { StrategySourceDiff } from "./types.js";

export function diffStrategySource(previous: string | undefined, current: string): StrategySourceDiff {
  if (previous === undefined) return { added: current.split("\n"), removed: [] };
  const before = previous.split("\n");
  const after = current.split("\n");
  const width = after.length + 1;
  const matrix = new Uint32Array((before.length + 1) * width);

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      matrix[index] = before[left] === after[right]
        ? 1 + (matrix[(left + 1) * width + right + 1] ?? 0)
        : Math.max(matrix[(left + 1) * width + right] ?? 0, matrix[left * width + right + 1] ?? 0);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      left += 1;
      right += 1;
    } else if ((matrix[(left + 1) * width + right] ?? 0) >= (matrix[left * width + right + 1] ?? 0)) {
      removed.push(before[left] ?? "");
      left += 1;
    } else {
      added.push(after[right] ?? "");
      right += 1;
    }
  }
  removed.push(...before.slice(left));
  added.push(...after.slice(right));
  return { added, removed };
}
