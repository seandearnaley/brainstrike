import type {
  McpTaskActionRequest,
  McpTaskDiagnostic,
  McpTaskPresentation,
  McpTaskPresentationControllerPort,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import { Button } from '@brainstrike/ui';
import {
  AlertCircle,
  CircleCheck,
  CircleDashed,
  CirclePause,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from 'react';

interface ActionState {
  readonly announcement: string | null;
  readonly diagnostic: McpTaskDiagnostic | null;
  readonly focus: 'alert' | 'summary' | null;
  readonly revision: number;
}

const INITIAL_ACTION_STATE: ActionState = {
  announcement: null,
  diagnostic: null,
  focus: null,
  revision: 0,
};

export interface McpTaskStatusCardProps {
  readonly controller: McpTaskPresentationControllerPort;
  readonly onTaskChange: (task: McpTaskPresentation) => void;
  readonly task: McpTaskPresentation;
}

function formatTimestamp(value: string): string {
  return value.replace('T', ' ').replace('.000Z', ' UTC');
}

function historyRows(history: McpTaskPresentation['history']): readonly {
  readonly entry: McpTaskPresentation['history'][number];
  readonly key: string;
}[] {
  const occurrences = new Map<string, number>();
  return history.map((entry) => {
    const identity = `${entry.at}:${entry.status}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { entry, key: `${identity}:${occurrence}` };
  });
}

function statusLabel(status: McpTaskPresentation['status']): string {
  switch (status) {
    case 'cancelled':
      return 'Cancelled';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'input_required':
      return 'Input required';
    case 'working':
      return 'Working';
  }
}

function statusIcon(status: McpTaskPresentation['status']): ReactElement {
  switch (status) {
    case 'cancelled':
      return <XCircle aria-hidden="true" className="size-3.5" />;
    case 'completed':
      return <CircleCheck aria-hidden="true" className="size-3.5 text-green-600" />;
    case 'failed':
      return <AlertCircle aria-hidden="true" className="size-3.5 text-destructive" />;
    case 'input_required':
      return <CirclePause aria-hidden="true" className="size-3.5 text-amber-600" />;
    case 'working':
      return <CircleDashed aria-hidden="true" className="size-3.5" />;
  }
}

interface TaskActionButtonsProps {
  readonly onAction: (action: McpTaskActionRequest['action']) => void;
  readonly pendingAction: McpTaskActionRequest['action'] | null;
  readonly task: McpTaskPresentation;
}

function TaskActionButtons({
  onAction,
  pendingAction,
  task,
}: TaskActionButtonsProps): ReactElement {
  const pending = pendingAction !== null;
  return (
    <div className="flex flex-wrap gap-2">
      {task.recovery === 'restart_required' ? (
        <Button
          disabled={pending}
          onClick={() => onAction('recover')}
          size="sm"
          type="button"
          variant="outline"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          {pendingAction === 'recover' ? 'Recovering…' : 'Recover task'}
        </Button>
      ) : null}
      {task.canCancel ? (
        <Button
          disabled={pending}
          onClick={() => onAction('cancel')}
          size="sm"
          type="button"
          variant="outline"
        >
          <XCircle aria-hidden="true" className="size-3.5" />
          {pendingAction === 'cancel' ? 'Cancelling…' : 'Cancel task'}
        </Button>
      ) : null}
    </div>
  );
}

function focusOutcome(
  state: ActionState,
  alertRef: RefObject<HTMLDivElement | null>,
  summaryRef: RefObject<HTMLDivElement | null>
): void {
  if (state.focus === 'alert') {
    alertRef.current?.focus();
    return;
  }
  if (state.focus === 'summary') {
    summaryRef.current?.focus();
  }
}

export function McpTaskStatusCard({
  controller,
  onTaskChange,
  task,
}: McpTaskStatusCardProps): ReactElement {
  const titleId = useId();
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [actionState, setActionState] = useState(INITIAL_ACTION_STATE);
  const [pendingAction, setPendingAction] = useState<McpTaskActionRequest['action'] | null>(null);
  const [, startTransition] = useTransition();

  const runAction = (action: McpTaskActionRequest['action']): void => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setPendingAction(action);
    startTransition(async () => {
      let nextState: ActionState;
      try {
        const result = await controller.act({ action, handle: task.handle });
        if (result.ok) {
          onTaskChange(result.task);
          nextState = {
            announcement: action === 'recover' ? 'Task recovery resumed.' : 'Task cancelled.',
            diagnostic: null,
            focus: 'summary',
            revision: actionState.revision + 1,
          };
        } else {
          nextState = {
            announcement: null,
            diagnostic: result.diagnostic,
            focus: 'alert',
            revision: actionState.revision + 1,
          };
        }
      } catch {
        nextState = {
          announcement: null,
          diagnostic: {
            code: 'action_failed',
            message:
              action === 'recover' ? 'MCP task recovery failed.' : 'MCP task cancellation failed.',
          },
          focus: 'alert',
          revision: actionState.revision + 1,
        };
      }
      setActionState(nextState);
      setPendingAction(null);
      inFlightRef.current = false;
    });
  };

  useEffect(() => {
    focusOutcome(actionState, alertRef, summaryRef);
  }, [actionState]);

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm"
      data-testid="mcp-task-status-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm" id={titleId}>
            Background task
          </h3>
          <div
            aria-live="polite"
            className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="mcp-task-status-summary"
            ref={summaryRef}
            role="status"
            tabIndex={-1}
          >
            {statusIcon(task.status)}
            <span>{statusLabel(task.status)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={task.updatedAt}>{formatTimestamp(task.updatedAt)}</time>
          </div>
        </div>
      </div>

      {task.statusMessage ? <p className="mt-2 text-sm">{task.statusMessage}</p> : null}

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">
          Status history ({task.history.length})
        </summary>
        <ol className="mt-2 space-y-1 border-border border-l pl-3">
          {historyRows(task.history).map(({ entry, key }) => (
            <li key={key}>
              <span className="font-medium">{statusLabel(entry.status)}</span>{' '}
              <time className="text-muted-foreground" dateTime={entry.at}>
                {formatTimestamp(entry.at)}
              </time>
            </li>
          ))}
        </ol>
        {task.omittedHistoryEntries > 0 ? (
          <p className="mt-2 text-muted-foreground">
            {task.omittedHistoryEntries} earlier updates omitted
          </p>
        ) : null}
      </details>

      {actionState.diagnostic ? (
        <div
          className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          ref={alertRef}
          role="alert"
          tabIndex={-1}
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{actionState.diagnostic.message}</span>
        </div>
      ) : null}

      {actionState.announcement ? (
        <span aria-live="polite" className="sr-only" role="status">
          {actionState.announcement}
        </span>
      ) : null}

      {task.canCancel || task.recovery === 'restart_required' ? (
        <div className="mt-3">
          <TaskActionButtons onAction={runAction} pendingAction={pendingAction} task={task} />
        </div>
      ) : null}
    </section>
  );
}
