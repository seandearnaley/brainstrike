// @vitest-environment jsdom
import { TooltipProvider } from '@brainstrike/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import { HOST_CONTEXT_COMPACTED_DATA_NAME } from '../compaction-summary-message';
import { PublishedConversation, viewMessage } from './committed-assistant-test-support';

afterEach(cleanup);

/** A compaction card part whose host-written lists are empty. */
const NO_LISTS = { earlierRequests: [], filesEdited: [], toolsLoaded: [] };

/** An answer whose run committed a compaction with `data`, then answered. */
function compacted(id: string, data: Record<string, unknown>) {
  return viewMessage(id, [
    { data: { ...NO_LISTS, ...data }, name: HOST_CONTEXT_COMPACTED_DATA_NAME, type: 'data' },
    { text: `Answer after ${id}`, type: 'text' },
  ]);
}

/** The committed thread of `messages`, and its compaction cards in order. */
async function cards(messages: ReturnType<typeof viewMessage>[], count: number) {
  render(
    <TooltipProvider>
      <CommittedAssistantConversation
        commands={{ onNew: vi.fn() }}
        label="Conversation"
        store={new PublishedConversation('root', messages)}
      />
    </TooltipProvider>
  );
  const found = await screen.findAllByTestId('compaction-summary-card');
  if (found.length !== count) {
    throw new Error(`Expected ${count} compaction cards`);
  }
  return found;
}

