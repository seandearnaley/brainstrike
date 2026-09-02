import type { McpTaskBridge } from '@brainstrike/assistant-contract';
import type {
  McpTaskHandle,
  McpTaskPresentation,
  McpTaskPresentationControllerPort,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import { createLogger } from '@brainstrike/logging';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { McpTaskStatusCard } from './mcp-task-status-card';
import { useMcpTaskBridge } from './use-mcp-task-bridge';

const logger = createLogger('McpTaskToolResult');

/**
 * Live status for a task-producing tool call (BST-1566). The persisted tool
 * result is only the correlation marker plus the snapshot taken when the tool
 * returned; everything after that comes from the host bridge: `list()` once on
 * mount adopts the current presentation for THIS handle, `onStatusChanged`
 * applies later observations for the same handle, and actions forward to
 * `bridge.act`. The renderer never polls — desktop main owns polling.
 *
 * Handle equality is the complete opaque handle (serverId, taskId,
 * authorityEpoch, principalId, resource); an observation for any other handle
 * is ignored, and an older observation (`updatedAt` behind the current one)
 * never regresses the card — the same recency fence the card applies to its
 * own action outcomes.
 */
export interface McpTaskToolResultProps {
  readonly snapshot: McpTaskPresentation;
}

type LiveStatus = 'failed' | 'live' | 'syncing' | 'unavailable';

const LIVE_STATUS_NOTE: Readonly<Record<Exclude<LiveStatus, 'live' | 'syncing'>, string>> = {
  failed: 'Live status could not be loaded; showing the last saved state.',
  unavailable: 'Live status unavailable in this host; showing the last saved state.',
};

const NO_BRIDGE_CONTROLLER: McpTaskPresentationControllerPort = {
  act: () =>
    Promise.resolve({
      diagnostic: {
        code: 'action_failed',
        message: 'Task controls are unavailable in this host.',
      },
      ok: false,
    }),
};

function taskHandleKey(handle: McpTaskHandle): string {
  return JSON.stringify([
    handle.authorityEpoch,
    handle.principalId,
    handle.resource,
    handle.serverId,
    handle.taskId,
  ]);
}

function adoptObservation(
  current: McpTaskPresentation,
  observed: McpTaskPresentation
): McpTaskPresentation {
  if (taskHandleKey(observed.handle) !== taskHandleKey(current.handle)) {
    return current;
  }
  return observed.updatedAt >= current.updatedAt ? observed : current;
}

function LiveMcpTask({
  bridge,
  snapshot,
}: {
  readonly bridge: McpTaskBridge | null;
  readonly snapshot: McpTaskPresentation;
}): ReactElement {
  const [task, setTask] = useState(snapshot);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(bridge ? 'syncing' : 'unavailable');
  const controller = useMemo<McpTaskPresentationControllerPort>(
    () => (bridge ? { act: (request) => bridge.act(request) } : NO_BRIDGE_CONTROLLER),
    [bridge]
  );

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let active = true;
    const unsubscribe = bridge.onStatusChanged((event) => {
      if (active) {
        setTask((current) => adoptObservation(current, event.task));
      }
    });
    bridge.list().then(
      (result) => {
        if (!active) {
          return;
        }
        setTask((current) => result.tasks.reduce(adoptObservation, current));
        setLiveStatus('live');
      },
      (error: unknown) => {
        if (!active) {
          return;
        }
        logger.warn('MCP task list failed; card keeps the persisted snapshot', {
          error: error instanceof Error ? error.message : String(error),
        });
        setLiveStatus('failed');
      }
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  return (
    <div className="my-1 max-w-xl">
      <McpTaskStatusCard controller={controller} onTaskChange={setTask} task={task} />
      {liveStatus === 'failed' || liveStatus === 'unavailable' ? (
        <p
          className="mt-1 text-muted-foreground text-xs"
          data-testid="mcp-task-live-status-note"
          role="note"
        >
          {LIVE_STATUS_NOTE[liveStatus]}
        </p>
      ) : null}
    </div>
  );
}

export function McpTaskToolResult({ snapshot }: McpTaskToolResultProps): ReactElement {
  const bridge = useMcpTaskBridge();
  // A replaced handle is a different task: remount so no state carries over.
  return <LiveMcpTask bridge={bridge} key={taskHandleKey(snapshot.handle)} snapshot={snapshot} />;
}
