type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drops keys whose value is `undefined`. Needed because `exactOptionalPropertyTypes`
 * forbids handing Prisma a `where` object with explicitly-undefined properties,
 * which is exactly what optional Zod query filters produce.
 */
export function compact<T extends object>(input: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Defined<T>;
}
