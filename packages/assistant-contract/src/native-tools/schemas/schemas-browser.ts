/**
 * Input schemas for the embedded-browser-pane agent tools (BST-1176 PR2,
 * BST-2324).
 *
 * Seeing set: navigate the pane, read the live page as an accessibility tree
 * ([ref=eN] handles), or as plain text. Acting set: click, type into and pick
 * options of an element by its ref, shaped like Playwright MCP's
 * `browser_click` / `browser_type` / `browser_select_option`. Desktop-only —
 * the pane exists only where a `WebContentsView` host runs. Flat strict
 * objects: there is no action union here, so an unknown key is a hallucinated
 * parameter and fails with an actionable one-line error.
 *
 * Authored in Effect Schema: ADR-0004 (amended 2026-10-15) makes Effect the
 * single boundary owner, and `effectToolInputSchema` derives the provider JSON
 * Schema from these declarations.
 */
import { Effect, Schema } from 'effect';

/**
 * A defaulted optional property, the way zod's `.default()` behaved here.
 *
 * zod bundled two separate facts into one call, and BOTH are load-bearing:
 *
 * - the model is TOLD the fallback (`default:` in the emitted JSON Schema), and
 * - the host FILLS it when the key is absent, because `runBrowserReadPage`
 *   hands `filter`/`maxChars` straight to the driver, where
 *   `accessibility-snapshot` types them as required. An unfilled `maxChars`
 *   would make its `used + cost > options.maxChars` budget check compare
 *   against `undefined` — always false, so the cap would silently vanish.
 *
 * Effect spells those separately (`.annotate({ default })` is the advertised
 * one, `withDecodingDefaultKey` the applied one), so this takes the literal
 * ONCE and derives both. Two spellings of one durable fact could otherwise
 * drift into advertising a fallback the decoder does not apply.
 *
 * `withDecodingDefaultKey` — not `withDecodingDefault` — is the key-level
 * variant: it fills on an ABSENT key only, which is what zod did. The
 * value-level twin also treats an explicit `undefined` as absent and emits an
 * `anyOf: [T, null]` property, which would change the advertised schema.
 */
function withDefault<Value>(schema: Schema.Codec<Value, Value>, value: Value) {
  return schema
    .annotate({ default: value })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
}

/**
 * Matches the UI URL bar: schemes are gated main-side by `isNavigableUrl`.
 * The bare-host/search normalization lives in the TOOL description — not
 * repeated here (provider serializes both; prompt tokens are budgeted).
 */
export const BrowserNavigateInputSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxLength(4096)).annotate({
    description: 'URL to open',
  }),
});

export type BrowserNavigateInput = typeof BrowserNavigateInputSchema.Type;

export const BrowserReadPageInputSchema = Schema.Struct({
  filter: withDefault(
    Schema.Literals(['interactive', 'all']).annotate({
      description: "'interactive' returns only actionable elements; 'all' the full tree",
    }),
    'interactive'
  ),
  maxChars: withDefault(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(500),
      Schema.isLessThanOrEqualTo(30_000)
    ).annotate({ description: 'Maximum characters of tree text to return' }),
    6000
  ),
});

export type BrowserReadPageInput = typeof BrowserReadPageInputSchema.Type;

export const BrowserGetPageTextInputSchema = Schema.Struct({
  maxChars: withDefault(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(100),
      Schema.isLessThanOrEqualTo(30_000)
    ).annotate({ description: 'Maximum characters to return' }),
    6000
  ),
});

export type BrowserGetPageTextInput = typeof BrowserGetPageTextInputSchema.Type;

/**
 * The two fields every acting tool takes, as Playwright MCP names them: the
 * person reads `element` on the approval card; `ref` is the handle from the
 * last `browserReadPage`.
 */
const actionTarget = {
  element: Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxLength(200)).annotate({
    description: 'Short element description the user approves',
  }),
  ref: Schema.String.annotate({ description: '[ref=eN] from your last browserReadPage' }),
};

export const BrowserClickInputSchema = Schema.Struct(actionTarget);

export type BrowserClickInput = typeof BrowserClickInputSchema.Type;

export const BrowserTypeInputSchema = Schema.Struct({
  ...actionTarget,
  submit: withDefault(Schema.Boolean.annotate({ description: 'Press Enter after typing' }), false),
  text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({
    description: "Text that replaces the field's value",
  }),
});

export type BrowserTypeInput = typeof BrowserTypeInputSchema.Type;

export const BrowserSelectOptionInputSchema = Schema.Struct({
  ...actionTarget,
  values: Schema.Array(Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxLength(500)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(50))
    .annotate({ description: 'Option values or labels to select' }),
});

export type BrowserSelectOptionInput = typeof BrowserSelectOptionInputSchema.Type;
