export function assertTextContentHasNoNullBytes(
  content: string | null | undefined,
  label: string
): void {
  if (typeof content === 'string' && content.includes('\0')) {
    throw new Error(`${label} cannot contain null bytes.`);
  }
}

export function assertTextContentsHaveNoNullBytes<T>(
  entries: readonly T[],
  getContent: (entry: T) => string | null | undefined,
  label: string
): void {
  for (const entry of entries) {
    assertTextContentHasNoNullBytes(getContent(entry), label);
  }
}
