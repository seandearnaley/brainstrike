import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({ append: vi.fn().mockResolvedValue(undefined) }),
  }),
  useAuiState: (selector: (state: { thread: { messages: readonly unknown[] } }) => unknown) =>
    selector({ thread: { messages: [] } }),
}));

// Lightweight stand-ins so the CodeMirror-backed surfaces do not run inside the
// unit environment — the test only asserts that the right content reaches them.
vi.mock('../../diff-view', () => ({
  DiffView: ({
    original,
    modified,
    filename,
    testId,
  }: {
    original: string;
    modified: string;
    filename?: string;
    testId?: string;
  }) => (
    <div
      data-filename={filename}
      data-modified={modified}
      data-original={original}
      data-testid={testId ?? 'diff-view'}
    />
  ),
}));

vi.mock('../../code-surface', () => ({
  CodeSurface: ({ value, path, testId }: { value: string; path?: string; testId?: string }) => (
    <div data-path={path} data-testid={testId ?? 'code-surface'} data-value={value} />
  ),
}));

import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function renderNotice(data: unknown) {
  const Comp = AssistantToolApprovalNotice as unknown as (p: { data: unknown }) => ReactElement;
  return render(<Comp data={data} />);
}

const baseRequest = {
  runId: 'run-1',
  toolCallId: 'call-1',
};

describe('AssistantToolApprovalNotice diff preview', () => {
  it('renders a real diff for stringReplaceWorkspaceFile approvals', () => {
    renderNotice({
      ...baseRequest,
      args: {
        newStr: 'const answer = 42;',
        oldStr: 'const answer = 0;',
        path: 'src/answer.ts',
        root: 'workspace',
      },
      toolName: 'brainstrike.stringReplaceWorkspaceFile',
    });

    const diff = screen.getByTestId('approval-diff-view');
    expect(diff.getAttribute('data-original')).toBe('const answer = 0;');
    expect(diff.getAttribute('data-modified')).toBe('const answer = 42;');
    expect(diff.getAttribute('data-filename')).toBe('src/answer.ts');
    expect(screen.getByText('src/answer.ts')).toBeInTheDocument();
    expect(screen.getByText('workspace')).toBeInTheDocument();
    // Raw-JSON expander remains available as a secondary view.
    expect(
      screen.getByRole('button', { name: /expand tool approval details/i })
    ).toBeInTheDocument();
  });

  it('renders a full-file preview for writeWorkspaceFile approvals', () => {
    renderNotice({
      ...baseRequest,
      args: {
        content: 'export const x = 1;\n',
        path: 'src/new-file.ts',
      },
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    const preview = screen.getByTestId('approval-write-preview');
    expect(preview.getAttribute('data-value')).toBe('export const x = 1;\n');
    expect(preview.getAttribute('data-path')).toBe('src/new-file.ts');
    expect(screen.getByText(/Creates or overwrites/i)).toBeInTheDocument();
    expect(screen.getByText('src/new-file.ts')).toBeInTheDocument();
  });

  it('falls back to a visible note when file-tool args fail narrowing', () => {
    renderNotice({
      ...baseRequest,
      // Missing `newStr` — cannot render a diff.
      args: { oldStr: 'const answer = 0;', path: 'src/answer.ts' },
      toolName: 'brainstrike.stringReplaceWorkspaceFile',
    });

    expect(screen.queryByTestId('approval-diff-view')).toBeNull();
    expect(screen.getByTestId('approval-preview-parse-error')).toBeInTheDocument();
  });

  it('leaves non-file tools with the plain JSON args view (no preview)', () => {
    renderNotice({
      ...baseRequest,
      args: { query: 'hello' },
      toolName: 'brainstrike.queryEmbeddingSpace',
    });

    expect(screen.queryByTestId('approval-diff-view')).toBeNull();
    expect(screen.queryByTestId('approval-write-preview')).toBeNull();
    expect(screen.queryByTestId('approval-preview-parse-error')).toBeNull();
  });
});
