import '@testing-library/jest-dom/vitest';
import './assistant-tool-approval-notice.browser.css';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({ append: vi.fn().mockResolvedValue(undefined) }),
  }),
  useAuiState: (selector: (state: { thread: { messages: readonly unknown[] } }) => unknown) =>
    selector({ thread: { messages: [] } }),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  CodeSurface: ({ testId }: { testId?: string }) => <div data-testid={testId ?? 'code-surface'} />,
}));

import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';

const request = {
  args: {
    content: 'export const x = 1;\n',
    path: 'src/new-file.ts',
    root: 'workspace',
  },
  runId: 'run-browser-spacing',
  toolCallId: 'call-browser-spacing',
  toolName: 'brainstrike.writeWorkspaceFile',
};

function renderNotice(): void {
  const Notice = AssistantToolApprovalNotice as unknown as (props: {
    data: unknown;
  }) => ReactElement;
  render(
    <div style={{ width: 170 }}>
      <Notice data={request} />
    </div>
  );
}

function textRange(element: HTMLElement, start: number, end: number): DOMRect {
  const node = element.firstChild;
  if (!(node instanceof Text)) {
    throw new Error(`Expected ${element.dataset['testid'] ?? element.tagName} to contain text`);
  }
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range.getBoundingClientRect();
}

function expectSameRenderedLine(first: HTMLElement, second: HTMLElement): void {
  const firstRect = first.getBoundingClientRect();
  const secondRect = second.getBoundingClientRect();
  expect(Math.abs(firstRect.top - secondRect.top)).toBeLessThan(1);
  expect(Math.abs(firstRect.bottom - secondRect.bottom)).toBeLessThan(1);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('approval file target rendering', () => {
  it('paints explicit spacing and keeps each separator with its following field', () => {
    renderNotice();

    const summary = screen.getByTestId('approval-file-target-summary');
    const [pathSeparator, rootSeparator] = screen.getAllByText('·', {
      exact: true,
      selector: 'span',
    });
    const pathLabel = screen.getByText('Path:', { exact: true, selector: 'span' });
    const pathValue = screen.getByText('src/new-file.ts');
    const rootLabel = screen.getByText('Workspace root:', { exact: true, selector: 'span' });
    const rootValue = screen.getByTestId('approval-workspace-root-value');

    if (!(pathSeparator && rootSeparator)) {
      throw new Error('Expected path and root separators');
    }

    expect(summary).toHaveTextContent(
      'Creates or overwrites · Path: src/new-file.ts · Workspace root: workspace'
    );

    // A narrow real layout makes independent flex items wrap. Each separator
    // must travel with its field rather than becoming an orphan on another line.
    expectSameRenderedLine(pathSeparator, pathLabel);
    expectSameRenderedLine(rootSeparator, rootLabel);

    // Real Chromium range geometry proves the spaces are painted. textContent
    // alone cannot distinguish this from flexbox's edge-whitespace collapse.
    const separatorGlyph = textRange(pathSeparator, 1, 2);
    const separatorRect = pathSeparator.getBoundingClientRect();
    expect(separatorGlyph.left - separatorRect.left).toBeGreaterThan(0);
    expect(separatorRect.right - separatorGlyph.right).toBeGreaterThan(0);
    expect(
      pathValue.getBoundingClientRect().left - textRange(pathLabel, 0, 5).right
    ).toBeGreaterThan(0);
    expect(
      rootValue.getBoundingClientRect().left - textRange(rootLabel, 0, 15).right
    ).toBeGreaterThan(0);
  });
});
