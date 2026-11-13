import type { Change } from "diff";

export interface TextAnchor {
  readonly sourceId: string;
  readonly offset: number;
}

export function changedOffset(changes: readonly Change[], offset: number, affinity: "left" | "right"): number {
  let previous = 0;
  let current = 0;
  for (const change of changes) {
    if (change.added) {
      if (previous === offset && affinity === "left") return current;
      current += change.value.length;
      continue;
    }
    const end = previous + change.value.length;
    if (offset < end || (offset === end && affinity === "left")) {
      return current + (change.removed ? 0 : offset - previous);
    }
    previous = end;
    if (!change.removed) current += change.value.length;
  }
  return current;
}
