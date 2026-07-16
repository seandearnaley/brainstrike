import { useAuiState } from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { type RunVerdictValue, useRunVerdictContext } from './run-verdict-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * The runId of THIS message's `run.finished` event, or null. The terminal
 * run event lands exactly once, on the run's final assistant message leg, so
 * its presence is the "render once per run" discriminant — independent of the
 * checkpoint journal, so edit-less runs get a verdict control too. `run.failed`
 * legs are deliberately excluded in v1: the transport failure is already an
 * honest ledger status, and a quality verdict on aborted work would conflate
 * the two signals. Web local-runtime events carry no runId and are skipped.
 */
export function selectFinishedRunId(parts: readonly unknown[]): string | null {
  for (const part of parts) {
    if (!isRecord(part) || part['name'] !== ASSISTANT_RUN_EVENT_DATA_NAME) {
      continue;
    }
    const data = part['data'];
    if (isRecord(data) && data['kind'] === 'run.finished' && typeof data['runId'] === 'string') {
      return data['runId'];
    }
  }
  return null;
}

type VerdictPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly verdict: RunVerdictValue }
  | { readonly kind: 'saved'; readonly verdict: RunVerdictValue }
  | { readonly kind: 'failed'; readonly verdict: RunVerdictValue };

/**
 * Pure presentational 👍/👎 pair. Write-only in v1: it reflects the verdict
 * chosen in THIS session (no read-back of a previously stored label after
 * reload); the stored label remains visible in the Task Ledger. Choices stay
 * clickable after saving so the user can change their mind (the ledger upserts
 * one label per run). A rejected save shows a visible retry — never a silent
 * drop.
 */
export function RunVerdictButtons({
  onVerdict,
}: {
  onVerdict: (verdict: RunVerdictValue) => Promise<void>;
}): ReactElement {
  const [phase, setPhase] = useState<VerdictPhase>({ kind: 'idle' });

  const submit = async (verdict: RunVerdictValue): Promise<void> => {
    setPhase({ kind: 'saving', verdict });
    try {
      await onVerdict(verdict);
      setPhase({ kind: 'saved', verdict });
    } catch {
      setPhase({ kind: 'failed', verdict });
    }
  };

  const saving = phase.kind === 'saving';
  const chosen = phase.kind === 'saved' ? phase.verdict : null;

  return (
    <div className="flex items-center gap-0.5" data-testid="run-verdict-buttons">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="This worked"
            aria-pressed={chosen === 'succeeded'}
            className={`h-5 px-1.5 text-[11px] ${chosen === 'succeeded' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
            disabled={saving}
            onClick={() => void submit('succeeded')}
            size="sm"
            variant="ghost"
          >
            <ThumbsUp className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Mark this run's work as succeeded</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="This didn't work"
            aria-pressed={chosen === 'failed'}
            className={`h-5 px-1.5 text-[11px] ${chosen === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
            disabled={saving}
            onClick={() => void submit('failed')}
            size="sm"
            variant="ghost"
          >
            <ThumbsDown className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Mark this run's work as failed</TooltipContent>
      </Tooltip>
      {phase.kind === 'failed' ? (
        <span className="ml-1 flex items-center gap-1 text-[11px] text-destructive">
          Couldn't save verdict
          <Button
            aria-label="Retry saving verdict"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => void submit(phase.verdict)}
            size="sm"
            variant="ghost"
          >
            Retry
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-run verdict footer: renders once per finished run (on the message leg
 * carrying the terminal `run.finished` event), for ANY finished run — with or
 * without edits. Returns null without a verdict provider or a finished runId —
 * capability gating, never a disabled stub.
 */
export function RunVerdictControl(): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const runId = useMemo(() => selectFinishedRunId(parts), [parts]);
  const context = useRunVerdictContext();
  if (!(runId && context)) {
    return null;
  }
  return (
    <div className="mt-1 flex" data-testid="run-verdict-footer">
      <RunVerdictButtons onVerdict={(verdict) => context.recordVerdict(runId, verdict)} />
    </div>
  );
}
