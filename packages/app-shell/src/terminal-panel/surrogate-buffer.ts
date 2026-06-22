/**
 * Surrogate-safe reassembly for the `window.terminal` data stream.
 *
 * The desktop pty backend splits a SINGLE pty output chunk across multiple
 * `terminal:data` events when it exceeds `MAX_EVENT_CHUNK_CHARS` (UTF-16 code
 * units). A split can land BETWEEN the two halves of a surrogate pair (e.g. an
 * emoji), so a chunk can end with a lone high surrogate whose matching low
 * surrogate arrives in the next event. The backend's own buffer is lossless
 * because it concatenates; but a per-chunk `xterm.write()` would render a U+FFFD
 * replacement char for the orphaned high surrogate.
 *
 * `SurrogateBuffer` defers a trailing lone high surrogate and prepends it to the
 * next chunk, so every value handed to `write()` contains only complete code
 * points. This is a no-op for the common case (no trailing high surrogate), so it
 * adds negligible overhead.
 *
 * It does NOT try to "fix" a lone LOW surrogate or other malformed input — only
 * the specific high-surrogate-at-end split the transport can introduce. Anything
 * else is passed through unchanged (no silent rewriting of the stream).
 */

/** A high surrogate is in the range U+D800–U+DBFF (the leading half of a pair). */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff;
}

export class SurrogateBuffer {
  /** A pending lone high surrogate from the previous chunk, or '' when none. */
  private pending = '';

  /**
   * Fold the next raw chunk with any deferred high surrogate. Returns the text
   * safe to write now (every code point complete); a fresh trailing lone high
   * surrogate is held back for the next call.
   */
  push(chunk: string): string {
    const combined = this.pending + chunk;
    this.pending = '';
    if (combined.length === 0) {
      return combined;
    }
    const lastCodeUnit = combined.charCodeAt(combined.length - 1);
    if (isHighSurrogate(lastCodeUnit)) {
      // Defer the trailing lone high surrogate; its low half is in the next event.
      this.pending = combined.slice(combined.length - 1);
      return combined.slice(0, combined.length - 1);
    }
    return combined;
  }

  /**
   * Drain any deferred surrogate (the stream ended without its low half — emit it
   * as-is rather than silently dropping it). Idempotent.
   */
  flush(): string {
    const remaining = this.pending;
    this.pending = '';
    return remaining;
  }
}
