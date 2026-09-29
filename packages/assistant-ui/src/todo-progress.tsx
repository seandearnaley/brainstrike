/**
 * TodoProgress — compact progress bar + checklist for the assistant's task list.
 *
 * Derived from the latest `brainstrike.manageTaskList` tool result in the
 * message stream (see derive-task-list.ts), so it renders identically live and
 * after a thread reload with no separate UI persistence. Renders nothing for an
 * empty list.
 */
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  type AssistantTaskStatus,
  type ManageTaskListResult,
  NATIVE_TOOL_ID,
  readMcpTaskToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { cn } from '@brainstrike/ui';
import { use, useId, useState } from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { StepRowHeader } from './activity-step-row';
import { toolStepStateFor } from './activity-trace-model';
import { McpTaskToolResult } from './mcp-task-tool-result';
import {
  isSubagentDelegationToolName,
  SUBAGENT_TOOL_CARDS,
  SubagentDelegationCard,
} from './subagent-tool-cards';
import { ToolFallback } from './tool-fallback';
import { useToolResultRenderers } from './use-tool-result-renderers';

const STATUS_GLYPH: Record<AssistantTaskStatus, string> = {
  completed: '✓',
  // biome-ignore lint/style/useNamingConvention: AssistantTaskStatus value (Mastra convention)
  in_progress: '▸',
  pending: '○',
};

const STATUS_GLYPH_CLASS: Record<AssistantTaskStatus, string> = {
  completed: 'text-emerald-500',
  // biome-ignore lint/style/useNamingConvention: AssistantTaskStatus value (Mastra convention)
  in_progress: 'text-sky-500',
  pending: 'text-muted-foreground',
};

export interface TodoProgressProps {
  result: ManageTaskListResult;
}

