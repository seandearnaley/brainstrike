import {
  applyToolModelOutputProjections,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRepeatedCallRefusalResult,
  buildRepeatedCallWarningText,
  checkRepeatedToolCall,
  mergeHintWithWarning,
  resetToolCallLoopGuards,
} from '../../assistant-server/tool-call-loop-guards';
import {
  projectGlobWorkspaceModelOutput,
  projectGrepSearchModelOutput,
} from '../../assistant-server/workspace-search-model-projections';

/**
 * BST-1188 loop guards: proof that the repeated-identical-call warning and
 * refusal survive the REAL grep/glob projectors (workspace-search-model-projections.ts,
 * grep-search-result-contract.ts — neither file is touched by BST-1188) and the
 * runtime dispatcher's fail-soft path. Split from workspace-search-model-projections.test.ts
 * (BST-1185/BST-1191) to stay under the file's own 1000-line lint ceiling; the
 * projector functions under test are unchanged by this split.
 *
 * - The warning is folded into the result's `hint` (the only field these
 *   purpose-built projectors always render when truthy — an arbitrary extra
 *   key is dropped).
 * - The refusal object (no `outputMode`) is REJECTED by the parsers and
 *   degrades through the SAME fail-soft dispatcher path
 *   workspace-search-model-projections.test.ts proves for other malformed
 *   shapes, rather than throwing and failing the run.
 */
describe('BST-1188 loop-guard warning/refusal projection round trip', () => {
  beforeEach(() => {
    resetToolCallLoopGuards();
  });

  it('renders third-call warnings folded into grep and glob hints, alongside any existing hint', () => {
    const grepArgs = { pattern: 'needle' };
    const globArgs = { pattern: '*.ts' };
    let grepCall = checkRepeatedToolCall('thread-warning', 'brainstrike.grepSearch', grepArgs);
    let globCall = checkRepeatedToolCall('thread-warning', 'brainstrike.globWorkspace', globArgs);
    for (let count = 0; count < 2; count += 1) {
      grepCall = checkRepeatedToolCall('thread-warning', 'brainstrike.grepSearch', grepArgs);
      globCall = checkRepeatedToolCall('thread-warning', 'brainstrike.globWorkspace', globArgs);
    }
    expect(grepCall).toEqual({ count: 3, status: 'warn' });
    expect(globCall).toEqual({ count: 3, status: 'warn' });

    const grepWarning = buildRepeatedCallWarningText('brainstrike.grepSearch', grepCall.count);
    const globWarning = buildRepeatedCallWarningText('brainstrike.globWorkspace', globCall.count);
    const grepProjected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      files: [],
      hint: mergeHintWithWarning('Existing grep guidance.', grepWarning),
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    });
    const globProjected = projectGlobWorkspaceModelOutput({
      count: 0,
      hint: mergeHintWithWarning('Existing glob guidance.', globWarning),
      matches: [],
      offset: 0,
      scanLimited: false,
      totalMatches: 0,
      truncated: false,
    });

    expect(grepProjected.value).toContain(grepWarning);
    expect(grepProjected.value).toContain('Existing grep guidance.');
    expect(globProjected.value).toContain(globWarning);
    expect(globProjected.value).toContain('Existing glob guidance.');
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
      ])
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
