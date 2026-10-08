// @vitest-environment jsdom
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  MessageNotSentError,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { memo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import {
  type CommittedAssistantCommands,
  selectCommittedAssistantMessage,
  selectCommittedAssistantTool,
} from '../committed-assistant-store';
import { ToolFallback } from '../tool-fallback';
import { ToolResultRendererProvider } from '../tool-result-renderer-context';
import {
  useCommittedAssistantRuntime,
  useCommittedAssistantSelector,
} from '../use-committed-assistant-runtime';
import type { ToolResultRenderer, ToolResultRendererProps } from '../use-tool-result-renderers';
import {
  PublishedConversation,
  recordedMessage,
  viewMessage,
} from './committed-assistant-test-support';

afterEach(cleanup);

describe('production external store binding', () => {
  it('restores an explicitly unsent draft and rejects a disconnect that races composer dispatch', async () => {
    const source = new PublishedConversation('root', []);
    const rejection = new MessageNotSentError('Command was not admitted');
    const onNew = vi.fn(async () => {
      throw rejection;
    });
    const onCommandError = vi.fn();
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: { onNew },
        onCommandError,
        store: source,
      })
    );
    const composer = result.current.thread.composer;
    act(() => {
      composer.setText('Keep this draft');
    });
    await act(async () => {
      await composer.send();
    });
    expect(composer.getState().text).toBe('Keep this draft');
    expect(onCommandError).toHaveBeenCalledWith(rejection);
    expect(onNew).toHaveBeenCalledOnce();
    expect(result.current.thread.getState().messages).toEqual([]);
    // A committed disconnect can land between the button check and dispatch.
    await act(async () => {
      source.publish({ connection: 'disconnected' });
      await composer.send();
    });
    expect(composer.getState().text).toBe('Keep this draft');
    expect(onNew).toHaveBeenCalledOnce();
    expect(source.getSnapshot().repository.messages).toEqual([]);
  });

  it('keeps canonical branches and imports after unavailable or rejected commands, including reconnect', async () => {
    const user = viewMessage('user', 'Question', 'user');
    const answer = viewMessage('answer', 'Answer');
    const sibling = viewMessage('sibling', 'Sibling');
    const source = new PublishedConversation('root', [user, answer]);
    const repository = {
      headId: answer.id,
      messages: [
        { message: user, parentId: null },
        { message: answer, parentId: user.id },
        { message: sibling, parentId: user.id },
      ],
    };
    source.publish({ repository });
    const setMessages = vi.fn(() => {
      throw new Error('Branch command rejected');
    });
    const onImport = vi.fn(() => {
      throw new Error('Import command rejected');
    });
    const onCommandError = vi.fn();
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: { onImport, onNew: vi.fn(), setMessages },
        onCommandError,
        store: source,
      })
    );
    const runtime = result.current;
    const switchBranch = (): void =>
      runtime.thread.getMessageById(answer.id).switchToBranch({ branchId: sibling.id });
    await act(async () => {
      source.publish({ connection: 'disconnected' });
    });
    act(() => {
      expect(switchBranch).toThrow('does not support switching branches');
    });
    expect(setMessages).not.toHaveBeenCalled();
    expect(runtime.thread.export()).toEqual(repository);
    act(() => {
      expect(() =>
        runtime.thread.import({ headId: sibling.id, messages: repository.messages })
      ).toThrow('host is unavailable');
    });
    expect(onImport).not.toHaveBeenCalled();
    expect(runtime.thread.export()).toEqual(repository);
    await act(async () => {
      source.publish({ connection: 'connected' });
    });
    act(() => {
      expect(switchBranch).toThrow('Branch command rejected');
    });
    expect(runtime.thread.export()).toEqual(repository);
    expect(runtime.thread.getState().messages).toEqual([user, answer]);
    act(() => {
      expect(() =>
        runtime.thread.import({ headId: sibling.id, messages: repository.messages })
      ).toThrow('Import command rejected');
    });
    expect(runtime.thread.export()).toEqual(repository);
    expect(source.getSnapshot().repository).toBe(repository);
    expect(setMessages).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledOnce();
    expect(onCommandError).toHaveBeenCalledTimes(3);
  });

  it('rejects an unsupported import and restores the committed repository', () => {
    const source = new PublishedConversation('root', [viewMessage('answer', 'Answer')]);
    const canonical = source.getSnapshot().repository;
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: { onNew: vi.fn() },
        onCommandError: vi.fn(),
        store: source,
      })
    );
    act(() => {
      expect(() => result.current.thread.import({ headId: null, messages: [] })).toThrow(
        'does not support importing'
      );
    });
    expect(result.current.thread.export()).toEqual(canonical);
  });

  it('observes asynchronous branch and import rejection and restores the canonical head', async () => {
    const answer = viewMessage('answer', 'Answer');
    const sibling = viewMessage('sibling', 'Sibling');
    const source = new PublishedConversation('root', [answer]);
    const repository = {
      headId: answer.id,
      messages: [
        { message: answer, parentId: null },
        { message: sibling, parentId: null },
      ],
    };
    source.publish({ repository });
    const onCommandError = vi.fn();
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: {
          onImport: async () => {
            throw new Error('Async import rejected');
          },
          onNew: vi.fn(),
          setMessages: async () => {
            throw new Error('Async branch rejected');
          },
        },
        onCommandError,
        store: source,
      })
    );
    const runtime = result.current;
    await act(async () => {
      runtime.thread.getMessageById(answer.id).switchToBranch({ branchId: sibling.id });
    });
    expect(onCommandError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Async branch rejected' })
    );
    expect(runtime.thread.export()).toEqual(repository);
    await act(async () => {
      runtime.thread.import({ headId: sibling.id, messages: repository.messages });
    });
    expect(onCommandError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Async import rejected' })
    );
    expect(runtime.thread.export()).toEqual(repository);
    expect(source.getSnapshot().repository).toBe(repository);
  });

  it('a late branch refusal withdraws only the selection it refused, never a newer accepted one', async () => {
    const answer = viewMessage('answer', 'Answer');
    const sibling = viewMessage('sibling', 'Sibling');
    const other = viewMessage('other', 'Other');
    const source = new PublishedConversation('root', [answer]);
    const repository = {
      headId: answer.id,
      messages: [
        { message: answer, parentId: null },
        { message: sibling, parentId: null },
        { message: other, parentId: null },
      ],
    };
    source.publish({ repository });
    let refuseFirst: (cause: Error) => void = () => undefined;
    const setMessages = vi
      .fn<NonNullable<CommittedAssistantCommands['setMessages']>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            refuseFirst = reject;
          })
      )
      .mockImplementationOnce(() => undefined);
    const onCommandError = vi.fn();
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: { onNew: vi.fn(), setMessages },
        onCommandError,
        store: source,
      })
    );
    const runtime = result.current;
    await act(async () => {
      runtime.thread.getMessageById(answer.id).switchToBranch({ branchId: sibling.id });
    });
    await act(async () => {
      runtime.thread.getMessageById(sibling.id).switchToBranch({ branchId: other.id });
    });
    expect(runtime.thread.export().headId).toBe(other.id);
    await act(async () => {
      refuseFirst(new Error('Late branch refusal'));
    });
    expect(onCommandError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Late branch refusal' })
    );
    expect(setMessages).toHaveBeenCalledTimes(2);
    expect(runtime.thread.export().headId).toBe(other.id);
    expect(source.getSnapshot().repository).toBe(repository);
  });

  it('shows a withheld observational memory reason in the committed thread meter', async () => {
    const source = new PublishedConversation('root', [viewMessage('answer', 'Answer')]);
    source.publish({ observationWithheld: 'branched-thread' });
    render(
      <TooltipProvider>
        <CommittedAssistantConversation
          commands={{ onNew: vi.fn() }}
          contextWindow={128_000}
          effectiveInputBudget={100_000}
          label="Conversation"
          store={source}
        />
      </TooltipProvider>
    );
    fireEvent.focus(await screen.findByTestId('context-usage-trigger'));
    expect(await screen.findByTestId('context-usage-om-note')).toHaveTextContent(
      /paused.*branches/i
    );
  });

  it('observes asynchronous tool-resume failures without changing a pending interaction', async () => {
    const answer = viewMessage('answer', [
      {
        args: {},
        toolCallId: 'question-call',
        toolName: 'question',
        type: 'tool-call',
      },
    ]);
    const source = new PublishedConversation('root', [answer]);
    const repository = source.getSnapshot().repository;
    const onCommandError = vi.fn();
    const rejection = new Error('Resume command rejected');
    const resume = vi.fn(async () => {
      throw rejection;
    });
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: { onNew: vi.fn(), onResumeToolCall: resume },
        onCommandError,
        store: source,
      })
    );
    const part = result.current.thread
      .getMessageById(answer.id)
      .getMessagePartByToolCallId('question-call');
    await act(async () => {
      part.resumeToolCall({ answer: 'Yes' });
    });
    expect(resume).toHaveBeenCalledWith({
      payload: { answer: 'Yes' },
      toolCallId: 'question-call',
    });
    expect(onCommandError).toHaveBeenCalledWith(rejection);
    expect(result.current.thread.export()).toEqual(repository);
    expect(source.getSnapshot().repository).toBe(repository);
  });

  it('keeps the actual shipped tool card from rerendering while the same answer streams text', async () => {
    const answer = viewMessage('host-answer', [
      {
        args: { path: 'AGENTS.md' },
        result: { ok: true },
        toolCallId: 'read-call',
        toolName: 'brainstrike.readWorkspaceFile',
        type: 'tool-call',
      },
      { text: 'Answer starts here.', type: 'text' },
    ]);
    if (answer.role !== 'assistant') {
      throw new Error('Missing answer fixture.');
    }
    const tool = answer.content[0];
    if (tool?.type !== 'tool-call') {
      throw new Error('Missing tool fixture.');
    }
    const store = new PublishedConversation('root', [answer]);
    store.publish({ isRunning: true });
    let cardRenders = 0;
    let previousProps: ToolResultRendererProps | undefined;
    const changedPropKeys = new Set<string>();
    const renderers: readonly ToolResultRenderer[] = [
      {
        Component: (props) => {
          cardRenders += 1;
          if (previousProps) {
            for (const key of Object.keys(props) as (keyof ToolResultRendererProps)[]) {
              if (props[key] !== previousProps[key]) {
                changedPropKeys.add(key);
              }
            }
          }
          previousProps = props;
          return (
            <div data-testid="tracked-real-tool-card">
              <ToolFallback {...props} />
            </div>
          );
        },
        kind: 'tracked-real-tool-card',
        matches: () => true,
        preserveEffectsWhenHidden: true,
      },
    ];
    render(
      <TooltipProvider>
        <ToolResultRendererProvider renderers={renderers}>
          <CommittedAssistantConversation
            commands={{ onNew: vi.fn() }}
            label="Conversation"
            store={store}
          />
        </ToolResultRendererProvider>
      </TooltipProvider>
    );
    await screen.findByTestId('tracked-real-tool-card');
    const initial = cardRenders;
    for (let token = 0; token < 20; token += 1) {
      await act(async () => {
        store.replaceMessage({
          ...answer,
          content: [tool, { text: `Answer starts here.${'!'.repeat(token + 1)}`, type: 'text' }],
        });
      });
    }
    expect([...changedPropKeys]).toEqual([]);
    expect(cardRenders).toBe(initial);
  });

  it('does not rerender unrelated rows or approval selectors per token, or write child progress into root', async () => {
    const saved = await recordedMessage();
    const live = viewMessage('host-answer', [
      {
        approval: { id: 'host-approval' },
        args: { path: 'AGENTS.md' },
        argsText: '{"path":"AGENTS.md"}',
        toolCallId: 'host-call',
        toolName: 'brainstrike.readWorkspaceFile',
        type: 'tool-call',
      },
      { text: 'Start', type: 'text' },
    ]);
    if (live.role !== 'assistant') {
      throw new Error('Missing assistant fixture.');
    }
    const tool = live.content[0];
    if (tool?.type !== 'tool-call') {
      throw new Error('Missing tool fixture.');
    }
    const store = new PublishedConversation('root', [saved, live]);
    store.publish({ isRunning: true });
    const child = new PublishedConversation('child', [saved]);
    const renders = { approval: 0, child: 0, saved: 0 };
    const commands: CommittedAssistantCommands = { onNew: vi.fn() };
    let runtime: AssistantRuntime | undefined;
    const SavedRow = memo(() => {
      const message = useAuiState((state) => state.message);
      if (message.id === saved.id) {
        renders.saved += 1;
      }
      return (
        <MessagePrimitive.Root>
          <MessagePrimitive.Parts />
        </MessagePrimitive.Root>
      );
    });
    const Approval = memo(() => {
      const part = useCommittedAssistantSelector(store, (snapshot) =>
        selectCommittedAssistantTool(snapshot, live.id, tool.toolCallId)
      );
      renders.approval += 1;
      return <span>{part?.approval?.id}</span>;
    });
    const Child = memo(() => {
      useCommittedAssistantSelector(child, (snapshot) =>
        selectCommittedAssistantMessage(snapshot, saved.id)
      );
      renders.child += 1;
      return null;
    });
    function BoundThread() {
      runtime = useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Messages components={{ Message: SavedRow }} />
          <Approval />
          <Child />
        </AssistantRuntimeProvider>
      );
    }
    render(<BoundThread />);
    const initial = { ...renders };
    for (let token = 0; token < 20; token += 1) {
      await act(async () => {
        store.replaceMessage({
          ...live,
          content: [tool, { text: `Start${'!'.repeat(token + 1)}`, type: 'text' }],
        });
      });
    }
    expect(renders.saved).toBe(initial.saved);
    expect(renders.approval).toBe(initial.approval);
    expect(renders.child).toBe(initial.child);
    expect(runtime?.thread.getState().messages[0]).toBe(saved);
    expect(runtime?.thread.getState().messages[1]?.content[0]).toBe(tool);
    const rootBeforeChild = runtime?.thread.getState().messages;
    await act(async () => {
      child.replaceMessage({ ...saved, content: [{ text: 'Child progress', type: 'text' }] });
    });
    expect(runtime?.thread.getState().messages).toBe(rootBeforeChild);
    expect(commands.onNew).not.toHaveBeenCalled();
  });

  it('retains native rich references, canonical branches and child view fields through disconnect/reconnect', async () => {
    const saved = await recordedMessage();
    const alternate = viewMessage('alternate-answer', 'Another branch');
    const source = new PublishedConversation('root', [saved]);
    const repository = {
      headId: saved.id,
      messages: [
        { message: saved, parentId: null },
        { message: alternate, parentId: null },
      ],
    };
    const extras = { childThreadId: 'child', parentRunId: 'parent', parentToolCallId: 'caller' };
    source.publish({ extras, repository });
    const commands = { onNew: vi.fn() };
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store: source })
    );
    const runtime = result.current;
    expect(runtime.thread.export()).toEqual(repository);
    expect(runtime.thread.getState().extras).toBe(extras);
    await act(async () => {
      source.publish({ connection: 'disconnected' });
    });
    expect(result.current).toBe(runtime);
    act(() => {
      runtime.thread.composer.setText('Draft survives reconnect');
    });
    expect(runtime.thread.composer.getState().canSend).toBe(false);
    expect(runtime.thread.getState().messages[0]).toBe(saved);
    await act(async () => {
      source.publish({ connection: 'connected' });
    });
    expect(runtime.thread.composer.getState().canSend).toBe(true);
    expect(runtime.thread.composer.getState().text).toBe('Draft survives reconnect');
    expect(runtime.thread.export().messages[0]?.message).toBe(saved);
    expect(runtime.thread.getState().capabilities.edit).toBe(false);
    expect(runtime.thread.getState().capabilities.reload).toBe(false);
    expect(commands.onNew).not.toHaveBeenCalled();
  });

  it('answers through the exact pending approval port without optimistic settlement or sibling card renders', async () => {
    const answer = viewMessage('host-answer', [
      {
        approval: { id: 'approval-a' },
        args: {},
        toolCallId: 'call-a',
        toolName: 'read',
        type: 'tool-call',
      },
      {
        approval: { id: 'approval-b' },
        args: {},
        toolCallId: 'call-b',
        toolName: 'edit',
        type: 'tool-call',
      },
    ]);
    if (answer.role !== 'assistant') {
      throw new Error('Missing answer fixture.');
    }
    const first = answer.content[0];
    const second = answer.content[1];
    if (first?.type !== 'tool-call' || second?.type !== 'tool-call') {
      throw new Error('Missing approval fixtures.');
    }
    const store = new PublishedConversation('root', [answer]);
    const commands: CommittedAssistantCommands = {
      onNew: vi.fn(),
      onRespondToToolApproval: vi.fn(async () => undefined),
    };
    const renders = { first: 0, second: 0 };
    const firstToolCallId = first.toolCallId;
    const secondToolCallId = second.toolCallId;
    function First() {
      useCommittedAssistantSelector(store, (snapshot) =>
        selectCommittedAssistantTool(snapshot, answer.id, firstToolCallId)
      );
      renders.first += 1;
      return null;
    }
    function Second() {
      useCommittedAssistantSelector(store, (snapshot) =>
        selectCommittedAssistantTool(snapshot, answer.id, secondToolCallId)
      );
      renders.second += 1;
      return null;
    }
    render(
      <>
        <First />
        <Second />
      </>
    );
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store })
    );
    const partRuntime = result.current.thread
      .getMessageById(answer.id)
      .getMessagePartByToolCallId(first.toolCallId);
    const baseline = { ...renders };
    await act(async () => {
      await partRuntime.respondToToolApproval({ approved: true });
    });
    expect(commands.onRespondToToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval-a', approved: true })
    );
    expect(store.getSnapshot().repository.messages[0]?.message.content[0]).toBe(first);
    expect(partRuntime.getState()).toEqual(expect.objectContaining({ approval: first.approval }));
    const settled = { ...first, approval: { ...first.approval, approved: true, id: 'approval-a' } };
    await act(async () => {
      store.replaceMessage({ ...answer, content: [settled, second] });
    });
    expect(renders.first).toBe(baseline.first + 1);
    expect(renders.second).toBe(baseline.second);
    expect(() => partRuntime.respondToToolApproval({ approved: false })).toThrow(
      'no pending approval'
    );
    expect(commands.onRespondToToolApproval).toHaveBeenCalledOnce();
  });

  it('rejects retained editable callbacks during disconnect and leaves approval identity intact for retry', async () => {
    const answer = viewMessage('host-answer', [
      {
        approval: { id: 'approval' },
        args: {},
        toolCallId: 'call',
        toolName: 'read',
        type: 'tool-call',
      },
    ]);
    const store = new PublishedConversation('root', [answer]);
    const respond = vi.fn(async () => {
      throw new Error('Interaction already settled on the host');
    });
    const onEdit = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({
        commands: { onEdit, onNew: vi.fn(), onRespondToToolApproval: respond },
        onCommandError: vi.fn(),
        store,
      })
    );
    const runtime = result.current;
    const part = runtime.thread.getMessageById(answer.id).getMessagePartByToolCallId('call');
    const original = store.getSnapshot().repository;
    await act(async () => {
      store.publish({ connection: 'disconnected' });
    });
    await expect(part.respondToToolApproval({ approved: true })).rejects.toThrow(
      'host is unavailable'
    );
    expect(respond).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => {
      store.publish({ connection: 'connected' });
    });
    await expect(part.respondToToolApproval({ approved: true })).rejects.toThrow('already settled');
    await expect(part.respondToToolApproval({ approved: true })).rejects.toThrow('already settled');
    expect(respond.mock.calls[0]).toEqual(respond.mock.calls[1]);
    expect(store.getSnapshot().repository).toBe(original);
  });

  it('replaces an interrupted view with a fresh committed restart snapshot without duplicating messages', async () => {
    const recorded = await recordedMessage();
    const interrupted = {
      ...recorded,
      status: { reason: 'cancelled' as const, type: 'incomplete' as const },
    };
    const store = new PublishedConversation('root', [interrupted]);
    const commands = { onNew: vi.fn() };
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store })
    );
    const runtime = result.current;
    const before = runtime.thread.export();
    await act(async () => {
      store.publish({ connection: 'disconnected' });
    });
    await act(async () => {
      store.publish({
        connection: 'connected',
        repository: {
          headId: interrupted.id,
          messages: [{ message: interrupted, parentId: null }],
        },
      });
    });
    const freshStore = new PublishedConversation('root', [interrupted]);
    const fresh = renderHook(() =>
      useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store: freshStore })
    );
    expect(runtime.thread.export()).toEqual(before);
    expect(runtime.thread.export()).toEqual(fresh.result.current.thread.export());
    expect(runtime.thread.getState().messages).toHaveLength(1);
    expect(runtime.thread.getState().messages[0]).toBe(interrupted);
    expect(commands.onNew).not.toHaveBeenCalled();
  });

  it('uses explicit edit, regenerate, Stop, branch and reset ports and exposes no local transcript writer', async () => {
    const user = viewMessage('host-user', 'Original', 'user');
    const answer = viewMessage('host-answer', 'Answer');
    const sibling = viewMessage('host-sibling', 'Sibling');
    const source = new PublishedConversation('root', [user, answer]);
    source.publish({
      repository: {
        headId: answer.id,
        messages: [
          { message: user, parentId: null },
          { message: answer, parentId: user.id },
          { message: sibling, parentId: user.id },
        ],
      },
    });
    const commands: CommittedAssistantCommands = {
      onCancel: vi.fn(),
      onEdit: vi.fn(),
      onNew: vi.fn(),
      onReload: vi.fn(),
      setMessages: vi.fn(),
      unstable_onBranchChange: vi.fn(),
    };
    const { result } = renderHook(() =>
      useCommittedAssistantRuntime({ commands, onCommandError: vi.fn(), store: source })
    );
    const runtime = result.current;
    const committed = source.getSnapshot();
    await act(async () => {
      await runtime.thread.append({
        content: [{ text: 'Edited', type: 'text' }],
        parentId: null,
        role: 'user',
        runConfig: {},
        sourceId: user.id,
      });
    });
    expect(commands.onEdit).toHaveBeenCalledWith(expect.objectContaining({ sourceId: user.id }));
    await act(async () => {
      await runtime.thread.startRun({ parentId: user.id, sourceId: answer.id });
    });
    expect(commands.onReload).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ sourceId: answer.id })
    );
    await act(async () => {
      await runtime.thread.cancelRun();
    });
    expect(commands.onCancel).toHaveBeenCalledOnce();
    act(() => {
      runtime.thread.getMessageById(answer.id).switchToBranch({ branchId: sibling.id });
    });
    expect(commands.setMessages).toHaveBeenCalledWith([user, sibling]);
    expect(commands.unstable_onBranchChange).toHaveBeenCalledWith({
      headId: sibling.id,
      visibleMessageIds: [user.id, sibling.id],
    });
    act(() => {
      runtime.thread.reset();
    });
    expect(commands.setMessages).toHaveBeenLastCalledWith([]);
    expect(source.getSnapshot()).toBe(committed);
    expect(runtime.thread.export().messages.map(({ message }) => message.id)).toEqual(
      expect.arrayContaining([answer.id, sibling.id])
    );
  });

  it('keeps the shipped transcript and composer mounted and focus intact while connection failure is visible', async () => {
    const source = new PublishedConversation('root', [
      viewMessage('host-answer', 'Committed answer'),
    ]);
    const commands = { onNew: vi.fn() };
    render(
      <TooltipProvider>
        <CommittedAssistantConversation commands={commands} label="Conversation" store={source} />
      </TooltipProvider>
    );
    const panel = screen.getByTestId('assistant-conversation-panel');
    const input = screen.getByRole('textbox');
    input.focus();
    await act(async () => {
      source.publish({ connection: 'failed', error: 'Protocol version mismatch' });
    });
    expect(screen.getByRole('alert', { name: 'Agent host error' })).toHaveTextContent(
      'Protocol version mismatch'
    );
    expect(screen.getByTestId('assistant-conversation-panel')).toBe(panel);
    expect(screen.getByRole('textbox')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(await screen.findByText('Committed answer')).toBeInTheDocument();
    await act(async () => {
      source.publish({ connection: 'connected', error: undefined });
    });
    expect(screen.queryByRole('alert', { name: 'Agent host error' })).toBeNull();
    expect(commands.onNew).not.toHaveBeenCalled();
  });
});
