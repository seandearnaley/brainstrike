import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  CodeSurface: ({
    value,
    path,
    testId,
    truncated,
  }: {
    value: string;
    path?: string;
    testId?: string;
    truncated?: boolean;
  }) => (
    <div
      data-path={path}
      data-testid={testId ?? 'code-surface'}
      data-truncated={truncated ? 'true' : 'false'}
      data-value={value}
    />
  ),
  DiffView: ({
    original,
    modified,
    filename,
    testId,
    truncated,
  }: {
    original: string;
    modified: string;
    filename?: string;
    testId?: string;
    truncated?: boolean;
  }) => (
    <div
      data-filename={filename}
      data-modified={modified}
      data-original={original}
      data-testid={testId ?? 'diff-view'}
      data-truncated={truncated ? 'true' : 'false'}
    />
  ),
}));

import {
  APPROVAL_PREVIEW_CHAR_CAP,
  AssistantToolApprovalNotice,
} from '../assistant-tool-approval-notice';

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
    expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
      'Path: src/answer.ts · Workspace root: workspace'
    );
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
        root: 'workspace',
      },
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    const preview = screen.getByTestId('approval-write-preview');
    expect(preview.getAttribute('data-value')).toBe('export const x = 1;\n');
    expect(preview.getAttribute('data-path')).toBe('src/new-file.ts');
    expect(screen.getByText(/Creates or overwrites/i)).toBeInTheDocument();
    expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
      'Creates or overwrites · Path: src/new-file.ts · Workspace root: workspace'
    );
  });

  it('visually bounds a long workspace root without shortening its semantic text', () => {
    const longRoot = `workspace-${'a'.repeat(480)}`;
    renderNotice({
      ...baseRequest,
      args: {
        newStr: 'const answer = 42;',
        oldStr: 'const answer = 0;',
        path: 'src/answer.ts',
        root: longRoot,
      },
      toolName: 'brainstrike.stringReplaceWorkspaceFile',
    });

    const rootLabel = screen.getByTestId('approval-workspace-root');
    const rootValue = screen.getByTestId('approval-workspace-root-value');
    expect(rootLabel).toHaveTextContent(`Workspace root: ${longRoot}`);
    expect(rootValue).toHaveTextContent(longRoot);
    expect(rootValue).toHaveAttribute('title', longRoot);
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

  it('does not show a truncation note for previews under the cap', () => {
    renderNotice({
      ...baseRequest,
      args: {
        newStr: 'const answer = 42;',
        oldStr: 'const answer = 0;',
        path: 'src/answer.ts',
      },
      toolName: 'brainstrike.stringReplaceWorkspaceFile',
    });

    expect(screen.getByTestId('approval-diff-view').getAttribute('data-truncated')).toBe('false');
    expect(screen.queryByTestId('approval-preview-truncated-note')).toBeNull();
  });

  it('caps an oversized diff preview before it reaches DiffView', () => {
    const bigOld = 'a'.repeat(APPROVAL_PREVIEW_CHAR_CAP + 500);
    const bigNew = 'b'.repeat(APPROVAL_PREVIEW_CHAR_CAP + 10);
    renderNotice({
      ...baseRequest,
      args: {
        newStr: bigNew,
        oldStr: bigOld,
        path: 'src/big.ts',
      },
      toolName: 'brainstrike.stringReplaceWorkspaceFile',
    });

    const diff = screen.getByTestId('approval-diff-view');
    expect(diff.getAttribute('data-original')).toHaveLength(APPROVAL_PREVIEW_CHAR_CAP);
    expect(diff.getAttribute('data-modified')).toHaveLength(APPROVAL_PREVIEW_CHAR_CAP);
    expect(diff.getAttribute('data-truncated')).toBe('true');

    const note = screen.getByTestId('approval-preview-truncated-note');
    // The larger of the two sides (oldStr, +500 over the cap) drives the note.
    expect(note.textContent).toContain(String(APPROVAL_PREVIEW_CHAR_CAP));
    expect(note.textContent).toContain(String(APPROVAL_PREVIEW_CHAR_CAP + 500));
  });

  it('caps an oversized write-file preview before it reaches CodeSurface', () => {
    const bigContent = 'x'.repeat(APPROVAL_PREVIEW_CHAR_CAP + 1234);
    renderNotice({
      ...baseRequest,
      args: {
        content: bigContent,
        path: 'src/new-big.ts',
      },
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    const preview = screen.getByTestId('approval-write-preview');
    expect(preview.getAttribute('data-value')).toHaveLength(APPROVAL_PREVIEW_CHAR_CAP);
    expect(preview.getAttribute('data-truncated')).toBe('true');

    const note = screen.getByTestId('approval-preview-truncated-note');
    expect(note.textContent).toContain(String(APPROVAL_PREVIEW_CHAR_CAP));
    expect(note.textContent).toContain(String(APPROVAL_PREVIEW_CHAR_CAP + 1234));
  });

  it('exposes the untruncated args in the raw JSON expander even when the preview is capped', async () => {
    const user = userEvent.setup();
    const bigContent = 'x'.repeat(APPROVAL_PREVIEW_CHAR_CAP + 1234);
    const view = renderNotice({
      ...baseRequest,
      args: {
        content: bigContent,
        path: 'src/new-big.ts',
      },
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    await user.click(screen.getByRole('button', { name: /expand tool approval details/i }));

    expect(view.container.textContent).toContain(bigContent);
  });
});

describe('AssistantToolApprovalNotice execute command preview', () => {
  it('renders the exact command with a visible default working directory', () => {
    renderNotice({
      ...baseRequest,
      args: { command: 'pnpm test' },
      toolName: 'brainstrike.executeCommand',
    });

    const preview = screen.getByTestId('approval-command-preview');
    const code = screen.getByTestId('approval-command-code');

    expect(preview.tagName).toBe('PRE');
    expect(code.tagName).toBe('CODE');
    expect(code.textContent).toBe('pnpm test');
    expect(preview.className).toContain('select-text');
    expect(preview.className).toContain('whitespace-pre-wrap');
    expect(preview.className).toContain('[overflow-wrap:anywhere]');
    expect(screen.getByText('Selected workspace root (default)')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-command-timeout')).toBeNull();
  });

  it('renders supplied cwd, root, and timeout without changing the command', () => {
    renderNotice({
      ...baseRequest,
      args: {
        command: 'pnpm --filter @brainstrike/ui test',
        cwd: 'packages/ui',
        root: 'brainstrike',
        timeoutMs: 240_000,
      },
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByTestId('approval-command-code').textContent).toBe(
      'pnpm --filter @brainstrike/ui test'
    );
    expect(screen.getByTestId('approval-command-cwd')).toHaveTextContent('packages/ui');
    expect(screen.getByTestId('approval-command-root')).toHaveTextContent('brainstrike');
    expect(screen.getByTestId('approval-command-timeout')).toHaveTextContent('240000 ms');
    expect(screen.getByTestId('approval-command-root').closest('dl')).toHaveTextContent(
      /Working directory\s*packages\/ui\s*Workspace\s*brainstrike\s*Timeout\s*240000 ms/
    );
    expect(screen.queryByText('Selected workspace root (default)')).toBeNull();
  });

  it('names the specified workspace root as the default cwd when root is supplied', () => {
    renderNotice({
      ...baseRequest,
      args: {
        command: 'pwd',
        root: 'packages/web',
      },
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByTestId('approval-command-cwd')).toHaveTextContent(
      'Specified workspace root (default)'
    );
    expect(screen.getByTestId('approval-command-root')).toHaveTextContent('packages/web');
  });

  it('preserves long multiline command whitespace in the wrapping preview', () => {
    const command = `printf 'first line\\n'\n${'x'.repeat(2000)}\nprintf 'last line\\n'`;
    renderNotice({
      ...baseRequest,
      args: { command },
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByTestId('approval-command-code').textContent).toBe(command);
  });

  it.each([
    ['non-object args', 'pnpm test'],
    ['a missing command', { cwd: 'packages/ui' }],
    ['an empty command', { command: '' }],
    ['an oversized command', { command: 'x'.repeat(10_001) }],
    ['an invalid cwd', { command: 'pnpm test', cwd: 42 }],
    ['an invalid root', { command: 'pnpm test', root: false }],
    ['an invalid timeout', { command: 'pnpm test', timeoutMs: 0 }],
    ['an unknown field', { command: 'pnpm test', shell: 'bash' }],
  ])('keeps %s on the visible raw-arguments error path', (_caseName, args) => {
    renderNotice({
      ...baseRequest,
      args,
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.queryByTestId('approval-command-preview')).toBeNull();
    expect(screen.getByTestId('approval-preview-parse-error')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /expand tool approval details/i })
    ).toBeInTheDocument();
  });

  it('renders the same command data for a rediscovered approval', () => {
    renderNotice({
      ...baseRequest,
      args: {
        command: 'pnpm build',
        cwd: '/workspace',
        timeoutMs: 600_000,
      },
      stale: true,
      suspendedAt: '2026-07-22T00:00:00.000Z',
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByTestId('approval-command-code').textContent).toBe('pnpm build');
    expect(screen.getByTestId('approval-command-cwd')).toHaveTextContent('/workspace');
    expect(screen.getByTestId('approval-command-timeout')).toHaveTextContent('600000 ms');
    expect(screen.getByText(/This request has been pending a while/i)).toBeInTheDocument();
  });
});

describe('AssistantToolApprovalNotice skill script preview', () => {
  it('separates the activated skill source from the mounted working root', () => {
    renderNotice({
      ...baseRequest,
      args: {
        args: ['--target', 'src/index.html'],
        cwd: '.',
        root: '05-nonprofit',
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'impeccable',
      },
      toolName: 'brainstrike.runSkillScript',
    });

    expect(screen.getByTestId('approval-skill-script-summary')).toHaveTextContent(
      'Run script palette.mjs from activated skill impeccable'
    );
    expect(screen.getByTestId('approval-skill-script-path')).toHaveTextContent(
      'scripts/palette.mjs'
    );
    expect(screen.getByTestId('approval-skill-script-cwd')).toHaveTextContent('.');
    expect(screen.getByTestId('approval-skill-script-root')).toHaveTextContent('05-nonprofit');
    expect(screen.getByTestId('approval-skill-script-args')).toHaveTextContent(
      '--target src/index.html'
    );
  });

  it('keeps malformed skill-script args on the visible raw-arguments error path', () => {
    renderNotice({
      ...baseRequest,
      args: {
        cwd: '.',
        root: '05-nonprofit',
        runtime: 'node',
        scriptPath: '/absolute/palette.mjs',
        skillName: 'impeccable',
      },
      toolName: 'brainstrike.runSkillScript',
    });

    expect(screen.queryByTestId('approval-skill-script-summary')).toBeNull();
    expect(screen.getByTestId('approval-preview-parse-error')).toBeInTheDocument();
  });
});

describe('durable delegated approval recovery', () => {
  it.each(['claimed', 'consumed', 'interrupted', 'unknown'])(
    'keeps the original tool preview but blocks a %s decision',
    (decisionState) => {
      renderNotice({
        ...baseRequest,
        args: { command: 'pnpm build' },
        decisionState,
        delegation: {
          path: [
            {
              childRuntimeRunId: 'child',
              parentRuntimeRunId: baseRequest.runId,
              parentToolCallId: baseRequest.toolCallId,
              personaId: 'worker',
            },
          ],
          toolCallId: 'leaf',
        },
        stale: true,
        suspendedAt: '2026-09-10T00:00:00Z',
        toolName: 'brainstrike.executeCommand',
      });
      expect(screen.getByTestId('approval-command-code')).toHaveTextContent('pnpm build');
      expect(
        screen.getByRole('button', { name: 'Approve brainstrike.executeCommand' })
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Decline brainstrike.executeCommand' })
      ).toBeDisabled();
      expect(screen.getByText('Tool decision')).toBeInTheDocument();
      expect(screen.getByTestId('delegated-decision-recovery-status')).toBeInTheDocument();
      expect(screen.queryByText(/re-running it may be safer/i)).not.toBeInTheDocument();
    }
  );
});
