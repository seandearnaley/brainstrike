import { createLogger } from '@brainstrike/logging';

const logger = createLogger('AssistantGrepZeroMatchProbes');

/** Wall-clock ceiling for each optional zero-match steering probe. */
export const ZERO_MATCH_PROBE_TIMEOUT_MS = 2000;

export interface ZeroMatchProbeCount {
  fileCount: number;
  matchCount: number;
}

export interface ZeroMatchProbeDeps {
  runCaseProbe: () => Promise<ZeroMatchProbeCount>;
  runExcludedPathProbe: () => Promise<ZeroMatchProbeCount>;
  runLiteralProbe: () => Promise<ZeroMatchProbeCount>;
}

type ZeroMatchProbeName = 'case' | 'literal' | 'excludedPath';

/**
 * Keep every auxiliary probe failure inside the steering seam. A probe is
 * useful guidance, never part of grepSearch correctness, so a timeout or throw
 * is logged and treated exactly like a count-only miss.
 */
async function runProbeSafely(
  probe: ZeroMatchProbeName,
  run: () => Promise<ZeroMatchProbeCount>
): Promise<ZeroMatchProbeCount> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`zero-match ${probe} probe timed out`));
        }, ZERO_MATCH_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn(`zero-match ${probe} probe failed; treating as a miss`, { error });
    return { fileCount: 0, matchCount: 0 };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Run eligible count-only steering probes in diagnostic order. The first hit
 * wins; an all-miss result stays byte-for-byte silent at the result envelope.
 */
export async function resolveZeroMatchProbeNote(
  input: { caseSensitive: boolean; isRegex: boolean },
  deps: ZeroMatchProbeDeps
): Promise<string | undefined> {
  if (input.caseSensitive) {
    const result = await runProbeSafely('case', deps.runCaseProbe);
    if (result.matchCount > 0) {
      return `0 exact-case matches, but ${result.matchCount} case-insensitive matches in ${result.fileCount} files — the pattern's casing may be wrong.`;
    }
  }

  if (input.isRegex) {
    const result = await runProbeSafely('literal', deps.runLiteralProbe);
    if (result.matchCount > 0) {
      return `0 regex matches, but ${result.matchCount} literal matches — regex metacharacters may need escaping.`;
    }
  }

  const result = await runProbeSafely('excludedPath', deps.runExcludedPathProbe);
  if (result.matchCount > 0) {
    return `0 matches in indexed/visible files, but ${result.matchCount} matches in excluded or ignored paths — scope explicitly to include them.`;
  }
  return;
}
