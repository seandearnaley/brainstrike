/**
 * Strips the inline reference metadata some providers leak into visible answer
 * text.
 *
 * OpenAI models that ran the native web-search tool wrap citation bookkeeping in
 * Unicode Private Use Area codepoints and emit it INSIDE the assistant's text
 * stream, so it arrives as ordinary characters in a `text` message part:
 *
 *   U+E200 <type> U+E202 <payload> U+E201   e.g. `\u{E200}cite\u{E202}turn0search0\u{E201}`
 *   U+E203 <hidden content> U+E204          content ChatGPT renders invisibly
 *
 * The delimiters themselves are invisible, so an unstripped marker surfaces as
 * bare `citeturn0search0` in the middle of a sentence.
 *
 * WHY THIS IS A STRIP AND NOT A CITATION LINK: the payload (`turn0search0`) is an
 * index into ChatGPT's own turn/search bookkeeping. Nothing in the API maps it to
 * a URL — the web-search tool result carries an ORDERED `sources` array with no
 * ids, and the authoritative citation channel is a separate `url_citation`
 * annotation (surfaced by the AI SDK as `source` parts, which
 * `MASTRA_STATIC_CHUNK_DISPOSITIONS` currently drops). Zipping marker index N to
 * `sources[N]` would be a guess, and a wrong source link is worse than no link.
 * Rendering real citations is a separate feature that starts by keeping those
 * `source` parts, not by parsing these markers.
 *
 * Keyed on the codepoints alone, so it is provider-agnostic by construction:
 * Anthropic and Gemini report citations as structured metadata rather than
 * inline markers, but an OpenRouter route to an OpenAI model carries the same
 * bytes, and no per-provider branch is needed to catch it.
 */

/**
 * A complete reference span. The negated class deliberately excludes both
 * delimiters so an unterminated START cannot swallow a later, well-formed span.
 */
const REFERENCE_SPAN = /\u{E200}[^\u{E200}\u{E201}]*\u{E201}/gu;

/** A complete visually-hidden span. */
const HIDDEN_SPAN = /\u{E203}[^\u{E203}\u{E204}]*\u{E204}/gu;

/**
 * An opening delimiter with no matching close, once every complete span is gone.
 * Everything after it is the marker's own payload — either the closing delimiter
 * has not streamed in yet, or the message was truncated mid-marker — so the end
 * of the string is the only correct boundary.
 */
const UNTERMINATED_SPAN = /[\u{E200}\u{E203}][\s\S]*$/u;

/**
 * Delimiters left with no span to belong to (a message whose stored text begins
 * part-way through a marker). These codepoints carry no prose meaning, so
 * dropping the character while keeping the surrounding text is the honest floor.
 */
const ORPHAN_DELIMITER = /[\u{E200}-\u{E204}]/gu;

/** Cheap gate for the marker-free majority: no delimiter, no work, no copy. */
const ANY_DELIMITER = /[\u{E200}-\u{E204}]/u;

/**
 * Remove provider citation/hidden-content markers from `text`, returning the
 * input unchanged (same reference) when it contains none.
 *
 * Runs on the FULL accumulated message text, not per streamed delta, so a marker
 * split across chunks is still matched as one span.
 */
export function stripProviderCitationMarkers(text: string): string {
  if (!ANY_DELIMITER.test(text)) {
    return text;
  }

  return text
    .replace(REFERENCE_SPAN, '')
    .replace(HIDDEN_SPAN, '')
    .replace(UNTERMINATED_SPAN, '')
    .replace(ORPHAN_DELIMITER, '');
}
