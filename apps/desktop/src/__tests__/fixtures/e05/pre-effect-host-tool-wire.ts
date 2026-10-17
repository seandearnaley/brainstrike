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
import { z } from 'zod';

const Id = z.string().min(1);

export const PlatformShellCompletedSchema = z.strictObject({
  command: z.string(),
  precedingWorktreePaths: z.array(z.string()).nullable(),
  rootId: Id,
  runId: Id.optional(),
  threadId: Id,
});

/** The worktrees Main's ledger adopted from the command, for the host to commit. */
export const PlatformShellCompletedResultSchema = z.strictObject({
  adopted: z.array(z.strictObject({ branch: Id.nullable(), path: Id, worktreeId: Id })),
});

export const WorktreePathsResultSchema = z.strictObject({
  paths: z.array(z.string()).nullable(),
});

/** `GrepSearchOptions` of the indexed grep half (`@brainstrike/db`). */
export const GrepIndexOptionsSchema = z.strictObject({
  candidateLimit: z.number().int().positive().exactOptional(),
  caseSensitive: z.boolean().exactOptional(),
  contextLines: z.number().int().nonnegative().exactOptional(),
  embeddingSetId: Id.exactOptional(),
  filePaths: z.array(z.string()).exactOptional(),
  isRegex: z.boolean().exactOptional(),
  maxResults: z.number().int().positive().exactOptional(),
  pattern: z.string().min(1),
  rootId: Id.exactOptional(),
  rootIds: z.array(Id).exactOptional(),
});

export const GrepIndexRequestSchema = z.strictObject({
  options: GrepIndexOptionsSchema,
  threadId: Id,
});

/** `GrepSearchResult` of the indexed grep half (`@brainstrike/db`). */
export const GrepIndexResultSchema = z.strictObject({
  candidatesTruncated: z.boolean(),
  matches: z.array(
    z.strictObject({
      after: z.array(z.string()),
      before: z.array(z.string()),
      chunkEndLine: z.number().int().exactOptional(),
      chunkId: z.string().exactOptional(),
      chunkStartLine: z.number().int().exactOptional(),
      line: z.number().int(),
      lineText: z.string(),
      path: z.string(),
      rootId: z.string().nullable().exactOptional(),
      rootName: z.string().nullable().exactOptional(),
    })
  ),
  scanLimited: z.boolean(),
  skippedMissingLineMetadata: z.number().int().nonnegative(),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const GitError = z.object({ error: z.string(), ok: z.literal(false) });
function gitResult<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }), GitError]);
}

export const WorktreeListResultSchema = gitResult(
  z.array(
    z.object({
      branch: z.string().nullable(),
      detached: z.boolean(),
      disabledReason: z.string().nullable(),
      externalTool: z.string().nullable(),
      id: z.string().nullable(),
      managed: z.boolean(),
      name: z.string(),
      path: z.string(),
      primary: z.boolean(),
      provenance: z.string(),
      repoCommonDir: z.string(),
      repositoryRoot: z.string(),
      rootId: z.string().nullable(),
      usable: z.boolean(),
    })
  )
);

export const WorktreeCreateResultSchema = gitResult(
  z.object({
    setup: z.object({ reason: z.string().nullable(), status: z.string() }),
    worktree: z.object({ branch: z.string().nullable(), id: z.string(), path: z.string() }),
  })
);

export const WorktreeArchiveResultSchema = gitResult(
  z.object({ snapshotRef: z.string(), worktree: z.object({ id: z.string() }) })
);

export const WorktreeCreateRequestSchema = z.strictObject({
  params: z.strictObject({
    baseRef: z.string().min(1),
    branch: z.string().min(1),
    name: z.string().min(1),
    rootId: Id,
  }),
  runId: Id.exactOptional(),
  threadId: Id,
});

export const WorktreeArchiveRequestSchema = z.strictObject({
  params: z.strictObject({ force: z.boolean().exactOptional(), worktreeId: Id }),
  runId: Id.exactOptional(),
  threadId: Id,
});

const BrowserFailure = z.object({
  error: z.enum([
    'blocked_url',
    'browser_unavailable',
    'driver_failed',
    'load_failed',
    'load_timeout',
    'navigate_failed',
  ]),
  hint: z.string(),
  ok: z.literal(false),
});
function browserResult<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), ...shape }), BrowserFailure]);
}

export const BrowserNavigateResultSchema = browserResult({ title: z.string(), url: z.string() });
export const BrowserReadPageResultSchema = browserResult({
  tree: z.string(),
  truncated: z.boolean(),
});
export const BrowserPageTextResultSchema = browserResult({
  text: z.string(),
  truncated: z.boolean(),
});

/**
 * Main re-parses the tool input with the catalog schema the host parsed it
 * with — so a hallucinated parameter is refused on this side of the window
 * boundary too, not only in the host.
 *
 * The input CANNOT be embedded as a zod field any more. A registered catalog
 * schema is authored in Effect Schema or zod (ADR-0004, amended 2026-10-15),
 * and `z.strictObject` rejects a non-zod element at its first parse ("expected
 * a Zod schema") — lazily, so it would have thrown on the first browser tool
 * call rather than at construction. The envelope stays zod; the input goes
 * through the catalog's own producer-neutral validator.
 */
const BrowserRequestEnvelopeSchema = z.strictObject({ input: z.json(), threadId: Id });

function browserRequestParser<Input>(toolId: keyof typeof NATIVE_TOOL_INPUT_SCHEMAS) {
  return (value: unknown): { readonly input: Input; readonly threadId: string } => {
    const envelope = BrowserRequestEnvelopeSchema.parse(value);
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

const Severity = z.enum(['warn', 'error', 'fatal']);

export const DiagnosticsReadRequestSchema = z.strictObject({
  filter: z.strictObject({
    fingerprint: z.string().min(1).exactOptional(),
    limit: z.number().int().min(1).max(200).exactOptional(),
    runId: z.string().min(1).exactOptional(),
    severity: Severity.exactOptional(),
    sinceMs: z.number().exactOptional(),
    threadId: z.string().min(1).exactOptional(),
    untilMs: z.number().exactOptional(),
  }),
  threadId: Id,
});

export const DiagnosticEventItemsSchema = z.array(
  z.object({
    causeChainJson: z.string().nullable(),
    causeChainTruncated: z.boolean(),
    code: z.string().nullable(),
    contextJson: z.string().nullable(),
    contextTruncated: z.boolean(),
    fingerprint: z.string(),
    id: z.string(),
    message: z.string(),
    messageTruncated: z.boolean(),
    occurredAt: z.number(),
    resourceId: z.string().nullable(),
    rootId: z.string().nullable(),
    runId: z.string().nullable(),
    scope: z.string().nullable(),
    sessionId: z.string(),
    severity: Severity,
    source: z.string(),
    stack: z.string().nullable(),
    stackTruncated: z.boolean(),
    threadId: z.string().nullable(),
  })
);

export const DiagnosticFingerprintItemsSchema = z.array(
  z.object({
    code: z.string().nullable(),
    count: z.number(),
    fingerprint: z.string(),
    firstSeenMs: z.number(),
    lastSeenMs: z.number(),
    latestMessage: z.string(),
    latestMessageTruncated: z.boolean(),
    severity: Severity,
    source: z.string(),
  })
);
