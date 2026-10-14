/**
 * Real feature-extraction pipelines carry their tokenizer, which the worker uses to
 * bound each batch. Pipeline stand-ins without one count whitespace words instead.
 */
export function attachStandInTokenizer<T>(extractor: T): T {
  if (
    (typeof extractor === 'function' || (typeof extractor === 'object' && extractor !== null)) &&
    !('tokenizer' in extractor)
  ) {
    Object.assign(extractor, {
      tokenizer: (text: string) => ({
        input_ids: { dims: [1, text.split(/\s+/).filter(Boolean).length + 2] },
      }),
    });
  }
  return extractor;
}
