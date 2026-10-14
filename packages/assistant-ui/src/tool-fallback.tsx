import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { resolveToolDisplayPolicy } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import { CommittedHumanInteraction } from './committed-human-interaction';
import { CommittedNetworkConsent } from './committed-network-consent';
import { ToolApprovalDecision } from './tool-approval-decision';
import { useRememberedToolArguments } from './tool-argument-context';
import { shouldUseRememberedToolArguments, type ToolArguments } from './tool-arguments';
import { useToolDurationMs } from './tool-duration-context';
import { formatActivityDuration } from './tool-durations';
import { ToolFallbackBody } from './tool-fallback-body';
import { ToolFallbackRow } from './tool-fallback-row';
import {
  extractResolvedRootName,
  resolveCardStatus,
  resolveErrorMessage,
} from './tool-fallback-state';
import { extractPrimaryArg, summarizeResult } from './tool-summaries';
import { categoryTintClasses, classifyToolName } from './tool-visual-classification';
import { useActivityGroupView } from './use-activity-group-view';
import { useToolCallProgressLabel } from './use-tool-call-progress';

function useDisplayToolArguments(
  toolCallId: string,
  args: unknown,
  argsText: string | undefined
): ToolArguments {
  const remembered = useRememberedToolArguments(toolCallId);
  if (!(remembered && shouldUseRememberedToolArguments(args))) {
    return { args, ...(argsText === undefined ? {} : { argsText }) };
  }
  return remembered;
}

/**
 * ToolFallback renders a tool call as the most prominent element in the run:
 * a tinted card whose header IS the shared activity step row (BST-1681) —
 * family icon, verb in tense, target chip, timing, state glyph — over
 * collapsible Arguments/Result panes.
 *
 * This file is the composition root only (BST-1684): the row and its
 * checkpoint sibling live in `tool-fallback-row.tsx`, everything below the row
 * in `tool-fallback-body.tsx`, and the pure state/error derivations in
 * `tool-fallback-state.ts`.
 *
 * Its state comes from `toolStepStateFor` and from nothing else — the SAME
 * derivation the trace headline and the group's step rows use, with no
 * card-only overrides left on top of it, so a step can never read one state
 * here and another there:
 * - `running`: live glyph + progress label; nothing to expand yet, so the row
 *   is not a button
 * - `waiting`: a LIVE pause — the part's status is `requires-action`, so the
 *   row reads "Waiting for approval"
 * - `done`: shows the result summary; the ROW is the expander for the details.
 *   A resultless call on a settled message lands here too: after a reload the
 *   thread carries no record that the pause was ever abandoned, and inventing
 *   one on the card would contradict the trace. Recording that outcome is
 *   persistence work (BST-1678), not something the card may guess at.
 * - `cancelled`: stopped without completing (an `incomplete`/cancelled status,
 *   a decline, a stopped run_python) — muted, never destructive chrome
 * - `failed`: shows the error message inline in red under the row
 */
