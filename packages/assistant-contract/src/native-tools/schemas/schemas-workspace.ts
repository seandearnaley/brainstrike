import { Schema, SchemaIssue } from 'effect';
import { CANVAS_HTML_MAX_BYTES, canvasHtmlWithinByteCeiling } from '../../mastra-memory-schema.js';

const ROOT_QUALIFIER_DESCRIPTION =
  "Open-folder name/id. Omit for this thread's primary folder; an explicit root always wins.";
const CANVAS_TITLE_MAX = 500;

// Character bounds preserve Zod 4.6.7 code points; the UTF-8 byte bound is authoritative.
function canvasHtml(description: string, options?: { readonly minLength?: number }) {
  const bounded =
    options?.minLength === undefined
      ? Schema.String
      : Schema.String.check(Schema.isMinCodePoints(options.minLength));
  return bounded.annotate({ description }).check(
    Schema.isMaxCodePoints(CANVAS_HTML_MAX_BYTES),
    Schema.makeFilter((value) =>
      canvasHtmlWithinByteCeiling(value)
        ? undefined
        : `canvas HTML exceeds ${CANVAS_HTML_MAX_BYTES} UTF-8 bytes`
    )
  );
}

const ManageCanvasActionInputSchema = Schema.Union(
  [
    Schema.Struct({
      action: Schema.Literal('create'),
      html: canvasHtml('Initial HTML content for version 1 (max 8 MB of UTF-8)'),
      title: Schema.String.check(Schema.isMinCodePoints(1))
        .check(Schema.isMaxCodePoints(CANVAS_TITLE_MAX))
        .annotate({ description: 'Canvas document title' }),
    }),
    Schema.Struct({
      action: Schema.Literal('update'),
      canvasId: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
        description: 'Canvas document id',
      }),
      newString: canvasHtml(
        'Replacement HTML substring; empty deletes the match (max 8 MB of UTF-8)'
      ),
      oldString: canvasHtml(
        'Exact HTML substring that must occur exactly once in the latest version',
        { minLength: 1 }
      ),
    }),
    Schema.Struct({
      action: Schema.Literal('rewrite'),
      canvasId: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
        description: 'Canvas document id',
      }),
      html: canvasHtml('Complete HTML content for the new version (max 8 MB of UTF-8)'),
    }),
    Schema.Struct({ action: Schema.Literal('list') }),
  ],
  { mode: 'oneOf' }
);

export const ManageCanvasInputSchema = Schema.Struct({
  action: Schema.Literals(['create', 'update', 'rewrite', 'list']).annotate({
    description: 'Canvas operation',
  }),
  canvasId: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1))).annotate({
    description: 'Required for update and rewrite',
  }),
  html: Schema.optionalKey(
    canvasHtml('Complete HTML; required for create and rewrite (max 8 MB of UTF-8)')
  ),
  newString: Schema.optionalKey(canvasHtml('Update replacement; may be empty (max 8 MB of UTF-8)')),
  oldString: Schema.optionalKey(
    canvasHtml('Update target; must occur exactly once', { minLength: 1 })
  ),
  title: Schema.optionalKey(
    Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(CANVAS_TITLE_MAX))
  ).annotate({ description: 'Required for create' }),
}).check(
  Schema.makeFilter((input) => {
    const parsed = Schema.decodeUnknownResult(ManageCanvasActionInputSchema)(input);
    if (parsed._tag === 'Success') {
      return;
    }
    return SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues.map(
      (issue) => ({
        issue: issue.message,
        path: (issue.path ?? []).map((segment) =>
          typeof segment === 'object' ? segment.key : segment
        ),
      })
    );
  })
);

export const ReadWorkspaceFileInputSchema = Schema.Struct({
  cursor: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^rfh_[A-Za-z0-9_-]{22}$/u)))
  ).annotate({
    description:
      'Short nextCursor handle from the previous page. Pass it unchanged with optional maxChars and omit every other field',
  }),
  endLine: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))).annotate({
    description:
      'Last 1-based line; omit with cursor unless replaying the original value unchanged',
  }),
  maxChars: Schema.optionalKey(
    Schema.NullOr(
      Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(50_000))
    )
  ).annotate({ description: 'Output character cap' }),
  path: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMinCodePoints(1)))).annotate({
    description: 'Workspace-relative file path; required only when starting a new read',
  }),
  root: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: ROOT_QUALIFIER_DESCRIPTION,
  }),
  startLine: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))).annotate({
    description:
      'First 1-based line; omit with cursor unless replaying the original value unchanged',
  }),
}).check(
  Schema.makeFilter((input) => {
    if (input.cursor) {
      return (['path', 'root'] as const)
        .filter((field) => input[field] !== null && input[field] !== undefined)
        .map((field) => ({ issue: `Omit ${field} when continuing with cursor`, path: [field] }));
    }
    if (!input.path) {
      return { issue: 'path is required when starting a new read', path: ['path'] };
    }
    return;
  })
);

