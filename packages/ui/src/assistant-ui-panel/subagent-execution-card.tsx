import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  BUILT_IN_PERSONAS,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '@brainstrike/assistant-contract/personas';
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
import { useToolDurationMs } from './tool-duration-context';
import { formatActivityDuration } from './tool-durations';
import { extractPrimaryArg } from './tool-fallback';

type SubagentCardProps = ComponentProps<ToolCallMessagePartComponent>;
type ToolStatus = SubagentCardProps['status'];

type DisplayStatus = 'running' | 'error' | 'success';

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

const PERSONA_LABELS = new Map<string, string>(
  BUILT_IN_PERSONAS.map((persona) => [persona.id, persona.label])
);

/** Resolve the human label for an `agent-<id>` delegation tool name. */
export function personaLabelForToolName(toolName: string): string {
  if (!toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX)) {
    return toolName;
  }
  const personaId = toolName.slice(SUBAGENT_DELEGATION_TOOL_PREFIX.length);
  return PERSONA_LABELS.get(personaId) ?? toolName;
}

interface SubAgentToolRow {
  argSummary: string | undefined;
  isError: boolean;
  key: string;
  toolName: string;
}

function resolveDisplayStatus(status: ToolStatus): DisplayStatus {
  if (status.type === 'running') {
    return 'running';
  }
  if (status.type === 'incomplete') {
    return 'error';
  }
  return 'success';
}

/** Read the child tool rows from a delegation result's `subAgentToolResults`. */
function readSubAgentToolRows(result: unknown): SubAgentToolRow[] {
  if (!(result && typeof result === 'object')) {
    return [];
  }
  const list = (result as { subAgentToolResults?: unknown }).subAgentToolResults;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : 'tool';
    const toolCallId = typeof record['toolCallId'] === 'string' ? record['toolCallId'] : undefined;
    return {
      argSummary: extractPrimaryArg(record['args'], undefined),
      isError: record['isError'] === true,
      key: toolCallId ?? `${toolName}-${index}`,
      toolName,
    };
  });
}

/**
 * Collapsed card for a subagent delegation (`agent-<key>`) tool part. Sourced
 * from the tool part itself — status from `status.type`, per-child-tool rows from
 * the result's `subAgentToolResults` — so it renders identically live (at
 * completion) and on reload. Nested `subagent.*` run events are filtered out of
 * the main timeline (they belong to this card).
 */
export const SubagentExecutionCard: ToolCallMessagePartComponent = ({
  toolName,
  toolCallId,
  result,
  status,
}) => {
  const [expanded, setExpanded] = useState(false);
  const displayStatus = resolveDisplayStatus(status);
  const label = personaLabelForToolName(toolName);
  const rows = useMemo(() => readSubAgentToolRows(result), [result]);
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
              {row.isError ? (
                <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <CheckCircle
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-green-600 dark:text-green-500"
                />
              )}
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
