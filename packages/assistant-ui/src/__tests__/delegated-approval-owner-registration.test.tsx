// @vitest-environment jsdom
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantDataRendererRegistration } from '../assistant-data-renderer-registration';
import { DelegatedApprovalOwnerContext } from '../subagent-conversation-navigation';

const useAssistantDataUI = vi.hoisted(() => vi.fn());
vi.mock('@assistant-ui/react', () => ({ useAssistantDataUI }));
vi.mock('../assistant-tool-approval-notice', () => ({
  AssistantToolApprovalNotice: ({
    colorId,
    ownerDisplayName,
  }: {
    colorId?: string;
    ownerDisplayName?: string;
  }) => (
    <div data-agent-color={colorId} data-testid="approval">
      {ownerDisplayName}
    </div>
  ),
}));

const data = {
  delegation: {
    path: [
      {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'root-run',
        parentToolCallId: 'delegate-call',
        personaId: 'worker',
      },
    ],
    toolCallId: 'leaf-call',
  },
  runId: 'root-run',
  toolCallId: 'leaf-call',
  toolName: 'writeFile',
};

function ApprovalPart({ approval = data }: { approval?: unknown }) {
  const entry = useAssistantDataUI.mock.calls.find(
    ([value]) => value.name === TOOL_APPROVAL_DATA_NAME
  )?.[0] as { render: ComponentType<{ data: unknown }> } | undefined;
  if (!entry) {
    throw new Error('Missing approval renderer');
  }
  const Part = entry.render;
  return <Part data={approval} />;
}

afterEach(() => useAssistantDataUI.mockClear());

it('uses the authorized delegated owner, and stays neutral while unresolved', async () => {
  const resolve = vi.fn(async () => ({ colorId: 'violet', displayName: 'Aster' }));
  render(
    <DelegatedApprovalOwnerContext value={resolve}>
      <AssistantDataRendererRegistration />
      <ApprovalPart />
    </DelegatedApprovalOwnerContext>
  );
  expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'unresolved');
  await waitFor(() =>
    expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'violet')
  );
  expect(screen.getByTestId('approval')).toHaveTextContent('Aster');
  expect(resolve).toHaveBeenCalledWith(data);
});

it('keeps missing authorization neutral instead of borrowing the panel color', async () => {
  const resolve = vi.fn(async () => undefined);
  render(
    <DelegatedApprovalOwnerContext value={resolve}>
      <AssistantDataRendererRegistration />
      <ApprovalPart />
    </DelegatedApprovalOwnerContext>
  );
  await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'unresolved')
  );
  expect(screen.getByRole('status')).toHaveTextContent('child identity could not be verified');
  expect(screen.getByTestId('approval')).toBeEmptyDOMElement();
});

it('leaves a root approval uncolored so it inherits its panel tint', () => {
  const resolve = vi.fn();
  render(
    <DelegatedApprovalOwnerContext value={resolve}>
      <AssistantDataRendererRegistration />
      <ApprovalPart
        approval={{ runId: 'root-run', toolCallId: 'own-call', toolName: 'writeFile' }}
      />
    </DelegatedApprovalOwnerContext>
  );
  expect(screen.getByTestId('approval')).not.toHaveAttribute('data-agent-color');
  expect(resolve).not.toHaveBeenCalled();
});

it('shows unavailable when the host has no delegated color resolver', () => {
  render(
    <>
      <AssistantDataRendererRegistration />
      <ApprovalPart />
    </>
  );
  expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'unresolved');
  expect(screen.getByRole('status')).toHaveTextContent('child identity could not be verified');
  expect(screen.getByTestId('approval')).toBeEmptyDOMElement();
});

it('reuses equivalent approval data and rechecks changed ancestry', async () => {
  const resolve = vi.fn(async () => ({ colorId: 'violet', displayName: 'Aster' }));
  const view = (approval: unknown) => (
    <DelegatedApprovalOwnerContext value={resolve}>
      <AssistantDataRendererRegistration />
      <ApprovalPart approval={approval} />
    </DelegatedApprovalOwnerContext>
  );
  const { rerender } = render(view(data));
  await waitFor(() => expect(screen.getByTestId('approval')).toHaveTextContent('Aster'));
  rerender(view(structuredClone(data)));
  expect(resolve).toHaveBeenCalledOnce();
  rerender(
    view({
      ...data,
      delegation: {
        ...data.delegation,
        path: [{ ...data.delegation.path[0], parentToolCallId: 'different-parent-call' }],
      },
    })
  );
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
});

it('drops a saved owner immediately when the resolver changes or disappears', async () => {
  const first = vi.fn(async () => ({ colorId: 'violet', displayName: 'Aster' }));
  let finishSecond: ((owner: { colorId: string; displayName: string }) => void) | undefined;
  const second = vi.fn(
    () =>
      new Promise<{ colorId: string; displayName: string }>((resolve) => {
        finishSecond = resolve;
      })
  );
  const view = (resolver: typeof first | typeof second | null) => (
    <DelegatedApprovalOwnerContext value={resolver}>
      <AssistantDataRendererRegistration />
      <ApprovalPart />
    </DelegatedApprovalOwnerContext>
  );
  const { rerender } = render(view(first));
  await waitFor(() => expect(screen.getByTestId('approval')).toHaveTextContent('Aster'));

  rerender(view(second));
  expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'unresolved');
  expect(screen.getByTestId('approval')).toBeEmptyDOMElement();
  await waitFor(() => expect(second).toHaveBeenCalledOnce());
  finishSecond?.({ colorId: 'rose', displayName: 'Briar' });
  await waitFor(() => expect(screen.getByTestId('approval')).toHaveTextContent('Briar'));

  rerender(view(null));
  expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'unresolved');
  expect(screen.getByTestId('approval')).toBeEmptyDOMElement();
  expect(screen.getByRole('status')).toHaveTextContent('child identity could not be verified');
});

it('ignores a late result from a replaced resolver', async () => {
  let finishFirst: ((owner: { colorId: string; displayName: string }) => void) | undefined;
  const first = vi.fn(
    () =>
      new Promise<{ colorId: string; displayName: string }>((resolve) => {
        finishFirst = resolve;
      })
  );
  const second = vi.fn(async () => ({ colorId: 'rose', displayName: 'Briar' }));
  const view = (resolver: typeof first | typeof second) => (
    <DelegatedApprovalOwnerContext value={resolver}>
      <AssistantDataRendererRegistration />
      <ApprovalPart />
    </DelegatedApprovalOwnerContext>
  );
  const { rerender } = render(view(first));
  await waitFor(() => expect(first).toHaveBeenCalledOnce());
  rerender(view(second));
  await waitFor(() => expect(screen.getByTestId('approval')).toHaveTextContent('Briar'));
  await act(async () => {
    finishFirst?.({ colorId: 'violet', displayName: 'Aster' });
  });
  expect(screen.getByTestId('approval')).toHaveAttribute('data-agent-color', 'rose');
  expect(screen.getByTestId('approval')).not.toHaveTextContent('Aster');
});
