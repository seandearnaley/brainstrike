import { useAuiState } from '@assistant-ui/react';
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import {
  type CommittedRunVerdict,
  type RunVerdictValue,
  useRunVerdictContext,
} from './run-verdict-context';

/**
 * The runId of THIS message's `run.finished` event, or null. The terminal
 * run event lands exactly once, on the run's final assistant message leg, so
 * its presence is the "render once per run" discriminant — independent of the
 * checkpoint journal, so edit-less runs get a verdict control too. `run.failed`
 * AND `run.cancelled` legs are deliberately excluded in v1 (review #1697):
 * the transport failure / user abort is already an honest ledger status, and
 * a quality verdict on aborted work would conflate the two signals. Web
 * local-runtime events carry no runId and are skipped.
 */
export function selectFinishedRunId(parts: readonly unknown[]): string | null {
  for (const part of parts) {
    const data = readAssistantRunEventDataPart(part);
    if (data?.kind === 'run.finished' && data.runId !== undefined) {
      return data.runId;
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
 * Pure presentational 👍/👎 pair. It reflects the verdict chosen in this
 * session, else the run's committed user verdict where the binding keeps one
 * (host threads), so a choice survives a reload; legacy threads stay
 * write-only, their label visible in the Task Ledger. Choices stay clickable
 * after saving so the user can change their mind (one label per run). A
 * rejected save shows a visible retry — never a silent drop.
 */
export function RunVerdictButtons({
  committed,
  onVerdict,
}: {
  /** The run's committed user verdict, shown until this session chooses. */
  committed?: RunVerdictValue | undefined;
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
  const chosen =
    phase.kind === 'saved' ? phase.verdict : phase.kind === 'idle' ? (committed ?? null) : null;

  return (
    <div className="flex items-center gap-0.5" data-testid="run-verdict-buttons">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="This worked"
            aria-pressed={chosen === 'succeeded'}
            className={`h-5 px-1.5 text-[11px] ${chosen === 'succeeded' ? 'text-success' : 'text-muted-foreground'}`}
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
            className={`h-5 px-1.5 text-[11px] ${chosen === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
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
  const committed = context.committed?.get(runId);
  return (
    <div className="mt-1 flex items-center gap-1" data-testid="run-verdict-footer">
      <RunVerdictButtons
        committed={committed?.source === 'user' ? userChoice(committed.verdict) : undefined}
        onVerdict={(verdict) => context.recordVerdict(runId, verdict)}
      />
      {committed && committed.source !== 'user' ? <DerivedRunVerdict verdict={committed} /> : null}
    </div>
  );
}

/** A committed user verdict the 👍/👎 pair can show; a `mixed` one shows neither. */
function userChoice(verdict: CommittedRunVerdict['verdict']): RunVerdictValue | undefined {
  return verdict === 'mixed' ? undefined : verdict;
}

/** Where a derived label came from: a Stop hook, or a reverted edit. */
function derivedSource(source: Exclude<CommittedRunVerdict['source'], 'user'>): string {
  return source === 'hook' ? 'Hook' : 'Edit revert';
}

/** A label the host derived (a Stop hook's, or a reverted edit's), until the user chooses. */
export function DerivedRunVerdict({
  verdict,
}: {
  verdict: CommittedRunVerdict;
}): ReactElement | null {
  if (verdict.source === 'user') {
    return null;
  }
  return (
    <span
      className="text-[11px] text-muted-foreground"
      data-testid="run-verdict-derived"
      title={verdict.detail}
    >
      {derivedSource(verdict.source)} verdict: {verdict.verdict}
    </span>
  );
}
