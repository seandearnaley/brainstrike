import { useAuiState } from '@assistant-ui/react';
import type { AssistantCheckpointRevertRunResult } from '@brainstrike/assistant-contract';
import { Undo2 } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { useCheckpointTurnRevert } from './edit-checkpoint-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Collect the tool-call ids of one assistant turn, in render order. Mirrors
 * `tool-activity.ts`: a part is a tool call when its discriminant `type` is
 * `'tool-call'`. Non-mutation tools simply have no journal entry, so the entry
 * lookup — not a tool-name filter here — decides what is revertible. Works for
 * live and reloaded turns alike (hydrated parts carry the same discriminant).
 */
export function collectMutationToolCallIds(parts: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const part of parts) {
    if (isRecord(part) && part['type'] === 'tool-call' && typeof part['toolCallId'] === 'string') {
      ids.push(part['toolCallId']);
    }
  }
  return ids;
}

type RevertPhase = 'idle' | 'confirm' | 'reverting' | 'conflict';

function hasConflict(results: readonly AssistantCheckpointRevertRunResult[]): boolean {
  return results.some((run) =>
    run.outcomes.some((outcome) => !outcome.ok && outcome.code === 'conflict')
  );
}

/**
 * Presentational turn-level revert control. Mirrors the per-entry
 * `CheckpointRevertButton` UX contract — confirm before reverting, and if any
 * file changed since the checkpoint offer "Revert anyway" (force). Split from the
 * data wiring so its phase machine is testable without an assistant-ui runtime.
 */
export function CheckpointTurnRevertControl({
  revertibleCount,
  onRevert,
}: {
  revertibleCount: number;
  onRevert: (force: boolean) => Promise<readonly AssistantCheckpointRevertRunResult[]>;
}): ReactElement {
  const [phase, setPhase] = useState<RevertPhase>('idle');

  const runRevert = async (force: boolean): Promise<void> => {
    setPhase('reverting');
    const results = await onRevert(force);
    // Success unmounts this control (the reverted entries drop out of the turn
    // selection on refetch); a lingering conflict re-offers "Revert anyway".
    setPhase(hasConflict(results) ? 'conflict' : 'idle');
  };

  const label = `Revert all ${revertibleCount} edit${revertibleCount === 1 ? '' : 's'} in this turn`;

  if (phase === 'conflict') {
    return (
      <span
        className="flex items-center gap-1 text-[11px]"
        data-testid="checkpoint-turn-revert-row"
      >
        <span className="text-muted-foreground">Some files changed since —</span>
        <Button
          className="h-5 px-1.5 text-[11px]"
          data-testid="checkpoint-turn-revert-anyway"
          onClick={() => runRevert(true)}
          size="sm"
          variant="ghost"
        >
          Revert anyway
        </Button>
      </span>
    );
  }

  if (phase === 'confirm') {
    return (
      <span className="flex items-center gap-1" data-testid="checkpoint-turn-revert-row">
        <Button
          className="h-5 gap-1 px-1.5 text-[11px]"
          data-testid="checkpoint-turn-revert-confirm"
          onClick={() => runRevert(false)}
          size="sm"
          variant="ghost"
        >
          <Undo2 className="size-3" />
          Revert {revertibleCount} edit{revertibleCount === 1 ? '' : 's'}
        </Button>
        <Button
          className="h-5 px-1.5 text-[11px] text-muted-foreground"
          data-testid="checkpoint-turn-revert-cancel"
          onClick={() => setPhase('idle')}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <span className="flex items-center" data-testid="checkpoint-turn-revert-row">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={label}
            className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
            data-testid="checkpoint-turn-revert"
            disabled={phase === 'reverting'}
            onClick={() => setPhase('confirm')}
            size="sm"
            variant="ghost"
          >
            <Undo2 className="size-3" />
            Revert all edits
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * Turn-level footer control: undo every revertible file edit an assistant turn
 * made, wired to the existing per-run revert path. Renders nothing when there is
 * no checkpoint provider (web) or the turn made no revertible edits — pure
 * capability gating, never a disabled stub. Reads the turn's tool-call parts from
 * the assistant-ui message state, so it works on live and reloaded threads alike.
 */
export function CheckpointTurnRevert(): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const toolCallIds = useMemo(() => collectMutationToolCallIds(parts), [parts]);
  const turn = useCheckpointTurnRevert(toolCallIds);
  if (!turn) {
    return null;
  }
  return (
    <div className="mt-1 flex" data-testid="checkpoint-turn-revert-footer">
      <CheckpointTurnRevertControl
        onRevert={(force) => turn.revert({ force })}
        revertibleCount={turn.revertibleCount}
      />
    </div>
  );
}