export const ToolFallback: ToolCallMessagePartComponent = (props) => {
  const {
    toolCallId,
    toolName,
    args,
    argsText,
    result,
    isError: isErrorResult = false,
    status,
  } = props;
  const { detailLevel } = useAssistantDetailLevel();
  const policy = resolveToolDisplayPolicy(detailLevel);
  const groupView = useActivityGroupView();
  const durationMs = useToolDurationMs(toolCallId);
  const durationLabel = durationMs === undefined ? undefined : formatActivityDuration(durationMs);
  const { args: displayArgs, argsText: displayArgsText } = useDisplayToolArguments(
    toolCallId,
    args,
    argsText
  );

  // Follow the Detail level (policy.defaultExpanded) until the user explicitly
  // toggles this card — so switching to Developer auto-expands already-rendered
  // cards (and Compact re-collapses them), while an explicit toggle still wins.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const isCollapsed = userCollapsed ?? !policy.defaultExpanded;
  const detailsId = useId();

  // Focus handoff (WAI-ARIA: focus must not fall to <body> when the focused
  // control is removed). The card is the one element of this call that
  // persists through pending → running → done, while its row is a
  // non-interactive group until a result lands. It is a programmatic target
  // only (tabIndex -1), so the Tab order is unchanged.
  const cardRef = useRef<HTMLDivElement>(null);
  const decisionRef = useCallback((decision: HTMLFieldSetElement | null) => {
    if (!decision) {
      return;
    }
    // Runs while the settled decision is still connected, before React
    // removes it, so focus moves to the card instead of being dropped.
    return () => {
      if (decision.contains(decision.ownerDocument.activeElement)) {
        cardRef.current?.focus({ preventScroll: true });
      }
    };
  }, []);

  const hasResult = result !== undefined;
  const { glyphState, runPythonResult } = resolveCardStatus(
    toolName,
    status,
    result,
    isErrorResult
  );
  const isRunning = glyphState === 'running';
  const isError = glyphState === 'failed';
  // BST-849: while the model streams a large tool input the card must visibly
  // move — received bytes off the raw (live) `argsText`, elapsed off the part
  // timing — or a two-minute file write reads exactly like a hung run.
  const { argsStreaming, label: progressLabel } = useToolCallProgressLabel(props, isRunning);
  const errorMessage = resolveErrorMessage(status, result, isErrorResult);
  const showDetails =
    policy.showDetailsExpander && !isRunning && (Boolean(displayArgsText) || hasResult);

  const primaryArg = useMemo(
    () => extractPrimaryArg(displayArgs, displayArgsText),
    [displayArgs, displayArgsText]
  );
  const resultSummary = useMemo(
    () => (isError || !policy.showResultSummary ? undefined : summarizeResult(result)),
    [isError, policy.showResultSummary, result]
  );
  // A group spanning one root says so once, in its folder chip; each row
  // names its root only when the group's calls span more than one.
  const resolvedRootName = useMemo(
    () => (groupView?.showRootChip === false ? undefined : extractResolvedRootName(result)),
    [groupView, result]
  );

  const category = classifyToolName(toolName);
  const tint = categoryTintClasses(category);
  // Activity trace at scale: inside a group a settled call is one line with
  // no card chrome. It becomes a card when opened, when it failed, while it
  // waits on a person and whenever it carries a decision.
  const compact =
    groupView !== undefined &&
    isCollapsed &&
    !isError &&
    glyphState !== 'waiting' &&
    props.approval === undefined;

  return (
    <div
      className={
        compact
          ? 'bs-tool-timeline bs-tool-compact outline-none focus-visible:ring-2 focus-visible:ring-ring'
          : `bs-tool-timeline my-1 rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isError ? 'border-destructive/50 bg-destructive/5' : tint.card
            }`
      }
      data-chrome={compact ? 'row' : 'card'}
      data-testid="tool-fallback"
      data-tool-category={category}
      ref={cardRef}
      // Only a card that can carry decision controls is a focus handoff target.
      tabIndex={props.approval ? -1 : undefined}
    >
      <ToolFallbackRow
        argsStreaming={argsStreaming}
        collapsed={isCollapsed}
        detailsId={detailsId}
        durationLabel={durationLabel}
        glyphState={glyphState}
        onToggle={() => setUserCollapsed(!isCollapsed)}
        primaryArg={primaryArg}
        progressLabel={progressLabel}
        resolvedRootName={resolvedRootName}
        resultSummary={resultSummary}
        showDetails={showDetails}
        toolCallId={toolCallId}
        toolName={toolName}
      />
      <CommittedHumanInteraction decisionRef={decisionRef} tool={props} />
      <CommittedNetworkConsent decisionRef={decisionRef} tool={props} />
      <ToolApprovalDecision decisionRef={decisionRef} tool={props} />
      <ToolFallbackBody
        argsText={displayArgsText}
        collapsed={isCollapsed}
        detailsId={detailsId}
        errorMessage={errorMessage}
        glyphState={glyphState}
        hasResult={hasResult}
        result={result}
        runPythonResult={runPythonResult}
        showDetails={showDetails}
        showRawIo={policy.showRawIo}
        toolCallId={toolCallId}
        toolName={toolName}
      />
    </div>
  );
};

ToolFallback.displayName = 'ToolFallback';
