/**
 * Renderer-side READ access to canvas documents (BST-1173).
 *
 * The agent host is the only owner: a thread's canvases are the committed
 * versions in its run log, read through `host.readCanvases`. All writes go
 * through the `brainstrike.manageCanvas` tool. A thread the host does not own
 * has no canvas owner, so every read of it rejects rather than answering empty.
 */
import type {
  AssistantThreadHostCanvasVersion,
  AssistantThreadHostCapability,
} from '../assistant-thread-host-context';

export interface CanvasPanelSummary {
  readonly canvasId: string;
  readonly createdAt: string;
  readonly latestVersion: number;
  readonly title: string;
}

export interface CanvasPanelVersion {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly html: string;
  readonly version: number;
}

type CanvasHost = Pick<AssistantThreadHostCapability, 'readCanvases'> | undefined;

async function readOwnedCanvases(
  host: CanvasHost,
  threadId: string
): Promise<ReadonlyMap<string, readonly AssistantThreadHostCanvasVersion[]>> {
  const owned = await host?.readCanvases?.(threadId);
  if (!owned) {
    throw new Error('This thread is not owned by the agent host, so it has no canvases.');
  }
  return owned;
}

/** Latest version per canvas of a host-owned thread, newest first. */
export async function readThreadCanvasSummaries(
  host: CanvasHost,
  threadId: string
): Promise<readonly CanvasPanelSummary[]> {
  const owned = await readOwnedCanvases(host, threadId);
  return [...owned.values()]
    .flatMap((versions) => {
      const latest = versions.at(-1);
      return latest
        ? [
            {
              canvasId: latest.canvasId,
              createdAt: latest.createdAt,
              latestVersion: latest.version,
              title: latest.title,
            },
          ]
        : [];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** One version's content of a host-owned thread, or null when it does not exist. */
export async function readThreadCanvasVersion(
  host: CanvasHost,
  threadId: string,
  canvasId: string,
  version: number
): Promise<CanvasPanelVersion | null> {
  const owned = await readOwnedCanvases(host, threadId);
  const found = owned.get(canvasId)?.find((candidate) => candidate.version === version);
  return found
    ? {
        createdAt: found.createdAt,
        createdBy: found.createdBy,
        html: found.html,
        version: found.version,
      }
    : null;
}
