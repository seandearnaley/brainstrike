/**
 * ADR-0036: a waiting file approval shows the change its call would make to
 * the file, read from the host; without that read it names the action only.
 */
import type { ApprovalFileChange } from '@brainstrike/assistant-contract/tool-approval';
import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { parsePartialJsonObject } from 'assistant-stream/utils';
import type { ReactElement } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { ApprovalChangeProvider, type ReadApprovalChange } from '../approval-change-context';
import { committedApprovalOptions } from '../committed-approval-options';
import { CommittedApprovalStrip } from '../committed-approval-strip';
import { ToolFallback } from '../tool-fallback';

// The diff itself draws in Chromium (packages/ui's FileDiffView browser test).
vi.mock('@brainstrike/ui/diff-view', () => ({
  FileDiffView: ({
    after,
    before,
    testId,
  }: {
    after: string | null;
    before: string | null;
    testId?: string;
  }) => <pre data-testid={testId}>{`${before ?? 'no file'} → ${after ?? 'no file'}`}</pre>,
}));

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

/** A file call waiting in the conversation, as the host's committed log shows it. */
function WaitingCall({
  args,
  toolName,
}: {
  readonly args: Readonly<Record<string, string>>;
  readonly toolName: string;
}): ReactElement {
  return (
    <ToolFallback
      addResult={() => {}}
      approval={{ id: 'interaction-1', options: committedApprovalOptions('edit') }}
      // The committed log's parse, which marks the args with a symbol key.
      args={parsePartialJsonObject(JSON.stringify(args)) ?? {}}
      argsText={JSON.stringify(args)}
      providerMetadata={{
        brainstrike: { targetRoot: { displayName: 'brainstrike', rootId: 'r' } },
      }}
      respondToApproval={() => Promise.resolve()}
      resume={() => {}}
      status={{ reason: 'interrupt', type: 'requires-action' }}
      toolCallId="call-1"
      toolName={toolName}
      type="tool-call"
    />
  );
}

/** Awaited, so the card's read settles inside act (React 19 suspends until it does). */
async function renderWith(read: ReadApprovalChange | null, ui: ReactElement): Promise<void> {
  await act(async () => {
    render(
      <TooltipProvider>
        <ApprovalChangeProvider value={read}>{ui}</ApprovalChangeProvider>
      </TooltipProvider>
    );
  });
}

const reads = (change: ApprovalFileChange) => vi.fn(async (_id: string) => change);

it('an edit shows the file before and after the call', async () => {
  const read = reads({ after: 'const a = 2;\n', before: 'const a = 1;\n', path: 'src/a.ts' });
  await renderWith(
    read,
    <WaitingCall
      args={{ newStr: 'a = 2', oldStr: 'a = 1', path: 'src/a.ts' }}
      toolName="brainstrike.stringReplaceWorkspaceFile"
    />
  );
  const diff = await screen.findByTestId('approval-diff-view');
  expect(diff).toHaveTextContent('const a = 1; → const a = 2;');
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
    'Edit src/a.ts in brainstrike'
  );
  expect(read).toHaveBeenCalledWith('interaction-1');
});

it('a write to a new file says Create and shows only the new text', async () => {
  await renderWith(
    reads({ after: 'hello\n', before: null, path: 'notes.md' }),
    <WaitingCall
      args={{ content: 'hello\n', path: 'notes.md' }}
      toolName="brainstrike.writeWorkspaceFile"
    />
  );
  const diff = await screen.findByTestId('approval-diff-view');
  expect(diff).toHaveTextContent('no file → hello');
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
    'Create notes.md in brainstrike'
  );
});

it('a write over an existing file says Edit', async () => {
  await renderWith(
    reads({ after: 'new\n', before: 'old\n', path: 'notes.md' }),
    <WaitingCall
      args={{ content: 'new\n', path: 'notes.md' }}
      toolName="brainstrike.writeWorkspaceFile"
    />
  );
  await screen.findByTestId('approval-diff-view');
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
    'Edit notes.md in brainstrike'
  );
});

