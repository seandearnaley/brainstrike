/**
 * Whether a canvas document carries anything the user can read or see.
 *
 * ONE definition, consumed by `manage-canvas-tool.ts` to refuse an empty
 * `create`. It exists because of live-app verifier runs 6 and 7 (2026-09-15):
 * the root created a titled shell "ready to receive the report" 25 s into the
 * turn and wrote the report behind a SECOND approval. The rule is deliberately
 * narrow — literally empty documents — because a predicate that tried to tell
 * a stub report from a short one would be guessing; the tool description and
 * the default instructions carry the placeholder case.
 *
 * Content-bearing elements count as content even with no text: an SVG chart
 * or a script that draws into a canvas is exactly what the Canvas surface is
 * for. The head block is removed first so a `<title>` never counts as text.
 */
const HEAD_BLOCK = /<head\b[\s\S]*?<\/head>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<[^>]*>/g;
const WHITESPACE_ENTITY = /&(?:nbsp|ensp|emsp|thinsp|#160|#xa0);/gi;
// No `g` flag: `.test` on a global regex is stateful across calls.
const CONTENT_BEARING_ELEMENT = /<(?:img|svg|canvas|video|audio|iframe|object|embed|script)\b/i;

export function isEmptyCanvasDocument(html: string): boolean {
  const body = html.replace(HEAD_BLOCK, '').replace(HTML_COMMENT, '');
  if (CONTENT_BEARING_ELEMENT.test(body)) {
    return false;
  }
  const text = body.replace(HTML_TAG, '').replace(WHITESPACE_ENTITY, ' ');
  return text.trim().length === 0;
}
