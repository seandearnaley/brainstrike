/** Title seeded on a thread before anyone has named it. */
export const DEFAULT_THREAD_TITLE = 'New Thread';

/**
 * Storage ceiling for a single canvas document, in UTF-8 BYTES.
 *
 * It lives in this shared contract rather than beside the schema because two
 * places enforce it and they are in different packages: the `manageCanvas`
 * input schema bounds each incoming FIELD, and the host's canvas store bounds
 * the COMPOSED result of an update — which is the only path that can produce a
 * document larger than any field it was given. One constant, so the two cannot
 * drift.
 */
export const CANVAS_HTML_MAX_BYTES = 8_000_000;

const CANVAS_HTML_ENCODER = new TextEncoder();

/**
 * Whether `value` fits the canvas storage ceiling, in UTF-8 bytes.
 *
 * A PREDICATE rather than a byte count, because every caller only ever compares
 * against the ceiling — and returning a count forces the measurement that the
 * bounds below usually make unnecessary.
 *
 * Both bounds follow from UTF-8/UTF-16 arithmetic and decide most inputs
 * without touching the encoder:
 *   - UTF-8 length >= UTF-16 length, so more units than the ceiling is over it.
 *   - UTF-8 length <= 3x UTF-16 length (a BMP unit is at most 3 bytes; a
 *     surrogate PAIR is 2 units and 4 bytes, which is under that ratio), so
 *     three times the units fitting means the bytes fit.
 * Only the band between those needs a real encode. That matters here because
 * this runs TWICE per tool call — `ManageCanvasInputSchema`'s superRefine
 * re-parses through `ManageCanvasActionInputSchema` — and because Zod 4 runs
 * checks non-abortively, so a payload that already failed `.max()` still
 * reaches this. Materialising a ~32 MB `Uint8Array` on the hostile path, twice,
 * is the thing worth avoiding.
 *
 * `TextEncoder`, not Node's `Buffer`: this package is a shared contract that
 * ships to the renderer and the hosted web bundle, where `Buffer` is not a
 * global and would be a ReferenceError the first time a canvas payload is
 * parsed. The encoder is hoisted rather than constructed per call.
 */
export function canvasHtmlWithinByteCeiling(value: string): boolean {
  if (value.length > CANVAS_HTML_MAX_BYTES) {
    return false;
  }
  if (value.length * 3 <= CANVAS_HTML_MAX_BYTES) {
    return true;
  }
  return CANVAS_HTML_ENCODER.encode(value).length <= CANVAS_HTML_MAX_BYTES;
}
