import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssistantGenerationMark, GenerationDetailsList } from '../assistant-generation-mark';
import {
  type GenerationDetails,
  GenerationDetailsProvider,
  type GenerationDetailsSource,
} from '../generation-details-context';

const finished: GenerationDetails = {
  cost: { basis: 'estimated', usd: 0.0412 },
  effort: 'high',
  finishReason: 'stop',
  firstOutputMs: 1900,
  model: { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 (OpenRouter)' },
  modelTimeMs: 21_400,
  outcome: 'completed',
  provider: { id: 'openrouter', name: 'OpenRouter' },
  steps: 4,
  tokens: { cacheRead: 12_900, cacheWrite: 0, input: 18_200, output: 1400, reasoning: 820 },
  toolCalls: 3,
  vendor: { id: 'anthropic', name: 'Anthropic' },
  wallTimeMs: 38_000,
};

function rowsOf(list: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    within(list)
      .getAllByRole('term')
      .map((term) => [term.textContent ?? '', term.nextElementSibling?.textContent ?? ''])
  );
}

describe('GenerationDetailsList', () => {
  it("states a finished run's model, settings, tokens, time and estimated cost, and nothing it need not", () => {
    render(<GenerationDetailsList details={finished} />);
    const list = screen.getByTestId('generation-details');
    expect(within(list).getByText('Claude Opus 5.5 (OpenRouter)')).toBeInTheDocument();
    // A run that simply finished says neither its status nor its end reason.
    expect(rowsOf(list)).toEqual({
      Effort: 'high',
      'Estimated cost': expect.stringMatching(/^\$0\.04/u),
      'First token': '1.9s',
      Input: '18,200 · 12,900 cached',
      'Model time': '21.4s',
      Output: '1,400 · 820 reasoning',
      Steps: '4 · 3 tool calls',
      'Total time': '38s',
    });
  });

  it('says a running run is running and leaves out every figure it never reported', () => {
    render(
      <GenerationDetailsList
        details={{
          model: { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
          provider: { id: 'openai', name: 'OpenAI' },
          steps: 0,
          tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, reasoning: 0 },
        }}
      />
    );
    expect(rowsOf(screen.getByTestId('generation-details'))).toEqual({
      Input: '0',
      Output: '0',
      Status: 'Running',
      Steps: '0',
    });
  });

  it('names a cut-off end and the billed basis of a reported cost', () => {
    render(
      <GenerationDetailsList
        details={{
          ...finished,
          cost: { basis: 'billed', usd: 0.05 },
          finishReason: 'length',
          outcome: 'failed',
          servedModel: 'anthropic/claude-opus-5.5-20261001',
        }}
      />
    );
    expect(rowsOf(screen.getByTestId('generation-details'))).toMatchObject({
      Billed: '$0.05',
      Ended: 'Output limit',
      'Served as': 'anthropic/claude-opus-5.5-20261001',
      Status: 'Failed',
    });
  });
});

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({ content: [], status: { reason: 'stop', type: 'complete' } }),
};

function Harness({
  messages,
  source,
}: {
  readonly messages: readonly ThreadMessageLike[];
  readonly source: GenerationDetailsSource | null;
}) {
  const runtime = useLocalRuntime(chatModel, { initialMessages: messages });
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <GenerationDetailsProvider value={source}>
          <ThreadPrimitive.Messages
            components={{
              AssistantMessage: () => (
                <MessagePrimitive.Root data-testid="answer">
                  <AssistantGenerationMark />
                </MessagePrimitive.Root>
              ),
              UserMessage: () => null,
            }}
          />
        </GenerationDetailsProvider>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

const answer = (hostRunId: string | undefined): ThreadMessageLike => ({
  content: [{ text: 'Answer', type: 'text' }],
  ...(hostRunId ? { metadata: { custom: { hostRunId } } } : {}),
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' },
});

const source: GenerationDetailsSource = {
  read: (runId) => (runId === 'run-1' ? finished : undefined),
  subscribe: () => () => undefined,
};

describe('AssistantGenerationMark', () => {
  it("marks the message with its run's maker and gateway, and shows the details on focus", async () => {
    render(<Harness messages={[answer('run-1')]} source={source} />);
    const mark = await screen.findByRole('img', { name: 'Claude Opus 5.5 (OpenRouter)' });
    const glyph = mark.querySelector('[data-model-mark]');
    expect(glyph).toHaveAttribute('data-model-mark', 'anthropic');
    expect(glyph).toHaveAttribute('data-model-route', 'openrouter');

    await userEvent.setup().tab();
    expect(mark).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Estimated cost');
    // Screen readers hear the details as the mark's description.
    expect(mark).toHaveAccessibleDescription(expect.stringContaining('1,400 · 820 reasoning'));
  });

  it('shows no mark for a message without a run, or a run the view has no details for', async () => {
    render(<Harness messages={[answer(undefined), answer('run-2')]} source={source} />);
    expect(await screen.findAllByTestId('answer')).toHaveLength(2);
    expect(screen.queryByTestId('generation-mark')).not.toBeInTheDocument();
  });

  it('shows no mark where the view binds no run details', async () => {
    render(<Harness messages={[answer('run-1')]} source={null} />);
    expect(await screen.findAllByTestId('answer')).toHaveLength(1);
    expect(screen.queryByTestId('generation-mark')).not.toBeInTheDocument();
  });
});
