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
 * for. The leading head region is removed first so a `<title>` never counts as
 * text (see `stripLeadingHead` for where that region ends).
 */

/**
 * One token the HTML parser keeps in the document head, matched at the scan
 * position (sticky). `<head>` and `</head>` are both optional in HTML5, so the
 * head cannot be found by pairing tags: it ends at `</head>` or at the first
 * token that is not head content, as the parser's "in head" insertion mode
 * ends it.
 */
const HEAD_TOKEN =
  /\s+|<!--[\s\S]*?-->|<!doctype\b[^>]*>|<\/?html\b[^>]*>|<(?<headTag>\/?head)\b[^>]*>|<(?:base|link|meta)\b[^>]*>|<(?<rawText>title|style|script|noscript|template)\b[^>]*>[\s\S]*?<\/\k<rawText>\s*>/iy;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<[^>]*>/g;
const WHITESPACE_ENTITY = /&(?:nbsp|ensp|emsp|thinsp|#160|#xa0);/gi;
// No `g` flag: `.test` on a global regex is stateful across calls.
const CONTENT_BEARING_ELEMENT = /<(?:img|svg|canvas|video|audio|iframe|object|embed|script)\b/i;
const BODY_CONTENT_OUTSIDE_EXPLICIT_HEAD = new Set(['script', 'template', 'noscript']);

function stripLeadingHead(html: string): string {
  HEAD_TOKEN.lastIndex = 0;
  let headEnd = 0;
  let explicitHead = false;
  for (let token = HEAD_TOKEN.exec(html); token; token = HEAD_TOKEN.exec(html)) {
    const { headTag, rawText } = token.groups ?? {};
    // Outside an explicit `<head>`, script/template/noscript are treated as
    // body content. A deliberate bias toward content: a leading script is how
    // a canvas draws itself. `style` stays head: a style-only document is empty.
    if (
      !explicitHead &&
      rawText !== undefined &&
      BODY_CONTENT_OUTSIDE_EXPLICIT_HEAD.has(rawText.toLowerCase())
    ) {
      break;
    }
    headEnd = HEAD_TOKEN.lastIndex;
    if (headTag?.startsWith('/')) {
      break;
    }
    explicitHead ||= headTag !== undefined;
  }
  return html.slice(headEnd);
}

export function isEmptyCanvasDocument(html: string): boolean {
  const body = stripLeadingHead(html).replace(HTML_COMMENT, '');
  if (CONTENT_BEARING_ELEMENT.test(body)) {
    return false;
  }
  const text = body.replace(HTML_TAG, '').replace(WHITESPACE_ENTITY, ' ');
  return text.trim().length === 0;
}
