/**
 * The web shell's thread host on the shared log (BST-1940; ADR-0022, 16 Oct
 * amendments): its threads list, start, rename and delete through the
 * browser host client, and each renders as the shared committed
 * conversation. It is not mounted until the browser writer ships
 * (sqlite-wasm 3.54).
 */
import type { AssistantThreadHostCapability } from '@brainstrike/app-shell/assistant-thread-host-context';
import {
  hostThreadWorkspaceRepository,
  projectHostThread,
  projectStartedHostThread,
} from '@brainstrike/host-conversation';
import type { WebHostClient } from '@brainstrike/web-writer/web-host-client';
import { createElement } from 'react';
import { WebHostThread } from './web-host-thread';

export interface WebThreadHostOptions {
  readonly client: WebHostClient;
  /** The hosted provider the next run asks for; Hosted Web chooses its model on the server. */
  readonly readModelId: () => string;
}

export function createWebThreadHost({
  client,
  readModelId,
}: WebThreadHostOptions): AssistantThreadHostCapability {
  // The client's catalog decides ownership; another tab may have started a thread since.
  const owns = async (threadId: string): Promise<boolean> =>
    (await client.request('thread/list', {})).threads.some(
      (thread) => thread.threadId === threadId
    );
  const threadClient = async (threadId: string) => ((await owns(threadId)) ? client : undefined);
  return {
    createThread: async (resourceId) => {
      const { threadId } = await client.request('thread/start', {
        commandId: crypto.randomUUID(),
      });
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return projectStartedHostThread(threadId, resourceId, rows);
    },
    deleteThread: async (threadId) =>
      (await owns(threadId))
        ? (await client.request('thread/delete', { threadId })).threadIds
        : undefined,
    listThreads: async (resourceId) =>
      (await client.request('thread/list', {})).threads.map((entry) =>
        projectHostThread(resourceId, entry)
      ),
    ownsThread: owns,
    renameThread: async (threadId, title) => {
      await client.request('thread/update', { commandId: crypto.randomUUID(), threadId, title });
    },
    renderThread: (threadId, _isVisible, onRunningChange) =>
      createElement(WebHostThread, {
        client,
        key: threadId,
        onRunningChange,
        readModelId,
        threadId,
      }),
    // A web thread has no folder: only its colour and icon are host-owned, and
    // any other key is refused before a request, never reaching history.
    updateThreadBinding: async (threadId, metadata) => {
      const { color, icon, ...binding } = metadata;
      const keys = Object.keys(binding);
      if (keys.length > 0) {
        throw new Error(`Web threads keep no ${keys.join(', ')}; nothing was changed.`);
      }
      if (color !== undefined || icon !== undefined) {
        await client.request('thread/update', {
          commandId: crypto.randomUUID(),
          ...(color === undefined ? {} : { color }),
          ...(icon === undefined ? {} : { icon }),
          threadId,
        });
      }
    },
    workspaceRepository: () => hostThreadWorkspaceRepository(threadClient),
  };
}
