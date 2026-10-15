// @vitest-environment jsdom
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { CommittedThreadView } from '@brainstrike/agent-host/thread-view';
import type {
  CommittedAssistantLogRow,
  CommittedAssistantRunIdentity,
} from '@brainstrike/assistant-ui';
import {
  CommittedAssistantConversation,
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
  resetContextUsageStore,
  selectCommittedAssistantTool,
  useCommittedAssistantRuntime,
  useCommittedAssistantSelector,
  useContextUsageStore,
} from '@brainstrike/assistant-ui';
import { useThreadContextStore } from '@brainstrike/assistant-ui/thread-context-store';
import { ToolFallback } from '@brainstrike/assistant-ui/tool-fallback';
import { ToolResultRendererProvider } from '@brainstrike/assistant-ui/tool-result-renderer-context';
import type { ToolResultRenderer } from '@brainstrike/assistant-ui/tool-result-renderers';
// Recorded through public HostCore + native StateStore + the pinned SDK, with a
// local scripted model: two approved runs reuse a toolCallId, with real split
// input, provider metadata, reasoning, tool-written child data and 48 tokens.
import recording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { memo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rows = recording.map((row) => HostLogRowSchema.parse(row));
const threadId = rows[0]?.threadId;
if (!threadId) {
  throw new Error('Missing recorded thread.');
}
const starts = rows.filter((row) => row.event.type === 'run.started');
const identities = new Map<string, CommittedAssistantRunIdentity>();
for (const [index, row] of starts.entries()) {
  if (row.event.type !== 'run.started') {
    continue;
  }
  const runId = row.event.runId;
  const previous = starts[index - 1];
  const accepted = rows.find(
    ({ event }) =>
      event.type === 'command.accepted' &&
      event.method === 'run/start' &&
      event.result !== null &&
      typeof event.result === 'object' &&
      !Array.isArray(event.result) &&
      event.result['runId'] === runId
  );
  if (accepted?.event.type !== 'command.accepted') {
    throw new Error('Missing recorded command.');
  }
  identities.set(runId, {
    // Test-owner identity policy only. Production must inject its canonical policy.
    assistantMessageId: runId,
    createdAt: new Date('2026-10-06T19:48:20.401Z'),
    metadata: { custom: { hostRunId: runId } },
    parentMessageId: previous?.event.type === 'run.started' ? previous.event.runId : null,
    userMessageId: accepted.event.commandId,
  });
}
function identifyRun(row: CommittedAssistantLogRow): CommittedAssistantRunIdentity {
  const identity =
    typeof row.event['runId'] === 'string' ? identities.get(row.event['runId']) : undefined;
  if (!identity) {
    throw new Error('Missing recorded owner identity.');
  }
  return identity;
}

/** Connection publication double around the REAL public committed gap fold. */
class OwnerSource {
  readonly fold = new CommittedThreadView(threadId ?? '');
  readonly listeners = new Set<() => void>();
  private snapshot: CommittedAssistantLogSourceSnapshot = {
    connected: true,
    error: undefined,
    rows: [],
  };
  constructor() {
    this.fold.subscribe(() => this.publish({ rows: this.fold.getSnapshot() }));
  }
  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(change: Partial<CommittedAssistantLogSourceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
const stores: CommittedAssistantLogStore[] = [];
function store(source: OwnerSource): CommittedAssistantLogStore {
  const result = new CommittedAssistantLogStore({ identifyRun, source, threadId: threadId ?? '' });
  stores.push(result);
  return result;
}
afterEach(() => {
  cleanup();
  resetContextUsageStore();
  for (const value of stores.splice(0)) {
    value.dispose();
  }
});

describe('real committed owner fold to production ExternalStore bridge', () => {
  it('records the thread context fold for the displayed branch and clears it with its view', () => {
    const source = new OwnerSource();
    source.fold.accept(rows);
    const bridge = new CommittedAssistantLogStore({ identifyRun, source, threadId });
    const recorded = useThreadContextStore.getState().byThread[threadId];
    // Every recorded run lies on one branch, root first, in commit order.
    expect(recorded?.branchRunIds).toEqual(
      starts.flatMap(({ event }) => (event.type === 'run.started' ? [event.runId] : []))
    );
    expect(recorded?.snapshot.runs.size).toBe(starts.length);
    bridge.dispose();
    expect(useThreadContextStore.getState().byThread[threadId]).toBeUndefined();
  });

  it('displays only the latest committed provider step as context through replay and reopen', async () => {
    const firstStep = rows.findIndex(({ event }) => event.type === 'model.step');
    const source = new OwnerSource();
    source.fold.accept(rows.slice(0, firstStep));
    const bridge = store(source);
    const surface = render(
      <TooltipProvider>
        <CommittedAssistantConversation
          commands={{ onNew: vi.fn() }}
          contextWindow={1000}
          effectiveInputBudget={800}
          label="Recorded host context"
          store={bridge}
        />
      </TooltipProvider>
    );
    expect(useContextUsageStore.getState().usageByThread[threadId]).toBeUndefined();
    await act(async () => {
      source.fold.accept(rows.slice(firstStep));
    });
    // Four recorded model steps each report 1 input / 25 output. The meter
    // reports the latest step's 26 tokens, not the 104-token billed sum.
    expect(useContextUsageStore.getState().usageByThread[threadId]).toEqual({
      inputTokens: 1,
      outputTokens: 25,
    });
    expect(screen.getByRole('button', { name: 'Context usage: 3% of input budget' })).toBeTruthy();
    const usage = useContextUsageStore.getState().usageByThread[threadId];
    await act(async () => {
      source.fold.accept(structuredClone(rows));
    });
    expect(useContextUsageStore.getState().usageByThread[threadId]).toBe(usage);
    surface.unmount();
    resetContextUsageStore();
    const reopened = new OwnerSource();
    reopened.fold.accept(rows);
    render(
      <TooltipProvider>
        <CommittedAssistantConversation
          commands={{ onNew: vi.fn() }}
          contextWindow={1000}
          effectiveInputBudget={800}
          label="Reopened host context"
          store={store(reopened)}
        />
      </TooltipProvider>
    );
    expect(useContextUsageStore.getState().usageByThread[threadId]).toEqual({
      inputTokens: 1,
      outputTokens: 25,
    });
  });

  it('answers a recorded host approval through visible vendor controls and waits for committed resolution', async () => {
    const request = rows.findIndex(({ event }) => event.type === 'interaction.requested');
    const requested = rows[request];
    if (requested?.event.type !== 'interaction.requested') {
      throw new Error('Missing captured host approval');
    }
    const source = new OwnerSource();
    source.fold.accept(rows.slice(0, request + 1));
    const bridge = store(source);
    const response = Promise.withResolvers<void>();
    const respond = vi.fn(() => response.promise);
    const commands = { onNew: vi.fn(), onRespondToToolApproval: respond };
    render(
      <TooltipProvider>
        <CommittedAssistantConversation
          commands={commands}
          label="Recorded host approval"
          store={bridge}
        />
      </TooltipProvider>
    );
    const approve = await screen.findByRole('button', {
      name: `Approve ${requested.event.toolId}`,
    });
    expect(approve).toBeVisible();
    const pending = selectCommittedAssistantTool(
      bridge.getSnapshot(),
      requested.event.runId,
      requested.event.toolCallId
    );
    await act(async () => {
      fireEvent.click(approve);
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: requested.event.interactionId, approved: true })
    );
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(approve);
    expect(respond).toHaveBeenCalledOnce();
    expect(
      selectCommittedAssistantTool(
        bridge.getSnapshot(),
        requested.event.runId,
        requested.event.toolCallId
      )
    ).toBe(pending);
    await act(async () => {
      response.resolve();
      await response.promise;
    });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(approve);
    expect(respond).toHaveBeenCalledOnce();
    await act(async () => {
      source.fold.accept(rows.slice(request + 1));
    });
    expect(screen.queryByRole('button', { name: `Approve ${requested.event.toolId}` })).toBeNull();
    expect(commands.onNew).not.toHaveBeenCalled();
  });
  it('preserves repeated run ownership, reasoning, provider fields and child data with one passive subscription', () => {
    const source = new OwnerSource();
    const extras = { childThreadId: 'captured-view-child', ownerThreadId: threadId };
    source.publish({ extras });
    const bridge = store(source);
    expect(source.listeners.size).toBe(1);
    const notify = vi.fn();
    bridge.subscribe(notify);
    source.fold.accept(rows.slice(12));
    expect(notify).not.toHaveBeenCalled();
    source.fold.accept(rows.slice(0, 12));
    expect(notify).toHaveBeenCalledOnce();
    expect(bridge.getSnapshot().extras).toBe(extras);
    const messages = bridge.getSnapshot().repository.messages;
    const answers = messages.filter(({ message }) => message.role === 'assistant');
    expect(answers).toHaveLength(2);
    const tools = answers.map(({ message }) =>
      message.content.find((part) => part.type === 'tool-call')
    );
    expect(tools[0]?.type === 'tool-call' && tools[0].toolCallId).toBe('recorded-reused-call');
    expect(tools[1]?.type === 'tool-call' && tools[1].toolCallId).toBe('recorded-reused-call');
    expect(tools[0]?.type === 'tool-call' && tools[0].approval?.id).not.toBe(
      tools[1]?.type === 'tool-call' && tools[1].approval?.id
    );
    for (const { message } of answers) {
      // The step's committed reasoning carries the provider fields its
      // `model.step` message kept; the reasoning-start trace was only live.
      const reasoning = message.content.find((part) => part.type === 'reasoning');
      expect(reasoning).toMatchObject({ text: 'The committed effect completed.' });
      expect(reasoning?.providerMetadata).toEqual({
        google: { signature: 'captured-signature' },
      });
      expect(
        message.content.find(
          (part) => part.type === 'data' && part.name === 'brainstrike.child-origin'
        )
      ).toMatchObject({
        data: {
          childThreadId: 'captured-view-child',
          parentRunId: message.id,
          parentToolCallId: 'recorded-reused-call',
        },
      });
    }
    const prior = bridge.getSnapshot();
    source.fold.accept(structuredClone(rows));
    source.publish({});
    expect(bridge.getSnapshot()).toBe(prior);
    expect(notify).toHaveBeenCalledOnce();
    const freshSource = new OwnerSource();
    freshSource.publish({ extras });
    freshSource.fold.accept(rows);
    expect(store(freshSource).getSnapshot()).toEqual(prior);
    bridge.dispose();
    expect(source.listeners.size).toBe(0);
  });

  it('keeps unrelated vendor rows and the shipped tool card stable across 24 actual live text deltas', async () => {
    const second = starts[1];
    if (second?.event.type !== 'run.started') {
      throw new Error('Missing second captured run.');
    }
    const secondId = second.event.runId;
    const first = starts[0];
    if (first?.event.type !== 'run.started') {
      throw new Error('Missing first captured run.');
    }
    const firstId = first.event.runId;
    const textStart = rows.findIndex(
      ({ event }) =>
        event.type === 'stream.chunk' &&
        event.runId === secondId &&
        event.chunk !== null &&
        typeof event.chunk === 'object' &&
        !Array.isArray(event.chunk) &&
        event.chunk['type'] === 'text-start'
    );
    const source = new OwnerSource();
    source.fold.accept(rows.slice(0, textStart));
    const bridge = store(source);
    // The model's text is run telemetry: the recorded chunks reach the store
    // as the host sends them, never as committed rows.
    const opened = rows[textStart]?.event;
    if (opened?.type !== 'stream.chunk') {
      throw new Error('Missing captured text start.');
    }
    bridge.acceptTelemetry(secondId, opened.chunk);
    const renders = { approval: 0, card: 0, first: 0, text: 0 };
    const renderers: readonly ToolResultRenderer[] = [
      {
        Component: (props) => {
          renders.card += 1;
          return <ToolFallback {...props} />;
        },
        kind: 'actual-committed-tool-card',
        matches: () => true,
        preserveEffectsWhenHidden: true,
      },
    ];
    const Message = memo(() => {
      const message = useAuiState((state) => state.message);
      if (message.id === firstId) {
        renders.first += 1;
      }
      return (
        <MessagePrimitive.Root>
          <MessagePrimitive.Parts />
        </MessagePrimitive.Root>
      );
    });
    const Approval = memo(() => {
      useCommittedAssistantSelector(bridge, (snapshot) =>
        selectCommittedAssistantTool(snapshot, secondId, 'recorded-reused-call')
      );
      renders.approval += 1;
      return null;
    });
    const Text = memo(() => {
      useCommittedAssistantSelector(bridge, (snapshot) =>
        snapshot.repository.messages
          .find(({ message }) => message.id === secondId)
          ?.message.content.find((part) => part.type === 'text')
      );
      renders.text += 1;
      return null;
    });
    const commands = { onNew: vi.fn() };
    function RowTrace() {
      const runtime = useCommittedAssistantRuntime({
        commands,
        onCommandError: vi.fn(),
        store: bridge,
      });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Messages components={{ Message }} />
          <Approval />
          <Text />
        </AssistantRuntimeProvider>
      );
    }
    render(
      <>
        <TooltipProvider>
          <ToolResultRendererProvider renderers={renderers}>
            <CommittedAssistantConversation
              commands={commands}
              label="Captured conversation"
              store={bridge}
            />
          </ToolResultRendererProvider>
        </TooltipProvider>
        <RowTrace />
      </>
    );
    const panel = screen.getByTestId('assistant-conversation-panel');
    const input = screen.getByRole('textbox');
    input.focus();
    const before = { ...renders };
    const firstMessage = bridge
      .getSnapshot()
      .repository.messages.find(({ message }) => message.id === firstId)?.message;
    const approval = selectCommittedAssistantTool(
      bridge.getSnapshot(),
      secondId,
      'recorded-reused-call'
    );
    const textEnd = rows.findIndex(
      (row, index) =>
        index > textStart &&
        row.event.type === 'stream.chunk' &&
        row.event.chunk !== null &&
        typeof row.event.chunk === 'object' &&
        !Array.isArray(row.event.chunk) &&
        row.event.chunk['type'] === 'text-end'
    );
    const publications = rows.slice(textStart + 1, textEnd);
    const isTextDelta = ({ event }: (typeof rows)[number]): boolean =>
      event.type === 'stream.chunk' &&
      typeof event.chunk === 'object' &&
      event.chunk !== null &&
      !Array.isArray(event.chunk) &&
      event.chunk['type'] === 'text-delta';
    expect(publications.filter(isTextDelta)).toHaveLength(24);
    // In recorded order: each delta live, the step's `model.step` committed.
    // The step's commit replaces the live text, so the delta after it is not shown.
    for (const row of publications) {
      await act(async () => {
        if (isTextDelta(row) && row.event.type === 'stream.chunk') {
          bridge.acceptTelemetry(secondId, row.event.chunk);
        } else {
          source.fold.accept([row]);
        }
      });
    }
    expect(renders.first).toBe(before.first);
    expect(renders.card).toBe(before.card);
    expect(renders.approval).toBe(before.approval);
    expect(renders.text).toBe(before.text + 24);
    expect(
      bridge
        .getSnapshot()
        .repository.messages.find(({ message }) => message.id === secondId)
        ?.message.content.filter((part) => part.type === 'text')
        .map((part) => part.type === 'text' && part.text)
    ).toEqual([Array.from({ length: 24 }, (_, index) => `Token${index} `).join('')]);
    expect(
      bridge.getSnapshot().repository.messages.find(({ message }) => message.id === firstId)
        ?.message
    ).toBe(firstMessage);
    expect(
      selectCommittedAssistantTool(bridge.getSnapshot(), secondId, 'recorded-reused-call')
    ).toBe(approval);
    expect(screen.getByTestId('assistant-conversation-panel')).toBe(panel);
    expect(document.activeElement).toBe(input);
    expect(commands.onNew).not.toHaveBeenCalled();
  });

  it('reconnects a pending captured approval without optimistic settlement or transcript mutation', async () => {
    const request = rows.findIndex(({ event }) => event.type === 'interaction.requested');
    const requested = rows[request];
    if (requested?.event.type !== 'interaction.requested') {
      throw new Error('Missing captured interaction.');
    }
    const { runId, interactionId, toolCallId } = requested.event;
    const source = new OwnerSource();
    source.fold.accept(rows.slice(0, request + 1));
    const bridge = store(source);
    const respond = vi.fn(async () => undefined);
    const commands = { onNew: vi.fn(), onRespondToToolApproval: respond };
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store: bridge })
    );
    const runtime = result.current;
    const part = runtime.thread.getMessageById(runId).getMessagePartByToolCallId(toolCallId);
    const pending = selectCommittedAssistantTool(bridge.getSnapshot(), runId, toolCallId);
    const repository = bridge.getSnapshot().repository;
    await act(async () => {
      source.publish({ connected: false });
    });
    await expect(part.respondToToolApproval({ approved: true })).rejects.toThrow('unavailable');
    expect(respond).not.toHaveBeenCalled();
    await act(async () => {
      source.publish({ connected: true });
      source.fold.accept(rows.slice(0, request + 1));
    });
    expect(result.current).toBe(runtime);
    expect(bridge.getSnapshot().repository).toBe(repository);
    expect(selectCommittedAssistantTool(bridge.getSnapshot(), runId, toolCallId)).toBe(pending);
    await act(async () => {
      await part.respondToToolApproval({ approved: true });
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: interactionId, approved: true })
    );
    expect(selectCommittedAssistantTool(bridge.getSnapshot(), runId, toolCallId)).toBe(pending);
    await act(async () => {
      source.fold.accept(rows.slice(request + 1));
    });
    expect(selectCommittedAssistantTool(bridge.getSnapshot(), runId, toolCallId)?.approval).toEqual(
      { approved: true, id: interactionId }
    );
    expect(runtime.thread.export()).toEqual(bridge.getSnapshot().repository);
    expect(commands.onNew).not.toHaveBeenCalled();
  });
});
