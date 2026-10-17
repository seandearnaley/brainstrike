import { MessagePartPrimitive, useAuiState } from '@assistant-ui/react';
import {
  type FileMentionTextSegment,
  splitFileMentionSegments,
} from '@brainstrike/assistant-contract';
import { FileText } from 'lucide-react';
import { memo, type ReactElement, useMemo } from 'react';

const PLAIN_TEXT_CLASS = 'whitespace-pre-wrap break-words';

/** Each segment with its offset in the message, a stable key for the rendered run. */
function keyedSegments(
  segments: readonly FileMentionTextSegment[]
): { readonly segment: FileMentionTextSegment; readonly start: number }[] {
  const keyed: { readonly segment: FileMentionTextSegment; readonly start: number }[] = [];
  let start = 0;
  for (const segment of segments) {
    keyed.push({ segment, start });
    start += segment.kind === 'text' ? segment.text.length : segment.raw.length;
  }
  return keyed;
}

/**
 * User-authored text parts, shown exactly as typed: plain text with whitespace
 * kept, never markdown (owner decision 2026-10-16; a prompt naming double-star
 * credential globs rendered as bold). Nothing is stripped or normalized, so a pasted
 * citation marker or Nerd Fonts glyph stays as the user sent it. A separate
 * component rather than a role check inside the renderer, so the call sites
 * state plainly which text is normalized and which is not.
 *
 * The one exception is a file the user mentioned: its `:file[label]{name=…}`
 * directive shows as a chip naming the file, as the user picked it, never as the
 * directive and its internal root id (owner decision 2026-10-17, BST-2043).
 */
export const UserMessageText = memo(function UserMessageText(): ReactElement {
  const text = useAuiState((state) => (state.part.type === 'text' ? state.part.text : null));
  const segments = useMemo(() => keyedSegments(text ? splitFileMentionSegments(text) : []), [text]);
  if (!segments.some(({ segment }) => segment.kind === 'file')) {
    return <MessagePartPrimitive.Text className={PLAIN_TEXT_CLASS} component="p" smooth={false} />;
  }
  return (
    <p className={PLAIN_TEXT_CLASS}>
      {segments.map(({ segment, start }) =>
        segment.kind === 'text' ? (
          segment.text
        ) : (
          <FileMentionChip key={start} label={segment.label} path={segment.path} />
        )
      )}
    </p>
  );
});

/** A mentioned file as the user picked it: its name, with the workspace path on hover. */
function FileMentionChip({
  label,
  path,
}: {
  readonly label: string;
  readonly path: string;
}): ReactElement {
  return (
    // A chip is atomic, so the bubble's `break-words` cannot break a long name:
    // the chip is capped at the bubble's width and its label truncates visually
    // (the full name stays in the text, for copy and assistive technology).
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 align-baseline font-medium text-[0.92em] leading-snug"
      data-testid="user-message-file-mention"
      title={path}
    >
      <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