describe('the compaction card in the committed thread', () => {
  it('shows a compaction that fell back', async () => {
    const summary =
      'Deterministic fallback: dropped 3 earlier turns (6 messages) after an agentic summarizer failure; no summarization model ran.';
    const [card] = await cards(
      [
        compacted('answer', {
          kind: 'deterministic',
          reason: 'pre-request',
          summary,
          turnsCompacted: 3,
        }),
      ],
      1
    );
    expect(card).toHaveAttribute('data-compaction-fallback', 'deterministic');
    expect(card).toHaveTextContent('Deterministic compaction (no summarization model ran)');
    expect(card).toHaveTextContent(summary);
  });

  it('shows why a compaction ran, the turns it compacted, and its summarizer’s model and usage', async () => {
    const [overflow, budget, refused, failed] = await cards(
      [
        compacted('overflow', {
          kind: 'deterministic',
          reason: 'context-overflow',
          summary: 'Deterministic fallback: dropped 1 earlier turns.',
          turnsCompacted: 1,
        }),
        compacted('budget', {
          kind: 'agentic',
          modelId: 'openai::gpt-6-sol',
          reason: 'pre-request',
          summary: '## Goal\nShip it.',
          turnsCompacted: 3,
          usage: { inputTokens: 12_400, outputTokens: 310 },
        }),
        // The summarizer answered outside its schema: deterministic, with its receipt.
        compacted('refused', {
          kind: 'deterministic',
          modelId: 'openai::gpt-6-sol',
          reason: 'pre-request',
          summary: 'Deterministic fallback: dropped 2 earlier turns.',
          turnsCompacted: 2,
          usage: { inputTokens: 900, outputTokens: 40 },
        }),
        // The summarizer's provider call failed: the fallback names its code and reference.
        compacted('failed', {
          kind: 'deterministic',
          reason: 'pre-request',
          summarizerFailure: {
            code: 'provider.auth-failed',
            correlationId: '0b6a1f4e-6f1c-4d4b-9a51-2f0f6e0b9c11',
          },
          summary: 'Deterministic fallback: dropped 2 earlier turns.',
          turnsCompacted: 2,
        }),
      ],
      4
    );
    if (!(overflow && budget && refused && failed)) {
      throw new Error('Expected four compaction cards');
    }
    expect(failed).toHaveTextContent('Deterministic compaction (the summarizer failed)');
    expect(within(failed).getByTestId('compaction-summary-summarizer-failure')).toHaveTextContent(
      'provider.auth-failed · Reference: 0b6a1f4e-6f1c-4d4b-9a51-2f0f6e0b9c11'
    );
    expect(
      within(overflow).queryByTestId('compaction-summary-summarizer-failure')
    ).not.toBeInTheDocument();
    expect(overflow).toHaveTextContent('Deterministic compaction (no summarization model ran)');
    expect(refused).toHaveTextContent(
      'Deterministic compaction (the summarizer’s answer did not match the required format)'
    );
    expect(within(refused).getByTestId('compaction-summary-usage')).toHaveTextContent(
      '900 in · 40 out'
    );
    expect(within(overflow).getByTestId('compaction-summary-reason')).toHaveTextContent(
      'After the provider reported a context overflow'
    );
    expect(within(overflow).getByTestId('compaction-summary-turns')).toHaveTextContent('1 turn');
    // No summarizer ran: no model or usage is claimed.
    expect(within(overflow).queryByTestId('compaction-summary-model')).not.toBeInTheDocument();
    expect(within(overflow).queryByTestId('compaction-summary-usage')).not.toBeInTheDocument();
    expect(within(budget).getByTestId('compaction-summary-reason')).toHaveTextContent(
      'Before the request, to keep it inside the context budget'
    );
    expect(within(budget).getByTestId('compaction-summary-turns')).toHaveTextContent('3 turns');
    expect(within(budget).getByTestId('compaction-summary-model')).toHaveTextContent(
      'openai::gpt-6-sol'
    );
    expect(within(budget).getByTestId('compaction-summary-usage')).toHaveTextContent(
      '12,400 in · 310 out'
    );
  });

  it('counts the steps a compaction inside a run covers, and names a request trim (BST-2531)', async () => {
    const [steps, both, trim] = await cards(
      [
        compacted('steps', {
          kind: 'agentic',
          reason: 'pre-request',
          stepsCompacted: 7,
          summary: '## Goal\nKeep going.',
          turnsCompacted: 0,
        }),
        compacted('both', {
          kind: 'agentic',
          reason: 'pre-request',
          stepsCompacted: 1,
          summary: '## Goal\nKeep going.',
          turnsCompacted: 2,
        }),
        compacted('trim', {
          kind: 'deterministic',
          reason: 'request-trim',
          summary: 'Deterministic fallback: dropped 1 earlier turns.',
          turnsCompacted: 1,
        }),
      ],
      3
    );
    if (!(steps && both && trim)) {
      throw new Error('Expected three compaction cards');
    }
    expect(within(steps).getByTestId('compaction-summary-turns')).toHaveTextContent('7 steps');
    expect(within(both).getByTestId('compaction-summary-turns')).toHaveTextContent(
      '2 turns, 1 step'
    );
    expect(within(trim).getByTestId('compaction-summary-turns')).toHaveTextContent('1 turn');
    expect(within(trim).getByTestId('compaction-summary-reason')).toHaveTextContent(
      'Left out of a request over the context budget'
    );
  });

  it('lists the files, tools and requests the host wrote, and shows the model’s summary as text (BST-2527)', async () => {
    const summary = 'Goal: Move the port.\nNext: Write the notes.';
    const [merged, fallback] = await cards(
      [
        compacted('merged', {
          earlierRequests: ['Move the port to 8443.\nKeep the old default.', 'Then the notes.'],
          filesEdited: [
            { edits: 2, path: 'src/server.ts' },
            { edits: 1, path: 'docs/port.md' },
          ],
          kind: 'agentic',
          reason: 'pre-request',
          summary,
          toolsLoaded: ['brainstrike_lspInspect'],
          turnsCompacted: 3,
        }),
        compacted('fallback', {
          kind: 'deterministic',
          reason: 'context-overflow',
          summary: 'Deterministic fallback: dropped 1 earlier turns.',
          turnsCompacted: 1,
        }),
      ],
      2
    );
    if (!(merged && fallback)) {
      throw new Error('Expected two compaction cards');
    }
    const items = (name: string) =>
      within(within(merged).getByRole('list', { name }))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    expect(items('Files edited')).toEqual(['src/server.ts 2 edits', 'docs/port.md 1 edit']);
    expect(items('Tools loaded')).toEqual(['brainstrike_lspInspect']);
    expect(items('Earlier requests')).toEqual([
      'Move the port to 8443.\nKeep the old default.',
      'Then the notes.',
    ]);
    // The model's part is its own text, not a list.
    const text = within(merged).getByText(/^Goal: Move the port\./u);
    expect(text.textContent).toBe(summary);
    expect(text.closest('ul')).toBeNull();
    // Nothing to list, no list.
    expect(within(fallback).queryAllByRole('list')).toEqual([]);
  });
});
