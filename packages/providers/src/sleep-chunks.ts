export const MAX_TIMER_MS = 2_147_483_647;

export function nextSleepChunkMs(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.min(remainingMs, MAX_TIMER_MS);
}

export function sleepChunkSchedule(totalDelayMs: number): number[] {
  if (!Number.isFinite(totalDelayMs) || totalDelayMs <= 0) return [];
  const chunks: number[] = [];
  let remaining = totalDelayMs;
  while (remaining > 0) {
    const chunk = nextSleepChunkMs(remaining);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}
