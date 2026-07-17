import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CornerDownRight,
} from 'lucide-react';
import { type ComponentProps, type ReactElement, useMemo, useState } from 'react';
import { Button } from '../button';
import { personaLabelForToolName } from './subagent-persona-label';
import {
  mergeSubagentToolRows,
  readSubAgentToolRows,
  type SubAgentToolRow,
} from './subagent-tool-rows';
import { useToolDurationMs } from './tool-duration-context';
import { formatActivityDuration } from './tool-durations';

/** Presentational-card props: the tool-part fields plus optional live rows. */
export type SubagentCardProps = Pick<
  ComponentProps<ToolCallMessagePartComponent>,
  'toolName' | 'toolCallId' | 'result' | 'status'
> & {
  /** In-flight child rows from live `subagent.tool.*` events (see SUBAGENTS). */
  liveRows?: readonly SubAgentToolRow[];
};
type ToolStatus = SubagentCardProps['status'];

type DisplayStatus = 'error' | 'running' | 'success';

const STATUS_LABELS: Record<DisplayStatus, string> = {
  error: 'Failed',
  running: 'Running',
  success: 'Completed',
};

const STATUS_ICONS: Record<DisplayStatus, ReactElement> = {
  error: <AlertCircle aria-hidden="true" className="size-4 text-destructive" />,
  running: (
    <CircleDashed aria-hidden="true" className="size-4 animate-pulse text-muted-foreground" />
  ),
  success: <CheckCircle aria-hidden="true" className="size-4 text-green-600 dark:text-green-500" />,
};

const ROW_ICONS: Record<DisplayStatus, ReactElement> = {
  error: <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />,
  running: (
    <CircleDashed
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-pulse text-muted-foreground"
    />
  ),
  success: (
    <CheckCircle
      aria-hidden="true"
      className="size-3.5 shrink-0 text-green-600 dark:text-green-500"
    />
  ),
};

function resolveDisplayStatus(status: ToolStatus): DisplayStatus {
  if (status.type === 'running') {
    return 'running';
  }
  if (status.type === 'incomplete') {
    return 'error';
  }
  return 'success';
}

const EMPTY_LIVE_ROWS: readonly SubAgentToolRow[] = [];

/**
 * Collapsed card for a subagent delegation (`agent-<key>`) tool part. Status
 * comes from `status.type`; per-child rows merge the persisted result's
 * `subAgentToolResults` (authoritative at completion + on reload) with LIVE
 * in-flight `subagent.tool.*` rows (`liveRows`, threaded by the connected
 * wrapper). Nested `subagent.*` run events are filtered out of the main timeline
 * (they belong to this card).
 */
export const SubagentExecutionCard = ({
  toolName,
  toolCallId,
  result,
  status,
  liveRows = EMPTY_LIVE_ROWS,
}: SubagentCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const displayStatus = resolveDisplayStatus(status);
  const label = personaLabelForToolName(toolName);
  const rows = useMemo(
    () => mergeSubagentToolRows(readSubAgentToolRows(result), liveRows),
    [result, liveRows]
  );
  const durationMs = useToolDurationMs(toolCallId);
  const elapsed = durationMs === undefined ? undefined : formatActivityDuration(durationMs);
  const hasRows = rows.length > 0;

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      <Button
        aria-expanded={expanded}
        className="flex h-auto w-full items-center gap-2 px-3 py-2 text-left font-normal"
        disabled={!hasRows}
        onClick={() => setExpanded((value) => !value)}
        type="button"
        variant="ghost"
      >
        <CornerDownRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {STATUS_ICONS[displayStatus]}
        <span className="font-medium">{label} subagent</span>
        <span className="text-muted-foreground">· {STATUS_LABELS[displayStatus]}</span>
        <span className="text-muted-foreground">
          · {rows.length} tool {rows.length === 1 ? 'call' : 'calls'}
        </span>
        {elapsed ? <span className="text-muted-foreground">· {elapsed}</span> : null}
        {hasRows ? (
          <span className="ml-auto shrink-0 text-muted-foreground">
            {expanded ? (
              <ChevronUp aria-hidden="true" className="size-4" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-4" />
            )}
          </span>
        ) : null}
      </Button>
      {expanded && hasRows ? (
        <ul className="border-border border-t px-3 py-2">
          {rows.map((row) => (
            <li className="flex items-center gap-2 py-1" key={row.key}>
              {ROW_ICONS[row.status]}
              <span className="font-mono text-xs">{row.toolName}</span>
              {row.argSummary ? (
                <span className="truncate text-muted-foreground text-xs">{row.argSummary}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
