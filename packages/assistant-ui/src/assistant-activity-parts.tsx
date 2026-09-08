import { MessagePrimitive, type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { createContext, type ReactNode, use, useId, useMemo, useState } from 'react';
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

function isReasoningPart(part: unknown): boolean {
  return Boolean(
    part && typeof part === 'object' && (part as { readonly type?: unknown }).type === 'reasoning'
  );
}

function isRunningReasoningPart(part: unknown): boolean {
  if (!isReasoningPart(part)) {
    return false;
  }
  const status = (part as { readonly status?: unknown }).status;
  return Boolean(
    status &&
      typeof status === 'object' &&
      (status as { readonly type?: unknown }).type === 'running'
  );
}

function reasoningToggleLabel(collapsed: boolean): string {
  return collapsed ? 'Show thinking' : 'Hide thinking';
}

/**
 * Per-group reasoning fold state. The library no longer owns a
 * `chainOfThought.collapsed` scope on the GroupedParts path, so the wrapper
 * holds it and the reasoning leaves read it through context. Leaves are
 * rendered as descendants of the wrapper (its `children`), so the provider
 * reaches them.
 */
const ReasoningCollapsedContext = createContext<boolean>(true);

/** Renders the reasoning text only while the fold is open. */
function ActivityReasoningLeaf() {
  const collapsed = use(ReasoningCollapsedContext);
  return collapsed ? null : <AssistantReasoningPart />;
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
 * The collapsible reasoning fold: a pill that toggles the reasoning panel.
 * Tool cards always render inside the panel (the reasoning collapse only hides
 * reasoning parts), so the panel stays mounted to keep `aria-controls` valid.
 */
function ChainReasoningFold({
  children,
  collapsed,
  isReasoningRunning,
  onToggle,
  panelId,
}: {
  children: ReactNode;
  collapsed: boolean;
  isReasoningRunning: boolean;
  onToggle: () => void;
  panelId: string;
}): ReactNode {
  return (
    <>
      <button
        aria-controls={panelId}
        aria-expanded={!collapsed}
        aria-label={reasoningToggleLabel(collapsed)}
        className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-2.5 text-left font-medium text-foreground text-xs transition-colors hover:bg-muted/35"
        data-testid="local-chain-of-thought"
        onClick={onToggle}
        type="button"
      >
        {isReasoningRunning ? (
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
              className="bs-thinking-mark-static size-4"
              live={false}
              testId="assistant-reasoning-static-mark"
            />
            <span className="truncate">Thinking</span>
          </span>
        )}
        {collapsed ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      <div
        className={cn(
          'bs-chain-of-thought-panel mt-2 empty:mt-0',
          collapsed ? '' : 'border-border/70 border-l pl-3'
        )}
        id={panelId}
      >
        {children}
      </div>
    </>
  );
}

interface ActivityGroupProps {
  readonly children: ReactNode;
  readonly indices: readonly number[];
  readonly status: { readonly type: string; readonly reason?: string };
}

/**
 * One contiguous activity group. Replaces the panel's `LocalChainOfThought`:
 * reads the group's parts by index from the message (the library's
 * `chainOfThought` scope does not exist on this path), derives the summary /
 * elapsed / durations exactly as before, and renders the unchanged
 * `AssistantActivityGroup` chrome around the reasoning fold.
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
  const hasReasoningParts = groupParts.some(isReasoningPart);
  const isReasoningRunning = groupParts.some(isRunningReasoningPart);
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
  const incompleteReason =
    status.type === 'incomplete' && typeof status.reason === 'string' ? status.reason : undefined;
  // The task-list summary is turn-wide; render it once, in the group that
  // holds the message's first activity part (or in every group when the
  // message has none — the list then has nowhere else to live).
  const firstActivityIndex = messageParts.findIndex(isActivityPart);
  const isFirstGroup = firstActivityIndex === -1 || indices.includes(firstActivityIndex);
  const { activityFallbackMs, shellOutputs, taskList, toolActivity, toolDurations } =
    useChainActivityDerivations(messageParts, messageId, groupParts);
  const [collapsed, setCollapsed] = useState(true);
  const reasoningPanelId = useId();

  const body = (
    <ReasoningCollapsedContext.Provider value={collapsed}>
      {children}
    </ReasoningCollapsedContext.Provider>
  );

  // A group can coalesce purely from group-transparent bookkeeping (e.g. a
  // run of `tool.started`/`tool.completed` events with no reasoning or
  // tool-call anchor, such as a trailing run purely of run-events after the
  // last real activity). With nothing to summarize, render it as if
  // ungrouped rather than showing an empty "Worked" card.
  if (!hasActivityParts) {
    return body;
  }

  return (
    <div className="bs-chain-of-thought mb-2 block max-w-2xl">
      {isFirstGroup && taskList ? <TodoProgress result={taskList} /> : null}
      <ToolDurationProvider durations={toolDurations}>
        <ShellOutputProvider outputs={shellOutputs}>
          <AssistantActivityGroup
            fallbackMs={activityFallbackMs}
            incompleteReason={
              incompleteReason as Parameters<typeof AssistantActivityGroup>[0]['incompleteReason']
            }
            isActive={isActivityActive}
            summary={toolActivity}
          >
            {hasReasoningParts ? (
              <ChainReasoningFold
                collapsed={collapsed}
                isReasoningRunning={isReasoningRunning}
                onToggle={() => setCollapsed((value) => !value)}
                panelId={reasoningPanelId}
              >
                {body}
              </ChainReasoningFold>
            ) : (
              body
            )}
          </AssistantActivityGroup>
        </ShellOutputProvider>
      </ToolDurationProvider>
    </div>
  );
}

/**
 * The assistant message's parts renderer. `indicator="never"` keeps the
 * streaming placeholder where it already lives (markdown-text.tsx renders the
 * thinking indicator for an empty running text part).
 */
export function AssistantActivityParts(): ReactNode {
  return (
    <MessagePrimitive.GroupedParts<ActivityGroupKey>
      groupBy={groupAssistantActivityPart}
      indicator="never"
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
            return (
              <ActivityPartLayout>
                <ActivityReasoningLeaf />
              </ActivityPartLayout>
            );
          case 'tool-call':
            return (
              <ActivityPartLayout>
                {part.toolUI ?? <ActivityToolPart {...part} />}
              </ActivityPartLayout>
            );
          case 'data':
            return part.dataRendererUI;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

AssistantActivityParts.displayName = 'AssistantActivityParts';
