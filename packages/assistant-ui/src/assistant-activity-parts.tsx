import {
  type EnrichedPartState,
  type MessagePartStatus,
  MessagePrimitive,
  type PartState,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  useAuiState,
} from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import { Brain } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { ActivityStepMetaProvider } from './activity-step-context';
import { deriveStepMeta } from './activity-step-meta';
import { StepRowHeader } from './activity-step-row';
import { ActivityTrace, type ActivityTraceProps } from './activity-trace';
import { deriveActivitySteps, summarizeActivity } from './activity-trace-model';
import { useAnsweredApprovals } from './answered-approvals-context';
import { approvalCardToolCallIds } from './approval-history';
import {
  ACTIVITY_GROUP_KEY,
  type ActivityGroupKey,
  groupAssistantActivityPart,
  isActivityPart,
  trailingGroupHasActivity,
} from './assistant-activity-grouping';
import { AssistantMessageText } from './assistant-message-text';
import { AssistantReasoningPart } from './assistant-reasoning-part';
import {
  AssistantThinkingIndicator,
  BrainstrikeThinkingMark,
} from './assistant-thinking-indicator';
import { ShellOutputProvider } from './shell-output-context';
import { isSubagentDelegationToolName } from './subagent-tool-cards';
import { CHAIN_OF_THOUGHT_TOOL_COMPONENTS, TodoProgress } from './todo-progress';
import { ToolDurationProvider } from './tool-duration-context';
import { useChainActivityDerivations } from './use-chain-activity-derivations';

/**
 * ACTIVITY PARTS (phase 1 of the activity-trace overhaul; spec
 * docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md).
 *
 * Renders an assistant message's parts through `MessagePrimitive.GroupedParts`
 * with `groupAssistantActivityPart` as the grouper. The legacy
 * `components.ChainOfThought` path ended a group on ANY non tool-call/reasoning
 * part, and this repo emits a `brainstrike.run-event` data part around every
 * tool call, so each call became its own "Worked · 1 step" group. Here the
 * run-event parts are group-transparent and one contiguous run of reasoning +
 * tool calls renders as one group, whose header is the `ActivityTrace` status
 * row (BST-1679: current step while running, verb summary at rest).
 *
 * BST-1656 rulings preserved: each contiguous group renders at its own
 * position (text splits), group status derives from that group's parts,
 * reasoning-only groups show no step count, the turn-wide task list renders
 * once in the first group, and wrappers stay mounted (the library keys a group
 * on its first part's id). One qualifier: the group that owns the message's
 * last part also counts as active while the message is running and that
 * group's own status is not `incomplete` — a tool call's result can land in
 * the same streamed chunk that fences the next call into the same coalesced
 * group, so a purely part-derived status would flash "Worked" between two
 * calls of the same run.
 */

function reasoningToggleLabel(open: boolean): string {
  return open ? 'Hide thinking' : 'Show thinking';
}

const ACTIVITY_SUMMARY_METADATA_KEY = 'brainstrikeActivitySummary';

/**
 * Seam for a future model-written resting summary (spec §4.2). Read-only
 * today: nothing in this repo writes the key. A non-string or blank value is
 * ignored — never coerced — so a malformed metadata blob falls back to the
 * derived verb summary instead of rendering "[object Object]".
 */
