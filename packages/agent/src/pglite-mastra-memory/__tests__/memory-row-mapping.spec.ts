import type { BufferedObservationChunk, SwapBufferedToActiveInput } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';
import { chooseBufferedActivationCount } from '../memory-row-mapping';

function bufferedChunk(cycleId: string, messageTokens: number): BufferedObservationChunk {
  return {
    cycleId,
    lastObservedAt: new Date('2026-08-01T00:00:00.000Z'),
    messageIds: [`message-${cycleId}`],
    messageTokens,
    observations: `Observation ${cycleId}`,
    tokenCount: 1,
  };
}

function activationInput(
  overrides: Partial<SwapBufferedToActiveInput> = {}
): SwapBufferedToActiveInput {
  return {
    activationRatio: 0.8,
    currentPendingTokens: 600,
    id: 'memory-1',
    messageTokensThreshold: 1000,
    ...overrides,
  };
}

describe('chooseBufferedActivationCount', () => {
  it('selects the smallest boundary that reaches the target within the retention budget', () => {
    const chunks = [bufferedChunk('a', 150), bufferedChunk('b', 250), bufferedChunk('c', 300)];

    expect(chooseBufferedActivationCount(chunks, activationInput())).toEqual({ count: 2 });
  });

  it('stays below the target when the next chunk would overshoot too far', () => {
    const chunks = [bufferedChunk('a', 250), bufferedChunk('b', 400)];

    expect(chooseBufferedActivationCount(chunks, activationInput())).toEqual({ count: 1 });
  });

  it('honors forced activation when the over-target boundary retains the required floor', () => {
    const chunks = [bufferedChunk('a', 30_000), bufferedChunk('b', 68_500)];

    expect(
      chooseBufferedActivationCount(
        chunks,
        activationInput({
          activationRatio: 0.5,
          currentPendingTokens: 100_000,
          forceMaxActivation: true,
          messageTokensThreshold: 100_000,
        })
      )
    ).toEqual({ count: 2 });
  });

  it('falls back below target when the over-target boundary leaves too few pending tokens', () => {
    const chunks = [bufferedChunk('a', 150), bufferedChunk('b', 300)];

    expect(chooseBufferedActivationCount(chunks, activationInput())).toEqual({ count: 1 });
  });

  it('uses the largest available under-target boundary and keeps a non-empty fallback', () => {
    expect(
      chooseBufferedActivationCount(
        [bufferedChunk('a', 100), bufferedChunk('b', 150)],
        activationInput()
      )
    ).toEqual({ count: 2 });
    expect(chooseBufferedActivationCount([], activationInput())).toEqual({ count: 1 });
  });
});
