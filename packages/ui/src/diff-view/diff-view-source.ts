import type {
  ChangedFileStatus,
  StructuredFileDiff,
  StructuredFileDiffContent,
} from '@brainstrike/types';

/**
 * How a {@link DiffView} gets its content. `strings` is the legacy shape
 * (kept so `git-diff-surface.tsx` / `assistant-tool-approval-notice.tsx`
 * compile and render unchanged); `structured` carries a full
 * {@link StructuredFileDiff} from the changeset diff engine (BST-1111).
 */
export type DiffViewSource =
  | {
      readonly kind: 'strings';
      readonly modified: string;
      readonly original: string;
      readonly truncated?: boolean | undefined;
    }
  | { readonly diff: StructuredFileDiff; readonly kind: 'structured' };

/**
 * What {@link DiffView} actually mounts. Every rendering branch downstream
 * switches on `.kind` here rather than re-deriving it from the source. The
 * `original`/`modified`/`hunkText` fields are the actual scalars callers
 * should key memoization/effect-dependency arrays off of directly — plain
 * strings compare by VALUE, so two calls with different `source` object
 * identities but equal underlying text land on equal values here, without
 * needing a separately-maintained cache key.
 */
export type ResolvedDiffPresentation =
  | { readonly kind: 'binary' }
  | {
      readonly hunkText: string;
      readonly hunkTextTruncated: boolean;
      readonly kind: 'hunks-only';
      readonly sideNote: string;
    }
  | {
      readonly kind: 'text';
      readonly modified: string;
      readonly original: string;
      readonly truncated: boolean;
    };

export interface DiffViewStatSummary {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Everything `DiffView` needs to render a given set of inputs, resolved in
 * one place — the single interpreter for `DiffViewSource` /
 * `StructuredFileDiffContent`. Nothing downstream re-derives `statSummary`,
 * `status`, `sourceKind`, or `contentKind` from `presentation`/`source`
 * itself; they're read straight off this object.
 */
export interface ResolvedDiffView {
  /** `'text'`, `'hunks-only'`, or `'binary'` — mirrors `presentation.kind`. */
  readonly contentKind: 'binary' | 'hunks-only' | 'text';
  /**
   * `source.diff.path` when `source.kind === 'structured'` and the caller
   * didn't pass an explicit `filename` — falling back to it avoids a silent
   * loss of syntax highlighting for structured callers that reasonably
   * expect the diff's own path to drive it.
   */
  readonly filenameFallback: string | undefined;
  readonly presentation: ResolvedDiffPresentation;
  readonly sourceKind: 'strings' | 'structured';
  /** `null` when not computable (binary) or when rendering the legacy `strings` source. */
  readonly statSummary: DiffViewStatSummary | null;
  /** `null` for the legacy `strings` source, which carries no file-status concept. */
  readonly status: ChangedFileStatus | null;
}

type HunksOnlyContent = Extract<StructuredFileDiffContent, { kind: 'hunks-only' }>;

/** Names which side(s) exceeded the inline cap, for the visible `diff-over-cap-note`. */
function resolveHunksOnlyNote(reason: HunksOnlyContent['reason']): string {
  switch (reason) {
    case 'over-cap-old':
      return 'old side too large to render in full';
    case 'over-cap-new':
      return 'new side too large to render in full';
    case 'over-cap-both':
      return 'both sides too large to render in full';
    case 'diff-overflow':
      return 'diff too large to render in full';
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled hunks-only reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function resolveStructuredDiffView(diff: StructuredFileDiff): ResolvedDiffView {
  const statSummary =
    diff.additions === null || diff.deletions === null
      ? null
      : { additions: diff.additions, deletions: diff.deletions };
  const shared = {
    filenameFallback: diff.path,
    sourceKind: 'structured' as const,
    statSummary,
    status: diff.status,
  };

  const { content } = diff;
  switch (content.kind) {
    case 'full': {
      const original = content.oldContent ?? '';
      const modified = content.newContent ?? '';
      return {
        ...shared,
        contentKind: 'text',
        presentation: { kind: 'text', modified, original, truncated: false },
      };
    }
    case 'hunks-only':
      return {
        ...shared,
        contentKind: 'hunks-only',
        presentation: {
          hunkText: content.hunkText,
          hunkTextTruncated: content.hunkTextTruncated,
          kind: 'hunks-only',
          sideNote: resolveHunksOnlyNote(content.reason),
        },
      };
    case 'binary':
      return {
        ...shared,
        contentKind: 'binary',
        presentation: { kind: 'binary' },
      };
    default: {
      const exhaustive: never = content;
      throw new Error(`Unhandled StructuredFileDiffContent kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Resolves a `DiffView`'s inputs into everything it needs to render.
 * `source` present wins over the legacy string props; when neither is
 * present this throws — a visible contract violation rather than a
 * silently blank diff. (The `DiffViewProps` union also enforces this at
 * compile time for TypeScript callers; the throw is the runtime backstop
 * for anything that reaches here past that — an untyped caller, or a type
 * escape.)
 */
export function resolveDiffView(props: {
  readonly modified?: string | undefined;
  readonly original?: string | undefined;
  readonly source?: DiffViewSource | undefined;
  readonly truncated?: boolean | undefined;
}): ResolvedDiffView {
  const { source, original, modified, truncated } = props;
  if (source) {
    switch (source.kind) {
      case 'strings':
        return {
          contentKind: 'text',
          filenameFallback: undefined,
          presentation: {
            kind: 'text',
            modified: source.modified,
            original: source.original,
            truncated: source.truncated ?? false,
          },
          sourceKind: 'strings',
          statSummary: null,
          status: null,
        };
      case 'structured':
        return resolveStructuredDiffView(source.diff);
      default: {
        const exhaustive: never = source;
        throw new Error(`Unhandled DiffViewSource kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  if (original === undefined || modified === undefined) {
    throw new Error(
      'DiffView requires either a `source` prop or both `original` and `modified` string props.'
    );
  }
  return {
    contentKind: 'text',
    filenameFallback: undefined,
    presentation: { kind: 'text', modified, original, truncated: truncated ?? false },
    sourceKind: 'strings',
    statSummary: null,
    status: null,
  };
}
