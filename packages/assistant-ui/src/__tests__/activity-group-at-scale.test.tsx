// @vitest-environment jsdom
// Activity trace at scale: how one group lays out a long run. Rendered through
// the real grouper, `ActivityGroup` and the shared cards; the recorded Luna
// run is the desktop E2E's own committed host log.
import '@testing-library/jest-dom/vitest';
import type { ThreadAssistantMessage, ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import { Harness } from './assistant-activity-timeline-fixtures';
import recording from './fixtures/committed-luna-long-tool-run.json';

const neverRun = {
  run(): never {
    throw new Error('Hydration must not invoke a model.');
  },
};

function recordedAnswer(): ThreadAssistantMessage['content'] {
  const rows: readonly CommittedAssistantLogRow[] = recording;
  const start = rows.find(({ event }) => event['type'] === 'run.started');
  const runId = start?.event['runId'];
  if (!(start && typeof runId === 'string')) {
    throw new Error('The recording has no run.');
  }
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date(start.ts ?? 0),
      parentMessageId: null,
      userMessageId: 'recorded-prompt',
    }),
    threadId: start.threadId,
  });
  const answer = projection
    .acceptCommitted(rows)
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  if (answer?.role !== 'assistant') {
    throw new Error('The recording has no answer.');
  }
  return answer.content;
}

function call(id: string, toolName: string, args: Record<string, unknown>, failed = false) {
  return {
    args,
    argsText: JSON.stringify(args),
    isError: failed,
    result: failed ? { error: `Path "${String(args['path'])}" does not exist.` } : { ok: true },
    toolCallId: id,
    toolName,
    type: 'tool-call' as const,
  };
}

const read = (id: string, path: string, failed = false) =>
  call(id, 'brainstrike.readWorkspaceFile', { path }, failed);

function renderAnswer(content: readonly unknown[]) {
  return render(
    <Harness
      adapter={neverRun}
      initialMessages={[{ content, role: 'assistant' } as ThreadMessageLike]}
    />
  );
}

async function openGroup(): Promise<HTMLElement> {
  const group = await screen.findByTestId('assistant-activity-group');
  fireEvent.click(within(group).getByRole('button', { name: 'Expand activity' }));
  return group;
}

