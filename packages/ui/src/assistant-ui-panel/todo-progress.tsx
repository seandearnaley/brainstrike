/**
 * TodoProgress — compact progress bar + checklist for the assistant's task list.
 *
 * Derived from the latest `brainstrike.manageTaskList` tool result in the
 * message stream (see derive-task-list.ts), so it renders identically live and
 * after a thread reload with no separate UI persistence. Renders nothing for an
 * empty list.
 */
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import type { AssistantTaskStatus, ManageTaskListResult } from '@brainstrike/assistant-contract';
import { cn } from '../lib/utils';
import { SUBAGENT_TOOL_CARDS } from './subagent-tool-cards';
import { ToolFallback } from './tool-fallback';

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
 */
export const TaskListToolCard: ToolCallMessagePartComponent = ({ args, argsText, result }) => {
  const rawArgs = argsText ?? (args === undefined ? '' : JSON.stringify(args, null, 2));
  const rawResult = result === undefined ? undefined : JSON.stringify(result, null, 2);
  return (
    <details className="bs-tasklist-tool-card my-1 rounded-md border border-border/60 bg-background/40 text-xs">
      <summary className="cursor-pointer select-none px-2.5 py-1 font-mono text-muted-foreground">
        Task list update
      </summary>
      <div className="flex flex-col gap-1 px-2.5 pb-2">
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
    </details>
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
export const CHAIN_OF_THOUGHT_TOOL_COMPONENTS = {
  /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "by_name" key */
  by_name: {
    // biome-ignore lint/style/useNamingConvention: Mastra-sanitized tool name key
    brainstrike_manageTaskList: TaskListToolCard,
    'brainstrike.manageTaskList': TaskListToolCard,
    // Subagent delegation tools (`agent-<personaId>`) render as a collapsed
    // SubagentExecutionCard, not a raw tool card.
    ...SUBAGENT_TOOL_CARDS,
  },
  /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Fallback" key */
  Fallback: ToolFallback,
};
