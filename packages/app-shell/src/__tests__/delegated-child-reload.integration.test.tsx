import type { DelegatedConversationRoot } from '../delegated-conversation-owner';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';
import '@testing-library/jest-dom/vitest';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  createDelegatedConversationRepository,
  migrate,
  readAssistantHistoryMessages,
  wasmLoader,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { ChildView } from '../delegated-workspace-child-view';
import { type ChildNode, loadDelegatedWorkspaceNode } from '../delegated-workspace-node';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';

let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
let node: ChildNode;
let rootThreadId: string;
const append = vi.fn();
let activeRoot: DelegatedConversationRoot | undefined;
const identity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'child-call',
  personaId: 'explore',
};

function OwningRoot() {
  const root = useDelegatedConversationRoot('owner', rootThreadId);
  useEffect(() => {
    activeRoot = root;
    return root?.onRuntimeReady({
      thread: { append, getState: () => ({ threadId: rootThreadId }) },
    });
  }, [root]);
  return null;
}

beforeEach(async () => {
  database = await wasmLoader.createPGlite('memory://');
  await migrate(database);
  const history = createPgliteAssistantThreadRepository(database as DbHandle);
  const root = await history.createThread('owner');
  const child = await history.createThread('native-child');
  rootThreadId = root.id;
  await history.createThreadRun({
    id: 'host',
    model: 'test',
    provider: 'openai',
    resourceId: 'owner',
    runtimeKind: 'hosted',
    status: 'completed',
    threadId: root.id,
    turnMessageId: 'root-user',
  });
  const graph = createDelegatedConversationRepository(database);
  const scope = { ownerResourceId: 'owner', rootThreadId: root.id };
  await graph.registerRoot(scope);
  await graph.createChild(scope, {
    color: 'emerald',
    configuration: {},
    displayName: 'Cedar',
    parentThreadId: root.id,
    resourceId: 'native-child',
    threadId: child.id,
  });
  await graph.createInvocation(scope, {
    ...identity,
    hostRunId: 'host',
    parentThreadId: root.id,
    threadId: child.id,
  });
  await graph.bindInvocationRun(scope, identity, identity.childRuntimeRunId);
  node = await loadDelegatedWorkspaceNode(graph, { ...scope, threadId: child.id });
  await database.query(
    `INSERT INTO mastra_messages (id, thread_id, "resourceId", role, type, content, "createdAt") VALUES ('saved-child', $1, 'native-child', 'assistant', 'v2', $2, NOW())`,
    [
      child.id,
      JSON.stringify({
        format: 2,
        parts: [{ text: 'Persisted native child transcript.', type: 'text' }],
      }),
    ]
  );
  Object.defineProperty(window, 'assistant', {
    configurable: true,
    value: { url: 'http://assistant.test' },
  });
}, 30_000);

afterEach(async () => {
  cleanup();
  activeRoot = undefined;
  Reflect.deleteProperty(window, 'assistant');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await database.close();
});

describe('child view after renderer restart', () => {
  it('shows arriving host output before a pending recovery read settles', async () => {
    let settle: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    render(
      <TooltipProvider>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </TooltipProvider>
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const messages = await readAssistantHistoryMessages(database, node.threadId, node.resourceId, {
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
    const update = delegatedUpdate(
      node.threadId,
      'new-host-leg',
      'Live output while recovery is pending.'
    );
    if (!update.baseline) {
      throw new Error('Missing test baseline');
    }
    const baseline = {
      ...update.baseline,
      messages: messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString(),
      })),
    };
    act(() => {
      activeRoot?.onDelegatedConversation({ ...update, baseline });
    });
    expect(await screen.findByText('Live output while recovery is pending.')).toBeVisible();
    await act(async () => {
      settle?.(Response.json({ approvals: [], suspends: [] }));
    });
    expect(screen.getByText('Live output while recovery is pending.')).toBeVisible();
    expect(screen.getByText('Persisted native child transcript.')).toBeVisible();
    expect(append).not.toHaveBeenCalled();
  });
  it('keeps native history visible when pending decision discovery fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 }))
    );
    render(
      <TooltipProvider>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </TooltipProvider>
    );
    expect(await screen.findByText('Persisted native child transcript.')).toBeVisible();
    expect(await screen.findByText('Pending decisions could not be restored')).toBeVisible();
    expect(append).not.toHaveBeenCalled();
  });

  it.each(['approval', 'question'] as const)(
    'restores a native %s card and routes the click through the owning root',
    async (kind) => {
      const target = {
        delegation: { path: [identity], toolCallId: 'leaf' },
        runId: 'parent-run',
        toolCallId: 'child-call',
      };
      const common = { ...target, stale: false, suspendedAt: '2026-09-10T00:00:00.000Z' };
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/assistant/suspended-runs');
        expect(url.searchParams.get('threadId')).toBe(rootThreadId);
        expect(url.searchParams.get('resourceId')).toBe('owner');
        return Response.json({
          approvals:
            kind === 'approval'
              ? [{ ...common, args: { path: 'report.txt' }, toolName: 'workspace.writeFile' }]
              : [],
          suspends:
            kind === 'question'
              ? [
                  {
                    ...common,
                    suspendPayload: { question: 'Which language?' },
                    toolName: 'brainstrike.askUser',
                  },
                ]
              : [],
        });
      });
      vi.stubGlobal('fetch', fetch);
      render(
        <TooltipProvider>
          <DelegatedConversationRootsProvider>
            <OwningRoot />
            <ChildView db={database as DbHandle} node={node} />
          </DelegatedConversationRootsProvider>
        </TooltipProvider>
      );
      expect(await screen.findByText('Persisted native child transcript.')).toBeVisible();
      expect(append).not.toHaveBeenCalled();
      const user = userEvent.setup();
      if (kind === 'approval') {
        await user.click(
          await screen.findByRole('button', { name: /approve workspace.writefile/i })
        );
      } else {
        await user.type(await screen.findByRole('textbox', { name: /answer/i }), 'TypeScript');
        await user.click(
          within(screen.getByTestId('assistant-ask-user-notice')).getByRole('button', {
            name: /^send$/i,
          })
        );
      }
      await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
      const key = kind === 'approval' ? TOOL_APPROVAL_RUN_CONFIG_KEY : TOOL_SUSPEND_RUN_CONFIG_KEY;
      expect(append.mock.calls[0]?.[0]).toMatchObject({
        role: 'user',
        runConfig: {
          custom: {
            [key]: {
              ...target,
              ...(kind === 'approval'
                ? { action: 'approve' }
                : { resumeData: { answer: 'TypeScript' } }),
            },
          },
        },
        startRun: true,
      });
      expect(append.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
      expect(append.mock.calls[0]?.[0]).not.toHaveProperty('sourceId');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
});
