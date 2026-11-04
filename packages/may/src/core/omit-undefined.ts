type DefinedKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
type OptionalKeys<T> = Exclude<keyof T, DefinedKeys<T>>;
type Flatten<T> = { [K in keyof T]: T[K] };

/** Keys whose value may be undefined become optional keys without an undefined value. */
export type OmitUndefined<T> = Flatten<
  { [K in DefinedKeys<T>]: T[K] } & { [K in OptionalKeys<T>]?: Exclude<T[K], undefined> }
>;

/** Copy own enumerable fields whose value is not undefined. */
export function omitUndefined<const T extends object>(value: T): OmitUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = item;
  return result as OmitUndefined<T>;
}
