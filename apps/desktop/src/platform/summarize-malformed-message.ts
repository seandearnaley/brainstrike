/** Longest content-derived string this summary will repeat into a log. */
const MAX_SUMMARY_STRING_LENGTH = 64;
/** Most keys this summary will name; the full count is always reported. */
const MAX_SUMMARY_KEYS = 20;

/**
 * Bounds one host-controlled string before it reaches a log, counting code points so a surrogate
 * pair is never split into a lone half. Walks at most 65 code points, so a multi-megabyte string
 * costs no more than a short one.
 */
export function truncateForLog(value: string): string {
  // A string's UTF-16 length is never less than its code-point count.
  if (value.length <= MAX_SUMMARY_STRING_LENGTH) {
    return value;
  }
  let kept = '';
  let count = 0;
  for (const codePoint of value) {
    if (count === MAX_SUMMARY_STRING_LENGTH) {
      return `${kept}…`;
    }
    kept += codePoint;
    count += 1;
  }
  return value;
}

/**
 * Describe an unusable host message without logging it. Host traffic carries
 * user content (parser source text and ASTs, DB query results), so the raw
 * payload must never reach the log: only its shape does.
 *
 * Every field here is bounded, because a malformed frame's *shape* is
 * content-controlled too: a mis-serialized response can put source text in a
 * key or in `type`, and a record keyed by identifier or path has as many keys
 * as the payload has content. Counts are exact; the strings behind them are
 * truncated.
 */
export function summarizeMalformedMessage(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return { messageType: value === null ? 'null' : typeof value };
  }
  if (Array.isArray(value)) {
    // Keys of a large array would be as unbounded as the payload itself.
    return { length: value.length, messageType: 'array' };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return {
    keyCount: keys.length,
    keys: keys.slice(0, MAX_SUMMARY_KEYS).map(truncateForLog),
    messageType: 'object',
    // A top-level string `type` is echoed, bounded to 64 characters, for ANY host: it names the frame
    // kind for the parser host. DB host frames use `kind`, so a well-formed one has no `type`, but a
    // malformed one that carries a string `type` has that value echoed, bounded.
    ...(typeof record['type'] === 'string' ? { type: truncateForLog(record['type']) } : {}),
  };
}
