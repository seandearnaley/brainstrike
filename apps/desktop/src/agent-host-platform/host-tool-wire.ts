/**
 * Wire shapes of the narrow Main reads and window-bound calls the agent host's
 * own tools make (`desktop-read/*`, `platform/worktree/*`, `platform/shell/*`).
 * Shared by Main's handlers and the host's clients; imports nothing Main-only.
 * Optional fields are exact (`exactOptional`), matching the store types under
 * `exactOptionalPropertyTypes`.
 */
import {
  type BrowserGetPageTextInput,
  type BrowserNavigateInput,
  type BrowserReadPageInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));

export const PlatformShellCompletedSchema = Schema.Struct({
  command: Schema.String,
  precedingWorktreePaths: Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))),
  rootId: Id,
  runId: Schema.optional(Id),
  threadId: Id,
});

/** The worktrees Main's ledger adopted from the command, for the host to commit. */
export const PlatformShellCompletedResultSchema = Schema.Struct({
  adopted: Schema.mutable(
    Schema.Array(Schema.Struct({ branch: Schema.NullOr(Id), path: Id, worktreeId: Id }))
  ),
});

export const WorktreePathsResultSchema = Schema.Struct({
  paths: Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))),
});

/** `GrepSearchOptions` of the indexed grep half (`@brainstrike/db`). */
export const GrepIndexOptionsSchema = Schema.Struct({
  candidateLimit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  contextLines: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  embeddingSetId: Schema.optionalKey(Id),
  filePaths: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  isRegex: Schema.optionalKey(Schema.Boolean),
  maxResults: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  pattern: Schema.String.check(Schema.isMinCodePoints(1)),
  rootId: Schema.optionalKey(Id),
  rootIds: Schema.optionalKey(Schema.mutable(Schema.Array(Id))),
});

export const GrepIndexRequestSchema = Schema.Struct({
  options: GrepIndexOptionsSchema,
  threadId: Id,
});

/** `GrepSearchResult` of the indexed grep half (`@brainstrike/db`). */
export const GrepIndexResultSchema = Schema.Struct({
  candidatesTruncated: Schema.Boolean,
  matches: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        after: Schema.mutable(Schema.Array(Schema.String)),
        before: Schema.mutable(Schema.Array(Schema.String)),
        chunkEndLine: Schema.optionalKey(Schema.Int),
        chunkId: Schema.optionalKey(Schema.String),
        chunkStartLine: Schema.optionalKey(Schema.Int),
        line: Schema.Int,
        lineText: Schema.String,
        path: Schema.String,
        rootId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        rootName: Schema.optionalKey(Schema.NullOr(Schema.String)),
      })
    )
  ),
  scanLimited: Schema.Boolean,
  skippedMissingLineMetadata: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalMatches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
});

const GitError = Schema.Struct({ error: Schema.String, ok: Schema.Literal(false) });
function gitResult<T extends Schema.Constraint>(value: T) {
  return Schema.Union([Schema.Struct({ ok: Schema.Literal(true), value }), GitError], {
    mode: 'oneOf',
  });
}

export const WorktreeListResultSchema = gitResult(
  Schema.mutable(
    Schema.Array(
      Schema.Struct({
        branch: Schema.NullOr(Schema.String),
        detached: Schema.Boolean,
        disabledReason: Schema.NullOr(Schema.String),
        externalTool: Schema.NullOr(Schema.String),
        id: Schema.NullOr(Schema.String),
        managed: Schema.Boolean,
        name: Schema.String,
        path: Schema.String,
        primary: Schema.Boolean,
        provenance: Schema.String,
        repoCommonDir: Schema.String,
        repositoryRoot: Schema.String,
        rootId: Schema.NullOr(Schema.String),
        usable: Schema.Boolean,
      })
    )
  )
);

export const WorktreeCreateResultSchema = gitResult(
  Schema.Struct({
    setup: Schema.Struct({ reason: Schema.NullOr(Schema.String), status: Schema.String }),
    worktree: Schema.Struct({
      branch: Schema.NullOr(Schema.String),
      id: Schema.String,
      path: Schema.String,
    }),
  })
);

export const WorktreeArchiveResultSchema = gitResult(
  Schema.Struct({ snapshotRef: Schema.String, worktree: Schema.Struct({ id: Schema.String }) })
);

export const WorktreeCreateRequestSchema = Schema.Struct({
  params: Schema.Struct({
    baseRef: Schema.String.check(Schema.isMinCodePoints(1)),
    branch: Schema.String.check(Schema.isMinCodePoints(1)),
    name: Schema.String.check(Schema.isMinCodePoints(1)),
    rootId: Id,
  }),
  runId: Schema.optionalKey(Id),
  threadId: Id,
});

export const WorktreeArchiveRequestSchema = Schema.Struct({
  params: Schema.Struct({ force: Schema.optionalKey(Schema.Boolean), worktreeId: Id }),
  runId: Schema.optionalKey(Id),
  threadId: Id,
});

const BrowserFailure = Schema.Struct({
  error: Schema.Literals([
    'blocked_url',
    'browser_unavailable',
    'driver_failed',
    'load_failed',
    'load_timeout',
    'navigate_failed',
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