export function TodoProgress({ result }: TodoProgressProps): React.JSX.Element | null {
  const { summary, tasks } = result;
  if (tasks.length === 0) {
    return null;
  }

  const percent = summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;

  return (
    <section
      aria-label="Task list progress"
      className="bs-todo-progress mb-2 max-w-xl rounded-md border border-border bg-background/60 p-2 text-sm"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-medium text-foreground">Tasks</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {summary.completed}/{summary.total}
        </span>
        <div
          aria-label="Completed tasks"
          aria-valuemax={summary.total}
          aria-valuemin={0}
          aria-valuenow={summary.completed}
          className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <ul className="flex flex-col gap-0.5">
        {tasks.map((task) => (
          <li className="flex items-start gap-2 leading-snug" key={task.id}>
            <span aria-hidden className={cn('mt-px', STATUS_GLYPH_CLASS[task.status])}>
              {STATUS_GLYPH[task.status]}
            </span>
            <span
              className={cn(
                task.status === 'completed' && 'text-muted-foreground line-through',
                task.status === 'in_progress' && 'font-medium text-foreground'
              )}
            >
              {task.status === 'in_progress' ? task.activeForm : task.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Compact per-tool card for `manageTaskList` calls. The rich checklist renders
 * once as {@link TodoProgress}; this collapses the raw tool card to a subtle
 * disclosure so the plan is not shown twice, while keeping the raw args/result
 * reachable behind the expander (ruling: hide the raw card body, keep raw args
 * reachable via the existing expander pattern).
 *
 * BST-1681: the disclosure is the shared L1 step row, not a `<details>` —
 * every card inside an activity group reads as the same row grammar, and the
 * verb carries the tense ("Updating tasks" while the call runs, "Updated
 * tasks" once it settled) instead of the state-blind "Task list update".
 * Local `useState` rather than the native element's own open state, because
 * the row is a `<button>` with `aria-expanded`/`aria-controls`.
 */
export const TaskListToolCard: ToolCallMessagePartComponent = ({
  args,
  argsText,
  isError = false,
  result,
  status,
  toolCallId,
  toolName,
}) => {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const rawArgs = argsText ?? (args === undefined ? '' : JSON.stringify(args, null, 2));
  const rawResult = result === undefined ? undefined : JSON.stringify(result, null, 2);
  // THE shared step state machine (task 5 review, Important 1) — the same one
  // the trace headline and ToolFallback read. A local `running ? running :
  // done` gave a cancelled or errored call a green Completed while the group
  // that contains it called the same step Stopped/Failed.
  const glyphState = toolStepStateFor({ isError, result, status });
  const isRunning = glyphState === 'running';
  const hasBody = Boolean(rawArgs) || rawResult !== undefined;
  return (
    <div className="bs-tasklist-tool-card my-1 rounded-md border border-border/60 bg-background/40 text-xs">
      <StepRowHeader
        family="tasks"
        label={open ? 'Collapse details' : 'Expand details'}
        state={glyphState}
        // The group's last-running lookup is keyed by `toolCallId`; without it
        // a task-list call that IS the group's last running step would be the
        // one row that never shimmers.
        stepId={toolCallId}
        target={null}
        // The part's OWN id (BST-1686): this card used to hard-code
        // `NATIVE_TOOL_ID.manageTaskList` here regardless of which of the
        // `by_name` map's two keys the part actually arrived under, so a
        // part named under the Mastra-sanitized `brainstrike_manageTaskList`
        // displayed the dotted canonical form instead — an undocumented
        // normalization on the "raw tool id as text" contract every other
        // card in the trace honors verbatim.
        toolName={toolName}
        verb={isRunning ? 'Updating tasks' : 'Updated tasks'}
        // The toggle trio travels together, as it does in ToolFallback (bot
        // round 1, Claude Minor 9): with neither raw args nor a raw result
        // the body would be empty, so the row renders as its non-interactive
        // form instead of a button promising details that do not exist.
        // Conditional spread, not `x ?? undefined`: under
        // `exactOptionalPropertyTypes` an optional prop may be absent but
        // never explicitly `undefined`.
        {...(hasBody ? { bodyId, expanded: open, onToggle: () => setOpen(!open) } : {})}
      />
      {open ? (
        <div className="flex flex-col gap-1 px-2.5 pb-2" id={bodyId}>
          {rawArgs ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              {rawArgs}
            </pre>
          ) : null}
          {rawResult ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              {rawResult}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * `MessagePrimitive.PartByIndex` tool-components map for the chain-of-thought
 * fallback. The plan renders once as {@link TodoProgress}; this collapses the
 * raw `manageTaskList` cards (dotted + Mastra-sanitized tool names) to
 * {@link TaskListToolCard} so the plan is not shown twice, renders subagent
 * delegation tools (`agent-<personaId>`) as a collapsed SubagentExecutionCard,
 * and falls back to the shared {@link ToolFallback} for every other tool.
 */
/**
 * Fallback router: `by_name` above is exact-match, so a USER-DEFINED persona's
 * delegation part (`agent-<id>` for an id unknown at build time) would land on
 * the raw ToolFallback. Route every delegation-prefixed part to the collapsed
 * SubagentExecutionCard instead; everything else keeps the shared ToolFallback.
 */
const ToolFallbackWithSubagents: typeof ToolFallback = (props) => {
  // Host-registered result renderers (BST-1572): the adapter package that owns
  // a surface supplies the descriptor, so nothing host-specific is imported
  // here. Claimed by result SHAPE, never by a `by_name` entry.
  const renderers = useToolResultRenderers();
  // The persisted thread owning this part; a host renderer acting on the
  // part's behalf (MCP Apps) correlates admission through it.
  const threadId = use(ActiveThreadKeyContext);
  if (isSubagentDelegationToolName(props.toolName)) {
    return <SubagentDelegationCard {...props} />;
  }
  const renderer =
    props.result === undefined
      ? undefined
      : renderers.find((candidate) => candidate.matches(props.result));
  if (renderer) {
    return <renderer.Component {...props} threadId={threadId} />;
  }
  // BST-1566: a task-producing MCP tool persists the `{ kind: 'mcp-task' }`
  // marker as its raw result. Tool names are server-defined, so the branch is
  // on the result shape (exact-match reader), never a `by_name` entry.
  const mcpTask =
    props.result === undefined ? undefined : readMcpTaskToolInvocationResult(props.result);
  if (mcpTask) {
    return <McpTaskToolResult snapshot={mcpTask} />;
  }
  return <ToolFallback {...props} />;
};

export const CHAIN_OF_THOUGHT_TOOL_COMPONENTS: {
  /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "by_name" key */
  by_name: Record<string, ToolCallMessagePartComponent>;
  /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Fallback" key */
  Fallback: ToolCallMessagePartComponent;
} = {
  /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "by_name" key */
  by_name: {
    [NATIVE_TOOL_ID.manageTaskList.replaceAll('.', '_')]: TaskListToolCard,
    [NATIVE_TOOL_ID.manageTaskList]: TaskListToolCard,
    // Subagent delegation tools (`agent-<personaId>`) render as a collapsed
    // SubagentExecutionCard, not a raw tool card.
    ...SUBAGENT_TOOL_CARDS,
  },
  /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Fallback" key */
  Fallback: ToolFallbackWithSubagents,
};
