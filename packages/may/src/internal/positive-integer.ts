export function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}
