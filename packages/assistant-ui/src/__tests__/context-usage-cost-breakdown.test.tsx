import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CumulativeUsageSection } from '../context-usage-popover';

const model = (id: string, provider: string, costUsd: number | null, inputTokens: number) => ({
  costUsd,
  inputTokens,
  model: id,
  outputTokens: 1000,
  provider,
});

describe('the thread cost breakdown', () => {
  it('prices each source and each model it used, by catalog name', () => {
    render(
      <CumulativeUsageSection
        cumulativeUsage={{
          bySource: [
            {
              costUsd: 11.5,
              estimated: false,
              inputTokens: 900_000,
              kind: 'chat',
              models: [
                model('claude-opus-5-5', 'anthropic', 10, 700_000),
                model('gpt-5.6-sol', 'openai', 1.5, 200_000),
              ],
              outputTokens: 2000,
            },
            {
              costUsd: 0.000_42,
              estimated: false,
              inputTokens: 4200,
              kind: 'memory-embedding',
              models: [model('text-embedding-3-small', 'openai', 0.000_42, 4200)],
              outputTokens: 0,
            },
          ],
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: { available: true, provenance: 'captured-usage-estimate', usdAmount: 11.5 },
          inputTokens: 904_200,
          outputTokens: 2000,
          totalTokens: 906_200,
        }}
      />
    );

    expect(screen.getByTestId('context-usage-source-chat')).toHaveTextContent('$11.50');
    expect(
      screen.getAllByTestId('context-usage-source-model').map((row) => row.textContent)
    ).toEqual([
      expect.stringMatching(/Claude Opus 5\.5.*\$10\.00/),
      expect.stringMatching(/GPT-5\.6 Sol.*\$1\.50/),
    ]);
    // A sub-cent cost stays visible instead of rounding to $0.00.
    expect(screen.getByTestId('context-usage-source-memory-embedding')).toHaveTextContent(
      '$0.00042'
    );
  });

  it('says a source is unpriced rather than showing $0', () => {
    render(
      <CumulativeUsageSection
        cumulativeUsage={{
          bySource: [
            {
              costUsd: 1,
              estimated: false,
              inputTokens: 10,
              kind: 'chat',
              models: [model('claude-opus-5-5', 'anthropic', 1, 10)],
              outputTokens: 1000,
            },
            {
              costUsd: null,
              estimated: false,
              inputTokens: 10,
              kind: 'subagent',
              models: [model('vendor/uncatalogued', 'openrouter', null, 10)],
              outputTokens: 1000,
            },
          ],
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: { available: false, reason: 'unpriced_model' },
          inputTokens: 20,
          outputTokens: 2000,
          totalTokens: 2020,
        }}
      />
    );

    expect(screen.getByTestId('context-usage-cost')).toHaveTextContent('cost unavailable');
    expect(screen.getByTestId('context-usage-source-subagent')).toHaveTextContent('unpriced');
    expect(screen.getByTestId('context-usage-source-subagent')).not.toHaveTextContent('$0');
  });
});
