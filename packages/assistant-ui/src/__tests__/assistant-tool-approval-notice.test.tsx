import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import { expandApprovalRow } from './approval-row-helpers';
import { renderWithApprovalSubmissions as render } from './approval-submission-test-utils';

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({ append: vi.fn() }),
  }),
  useAuiState: (selector: (state: { thread: { messages: readonly unknown[] } }) => unknown) =>
    selector({ thread: { messages: [] } }),
}));

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

// The notice carries no waiting interaction, so its file cards read no file
// (approval-file-change.test.tsx covers the diff a waiting card shows).
describe('AssistantToolApprovalNotice file preview', () => {
  it('names the action, the file and the folder of an edit', () => {
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

    expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
      'Edit src/answer.ts in workspace'
    );
    expect(screen.queryByTestId('approval-diff-view')).toBeNull();
    // Raw-JSON expander remains available as a secondary view.
    expect(
      screen.getByRole('button', { name: /expand tool approval details/iu })
    ).toBeInTheDocument();
  });

  it('says Write for a write whose file it has not read', () => {
    renderNotice({
      ...baseRequest,
      args: {
        content: 'export const x = 1;\n',
        path: 'src/new-file.ts',
        root: 'workspace',
      },
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    expect(screen.getByTestId('approval-file-target-summary')).toHaveTextContent(
      'Write src/new-file.ts in workspace'
    );
  });

  it('keeps a long folder name whole for its tooltip', () => {
    const longRoot = `workspace-${'a'.repeat(480)}`;
    renderNotice({
      ...baseRequest,
      args: { path: 'src/answer.ts', root: longRoot },
      toolName: 'brainstrike.deleteWorkspaceFile',
    });

    const rootValue = screen.getByTestId('approval-workspace-root-value');
    expect(rootValue).toHaveTextContent(longRoot);
    expect(rootValue).toHaveAttribute('title', longRoot);
  });

  it('falls back to a visible note when file-tool args fail narrowing', () => {
    renderNotice({
      ...baseRequest,
      // Missing `newStr`: the tool would refuse this call.
      args: { oldStr: 'const answer = 0;', path: 'src/answer.ts' },
      toolName: 'brainstrike.stringReplaceWorkspaceFile',
    });

    expect(screen.queryByTestId('approval-file-target-summary')).toBeNull();
    expect(screen.getByTestId('approval-preview-parse-error')).toBeInTheDocument();
  });

  it('leaves non-file tools with the plain JSON args view (no preview)', () => {
    renderNotice({
      ...baseRequest,
      args: { query: 'hello' },
      toolName: 'brainstrike.lspInspect',
    });

    expect(screen.queryByTestId('approval-file-target-summary')).toBeNull();
    expect(screen.queryByTestId('approval-preview-parse-error')).toBeNull();
  });

  it("shows a write's whole content in the raw arguments", async () => {
    const user = userEvent.setup();
    const bigContent = 'x'.repeat(200_000);
    const view = renderNotice({
      ...baseRequest,
      args: {
        content: bigContent,
        path: 'src/new-big.ts',
      },
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    await user.click(screen.getByRole('button', { name: /expand tool approval details/iu }));

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
      /Working directory\s*packages\/ui\s*Workspace\s*brainstrike\s*Timeout\s*240000 ms/u
    );
    expect(screen.queryByText('Selected workspace root (default)')).toBeNull();
  });

  it('says a command asking to leave the sandbox runs with full access', () => {
    renderNotice({
      ...baseRequest,
      args: { command: 'curl https://example.com', dangerouslyDisableSandbox: true },
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByTestId('approval-command-outside-sandbox')).toHaveTextContent(
      'Runs outside the sandbox, with full access to your files and network.'
    );
    expect(screen.getByTestId('approval-command-code').textContent).toBe(
      'curl https://example.com'
    );
  });

  it('shows no sandbox warning for a command that stays in it', () => {
    renderNotice({
      ...baseRequest,
      args: { command: 'pnpm test', dangerouslyDisableSandbox: false },
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByTestId('approval-command-code').textContent).toBe('pnpm test');
    expect(screen.queryByTestId('approval-command-outside-sandbox')).toBeNull();
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
      screen.getByRole('button', { name: /expand tool approval details/iu })
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
    expect(screen.getByText(/This request has been pending a while/iu)).toBeInTheDocument();
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
  it.each(['claimed', 'consumed', 'interrupted', 'cancelled', 'unknown', undefined])(
    'keeps the original tool preview but blocks a %s decision',
    async (decisionState) => {
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
      // Every case carries a `decisionState` own key (the `undefined` one reads
      // as 'invalid'), so the notice is locked and collapses into a row; the
      // preview and buttons live in its expanded body.
      await expandApprovalRow(userEvent.setup());
      expect(screen.getByTestId('approval-command-code')).toHaveTextContent('pnpm build');
      expect(
        screen.queryByRole('button', { name: 'Approve brainstrike.executeCommand' })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Decline brainstrike.executeCommand' })
      ).not.toBeInTheDocument();
      expect(screen.getByText('Run pnpm build?')).toBeInTheDocument();
      expect(screen.getByTestId('delegated-decision-recovery-status')).toBeInTheDocument();
      expect(screen.queryByText(/re-running it may be safer/iu)).not.toBeInTheDocument();
    }
  );
});
