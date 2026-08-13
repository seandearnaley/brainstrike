import { createLogger } from '@brainstrike/logging';

const logger = createLogger('AssistantGrepZeroMatchProbes');

/** Wall-clock ceiling for each optional zero-match steering probe. */
export const ZERO_MATCH_PROBE_TIMEOUT_MS = 2000;

export interface ZeroMatchProbeCount {
  examplePaths?: readonly string[];
  matchCount: number;
  /** The probe's bounded run hit its time budget: a zero count is "did not finish", not "no matches" (BST-1246). */
  timedOut?: boolean;
}

export interface ZeroMatchProbeDeps {
  runCaseProbe: (signal: AbortSignal) => Promise<ZeroMatchProbeCount>;
  runExcludedPathProbe: (signal: AbortSignal) => Promise<ZeroMatchProbeCount>;
  runLiteralProbe: (signal: AbortSignal) => Promise<ZeroMatchProbeCount>;
}

type ZeroMatchProbeName = 'case' | 'literal' | 'excludedPath';

/**
 * Keep every auxiliary probe failure inside the steering seam. A probe is
 * useful guidance, never part of grepSearch correctness, so a timeout or throw
 * is logged and treated exactly like a count-only miss.
 */
async function runProbeSafely(
  probe: ZeroMatchProbeName,
  run: (signal: AbortSignal) => Promise<ZeroMatchProbeCount>
): Promise<ZeroMatchProbeCount> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`zero-match ${probe} probe timed out`));
        }, ZERO_MATCH_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn(`zero-match ${probe} probe failed; treating as a miss`, { error });
    // An errored/timed-out probe DID NOT FINISH — flag it so consumers can
    // distinguish "no matches" from "unknown" (only the excluded-path note
    // renders it today).
    return { matchCount: 0, timedOut: true };
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
      return `0 exact-case matches, but ${result.matchCount} case-insensitive matches — the pattern's casing may be wrong.`;
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
    const examples = result.examplePaths?.slice(0, 2);
    const exampleNote = examples && examples.length > 0 ? ` (e.g. ${examples.join(', ')})` : '';
    return `0 matches in indexed/visible files, but ${result.matchCount} matches in excluded or ignored paths${exampleNote} — grepSearch cannot reach these; call globWorkspace with includeIgnored: true to list them, then readWorkspaceFile to inspect.`;
  }
  if (result.timedOut) {
    // BST-1246 review: the excluded-path probe searches UNPRUNED trees
    // (node_modules included, by design) under a short budget, so on large
    // repos it can time out routinely. A silent zero here would be the same
    // silent-degradation pattern this ticket removed from the live pass —
    // say "unfinished", never "no matches".
    return 'the excluded-path probe did not finish within its time budget, so matches may still exist in excluded or ignored paths — call globWorkspace with includeIgnored: true to check.';
  }
  return;
}
