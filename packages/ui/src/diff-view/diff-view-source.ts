import type { StructuredFileDiff, StructuredFileDiffContent } from '@brainstrike/types';

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
 * What {@link DiffView} actually mounts, resolved from either a `source` or
 * the legacy string props. This is the single point that interprets the
 * `StructuredFileDiffContent` union — every rendering branch downstream
 * switches on `.kind` here rather than re-deriving it.
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

function resolveStructuredPresentation(diff: StructuredFileDiff): ResolvedDiffPresentation {
  const { content } = diff;
  switch (content.kind) {
    case 'full':
      return {
        kind: 'text',
        modified: content.newContent ?? '',
        original: content.oldContent ?? '',
        truncated: false,
      };
    case 'hunks-only':
      return {
        hunkText: content.hunkText,
        hunkTextTruncated: content.hunkTextTruncated,
        kind: 'hunks-only',
        sideNote: resolveHunksOnlyNote(content.reason),
      };
    case 'binary':
      return { kind: 'binary' };
    default: {
      const exhaustive: never = content;
      throw new Error(`Unhandled StructuredFileDiffContent kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Resolves a `DiffView`'s inputs into what to actually render. `source`
 * present wins over the legacy string props; when neither is present this
 * throws — a visible contract violation rather than a silently blank diff.
 */
export function resolveDiffPresentation(props: {
  readonly modified?: string | undefined;
  readonly original?: string | undefined;
  readonly source?: DiffViewSource | undefined;
  readonly truncated?: boolean | undefined;
}): ResolvedDiffPresentation {
  const { source, original, modified, truncated } = props;
  if (source) {
    switch (source.kind) {
      case 'strings':
        return {
          kind: 'text',
          modified: source.modified,
          original: source.original,
          truncated: source.truncated ?? false,
        };
      case 'structured':
        return resolveStructuredPresentation(source.diff);
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
  return { kind: 'text', modified, original, truncated: truncated ?? false };
}
