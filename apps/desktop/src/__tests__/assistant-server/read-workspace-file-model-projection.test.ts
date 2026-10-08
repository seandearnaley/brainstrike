import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent';
import {
  decodedWorkspaceTextModelOutputChars,
  projectReadWorkspaceFileModelOutput,
} from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';

describe('projectReadWorkspaceFileModelOutput replay', () => {
  it('replays a stored projection above the resolved floor budget but below the ceiling', () => {
    const floorBudget = resolveScaledToolResultBudget(8192).domainModelResultCharBudget;
    const storedModelOutput = {
      type: 'text' as const,
      value: `read /large.txt lines 1-1/1\n${'x'.repeat(8000)}`,
    };

    expect(decodedWorkspaceTextModelOutputChars([storedModelOutput.value])).toBeGreaterThan(
      floorBudget
    );
    expect(decodedWorkspaceTextModelOutputChars([storedModelOutput.value])).toBeLessThanOrEqual(
      CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
    );
    expect(projectReadWorkspaceFileModelOutput(storedModelOutput, floorBudget)).toEqual(
      storedModelOutput
    );
  });

  it('rejects a stored projection above the fixed replay ceiling', () => {
    const floorBudget = resolveScaledToolResultBudget(8192).domainModelResultCharBudget;
    const storedModelOutput = {
      type: 'text' as const,
      value: `read /too-large.txt lines 1-1/1\n${'x'.repeat(
        CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
      )}`,
    };

    expect(() => projectReadWorkspaceFileModelOutput(storedModelOutput, floorBudget)).toThrow(
      `stored model projection exceeds the ${CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget}-character domain budget`
    );
  });
});
