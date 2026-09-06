/**
 * PURE `parseArgs` builders for contract channels (BST-1648). They run in
 * MAIN before a handler sees renderer input and THROW on malformed input —
 * never coerce. Kept free of `electron`/`node:*`/package imports so contract
 * modules that use them stay bundleable into the sandboxed preloads.
 */

function assertStringArg(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

/** A single string positional argument (`[text]`). */
export function parseSingleString(message: string): (raw: readonly unknown[]) => [string] {
  return (raw) => [assertStringArg(raw[0], message)];
}
