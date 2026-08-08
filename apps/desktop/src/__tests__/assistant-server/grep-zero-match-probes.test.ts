import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveZeroMatchProbeNote,
  ZERO_MATCH_PROBE_TIMEOUT_MS,
  type ZeroMatchProbeDeps,
} from '../../assistant-server/grep-zero-match-probes';

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

function makeDeps(): ZeroMatchProbeDeps {
  return {
    runCaseProbe: vi.fn(async () => ({ fileCount: 0, matchCount: 0 })),
    runExcludedPathProbe: vi.fn(async () => ({ fileCount: 0, matchCount: 0 })),
    runLiteralProbe: vi.fn(async () => ({ fileCount: 0, matchCount: 0 })),
  };
}

beforeEach(() => {
  loggerWarnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveZeroMatchProbeNote', () => {
  it('runs only the unconditionally eligible excluded-path probe for a plain search', async () => {
    const deps = makeDeps();

    await expect(
      resolveZeroMatchProbeNote({ caseSensitive: false, isRegex: false }, deps)
    ).resolves.toBeUndefined();
    expect(deps.runCaseProbe).not.toHaveBeenCalled();
    expect(deps.runLiteralProbe).not.toHaveBeenCalled();
    expect(deps.runExcludedPathProbe).toHaveBeenCalledOnce();
  });

  it('returns the case probe note and short-circuits later probes', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runCaseProbe).mockResolvedValue({ fileCount: 2, matchCount: 5 });

    await expect(
      resolveZeroMatchProbeNote({ caseSensitive: true, isRegex: true }, deps)
    ).resolves.toBe(
      "0 exact-case matches, but 5 case-insensitive matches in 2 files — the pattern's casing may be wrong."
    );
    expect(deps.runLiteralProbe).not.toHaveBeenCalled();
    expect(deps.runExcludedPathProbe).not.toHaveBeenCalled();
  });

  it('returns the literal probe note without a file count and short-circuits excluded paths', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runLiteralProbe).mockResolvedValue({ fileCount: 9, matchCount: 3 });

    const note = await resolveZeroMatchProbeNote({ caseSensitive: true, isRegex: true }, deps);

    expect(note).toBe(
      '0 regex matches, but 3 literal matches — regex metacharacters may need escaping.'
    );
    expect(note).not.toContain('9');
    expect(deps.runExcludedPathProbe).not.toHaveBeenCalled();
  });

  it('returns the excluded-path note without a file count', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runExcludedPathProbe).mockResolvedValue({ fileCount: 4, matchCount: 7 });

    const note = await resolveZeroMatchProbeNote({ caseSensitive: false, isRegex: false }, deps);

    expect(note).toBe(
      '0 matches in indexed/visible files, but 7 matches in excluded or ignored paths — scope explicitly to include them.'
    );
    expect(note).not.toContain('4');
  });

  it('stays silent when every eligible probe misses', async () => {
    const deps = makeDeps();

    await expect(
      resolveZeroMatchProbeNote({ caseSensitive: true, isRegex: true }, deps)
    ).resolves.toBeUndefined();
    expect(deps.runCaseProbe).toHaveBeenCalledOnce();
    expect(deps.runLiteralProbe).toHaveBeenCalledOnce();
    expect(deps.runExcludedPathProbe).toHaveBeenCalledOnce();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('logs a thrown probe failure and continues to the next eligible probe', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runCaseProbe).mockRejectedValue(new Error('case probe broke'));
    vi.mocked(deps.runLiteralProbe).mockResolvedValue({ fileCount: 1, matchCount: 3 });

    await expect(
      resolveZeroMatchProbeNote({ caseSensitive: true, isRegex: true }, deps)
    ).resolves.toBe(
      '0 regex matches, but 3 literal matches — regex metacharacters may need escaping.'
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('case'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('times out a hanging probe, logs it, and treats it as a miss', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    vi.mocked(deps.runExcludedPathProbe).mockImplementation(() => new Promise(() => undefined));

    const pending = resolveZeroMatchProbeNote({ caseSensitive: false, isRegex: false }, deps);
    await vi.advanceTimersByTimeAsync(ZERO_MATCH_PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('excludedPath'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});
