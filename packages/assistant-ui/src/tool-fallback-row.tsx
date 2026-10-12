import {
  denormalizeNativeToolName,
  isRevertibleCaptureStatus,
} from '@brainstrike/assistant-contract';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { Undo2 } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { StepRowHeader } from './activity-step-row';
import type { ActivityStepState } from './activity-trace-model';
import { verbForTool } from './activity-verbs';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import {
  REVERTIBLE_MUTATION_TOOL_NAMES,
  useCheckpointForToolCall,
} from './edit-checkpoint-context';
import { ACTIVE_TENSE_STATES } from './tool-fallback-state';
import type { PrimaryArgSummary } from './tool-summaries';

/**
 * The tool card's L1 step row: the shared `StepRowHeader` plus the checkpoint
 * revert control as its SIBLING inside `.bs-step-row-line` — never nested
 * inside the row's `<button>`, since nested interactives are invalid HTML.
 *
 * Split out of `tool-fallback.tsx` (BST-1684); the DOM, the ids and the
 * conditional-spread prop rules are unchanged.
 */
export function ToolFallbackRow({
  argsStreaming,
  collapsed,
  detailsId,
  durationLabel,
  glyphState,
  onToggle,
  primaryArg,
  progressLabel,
  resolvedRootName,
  resultSummary,
  showDetails,
  toolCallId,
  toolName,
}: {
  readonly argsStreaming: boolean;
  readonly collapsed: boolean;
  readonly detailsId: string;
  readonly durationLabel: string | undefined;
  readonly glyphState: ActivityStepState;
  readonly onToggle: () => void;
  readonly primaryArg: PrimaryArgSummary | undefined;
  readonly progressLabel: string;
  readonly resolvedRootName: string | undefined;
  readonly resultSummary: string | undefined;
  readonly showDetails: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
}): ReactNode {
  const verb = verbForTool(toolName);
  // A cancelled/failed step reads the past tense with the glyph carrying the
  // state — consistent with the trace's resting summary, which lists failed
  // verbs in the done tense too. A WAITING step does not: it is in flight,
  // paused on the user, so it keeps the active tense on every surface (bot
  // round 1, Claude Important 3 — "Ran rm -rf build" under a Waiting glyph
  // asserted something that had not happened; the subagent card already read
  // its waiting rows as "Delegating to <persona>").
  const verbLabel = ACTIVE_TENSE_STATES.has(glyphState) ? verb.active : verb.done;
  const isRunning = glyphState === 'running';
  const isError = glyphState === 'failed';

  return (
    <div className="bs-step-row-line px-1">
      <StepRowHeader
        family={verb.family}
        label={collapsed ? 'Expand details' : 'Collapse details'}
        state={glyphState}
        stepId={toolCallId}
        // The tool id when the args name no target (bot round 1, Claude
        // Important 4): a bare "Read" beside an empty chip slot says strictly
        // less than the id, which the row otherwise carries only as sr-only
        // text and a `title`. Skipped when the verb already spells the id
        // (`namesTool`: "Called legacy.echo"), or the row would read it
        // twice. `targetTitle` stays the untruncated primary arg, so the
        // tooltip never labels the id as an argument.
        target={primaryArg?.display ?? (verb.namesTool ? null : toolName)}
        timing={
          <ToolRunTiming
            argsStreaming={argsStreaming}
            durationLabel={durationLabel}
            isRunning={isRunning}
            progressLabel={progressLabel}
          />
        }
        toolName={toolName}
        trailing={
          <>
            {resultSummary ? <span className="bs-step-row-meta">{resultSummary}</span> : null}
            {resolvedRootName ? (
              <span
                className="bs-step-row-meta"
                title={`Resolved workspace root: ${resolvedRootName}`}
              >
                in {resolvedRootName}
              </span>
            ) : null}
          </>
        }
        verb={verbLabel}
        // Conditional spreads, not `prop={x ?? undefined}`: under
        // `exactOptionalPropertyTypes` an optional prop may be absent but
        // never explicitly `undefined`. The toggle trio travels together —
        // a row with no details pane is not interactive at all.
        {...(showDetails ? { bodyId: detailsId, expanded: !collapsed, onToggle } : {})}
        {...(primaryArg?.full === undefined ? {} : { targetTitle: primaryArg.full })}
      />
      {isRunning || isError ? null : (
        <CheckpointRevertButton toolCallId={toolCallId} toolName={toolName} />
      )}
    </div>
  );
}

/**
 * The header's timing slot: the live progress label while the call runs
 * (BST-849), the measured execution time once it has finished.
 */
