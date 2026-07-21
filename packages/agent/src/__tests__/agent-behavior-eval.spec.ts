import { describe, expect, it } from 'vitest';
import {
  runAdvisoryAgentBehaviorEvaluation,
  runAgentBehaviorEvaluation,
  runMisbehavingControlEvaluation,
} from '../evaluation/agent-behavior-eval-runner';

/**
 * BST-589 merge gate (Phase 1, deterministic — zero LLM cost): Mastra
 * runEvals gates over the REAL agent runtime (real tools, instructions,
 * gating) driven by scripted LanguageModelV2 fixtures. Mirrors the
 * hybrid-eval precedent: the vitest assertion on the verdict IS the gate.
 */
describe('agent behavior evaluation (runEvals gates)', () => {
  it('passes the deterministic gate suite: tool selection, error-free run, and plan mode', async () => {
    const report = await runAgentBehaviorEvaluation();

    expect(report.failures).toEqual([]);
    expect(report.flows.map((flow) => ({ name: flow.name, verdict: flow.verdict }))).toEqual([
      { name: 'tool-selection', verdict: 'passed' },
      { name: 'error-free-run', verdict: 'passed' },
      { name: 'plan-mode-tool-filter', verdict: 'passed' },
    ]);
    expect(report.passed).toBe(true);
  }, 120_000);

  it('reports threshold drift as advisory scored evidence, not a failed gate', async () => {
    const report = await runAdvisoryAgentBehaviorEvaluation();

    expect(report).toEqual({
      averageScore: 0.5,
      thresholdPassed: false,
      verdict: 'scored',
    });
  }, 120_000);

  it('CONTROL: every deterministic gate can fail on its target regression', async () => {
    // An instrument that cannot fail on what it tests is not evidence
    // (hybrid-eval design-integrity rule): a scripted model that answers
    // without calling the required tool must produce a failed verdict.
    const report = await runMisbehavingControlEvaluation();

    expect(report.passed).toBe(false);
    expect(report.flows.map((flow) => ({ name: flow.name, verdict: flow.verdict }))).toEqual([
      { name: 'tool-selection-control', verdict: 'failed' },
      { name: 'plan-mode-tool-filter-control', verdict: 'failed' },
      { name: 'tool-error-control', verdict: 'failed' },
      { name: 'missing-tool-control', verdict: 'failed' },
    ]);
    expect(report.failures).toHaveLength(4);
  }, 120_000);
});
