import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetTokenCountingRuntimeModuleForTests } from '../token-counting-runtime';

const supportsAccurateTokenCountingMock = vi.hoisted(() => vi.fn());
const countTokensAccurateMock = vi.hoisted(() => vi.fn());
const calculateGroupTokensMock = vi.hoisted(() => vi.fn());

vi.mock('../token-utils', () => ({
  calculateGroupTokens: calculateGroupTokensMock,
  supportsAccurateTokenCounting: supportsAccurateTokenCountingMock,
  countTokensAccurate: countTokensAccurateMock,
}));

describe('token-counting-runtime', () => {
  beforeEach(() => {
    __resetTokenCountingRuntimeModuleForTests();
    calculateGroupTokensMock.mockReset();
    supportsAccurateTokenCountingMock.mockReset();
    countTokensAccurateMock.mockReset();
  });

  it('keeps heuristic counting available without loading the accurate runtime', async () => {
    const { countTokensHeuristic } = await import('../token-counting-runtime');

    expect(countTokensHeuristic('abcdefgh')).toBe(2);
    expect(supportsAccurateTokenCountingMock).not.toHaveBeenCalled();
    expect(countTokensAccurateMock).not.toHaveBeenCalled();
  });

  it('loads the accurate runtime lazily for support checks', async () => {
    supportsAccurateTokenCountingMock.mockResolvedValue(true);

    const { supportsAccurateTokenCounting } = await import('../token-counting-runtime');

    await expect(supportsAccurateTokenCounting()).resolves.toBe(true);
    expect(supportsAccurateTokenCountingMock).toHaveBeenCalledTimes(1);
  });

  it('loads the accurate runtime lazily for accurate counting', async () => {
    countTokensAccurateMock.mockResolvedValue(42);

    const { countTokensAccurate } = await import('../token-counting-runtime');

    await expect(countTokensAccurate('hello world')).resolves.toBe(42);
    expect(countTokensAccurateMock).toHaveBeenCalledWith('hello world');
  });

  it('loads the accurate runtime lazily for grouped counting', async () => {
    calculateGroupTokensMock.mockResolvedValue(99);

    const { calculateGroupTokens } = await import('../token-counting-runtime');

    await expect(calculateGroupTokens(['a', 'bb'])).resolves.toBe(99);
    expect(calculateGroupTokensMock).toHaveBeenCalledWith(['a', 'bb']);
  });

  it('keeps lightweight formatting helpers local to the facade', async () => {
    const { formatTokenCount } = await import('../token-counting-runtime');

    expect(formatTokenCount(1500)).toBe('1.5K tokens');
    expect(calculateGroupTokensMock).not.toHaveBeenCalled();
    expect(supportsAccurateTokenCountingMock).not.toHaveBeenCalled();
    expect(countTokensAccurateMock).not.toHaveBeenCalled();
  });
});