describe('a long run in one activity group', () => {
  it('folds the recorded run’s twelve reads into one row whose members are not mounted', async () => {
    renderAnswer(recordedAnswer());
    const group = await openGroup();
    const cluster = within(group).getByTestId('activity-cluster');
    expect(cluster).toHaveTextContent('Read 12 files');
    expect(cluster).toHaveTextContent('module-1.ts, module-2.ts, module-3.ts, +9');
    // Only the glob and grep are mounted; the folded reads build nothing.
    expect(within(group).getAllByTestId('tool-fallback')).toHaveLength(2);
    expect(
      within(group)
        .getAllByTestId('tool-fallback')
        .map((card) => card.getAttribute('data-chrome'))
    ).toEqual(['row', 'row']);
    // One root: the rows do not repeat its name.
    expect(within(group).queryByText(/^in bs-e2e-long-tool-run/u)).toBeNull();

    fireEvent.click(
      within(cluster).getByRole('button', { name: /^Read 12 files.*show 12 calls$/u })
    );
    expect(within(group).getAllByTestId('tool-fallback')).toHaveLength(14);
    expect(within(cluster).getByRole('button', { name: /hide 12 calls$/u })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('keeps a 500-call run to one row, a filter bar and a capped strip', async () => {
    renderAnswer(Array.from({ length: 500 }, (_v, i) => read(`call-${i}`, `src/file-${i}.ts`)));
    const group = await openGroup();
    expect(within(group).getAllByTestId('activity-cluster')).toHaveLength(1);
    expect(within(group).getByTestId('activity-cluster')).toHaveTextContent('Read 500 files');
    expect(within(group).queryAllByTestId('tool-fallback')).toHaveLength(0);
    expect(group.querySelectorAll('.bs-step-row')).toHaveLength(1);
    expect(within(group).getByRole('button', { name: 'Reads500' })).toBeInTheDocument();
    const strip = within(group).getByTestId('assistant-activity-run-strip');
    expect(strip.querySelectorAll('rect').length).toBeLessThanOrEqual(80);
  });

  it('opens the group at its failure from the failed count, and ] / [ walk the failures', async () => {
    const content = [
      ...Array.from({ length: 5 }, (_v, i) => read(`call-${i}`, `src/a-${i}.ts`)),
      read('call-missing', 'src/missing.ts', true),
      ...Array.from({ length: 5 }, (_v, i) => read(`call-${i + 5}`, `src/b-${i}.ts`)),
      read('call-gone', 'src/gone.ts', true),
    ];
    renderAnswer(content);
    const group = await screen.findByTestId('assistant-activity-group');
    const summary = within(group).getByTestId('assistant-activity-summary');
    expect(summary).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(within(group).getByRole('button', { name: 'Show 2 failed steps' }));
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-step-id')).toBe('call-missing')
    );
    // Failures stand on their own rows, as cards, between the folded runs.
    const failedCard = within(group)
      .getAllByTestId('tool-fallback')
      .find((card) => card.contains(document.activeElement));
    expect(failedCard).toHaveAttribute('data-chrome', 'card');
    expect(within(group).getAllByTestId('activity-cluster')).toHaveLength(2);

    fireEvent.keyDown(document.activeElement as Element, { key: ']' });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-step-id')).toBe('call-gone')
    );
    fireEvent.keyDown(document.activeElement as Element, { key: ']' });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-step-id')).toBe('call-missing')
    );
    fireEvent.keyDown(document.activeElement as Element, { key: '[' });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-step-id')).toBe('call-gone')
    );
  });

  it('moves between rows with the arrow keys and opens a cluster with →', async () => {
    const user = userEvent.setup();
    renderAnswer([
      call('call-glob', 'brainstrike.globWorkspace', { pattern: 'src/**/*.ts' }),
      ...Array.from({ length: 4 }, (_v, i) => read(`call-${i}`, `src/a-${i}.ts`)),
    ]);
    const group = await openGroup();
    const summary = within(group).getByTestId('assistant-activity-summary');
    summary.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-step-id')).toBe('call-glob');
    await user.keyboard('{ArrowDown}');
    const clusterRow = within(within(group).getByTestId('activity-cluster')).getByRole('button');
    expect(document.activeElement).toBe(clusterRow);
    await user.keyboard('{ArrowRight}');
    expect(clusterRow).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-step-id')).toBe('call-0');
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(clusterRow).toHaveAttribute('aria-expanded', 'false');
  });

  it('filters a long group by family or failure and restores the clusters under All', async () => {
    renderAnswer([
      ...Array.from({ length: 10 }, (_v, i) => read(`call-${i}`, `src/a-${i}.ts`)),
      read('call-missing', 'src/missing.ts', true),
      ...Array.from({ length: 9 }, (_v, i) => read(`call-${i + 10}`, `src/b-${i}.ts`)),
      call('call-grep', 'brainstrike.grepSearch', { pattern: 'needle' }),
      call('call-test', 'brainstrike.executeCommand', { command: 'pnpm test' }),
    ]);
    const group = await openGroup();
    const filters = within(group).getByRole('group', { name: 'Filter steps' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((chip) => chip.textContent)
    ).toEqual(['All22', 'Reads20', 'Commands1', 'Searches1', 'Failed1']);

    fireEvent.click(within(filters).getByRole('button', { name: 'Failed1' }));
    expect(within(group).getAllByTestId('tool-fallback')).toHaveLength(1);
    expect(within(group).queryAllByTestId('activity-cluster')).toHaveLength(0);

    fireEvent.click(within(filters).getByRole('button', { name: 'Commands1' }));
    expect(within(group).getByTestId('tool-fallback')).toHaveTextContent('pnpm test');

    fireEvent.click(within(filters).getByRole('button', { name: 'All22' }));
    expect(within(group).getAllByTestId('activity-cluster')).toHaveLength(2);
    fireEvent.click(within(group).getByRole('button', { name: 'Expand all' }));
    expect(within(group).getAllByTestId('tool-fallback')).toHaveLength(22);
  });
});
