// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Harness } from './assistant-activity-timeline-fixtures';

const neverRun = {
  async run() {
    throw new Error('Hydration must not invoke a model.');
  },
};

const completedReasoning = { text: 'Reasoned.', type: 'reasoning' as const };

function tool(toolCallId: string, extra: Record<string, unknown> = {}) {
  return {
    args: {},
    argsText: '{}',
    result: { ok: true },
    toolCallId,
    toolName: `tool_${toolCallId}`,
    type: 'tool-call' as const,
    ...extra,
  };
}

describe('AssistantActivityParts (hydrated messages)', () => {
  it('renders completed reasoning with a static reasoning mark', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [completedReasoning], role: 'assistant' }]}
      />
    );
    expect(await screen.findByTestId('assistant-reasoning-indicator')).toHaveTextContent(
      'Thinking'
    );
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass(
      'bs-thinking-mark-static'
    );
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });

  it('summarizes the tool calls within one activity group', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [tool('a'), tool('b'), tool('c')], role: 'assistant' }]}
      />
    );
    expect(await screen.findByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByText(/3 steps/)).toBeInTheDocument();
    expect(screen.getAllByTestId('tool-fallback')).toHaveLength(3);
  });

  it('retains the activity wrapper for a completed single tool call', async () => {
    render(
      <Harness adapter={neverRun} initialMessages={[{ content: [tool('a')], role: 'assistant' }]} />
    );
    expect(await screen.findByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
  });

  it('keeps the reasoning fold collapsed by default and hides the reasoning text', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [completedReasoning, tool('a')], role: 'assistant' }]}
      />
    );
    const fold = await screen.findByTestId('local-chain-of-thought');
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Reasoned.')).not.toBeInTheDocument();
  });

  it('renders text parts outside any activity group', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          { content: [tool('a'), { text: 'Answer.', type: 'text' }], role: 'assistant' },
        ]}
      />
    );
    const group = await screen.findByTestId('assistant-activity-group');
    expect(group).not.toHaveTextContent('Answer.');
    // AssistantMessageText lazy-loads its markdown renderer via a dynamic
    // import (see assistant-message-text.tsx); the real panel preloads it on
    // mount, but this isolated Harness does not, so the text part isn't
    // guaranteed to be in the DOM the instant the group is. `findByText`
    // waits for the async import to resolve, matching the pattern already
    // used in assistant-activity-timeline.behavior.test.tsx.
    expect(await screen.findByText('Answer.')).toBeInTheDocument();
  });
});