export type ReadWorkspaceFileInput = typeof ReadWorkspaceFileInputSchema.Type;

export const WriteWorkspaceFileInputSchema = Schema.Struct({
  content: Schema.String.check(Schema.isMaxCodePoints(8_000_000)).annotate({
    description: 'Full UTF-8 content (up to ~2 MB); overwrites an existing file',
  }),
  path: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Workspace-relative path; creates missing parent directories',
  }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
});

export type WriteWorkspaceFileInput = typeof WriteWorkspaceFileInputSchema.Type;

export const StringReplaceWorkspaceFileInputSchema = Schema.Struct({
  newStr: Schema.String.check(Schema.isMaxCodePoints(8_000_000)).annotate({
    description: 'Replacement text; empty deletes the matched block',
  }),
  oldStr: Schema.String.check(Schema.isMinCodePoints(1))
    .check(Schema.isMaxCodePoints(8_000_000))
    .annotate({
      description:
        'Existing text block. Use whole lines and enough context to identify one location; ambiguous matches are refused.',
    }),
  path: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Existing workspace-relative file path',
  }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
});

export type StringReplaceWorkspaceFileInput = typeof StringReplaceWorkspaceFileInputSchema.Type;

export const DeleteWorkspaceFileInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Workspace-relative file path; directories are refused',
  }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
});

export type DeleteWorkspaceFileInput = typeof DeleteWorkspaceFileInputSchema.Type;

export const RenameWorkspaceFileInputSchema = Schema.Struct({
  fromPath: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Existing workspace-relative source file',
  }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
  toPath: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Destination path in the same root; no overwrite; creates missing parents',
  }),
});

export type RenameWorkspaceFileInput = typeof RenameWorkspaceFileInputSchema.Type;

export const ReadWorkspaceDirectoryInputSchema = Schema.Struct({
  depth: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(5))
  ).annotate({ description: 'Traversal depth (max 5)' }),
  detail: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'Include entry size/depth (default false)',
  }),
  includeDirectories: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'Include directories',
  }),
  includeFiles: Schema.optionalKey(Schema.Boolean).annotate({ description: 'Include files' }),
  includeHidden: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'Include hidden entries',
  }),
  maxEntries: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(500))
  ).annotate({ description: 'Entry cap' }),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(5000))
  ).annotate({ description: 'Pagination offset' }),
  path: Schema.optionalKey(Schema.String).annotate({
    description: 'Directory path (default root)',
  }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
});

export type ReadWorkspaceDirectoryInput = typeof ReadWorkspaceDirectoryInputSchema.Type;

export const FindWorkspaceSymbolInputSchema = Schema.Struct({
  contextLines: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(10))
  ).annotate({ description: 'Preview lines before/after each match (default 2)' }),
  maxMatches: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(20))
  ).annotate({ description: 'Max matches (default 5)' }),
  path: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Workspace-relative file path',
  }),
  query: Schema.String.check(Schema.isMinCodePoints(1)).annotate({
    description: 'Symbol name or substring to find',
  }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
});

export type FindWorkspaceSymbolInput = typeof FindWorkspaceSymbolInputSchema.Type;

export const ListWorkspaceContextInputSchema = Schema.Record(Schema.String, Schema.Never);

export type ListWorkspaceContextInput = typeof ListWorkspaceContextInputSchema.Type;

export const ReadWorkspaceContextInputSchema = Schema.Struct({
  filePaths: Schema.Array(Schema.String.check(Schema.isMinCodePoints(1)))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(5000))
    .annotate({ description: 'Workspace-relative file paths to read' }),
  maxCharsPerFile: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(50_000))
  ).annotate({ description: 'Per-file character cap' }),
  maxFiles: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(500))
  ).annotate({ description: 'File count cap' }),
  root: Schema.optionalKey(Schema.String).annotate({ description: ROOT_QUALIFIER_DESCRIPTION }),
  tokenBudget: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(200_000))
  ).annotate({ description: 'Total output token cap' }),
});

export type ReadWorkspaceContextInput = typeof ReadWorkspaceContextInputSchema.Type;

// Branches strip declared cross-action extras; the provider envelope above stays closed.
export type ManageCanvasInput = typeof ManageCanvasActionInputSchema.Type;
export function normalizeManageCanvasInput(input: unknown): ManageCanvasInput {
  return Schema.decodeUnknownSync(ManageCanvasActionInputSchema)(input);
}
