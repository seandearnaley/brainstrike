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
    runCaseProbe: vi.fn(async (_signal: AbortSignal) => ({ matchCount: 0 })),
    runExcludedPathProbe: vi.fn(async (_signal: AbortSignal) => ({ matchCount: 0 })),
    runLiteralProbe: vi.fn(async (_signal: AbortSignal) => ({ matchCount: 0 })),
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
    vi.mocked(deps.runCaseProbe).mockResolvedValue({ matchCount: 5 });

    await expect(
      resolveZeroMatchProbeNote({ caseSensitive: true, isRegex: true }, deps)
    ).resolves.toBe(
      "0 exact-case matches, but 5 case-insensitive matches — the pattern's casing may be wrong."
    );
    expect(deps.runLiteralProbe).not.toHaveBeenCalled();
    expect(deps.runExcludedPathProbe).not.toHaveBeenCalled();
  });

  it('returns the literal probe note and short-circuits excluded paths', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runLiteralProbe).mockResolvedValue({ matchCount: 3 });

    const note = await resolveZeroMatchProbeNote({ caseSensitive: true, isRegex: true }, deps);

    expect(note).toBe(
      '0 regex matches, but 3 literal matches — regex metacharacters may need escaping.'
    );
    expect(deps.runExcludedPathProbe).not.toHaveBeenCalled();
  });

  it('returns the actionable excluded-path note with bounded example paths', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runExcludedPathProbe).mockResolvedValue({
      examplePaths: ['node_modules/dep/index.ts', 'dist/bundle.js', 'ignored/third.ts'],
      matchCount: 7,
    });

    const note = await resolveZeroMatchProbeNote({ caseSensitive: false, isRegex: false }, deps);

    expect(note).toBe(
      '0 matches in indexed/visible files, but 7 matches in excluded or ignored paths (e.g. node_modules/dep/index.ts, dist/bundle.js) — grepSearch cannot reach these; call globWorkspace with includeIgnored: true to list them, then readWorkspaceFile to inspect.'
    );
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
    vi.mocked(deps.runLiteralProbe).mockResolvedValue({ matchCount: 3 });

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

  it('times out a hanging excluded-path probe, logs it, and says the probe did not finish', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    let probeSignal: AbortSignal | undefined;
    vi.mocked(deps.runExcludedPathProbe).mockImplementation(
      (signal) =>
        new Promise(() => {
          probeSignal = signal;
        })
    );

    const pending = resolveZeroMatchProbeNote({ caseSensitive: false, isRegex: false }, deps);
    await vi.advanceTimersByTimeAsync(ZERO_MATCH_PROBE_TIMEOUT_MS);

    // BST-1246 review: an unfinished probe must NOT read as an honest
    // "no matches in excluded paths" — the note says so explicitly.
    await expect(pending).resolves.toBe(
      'the excluded-path probe did not finish within its time budget, so matches may still exist in excluded or ignored paths — call globWorkspace with includeIgnored: true to check.'
    );
    expect(probeSignal?.aborted).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('excludedPath'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('reports an unfinished probe from the probe result itself (timedOut flag)', async () => {
    const deps = makeDeps();
    vi.mocked(deps.runExcludedPathProbe).mockResolvedValue({ matchCount: 0, timedOut: true });

    await expect(
      resolveZeroMatchProbeNote({ caseSensitive: false, isRegex: false }, deps)
    ).resolves.toMatch(/did not finish/);
  });
});
