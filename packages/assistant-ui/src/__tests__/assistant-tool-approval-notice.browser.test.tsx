import '@testing-library/jest-dom/vitest';
import './assistant-tool-approval-notice.browser.css';
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import { renderWithApprovalSubmissions as render } from './approval-submission-test-utils';

vi.mock('@assistant-ui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useAui: () => ({
    thread: () => ({ append: vi.fn().mockResolvedValue(undefined) }),
  }),
  useAuiState: (selector: (state: { thread: { messages: readonly unknown[] } }) => unknown) =>
    selector({ thread: { messages: [] } }),
}));

const request = {
  args: { content: 'export const x = 1;\n' },
  runId: 'run-browser-spacing',
  toolCallId: 'call-browser-spacing',
  toolName: 'brainstrike.writeWorkspaceFile',
};

function renderNotice(data: unknown): void {
  const Notice = AssistantToolApprovalNotice as unknown as (props: {
    data: unknown;
  }) => ReactElement;
  render(
    <div style={{ width: 170 }}>
      <Notice data={data} />
    </div>
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('approval file target rendering', () => {
  it('keeps the action, the file and the folder on one line, cutting the file and folder to fit', () => {
    const longPath = `src/${'nested/'.repeat(20)}new-file.ts`;
    const longRoot = `workspace-${'a'.repeat(480)}`;
    renderNotice({ ...request, args: { ...request.args, path: longPath, root: longRoot } });

    const summary = screen.getByTestId('approval-file-target-summary');
    const action = screen.getByText('Write', { exact: true });
    const path = screen.getByTitle(longPath);
    const rootValue = screen.getByTestId('approval-workspace-root-value');
    const folder = rootValue.parentElement;
    if (!folder) {
      throw new Error('Expected the folder to sit in its own span');
    }

    expect(summary).toHaveTextContent(`Write ${longPath} in ${longRoot}`);
    const lineHeight = Number.parseFloat(getComputedStyle(summary).lineHeight);
    expect(summary.getBoundingClientRect().height).toBeLessThan(2 * lineHeight);
    // A painted gap between the action and the file, not only a text space.
    expect(path.getBoundingClientRect().left).toBeGreaterThan(action.getBoundingClientRect().right);
    for (const cut of [path, folder]) {
      expect(cut.clientWidth).toBeGreaterThan(0);
      expect(cut.scrollWidth).toBeGreaterThan(cut.clientWidth);
      expect(getComputedStyle(cut).textOverflow).toBe('ellipsis');
      expect(cut.getBoundingClientRect().right).toBeLessThanOrEqual(
        summary.getBoundingClientRect().right + 1
      );
    }
    expect(rootValue).toHaveAttribute('title', longRoot);
  });
});
