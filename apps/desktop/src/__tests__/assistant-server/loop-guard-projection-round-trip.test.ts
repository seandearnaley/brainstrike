import {
  applyToolModelOutputProjections,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  resolveScaledToolResultBudget,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import type { GrepFileSummary, GrepToolResult } from '@brainstrike/host-capabilities/native-tools';
import {
  buildRepeatedCallRefusalResult,
  projectGlobWorkspaceModelOutput,
  projectGrepSearchModelOutput,
  resetToolCallLoopGuards,
  withRepeatedCallGuard,
} from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-1188 loop guards: proof that the repeated-identical-call warning and
 * refusal survive the REAL grep/glob projectors (workspace-search-model-projections.ts,
 * grep-search-result-contract.ts) and the runtime dispatcher's fail-soft path.
 * Split from workspace-search-model-projections.test.ts (BST-1185/BST-1191) to
 * stay under the file's own 1000-line lint ceiling; the projector functions
 * under test are unchanged by this split.
 *
 * - The warning is its OWN `loopGuardWarning` field, rendered as its own
 *   `warning:` line UNCONDITIONALLY — never folded into `hint`, which the
 *   continuation logic skips whenever the page was already trimmed by the
 *   output-char budget (PR #2323 review: exactly the large/expensive
 *   repeats this guard exists to stop).
 * - The refusal object (no `outputMode`) is REJECTED by the parsers and
 *   degrades through the SAME fail-soft dispatcher path
 *   workspace-search-model-projections.test.ts proves for other malformed
 *   shapes, rather than throwing and failing the run.
 * - `withRepeatedCallGuard` never calls `run` on the 4th+ consecutive call
 *   (drives these tests through the ACTUAL production entry point, not just
 *   the underlying peek/commit primitives).
 */
describe('BST-1188 loop-guard warning/refusal projection round trip', () => {
  beforeEach(() => {
    resetToolCallLoopGuards();
  });

  async function grepCallsUntil(
    threadScope: string,
    input: unknown,
    result: () => GrepToolResult,
    times: number
  ): Promise<Awaited<ReturnType<typeof withRepeatedCallGuard<GrepToolResult>>>> {
    let last: Awaited<ReturnType<typeof withRepeatedCallGuard<GrepToolResult>>> | undefined;
    for (let attempt = 0; attempt < times; attempt += 1) {
      last = await withRepeatedCallGuard({
        input,
        run: () => Promise.resolve(result()),
        threadScope,
        toolId: 'brainstrike.grepSearch',
      });
    }
    if (!last) {
      throw new Error('grepCallsUntil requires times > 0');
    }
    return last;
  }

  it('renders the third-call warning as its own line on a healthy result', async () => {
    const args = { pattern: 'needle' };
    const buildHealthy = (): GrepToolResult => ({
      candidatesTruncated: false,
      files: [],
      hint: 'Existing grep guidance.',
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    });

    const warned = await grepCallsUntil('thread-warning', args, buildHealthy, 3);

    expect('loopGuardWarning' in warned && warned.loopGuardWarning).toContain(
      'made this exact brainstrike.grepSearch call 3 times in a row'
    );
    const projected = projectGrepSearchModelOutput(warned);
    expect(projected.value).toContain('warning: You have made this exact');
    // The pre-existing hint (real continuation guidance) must survive
    // alongside the warning — the warning is an ADDITIONAL line, not a
    // replacement.
    expect(projected.value).toContain('Existing grep guidance.');
  });

  it('still renders the warning when the page overflows the char budget and the hint is suppressed', async () => {
    // Mirrors workspace-search-model-projections.test.ts's own "fits a
    // maximum grep page to the domain ceiling" fixture: enough long-path
    // items that the projector's own budget-fit loop drops items and
    // switches the continuation line to the `offset=` form — the exact
    // condition under which a `hint`-borne warning previously vanished
    // (PR #2323 review).
    const args = { pattern: 'needle' };
    const buildOverflowing = (): GrepToolResult => ({
      candidatesTruncated: false,
      files: Array.from({ length: 50 }, (_, index) => ({
        firstLine: index + 1,
        matchCount: index + 2,
        path: `/very/long/generated/path/${String(index).padStart(3, '0')}-${'x'.repeat(80)}.ts`,
        rootId: `root-${index % 2}`,
        rootName: index % 2 === 0 ? 'alpha' : 'beta',
        source: 'both' as const,
      })) satisfies GrepFileSummary[],
      liveEngine: 'ripgrep',
      offset: 0,
      openRoots: 2,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 50,
      totalMatches: 20_000,
      truncated: false,
    });

    const warned = await grepCallsUntil('thread-overflow', args, buildOverflowing, 3);
    const projected = projectGrepSearchModelOutput(warned);

    expect(serializedCharsOf(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    // Proves this candidate really did hit the omitted-by-projection path
    // (offset-form continuation), the branch that discards `hint`.
    expect(projected.value).toMatch(
      /continue: reuse the prior brainstrike\.grepSearch input with offset=\d+$/
    );
    expect(projected.value).toContain('warning: You have made this exact');
  });

  function serializedCharsOf(value: unknown): number {
    return JSON.stringify(value).length;
  }

  it('never calls run on the 4th+ consecutive identical call', async () => {
    const args = { pattern: 'needle' };
    const run = vi.fn(
      (): Promise<GrepToolResult> =>
        Promise.resolve({
          candidatesTruncated: false,
          files: [],
          liveEngine: 'ripgrep',
          offset: 0,
          outputMode: 'files',
          scanLimited: false,
          totalFiles: 0,
          totalMatches: 0,
          truncated: false,
        })
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withRepeatedCallGuard({
        input: args,
        run,
        threadScope: 'thread-skip',
        toolId: 'brainstrike.grepSearch',
      });
    }
    expect(run).toHaveBeenCalledTimes(3);

    const fourth = await withRepeatedCallGuard({
      input: args,
      run,
      threadScope: 'thread-skip',
      toolId: 'brainstrike.grepSearch',
    });

    expect(run).toHaveBeenCalledTimes(3); // NOT 4 — the guard skipped it.
    expect(fourth).toMatchObject({ ok: false, refused: true });
  });

  it('rejects fourth-call refusal objects with the typed projector marker', () => {
    const grepRefusal = buildRepeatedCallRefusalResult('brainstrike.grepSearch', 4);
    const globRefusal = buildRepeatedCallRefusalResult('brainstrike.globWorkspace', 4);

    expect(() => projectGrepSearchModelOutput(grepRefusal)).toThrow(
      ToolProjectionInputRejectedError
    );
    expect(() => projectGlobWorkspaceModelOutput(globRefusal)).toThrow(
      ToolProjectionInputRejectedError
    );
  });

  it('keeps loop-guard refusals non-throwing through the runtime dispatcher', () => {
    const grepRefusal = buildRepeatedCallRefusalResult('brainstrike.grepSearch', 4);
    const globRefusal = buildRepeatedCallRefusalResult('brainstrike.globWorkspace', 4);
    const tools = applyToolModelOutputProjections(
      {
        globWorkspace: {
          execute: () => globRefusal,
          id: 'brainstrike.globWorkspace',
          toModelOutput: projectGlobWorkspaceModelOutput,
        } as never,
        grepSearch: {
          execute: () => grepRefusal,
          id: 'brainstrike.grepSearch',
          toModelOutput: projectGrepSearchModelOutput,
        } as never,
      },
      new Map([
        ['globWorkspace', 'brainstrike.globWorkspace'],
        ['grepSearch', 'brainstrike.grepSearch'],
      ]),
      undefined,
      resolveScaledToolResultBudget(131_072)
    );
    const globProjection = (
      tools['globWorkspace'] as {
        toModelOutput?: (value: unknown) => unknown;
      }
    ).toModelOutput?.(globRefusal) as { type?: string; value?: string };
    const grepProjection = (
      tools['grepSearch'] as {
        toModelOutput?: (value: unknown) => unknown;
      }
    ).toModelOutput?.(grepRefusal) as { type?: string; value?: string };

    expect(globProjection.type).toBe('text');
    expect(globProjection.value).toContain('refused');
    expect(grepProjection.type).toBe('text');
    expect(grepProjection.value).toContain('refused');
  });
});
