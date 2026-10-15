import { diffPromptToolCallWindow } from '@brainstrike/assistant-contract/context-breakdown';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import { ContextMapLinkContext } from '../context-map-link-context';
import { ContextUsageMeter } from '../context-usage-meter';
import { resetContextUsageStore } from '../context-usage-store';
import { ThreadContextFold } from '../thread-context-fold';
import { resetThreadContextStore, useThreadContextStore } from '../thread-context-store';

vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(
    selector: (state: { thread: { isRunning: boolean; messages: unknown[] } }) => T
  ) => selector({ thread: { isRunning: false, messages: [] } }),
}));

const props = { contextWindow: 200_000, effectiveInputBudget: 126_000, threadKey: 't1' };

function seed(window: boolean): void {
  const rows: CommittedAssistantLogRow[] = [];
  const add = (event: Record<string, unknown>) =>
    rows.push({ event, seq: rows.length + 1, threadId: 't1' });
  add({ prompt: 'p', runId: 'r1', type: 'run.started' });
  add({
    input: {},
    runId: 'r1',
    toolCallId: 'a',
    toolCatalogId: 'brainstrike.readWorkspaceFile',
    type: 'effect.started',
  });
  add({
    output: {
      approxOutputTokens: 1,
      content: '1: x',
      endLine: 1,
      path: 'src/a.ts',
      rootId: 'root',
      startLine: 1,
      totalLines: 1,
      truncated: false,
    },
    runId: 'r1',
    toolCallId: 'a',
    type: 'effect.finished',
  });
  add({
    runId: 'r1',
    type: 'provider.request.prepared',
    ...(window
      ? {
          toolCallWindow: diffPromptToolCallWindow(undefined, [
            {
              inputTokens: 10,
              output: 'full',
              outputTokens: 2390,
              toolCallId: 'a',
              toolName: 'brainstrike.readWorkspaceFile',
            },
          ]),
        }
      : {}),
  });
  const snapshot = new ThreadContextFold().accept(rows);
  useThreadContextStore.getState().record('t1', { branchRunIds: ['r1'], snapshot });
}

beforeEach(() => {
  resetContextUsageStore();
  resetThreadContextStore();
});
afterEach(cleanup);

describe('ContextUsageMeter workspace files row', () => {
  it("shows the latest window's file tokens and opens the Context tab", () => {
    seed(true);
    const openContextMap = vi.fn();
    render(
      <ContextMapLinkContext value={{ openContextMap }}>
        <ContextUsageMeter {...props} />
      </ContextMapLinkContext>
    );
    fireEvent.focus(screen.getByTestId('context-usage-trigger'));
    expect(screen.getByTestId('context-usage-workspace-files').textContent).toContain('~2.4K');
    fireEvent.click(screen.getByTestId('context-usage-open-context-map'));
    expect(openContextMap).toHaveBeenCalledOnce();
  });

  it('says the window was not recorded, and offers no link without the Context tab', () => {
    seed(false);
    render(<ContextUsageMeter {...props} />);
    fireEvent.focus(screen.getByTestId('context-usage-trigger'));
    expect(screen.getByTestId('context-usage-workspace-files').textContent).toContain(
      'not recorded'
    );
    expect(screen.queryByTestId('context-usage-open-context-map')).toBeNull();
  });

  it('shows no row where no thread context exists', () => {
    render(<ContextUsageMeter {...props} />);
    fireEvent.focus(screen.getByTestId('context-usage-trigger'));
    expect(screen.queryByTestId('context-usage-workspace-files')).toBeNull();
  });

  it("publishes the ring's figure for the Context tab, and nothing while the ring is hidden", () => {
    const { rerender } = render(<ContextUsageMeter {...props} estimatedTokens={4000} />);
    expect(useThreadContextStore.getState().ringByThread['t1']).toEqual({
      budgetTokens: 126_000,
      isEstimated: true,
      usedTokens: 4000,
    });
    resetThreadContextStore();
    rerender(<ContextUsageMeter {...props} contextWindow={undefined} estimatedTokens={5000} />);
    expect(useThreadContextStore.getState().ringByThread['t1']).toBeUndefined();
  });
});
