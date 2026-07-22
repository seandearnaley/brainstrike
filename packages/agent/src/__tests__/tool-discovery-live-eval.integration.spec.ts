import { describe, expect, it } from 'vitest';
import {
  runToolDiscoveryLiveEvaluation,
  TOOL_DISCOVERY_LIVE_EVAL_CASES,
} from '../evaluation/tool-discovery-live-eval';

const liveEvalEnabled = process.env['BRAINSTRIKE_RUN_LIVE_TOOL_DISCOVERY_EVAL'] === '1';

describe.skipIf(!liveEvalEnabled)('live hosted tool-discovery evaluation', () => {
  it('selects workspace context across the advisory small-model matrix', async () => {
    const report = await runToolDiscoveryLiveEvaluation();
    const failureContext = JSON.stringify(report, null, 2);

    expect(
      report.cases.map(({ id }) => id),
      failureContext
    ).toEqual(TOOL_DISCOVERY_LIVE_EVAL_CASES.map(({ id }) => id));
    expect(
      report.cases.every(
        ({ finalToolChoice, selectedToolIds }) =>
          finalToolChoice === 'brainstrike_listWorkspaceContext' &&
          selectedToolIds.includes('brainstrike_listWorkspaceContext')
      ),
      failureContext
    ).toBe(true);
    expect(
      report.cases.every(({ searchObservations }) => searchObservations.length > 0),
      failureContext
    ).toBe(true);
    expect(report.passed, failureContext).toBe(true);
  }, 240_000);
});
