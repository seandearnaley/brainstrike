import {
  type EnrichedPartState,
  type MessagePartStatus,
  MessagePrimitive,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  useAuiState,
} from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { AssistantActivityGroup } from './assistant-activity-group';
import {
  ACTIVITY_GROUP_KEY,
  type ActivityGroupKey,
  groupAssistantActivityPart,
  isActivityPart,
} from './assistant-activity-grouping';
import { AssistantMessageText } from './assistant-message-text';
import { AssistantReasoningPart } from './assistant-reasoning-part';
import {
  AssistantThinkingIndicator,
  BrainstrikeThinkingMark,
} from './assistant-thinking-indicator';
import { ShellOutputProvider } from './shell-output-context';
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
 * tool calls renders as one `AssistantActivityGroup`.
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
 * One reasoning part's own disclosure pill + panel (BST-1677 wave 2). Each
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
 * part (e.g. an intervening tool call) arrives. Guarded by
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
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={reasoningToggleLabel(open)}
        className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-2.5 text-left font-medium text-foreground text-xs transition-colors hover:bg-muted/35"
        data-testid="local-chain-of-thought"
        onClick={() => setUserOpen(!open)}
        type="button"
      >
        {isStreaming ? (
          <AssistantThinkingIndicator
            className="min-w-0"
            markClassName="size-4"
            textClassName="truncate"
          />
        ) : (
          <span
            className="bs-thinking-indicator min-w-0"
            data-testid="assistant-reasoning-indicator"
          >
            <BrainstrikeThinkingMark
              className="size-4"
              live={false}
              testId="assistant-reasoning-static-mark"
            />
            <span className="truncate">Thinking</span>
          </span>
        )}
        {open ? (
          <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
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
  readonly children: ReactNode;
  readonly indices: readonly number[];
  readonly status: MessagePartStatus | ToolCallMessagePartStatus;
}

/**
 * Narrows a `GroupPart.status` (part-level: `MessagePartStatus |
 * ToolCallMessagePartStatus`) down to the reason `AssistantActivityGroup`
 * accepts (message-level: `Extract<MessageStatus, { type: 'incomplete'
 * }>['reason']`). The two unions are independently declared — see the prop's
 * own comment in assistant-activity-group.tsx — but their `'incomplete'`
 * reason values happen to coincide, so the return type here is checked
 * assignability, not a cast.
 */
function toIncompleteReason(
  status: MessagePartStatus | ToolCallMessagePartStatus
): Parameters<typeof AssistantActivityGroup>[0]['incompleteReason'] {
  return status.type === 'incomplete' ? status.reason : undefined;
}

/**
 * One contiguous activity group. Replaces the panel's now-deleted local
 * chain-of-thought renderer (BST-1677): reads the group's parts by index from
 * the message (the library's `chainOfThought` scope does not exist on this
 * path), derives the summary / elapsed / durations exactly as before, and
 * renders the unchanged `AssistantActivityGroup` chrome around its children.
 * Each reasoning leaf owns its own disclosure (`ActivityReasoningBlock`), so
 * the group body renders `children` directly — tool cards and reasoning
 * blocks interleaved in part order.
 */
function ActivityGroup({ children, indices, status }: ActivityGroupProps): ReactNode {
  const messageParts = useAuiState((state) => state.message.parts);
  const messageId = useAuiState((state) => (state.message as { id?: string }).id ?? '');
  const isMessageRunning = useAuiState(
    (state) => state.message.role === 'assistant' && state.message.status.type === 'running'
  );
  const groupParts = useMemo(
    () => indices.map((index) => messageParts[index]).filter((part) => part !== undefined),
    [indices, messageParts]
  );
  const hasActivityParts = groupParts.some(isActivityPart);
  // A group's own member statuses can all already read "complete" (e.g. a
  // tool-call result arrives atomically in one streamed chunk) even though
  // the group is still the OPEN, trailing run of a message that hasn't
  // finished — the next chunk may fence another tool call into this same
  // coalesced key. Treat that case as active too, so the card doesn't look
  // finished a beat before the next call actually starts.
  const isTrailingGroup = indices.at(-1) === messageParts.length - 1;
  const isActivityActive =
    status.type === 'running' ||
    (isMessageRunning && isTrailingGroup && status.type !== 'incomplete');
  const incompleteReason = toIncompleteReason(status);
  // The task-list summary is turn-wide; render it once, in the group that
  // holds the message's first activity part. (A message with no activity
  // part at all never reaches this branch: `!hasActivityParts` below returns
  // early before `isFirstGroup` is read.)
  const firstActivityIndex = messageParts.findIndex(isActivityPart);
  const isFirstGroup = indices.includes(firstActivityIndex);
  const { activityFallbackMs, shellOutputs, taskList, toolActivity, toolDurations } =
    useChainActivityDerivations(messageParts, messageId, groupParts);

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
          <AssistantActivityGroup
            fallbackMs={activityFallbackMs}
            incompleteReason={incompleteReason}
            isActive={isActivityActive}
            summary={toolActivity}
          >
            {children}
          </AssistantActivityGroup>
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
 * regressed both cases. When an empty running text part exists it is normally
 * the LAST part (the stream never opens a text part and then appends another
 * part before its first delta), so the library emits no indicator and
 * `markdown-text.tsx` owns the placeholder; the one theoretical overlap (an
 * empty running text part that is not last) is a shape the legacy
 * `MessagePrimitive.Parts` path shared.
 */
export function AssistantActivityParts(): ReactNode {
  return (
    <MessagePrimitive.GroupedParts<ActivityGroupKey>
      groupBy={groupAssistantActivityPart}
      indicator="no-text"
    >
      {({ children, part }) => {
        switch (part.type) {
          case ACTIVITY_GROUP_KEY:
            return (
              <ActivityGroup indices={part.indices} status={part.status}>
                {children}
              </ActivityGroup>
            );
          case 'text':
            return <AssistantMessageText />;
          case 'reasoning':
            return <ActivityReasoningBlock part={part} />;
          case 'tool-call':
            return (
              <ActivityPartLayout>
                {part.toolUI ?? <ActivityToolPart {...part} />}
              </ActivityPartLayout>
            );
          case 'data':
            return part.dataRendererUI;
          case 'indicator':
            return (
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