it('a write that leaves the file as it is says so instead of an empty diff', async () => {
  await renderWith(
    reads({ after: 'same\n', before: 'same\n', path: 'notes.md' }),
    <WaitingCall
      args={{ content: 'same\n', path: 'notes.md' }}
      toolName="brainstrike.writeWorkspaceFile"
    />
  );
  expect(await screen.findByText('No changes')).toBeInTheDocument();
  expect(screen.queryByTestId('approval-diff-view')).toBeNull();
});

it('creating an empty file says so instead of drawing an empty diff', async () => {
  await renderWith(
    reads({ after: '', before: null, path: 'empty.md' }),
    <WaitingCall
      args={{ content: '', path: 'empty.md' }}
      toolName="brainstrike.writeWorkspaceFile"
    />
  );
  expect(await screen.findByText('Empty file')).toBeInTheDocument();
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent('Create empty.md');
  expect(screen.queryByTestId('approval-diff-view')).toBeNull();
});

it('a delete shows the text it removes', async () => {
  await renderWith(
    reads({ after: null, before: 'bye\n', path: 'old.txt' }),
    <WaitingCall args={{ path: 'old.txt' }} toolName="brainstrike.deleteWorkspaceFile" />
  );
  const diff = await screen.findByTestId('approval-diff-view');
  expect(diff).toHaveTextContent('bye → no file');
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
    'Delete old.txt in brainstrike'
  );
});

it('a read the host refuses shows why, and no diff', async () => {
  await renderWith(
    async () => {
      throw new Error('old.bin is not a text file.');
    },
    <WaitingCall args={{ path: 'old.bin' }} toolName="brainstrike.deleteWorkspaceFile" />
  );
  expect(await screen.findByText('old.bin is not a text file.')).toBeInTheDocument();
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent('Delete old.bin');
  expect(screen.queryByTestId('approval-diff-view')).toBeNull();
});

it('a rename names both paths and reads nothing', async () => {
  const read = vi.fn<ReadApprovalChange>();
  await renderWith(
    read,
    <WaitingCall
      args={{ fromPath: 'src/a.ts', toPath: 'src/b.ts' }}
      toolName="brainstrike.renameWorkspaceFile"
    />
  );
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
    'Rename src/a.ts → src/b.ts in brainstrike'
  );
  expect(read).not.toHaveBeenCalled();
});

it('without the host read, a card names the action only', async () => {
  await renderWith(
    null,
    <WaitingCall
      args={{ content: 'hello\n', path: 'notes.md' }}
      toolName="brainstrike.writeWorkspaceFile"
    />
  );
  expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
    'Write notes.md in brainstrike'
  );
  expect(screen.queryByTestId('approval-diff-view')).toBeNull();
});

it('a call the tool would refuse keeps the raw arguments', async () => {
  const read = vi.fn<ReadApprovalChange>();
  await renderWith(
    read,
    <WaitingCall args={{ root: 'brainstrike' }} toolName="brainstrike.deleteWorkspaceFile" />
  );
  expect(screen.getByTestId('approval-preview-parse-error')).toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});

it("a delegated child's approval under review shows its diff", async () => {
  const read = reads({ after: 'b\n', before: 'a\n', path: 'x.txt' });
  await renderWith(
    read,
    <CommittedApprovalStrip
      approvals={[
        {
          args: { content: 'b\n', path: 'x.txt' },
          interactionId: 'child-interaction',
          owner: 'Explorer 1',
          respond: async () => undefined,
          risk: 'edit',
          runId: 'child-run',
          toolCallId: 'child-call',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
      ]}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
  const dialog = screen.getByRole('dialog', { name: 'Pending approvals' });
  expect(await within(dialog).findByTestId('approval-diff-view')).toHaveTextContent('a → b');
  expect(read).toHaveBeenCalledWith('child-interaction');
});
