import type { MouseEvent, ReactNode } from 'react';
import type { RunStripMark } from './activity-group-view-model';

/**
 * The header's run strip: one mark per step (or per bucket of a long run),
 * coloured by family, with failures tall and red. It shows where a long run
 * read, edited and broke at a glance; a click opens the step under the
 * pointer. One button rather than a mark per step, so a 300-step run adds a
 * single tab stop: from the keyboard it opens the first failure, or else the
 * newest step.
 */
export function ActivityRunStrip({
  failed,
  marks,
  onPick,
}: {
  readonly failed: number;
  readonly marks: readonly RunStripMark[];
  readonly onPick: (stepId: string) => void;
}): ReactNode {
  if (marks.length === 0) {
    return null;
  }
  const pick = (event: MouseEvent<HTMLButtonElement>): void => {
    // `detail` is 0 for a keyboard activation: there is no pointer position.
    if (event.detail === 0) {
      const target = marks.find((mark) => mark.kind === 'failed') ?? marks.at(-1);
      if (target) {
        onPick(target.stepId);
      }
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    const index = Math.min(marks.length - 1, Math.max(0, Math.floor(ratio * marks.length)));
    const mark = marks[index];
    if (mark) {
      onPick(mark.stepId);
    }
  };
  return (
    <button
      aria-label={
        failed > 0
          ? `Run strip, ${marks.length} marks. Open the first failed step`
          : `Run strip, ${marks.length} marks. Open the newest step`
      }
      className="bs-run-strip"
      data-testid="assistant-activity-run-strip"
      onClick={pick}
      type="button"
    >
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox={`0 0 ${marks.length} 10`}>
        {marks.map((mark, index) => {
          const tall = mark.kind === 'failed' || mark.kind === 'running' || mark.kind === 'waiting';
          return (
            <rect
              className={`bs-run-mark bs-run-mark-${mark.kind}`}
              data-kind={mark.kind}
              height={tall ? 10 : 6}
              // Marks are keyed by position: a bucket's step changes as the run grows.
              // biome-ignore lint/suspicious/noArrayIndexKey: the position IS the identity of a strip mark.
              key={index}
              width={0.72}
              x={index + 0.14}
              y={tall ? 0 : 4}
            >
              <title>{mark.label}</title>
            </rect>
          );
        })}
      </svg>
    </button>
  );
}
