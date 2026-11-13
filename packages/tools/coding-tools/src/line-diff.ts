const MAX_EXACT_EDIT_DISTANCE = 512;

export type DiffOperation =
  | { readonly type: "equal"; readonly line: string }
  | { readonly type: "add"; readonly line: string }
  | { readonly type: "delete"; readonly line: string };

export function diffLines(before: readonly string[], after: readonly string[]): DiffOperation[] {
  const exact = myersDiff(before, after);
  if (exact !== undefined) return exact;

  // Bound worst-case time and memory while still preserving separated edits:
  // patience anchors divide large changes into independently diffable blocks.
  return patienceDiff(before, after);
}

function patienceDiff(before: readonly string[], after: readonly string[]): DiffOperation[] {
  const output: DiffOperation[] = [];
  diffPatienceRange(before, 0, before.length, after, 0, after.length, output);
  return output;
}

function diffPatienceRange(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
  output: DiffOperation[],
): void {
  while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeStart] === after[afterStart]) {
    output.push({ type: "equal", line: before[beforeStart]! });
    beforeStart += 1;
    afterStart += 1;
  }
  let suffix = 0;
  while (
    beforeStart < beforeEnd - suffix &&
    afterStart < afterEnd - suffix &&
    before[beforeEnd - suffix - 1] === after[afterEnd - suffix - 1]
  )
    suffix += 1;
  const middleBeforeEnd = beforeEnd - suffix;
  const middleAfterEnd = afterEnd - suffix;

  if (beforeStart === middleBeforeEnd) {
    for (let index = afterStart; index < middleAfterEnd; index++) {
      output.push({ type: "add", line: after[index]! });
    }
  } else if (afterStart === middleAfterEnd) {
    for (let index = beforeStart; index < middleBeforeEnd; index++) {
      output.push({ type: "delete", line: before[index]! });
    }
  } else {
    const exact = myersDiff(before.slice(beforeStart, middleBeforeEnd), after.slice(afterStart, middleAfterEnd));
    if (exact !== undefined) {
      output.push(...exact);
    } else {
      const anchors = patienceAnchors(before, beforeStart, middleBeforeEnd, after, afterStart, middleAfterEnd);
      if (anchors.length === 0) {
        for (let index = beforeStart; index < middleBeforeEnd; index++) {
          output.push({ type: "delete", line: before[index]! });
        }
        for (let index = afterStart; index < middleAfterEnd; index++) {
          output.push({ type: "add", line: after[index]! });
        }
      } else {
        let previousBefore = beforeStart;
        let previousAfter = afterStart;
        for (const anchor of anchors) {
          diffPatienceRange(before, previousBefore, anchor.before, after, previousAfter, anchor.after, output);
          output.push({ type: "equal", line: before[anchor.before]! });
          previousBefore = anchor.before + 1;
          previousAfter = anchor.after + 1;
        }
        diffPatienceRange(before, previousBefore, middleBeforeEnd, after, previousAfter, middleAfterEnd, output);
      }
    }
  }
  for (let offset = suffix; offset > 0; offset--) {
    output.push({ type: "equal", line: before[beforeEnd - offset]! });
  }
}

interface PatienceAnchor {
  readonly before: number;
  readonly after: number;
}

function patienceAnchors(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
): PatienceAnchor[] {
  const beforeLines = uniqueLinePositions(before, beforeStart, beforeEnd);
  const afterLines = uniqueLinePositions(after, afterStart, afterEnd);
  const candidates: PatienceAnchor[] = [];
  for (const [line, position] of beforeLines) {
    if (position.count !== 1) continue;
    const matching = afterLines.get(line);
    if (matching?.count === 1) {
      candidates.push({ before: position.index, after: matching.index });
    }
  }
  candidates.sort((left, right) => left.before - right.before);
  if (candidates.length < 2) return candidates;

  const tails: number[] = [];
  const tailIndices: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (const [index, candidate] of candidates.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle]! < candidate.after) low = middle + 1;
      else high = middle;
    }
    tails[low] = candidate.after;
    previous[index] = low === 0 ? -1 : tailIndices[low - 1]!;
    tailIndices[low] = index;
  }
  const anchors: PatienceAnchor[] = [];
  let index = tailIndices[tails.length - 1]!;
  while (index >= 0) {
    anchors.push(candidates[index]!);
    index = previous[index]!;
  }
  return anchors.reverse();
}

function uniqueLinePositions(
  lines: readonly string[],
  start: number,
  end: number,
): Map<string, { count: number; index: number }> {
  const positions = new Map<string, { count: number; index: number }>();
  for (let index = start; index < end; index++) {
    const line = lines[index]!;
    const current = positions.get(line);
    positions.set(line, {
      count: (current?.count ?? 0) + 1,
      index: current?.index ?? index,
    });
  }
  return positions;
}

function myersDiff(before: readonly string[], after: readonly string[]): DiffOperation[] | undefined {
  const maximum = before.length + after.length;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let distance = 0; distance <= Math.min(maximum, MAX_EXACT_EDIT_DISTANCE); distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const fromDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      const fromAdd = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      let x =
        diagonal === -distance || (diagonal !== distance && fromDelete < fromAdd)
          ? Math.max(0, fromAdd)
          : Math.max(0, fromDelete + 1);
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        return backtrackMyers(before, after, trace, distance);
      }
    }
  }
  return undefined;
}

function backtrackMyers(
  before: readonly string[],
  after: readonly string[],
  trace: readonly Map<number, number>[],
  finalDistance: number,
): DiffOperation[] {
  let x = before.length;
  let y = after.length;
  const reversed: DiffOperation[] = [];
  for (let distance = finalDistance; distance >= 0; distance--) {
    const frontier = trace[distance]!;
    const diagonal = x - y;
    const fromDelete = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const fromAdd = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal =
      diagonal === -distance || (diagonal !== distance && fromDelete < fromAdd) ? diagonal + 1 : diagonal - 1;
    const previousX = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      reversed.push({ type: "equal", line: before[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      reversed.push({ type: "add", line: after[y - 1]! });
      y -= 1;
    } else {
      reversed.push({ type: "delete", line: before[x - 1]! });
      x -= 1;
    }
  }
  return reversed.reverse();
}
