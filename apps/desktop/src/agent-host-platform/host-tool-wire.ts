/**
 * Wire shapes of the narrow Main reads and window-bound calls the agent host's
 * own tools make (`desktop-read/*`, `platform/browser/*`).
 * Shared by Main's handlers and the host's clients; imports nothing Main-only.
 * Optional fields are exact (`exactOptional`), matching the store types under
 * `exactOptionalPropertyTypes`.
 */
import {
  type BrowserClickInput,
  type BrowserGetPageTextInput,
  type BrowserNavigateInput,
  type BrowserReadPageInput,
  type BrowserSelectOptionInput,
  type BrowserTypeInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));

const BrowserFailure = Schema.Struct({
  error: Schema.Literals([
    'blocked_action',
    'blocked_destination',
    'blocked_url',
    'browser_unavailable',
    'driver_failed',
    'element_not_actionable',
    'load_failed',
    'load_timeout',
    'navigate_failed',
    'not_agent_page',
    'origin_not_approved',
    'stale_ref',
  ]),
  hint: Schema.String,
  ok: Schema.Literal(false),
});
function browserResult<T extends Schema.Struct.Fields>(shape: T) {
  return Schema.Union([Schema.Struct({ ok: Schema.Literal(true), ...shape }), BrowserFailure], {
    mode: 'oneOf',
  });
}

export const BrowserNavigateResultSchema = browserResult({
  title: Schema.String,
  url: Schema.String,
});
export const BrowserReadPageResultSchema = browserResult({
  tree: Schema.String,
  truncated: Schema.Boolean,
});
export const BrowserPageTextResultSchema = browserResult({
  text: Schema.String,
  truncated: Schema.Boolean,
});
/** A click or typed input: where the page is once it settled (BST-2324). */
export const BrowserActionResultSchema = browserResult({
  title: Schema.String,
  url: Schema.String,
});
export const BrowserSelectOptionResultSchema = browserResult({
  selected: Schema.Array(Schema.String),
  title: Schema.String,
  url: Schema.String,
});

/**
 * Main re-parses the tool input with the catalog schema the host parsed it
 * with — so a hallucinated parameter is refused on this side of the window
 * boundary too, not only in the host.
 *
 * The envelope is first-party Effect Schema. The catalog's registered input
 * owns provider normalization and validation, so read it through that boundary.
 */
const BrowserRequestEnvelopeSchema = Schema.Struct({ input: Schema.MutableJson, threadId: Id });

function browserRequestParser<Input>(toolId: keyof typeof NATIVE_TOOL_INPUT_SCHEMAS) {
  return (value: unknown): { readonly input: Input; readonly threadId: string } => {
    const envelope = wireDecoder(BrowserRequestEnvelopeSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(value);
    const parsed = validateToolInputValue(NATIVE_TOOL_INPUT_SCHEMAS[toolId], envelope.input);
    if (!parsed.success) {
      throw new Error(
        `invalid ${toolId} input — ${parsed.issues
          .map(
            (issue) =>
              `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`
          )
          .join('; ')}`
      );
    }
    // Sound: the value was just decoded by the catalog schema this `Input` is
    // the authored type of.
    return { input: parsed.value as Input, threadId: envelope.threadId };
  };
}

export const parseBrowserNavigateRequest = browserRequestParser<BrowserNavigateInput>(
  NATIVE_TOOL_ID.browserNavigate
);
export const parseBrowserReadPageRequest = browserRequestParser<BrowserReadPageInput>(
  NATIVE_TOOL_ID.browserReadPage
);
export const parseBrowserPageTextRequest = browserRequestParser<BrowserGetPageTextInput>(
  NATIVE_TOOL_ID.browserGetPageText
);
export const parseBrowserClickRequest = browserRequestParser<BrowserClickInput>(
  NATIVE_TOOL_ID.browserClick
);
export const parseBrowserTypeRequest = browserRequestParser<BrowserTypeInput>(
  NATIVE_TOOL_ID.browserType
);
export const parseBrowserSelectOptionRequest = browserRequestParser<BrowserSelectOptionInput>(
  NATIVE_TOOL_ID.browserSelectOption
);

const Severity = Schema.Literals(['warn', 'error', 'fatal']);

export const DiagnosticsReadRequestSchema = Schema.Struct({
  filter: Schema.Struct({
    fingerprint: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1))),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200))
    ),
    runId: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1))),
    severity: Schema.optionalKey(Severity),
    sinceMs: Schema.optionalKey(Schema.Finite),
    threadId: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1))),
    untilMs: Schema.optionalKey(Schema.Finite),
  }),
  threadId: Id,
});

export const DiagnosticEventItemsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      causeChainJson: Schema.NullOr(Schema.String),
      causeChainTruncated: Schema.Boolean,
      code: Schema.NullOr(Schema.String),
      contextJson: Schema.NullOr(Schema.String),
      contextTruncated: Schema.Boolean,
      fingerprint: Schema.String,
      id: Schema.String,
      message: Schema.String,
      messageTruncated: Schema.Boolean,
      occurredAt: Schema.Finite,
      resourceId: Schema.NullOr(Schema.String),
      rootId: Schema.NullOr(Schema.String),
      runId: Schema.NullOr(Schema.String),
      scope: Schema.NullOr(Schema.String),
      sessionId: Schema.String,
      severity: Severity,
      source: Schema.String,
      stack: Schema.NullOr(Schema.String),
      stackTruncated: Schema.Boolean,
      threadId: Schema.NullOr(Schema.String),
    })
  )
);

export const DiagnosticFingerprintItemsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      code: Schema.NullOr(Schema.String),
      count: Schema.Finite,
      fingerprint: Schema.String,
      firstSeenMs: Schema.Finite,
      lastSeenMs: Schema.Finite,
      latestMessage: Schema.String,
      latestMessageTruncated: Schema.Boolean,
      severity: Severity,
      source: Schema.String,
    })
  )
);