function ToolRunTiming({
  argsStreaming,
  durationLabel,
  isRunning,
  progressLabel,
}: {
  readonly argsStreaming: boolean;
  readonly durationLabel: string | undefined;
  readonly isRunning: boolean;
  readonly progressLabel: string;
}): ReactNode {
  if (isRunning) {
    return (
      <AssistantThinkingIndicator
        // Shrinkable, unlike the settled duration: a label such as
        // "Receiving input · 999.9 KB · 9m 59s" must truncate in a narrow
        // pane rather than squeeze the target chip out of its slot. That
        // geometry belongs to the SLOT, not to this indicator, and lives in
        // `.bs-step-row-timing` (overrides.css): the `max-w-[60%] shrink
        // min-w-0` this used to carry sat inside the slot, where the
        // percentage resolved against the slot's own width and `flex-shrink`
        // was inert (the slot is a block container, not a flex one).
        className="text-xs tabular-nums"
        data-args-streaming={argsStreaming ? 'true' : undefined}
        label={progressLabel}
        // The row's state glyph already carries the live mark; a second one
        // here would put two `[data-live="true"]` elements on one step.
        showMark={false}
        textClassName="truncate"
      />
    );
  }
  if (!durationLabel) {
    return null;
  }
  return (
    <span
      className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
      title="Execution time"
    >
      {durationLabel}
    </span>
  );
}

/**
 * Per-card undo control for the four agent mutation tools. Renders nothing when
 * there is no journal entry for this tool call (web / not-yet-journaled) — pure
 * capability gating, never a disabled stub. States: revertible → confirm →
 * revert; already reverted → disabled "Reverted"; non-revertible capture →
 * disabled with a reason tooltip; conflict response → inline "Revert anyway?".
 */
function CheckpointRevertButton({
  toolCallId,
  toolName,
}: {
  readonly toolCallId: string;
  readonly toolName: string;
}): ReactElement | null {
  const checkpoint = useCheckpointForToolCall(toolCallId);
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'reverting' | 'conflict' | 'failed'>(
    'idle'
  );
  const [failure, setFailure] = useState<string | null>(null);

  if (!(checkpoint && REVERTIBLE_MUTATION_TOOL_NAMES.has(denormalizeNativeToolName(toolName)))) {
    return null;
  }
  const { availability, entry, refusal, revert } = checkpoint;

  if (entry.revertedAt) {
    return (
      <span
        className="shrink-0 text-[11px] text-muted-foreground"
        data-testid="checkpoint-reverted"
      >
        Reverted
      </span>
    );
  }

  // Legacy content-era refusals first (pre-snapshot rows recorded with a
  // non-restorable capture status), then snapshot availability (BST-1164 T4:
  // no turn-start snapshot covers this edit — visibly disabled, never a
  // click-time surprise).
  const unavailableReason = isRevertibleCaptureStatus(entry.captureStatus)
    ? availability.restorable
      ? null
      : availability.reason
    : `capture status "${entry.captureStatus}" has no restorable state.`;
  if (unavailableReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            data-testid="checkpoint-unrevertible"
          >
            Can't restore
          </span>
        </TooltipTrigger>
        <TooltipContent>{unavailableReason}</TooltipContent>
      </Tooltip>
    );
  }

  const runRevert = async (force: boolean): Promise<void> => {
    setPhase('reverting');
    try {
      const result = await revert(force ? { force: true } : undefined);
      if (result.ok) {
        setPhase('idle');
        return;
      }
      setPhase(result.code === 'conflict' ? 'conflict' : 'idle');
    } catch (error) {
      // The owner refused (e.g. the thread has an active run): show its reason,
      // never an unhandled rejection or a button stuck in 'reverting'.
      setFailure(error instanceof Error ? error.message : String(error));
      setPhase('failed');
    }
  };

  if (phase === 'failed') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px]">
        <span className="text-destructive" data-testid="checkpoint-revert-error">
          {failure}
        </span>
        <Button
          className="h-5 px-1.5 text-[11px]"
          data-testid="checkpoint-revert-retry"
          onClick={() => {
            setFailure(null);
            setPhase('confirm');
          }}
          size="sm"
          variant="ghost"
        >
          Try again
        </Button>
      </span>
    );
  }

  if (phase === 'conflict') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px]">
        <span className="text-muted-foreground">Changed since —</span>
        <Button
          className="h-5 px-1.5 text-[11px]"
          data-testid="checkpoint-revert-anyway"
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
      <span className="flex shrink-0 items-center gap-1">
        <Button
          className="h-5 px-1.5 text-[11px]"
          data-testid="checkpoint-revert-confirm"
          onClick={() => runRevert(false)}
          size="sm"
          variant="ghost"
        >
          Confirm restore
        </Button>
        <Button
          className="h-5 px-1.5 text-[11px] text-muted-foreground"
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
    <Tooltip>
      {/* A span trigger: a disabled button receives no pointer events, and the
          refusal reason must still show on hover. */}
      <TooltipTrigger asChild>
        <span className="shrink-0">
          <Button
            aria-label={`Revert ${toolName}`}
            className="h-5 gap-1 px-1.5 text-[11px]"
            data-testid="checkpoint-revert"
            disabled={phase === 'reverting' || refusal !== null}
            onClick={() => setPhase('confirm')}
            size="sm"
            variant="ghost"
          >
            <Undo2 className="size-3" />
            Revert
          </Button>
        </span>
      </TooltipTrigger>
      {/* Turn-start semantics (BST-1164 T4): the snapshot engine restores the
          file to its state when the turn began, not to just-before-this-edit. */}
      <TooltipContent>{refusal ?? 'Restore this file to its state at turn start'}</TooltipContent>
    </Tooltip>
  );
}