function readActivitySummaryOverride(message: unknown): string | null {
  if (!(message && typeof message === 'object')) {
    return null;
  }
  const metadata = (message as { readonly metadata?: unknown }).metadata;
  if (!(metadata && typeof metadata === 'object')) {
    return null;
  }
  const custom = (metadata as { readonly custom?: unknown }).custom;
  if (!(custom && typeof custom === 'object')) {
    return null;
  }
  const value = (custom as Record<string, unknown>)[ACTIVITY_SUMMARY_METADATA_KEY];
  if (typeof value !== 'string') {
    return null;
  }
  // Validated AND rendered on the trimmed value — returning the raw string
  // painted a padded override's whitespace into the headline (review finding 8).
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True while the given part's own `status.type` reads `'running'`. */
function isPartRunning(part: PartState): boolean {
  return part.status.type === 'running';
}

/**
 * A part's own status (`part.status.type` / `.reason` — the same fields the
 * reasoning disclosure reads for its own streaming flag). `PartState.status` is
 * always present; the `undefined` case is `Array#at(-1)` on a group with no
 * activity part, which counts as `complete` — matching the library's own
 * `normalizePartStatus` fallback.
 */
function activityPartStatus(
  part: PartState | undefined
): MessagePartStatus | ToolCallMessagePartStatus {
  return part?.status ?? { type: 'complete' };
}

function ActivityPartLayout({ children }: { children?: ReactNode }): ReactNode {
  return <div className="mb-2 last:mb-0 empty:mb-0">{children}</div>;
}

function ActivityToolPart(props: ToolCallMessagePartProps) {
  const Component =
    CHAIN_OF_THOUGHT_TOOL_COMPONENTS.by_name[props.toolName] ??
    CHAIN_OF_THOUGHT_TOOL_COMPONENTS.Fallback;
  return <Component {...props} />;
}

/**
 * The reasoning row's glyph slot. It replaces the generic state glyph rather
 * than reusing it (BST-1681) because the reasoning mark carries the phase-1
 * test ids the hydration-liveness invariant and the disclosure suite read:
 * ONE live mark while the part streams, the static
 * `assistant-reasoning-indicator` / `assistant-reasoning-static-mark` pair
 * once it settles. The tense itself lives in the row's verb slot
 * ("Thinking" / "Thought"), so neither branch renders text of its own.
 */
function ReasoningGlyph({ isStreaming }: { isStreaming: boolean }): ReactNode {
  if (isStreaming) {
    return <BrainstrikeThinkingMark className="size-4" testId="assistant-reasoning-live-mark" />;
  }
  return (
    <span className="bs-thinking-indicator" data-testid="assistant-reasoning-indicator">
      <BrainstrikeThinkingMark
        className="size-4"
        live={false}
        testId="assistant-reasoning-static-mark"
      />
    </span>
  );
}

/**
 * One reasoning part's own disclosure row + panel (BST-1677 wave 2, re-skinned
 * as the shared L1 step row in BST-1681). Each
 * reasoning leaf in a group owns its open/closed state independently — a
 * group with several thinking blocks (common once a group can hold many
 * tool calls) never opens or closes them together. Default open state
 * follows the part's own `status.type === 'running'`: open while it streams,
 * settling collapsed the moment it completes; a manual toggle sticks for the
 * life of the mounted block. Reasoning leaves have no `idKey` in
 * `@assistant-ui/core`'s `MessageGroupedParts` (only tool calls do, via
 * `toolCallId`) — they are keyed by absolute part index instead, which stays
 * stable because streaming is append-only and group nodes keep their own
 * `nodeKey` as siblings append, so this block does not remount when a later
 * part (e.g. an intervening tool call) arrives. The row's own verb follows
 * the same signal in the past tense once it settles — "Thinking" while the
 * part streams, "Thought" once it does not (BST-1679). That is the same
 * predicate `deriveActivitySteps` applies to a reasoning part
 * (`reasoningStepState`), read here from the part this block already owns
 * rather than re-plumbed from the group's step list: the group renders its
 * leaves through the message-level part switch, and a reasoning step carries
 * no duration to add to the label. Guarded by
 * "a manually opened block survives an intervening tool call and the turn
 * finishing (BST-1656)" in assistant-reasoning-disclosure.behavior.test.tsx.
 */
function ActivityReasoningBlock({
  part,
}: {
  part: Extract<EnrichedPartState, { type: 'reasoning' }>;
}): ReactNode {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const panelId = useId();
  const isStreaming = part.status.type === 'running';
  const open = userOpen ?? isStreaming;

  return (
    <ActivityPartLayout>
      <StepRowHeader
        bodyId={panelId}
        // The panel below is ALWAYS mounted (only its content is gated on
        // `open`), so unlike the tool / subagent / task cards this row's
        // `aria-controls` never dangles and stays on in both states.
        controlsAlwaysMounted
        expanded={open}
        family="other"
        glyph={<ReasoningGlyph isStreaming={isStreaming} />}
        icon={Brain}
        label={reasoningToggleLabel(open)}
        // BST-1682: every other row folds its visible content into its name
        // (WCAG 2.5.3). This one opts out because `label` ALREADY names the
        // step — "Show thinking" / "Hide thinking" is the visible affordance
        // AND an e2e + BST-1656 behaviour contract, and the composed form
        // ("Thinking, show thinking") would only stutter.
        nameFromContent={false}
        onToggle={() => setUserOpen(!open)}
        state={isStreaming ? 'running' : 'done'}
        target={null}
        testId="local-chain-of-thought"
        verb={isStreaming ? 'Thinking' : 'Thought'}
      />
      <div
        className={cn(
          'bs-chain-of-thought-panel mt-2 empty:mt-0',
          open ? 'border-border/70 border-l pl-3' : ''
        )}
        id={panelId}
      >
        {open ? <AssistantReasoningPart /> : null}
      </div>
    </ActivityPartLayout>
  );
}

interface ActivityGroupProps {
  readonly cardedCalls: ReadonlySet<string>;
  readonly children: ReactNode;
  readonly indices: readonly number[];
  readonly status: MessagePartStatus | ToolCallMessagePartStatus;
}

/**
 * Narrows a `GroupPart.status` (part-level: `MessagePartStatus |
 * ToolCallMessagePartStatus`) down to the reason `ActivityTrace` accepts
 * (message-level: `Extract<MessageStatus, { type: 'incomplete' }>['reason']`).
 * The two unions are independently declared — 0.15.18 dropped `'tool-calls'`
 * from the PART union while keeping it on the message union — but their
 * `'incomplete'` reason values otherwise coincide, so the return type here is
 * checked assignability, not a cast.
 */
function toIncompleteReason(
  status: MessagePartStatus | ToolCallMessagePartStatus
): ActivityTraceProps['incompleteReason'] {
  return status.type === 'incomplete' ? status.reason : undefined;
}

/**
 * One contiguous activity group. Replaces the panel's now-deleted local
 * chain-of-thought renderer (BST-1677): reads the group's parts by index from
 * the message (the library's `chainOfThought` scope does not exist on this
 * path), derives the steps / elapsed / durations from them, and renders the
 * `ActivityTrace` status row (BST-1679) around its children.
 * Each reasoning leaf owns its own disclosure (`ActivityReasoningBlock`), so
 * the group body renders `children` directly — tool cards and reasoning
 * blocks interleaved in part order.
 */
function ActivityGroup({ cardedCalls, children, indices, status }: ActivityGroupProps): ReactNode {
  const messageParts = useAuiState((state) => state.message.parts);
  const messageId = useAuiState((state) => (state.message as { id?: string }).id ?? '');
  const isMessageRunning = useAuiState(
    (state) => state.message.role === 'assistant' && state.message.status.type === 'running'
  );
  const groupParts = useMemo(
    () =>
      indices
        .map((index) => messageParts[index])
        .filter(
          (part): part is PartState =>
            part !== undefined &&
            !(
              part.type === 'tool-call' &&
              part.result === undefined &&
              part.status.type === 'requires-action' &&
              cardedCalls.has(part.toolCallId)
            )
        ),
    [indices, messageParts, cardedCalls]
  );
  const hasActivityParts = groupParts.some(isActivityPart);
  // A group's own member statuses can all already read "complete" (e.g. a
  // tool-call result arrives atomically in one streamed chunk) even though
  // the group is still the OPEN, trailing run of a message that hasn't
  // finished — the next chunk may fence another tool call into this same
  // coalesced key. Treat that case as active too, so the card doesn't look
  // finished a beat before the next call actually starts.
  const isTrailingGroup = indices.at(-1) === messageParts.length - 1;
  // Finding 1 (PR #3061 review), narrowed in the fix round: `getGroupStatus`
  // mirrors the group's LAST member part, so a group whose own last member is
  // a transparent data part (e.g. a `tool.completed` run-event that is not
  // the message's last PART — a trailing `run.cancelled`/`run.failed`
  // standalone row can follow it) can read "complete" even though an earlier,
  // resultless tool call or still-streaming reasoning part in the SAME group
  // carries the message's own `incomplete` status. Status of the group as its
  // activity parts see it: running if any activity part runs, else the LAST
  // activity part's status (a trailing transparent data part can no longer
  // mask an interrupted tool call or reasoning part) — never derived from a
  // data member. Symmetrically, a group whose activity parts ALL resolved
  // reads "Worked" even on a cancelled/errored message: the standalone
  // `run.*` row carries the run outcome, this card reports what the activity
  // itself did.
  const activityParts = groupParts.filter(isActivityPart);
  const activityStatus = activityParts.some(isPartRunning)
    ? ({ type: 'running' } as const)
    : activityPartStatus(activityParts.at(-1));
  const incompleteReason = toIncompleteReason(activityStatus);
  // An uncarded paused tool still owns a waiting trace. A dedicated approval
  // card owns the paused tool's controls/history instead; completed reasoning
  // beside it must not inherit the message's obsolete waiting state.
  const hasGatedActivity = activityParts.some(
    (part) => part.type === 'tool-call' && part.status.type === 'requires-action'
  );
  const isActivityActive =
    status.type === 'running' ||
    hasGatedActivity ||
    (isMessageRunning && isTrailingGroup && status.type !== 'incomplete');
  // The task-list summary is turn-wide; render it once, in the group that
  // holds the message's first activity part. (A message with no activity
  // part at all never reaches this branch: `!hasActivityParts` below returns
  // early before `isFirstGroup` is read.)
  const firstActivityIndex = messageParts.findIndex(isActivityPart);
  const isFirstGroup = indices.includes(firstActivityIndex);
  const { activityFallbackMs, shellOutputs, taskList, toolDurations } = useChainActivityDerivations(
    messageParts,
    messageId,
    groupParts
  );
  // The status row's own model (BST-1679): one step per reasoning/tool-call
  // part, summarized into the live label ("Calling linear.list_comments") and
  // the resting verb phrase ("Read 2 files, ran"). The detail line under the
  // header names what the CURRENTLY running tool is working on — the last
  // running step wins, so parallel calls read as the most recent one rather
  // than flickering between them.
  const steps = useMemo(
    () => deriveActivitySteps(groupParts, toolDurations),
    [groupParts, toolDurations]
  );
  const summary = useMemo(() => summarizeActivity(steps), [steps]);
  // The one presentation fact a card cannot derive from its own props
  // (BST-1681): which step is the group's LAST running one — the only row
  // whose verb shimmers. Derived here, where the whole step list is known,
  // and handed down through the provider; with two calls in flight, a card
  // reading only its own status would shimmer both.
  const stepMeta = useMemo(() => deriveStepMeta(steps), [steps]);
  const detail = useMemo(
    () =>
      steps.findLast((step) => step.kind === 'tool' && step.state === 'running')?.target ?? null,
    [steps]
  );
  const restingOverride = useAuiState((state) => readActivitySummaryOverride(state.message));

  // A group can coalesce purely from group-transparent bookkeeping (e.g. a
  // run of `tool.started`/`tool.completed` events with no reasoning or
  // tool-call anchor, such as a trailing run purely of run-events after the
  // last real activity). With nothing to summarize, render it as if
  // ungrouped rather than showing an empty "Worked" card.
  if (!hasActivityParts) {
    return children;
  }

  return (
    <div className="bs-chain-of-thought mb-2 block max-w-2xl">
      {isFirstGroup && taskList ? <TodoProgress result={taskList} /> : null}
      <ToolDurationProvider durations={toolDurations}>
        <ShellOutputProvider outputs={shellOutputs}>
          <ActivityStepMetaProvider meta={stepMeta}>
            <ActivityTrace
              detail={detail}
              fallbackMs={activityFallbackMs}
              incompleteReason={incompleteReason}
              isActive={isActivityActive}
              restingOverride={restingOverride}
              summary={summary}
            >
              {/* `.bs-step-list` is what the reveal stagger counts
                  (`:nth-child`), so each step keeps exactly ONE wrapper here
                  — `ActivityPartLayout`'s div. */}
              <div className="bs-step-list">{children}</div>
            </ActivityTrace>
          </ActivityStepMetaProvider>
        </ShellOutputProvider>
      </ToolDurationProvider>
    </div>
  );
}

/**
 * The assistant message's parts renderer. `indicator="no-text"` (the library
 * default) restores parity with the legacy `MessagePrimitive.Parts` path's
 * placeholders: the library's `EmptyParts` rendered a thinking indicator for
 * a running message with zero parts, and its `ConditionalEmpty`
 * (`unstable_showEmptyOnNonTextEnd`, on by default) rendered one whenever a
 * running message's LAST part was not `text`/`reasoning` — e.g. only a
 * `run.started` data part has arrived so far. `"never"` blanked the assistant
 * bubble for the whole gap between Send and the first part landing, which
 * regressed both cases. The library ALSO emits the slot whenever the last
 * part is a tool call or a transparent data part — i.e. while an activity
 * group is live — and rendering it there put a second "Thinking" row under a
 * collapsed group whose header already cycles the current step (CDT pass 4).
 * So the slot is dropped exactly when the TRAILING group holds an activity
 * part (`trailingGroupHasActivity`): that group's header is the live status.
 * It still renders for zero parts, for only standalone data (`run.started`),
 * and for `[…, text, tool.started]` — there the earlier group is no longer
 * trailing (it reads "Worked") and the bare data-only group renders nothing,
 * so without the slot a running turn would have no live affordance at all
 * until the next tool-call part lands. When an empty running text part exists
 * it is normally
 * the LAST part (the stream never opens a text part and then appends another
 * part before its first delta), so the library emits no indicator and
 * `markdown-text.tsx` owns the placeholder; the one theoretical overlap (an
 * empty running text part that is not last) is a shape the legacy
 * `MessagePrimitive.Parts` path shared.
 */
export function AssistantActivityParts(): ReactNode {
  const messageParts = useAuiState((state) => state.message.parts);
  const { cardedSurfaceCalls, requests } = useAnsweredApprovals();
  const cardedCalls = useMemo(
    () => approvalCardToolCallIds(messageParts, cardedSurfaceCalls, requests),
    [messageParts, cardedSurfaceCalls, requests]
  );
  const trailingGroupHoldsActivity = useAuiState((state) =>
    trailingGroupHasActivity(state.message.parts)
  );
  return (
    <MessagePrimitive.GroupedParts<ActivityGroupKey>
      groupBy={groupAssistantActivityPart}
      indicator="no-text"
    >
      {({ children, part }) => {
        switch (part.type) {
          case ACTIVITY_GROUP_KEY:
            return (
              <ActivityGroup cardedCalls={cardedCalls} indices={part.indices} status={part.status}>
                {children}
              </ActivityGroup>
            );
          case 'text':
            return <AssistantMessageText />;
          case 'reasoning':
            return <ActivityReasoningBlock part={part} />;
          case 'tool-call':
            if (
              part.result === undefined &&
              part.status.type === 'requires-action' &&
              cardedCalls.has(part.toolCallId) &&
              !isSubagentDelegationToolName(part.toolName)
            ) {
              return null;
            }
            return (
              <ActivityPartLayout>
                {part.toolUI ?? <ActivityToolPart {...part} />}
              </ActivityPartLayout>
            );
          case 'data':
            return part.dataRendererUI;
          case 'indicator':
            return trailingGroupHoldsActivity ? null : (
              <AssistantThinkingIndicator
                className="bs-streaming-thinking"
                markClassName="size-4"
              />
            );
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

AssistantActivityParts.displayName = 'AssistantActivityParts';
