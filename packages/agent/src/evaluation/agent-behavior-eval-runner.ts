import type { LanguageModelV2 } from '@ai-sdk/provider';
import { runEvals } from '@mastra/core/evals';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { calledToolGate, noToolErrorsGate, responseExactMatchScorer } from './agent-behavior-gates';
import {
  createPlanModeInventoryEvalModel,
  createTextOnlyEvalModel,
  createToolCallingEvalModel,
} from './scripted-eval-models';

/**
 * Agent-behavior evaluation runner (BST-589 Phase 1) — the merge-gate
 * counterpart of packages/db's hybrid-eval-runner: deterministic, zero LLM
 * cost, driven through the REAL agent runtime (real tool map, instructions,
 * permission/plan gates) with scripted LanguageModelV2 fixtures injected via
 * `modelOverride`. The vitest spec asserting `report.passed` IS the CI gate.
 */

export interface AgentBehaviorFlowResult {
  readonly gateResults: readonly { id: string; passed: boolean; score: number }[];
  readonly name: string;
  readonly verdict: string;
}

export interface AgentBehaviorEvaluationReport {
  readonly failures: readonly string[];
  readonly flows: readonly AgentBehaviorFlowResult[];
  readonly passed: boolean;
}

const WEATHER_TOOL_ID = 'get_weather';
const WRITE_TOOL_ID = 'brainstrike.writeWorkspaceFile';
const MODEL_FACING_WRITE_TOOL_ID = 'brainstrike_writeWorkspaceFile';

function makeWeatherTool() {
  return createTool({
    description: 'Get the current weather for a city.',
    execute: ({ city }: { city: string }) => Promise.resolve({ city, tempC: 21 }),
    id: WEATHER_TOOL_ID,
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({ city: z.string(), tempC: z.number() }),
  });
}

function makeWriteTool() {
  return createTool({
    description: 'Write text content to a workspace file.',
    execute: ({ path }: { content: string; path: string }) => Promise.resolve({ path }),
    id: WRITE_TOOL_ID,
    inputSchema: z.object({ content: z.string(), path: z.string() }),
    outputSchema: z.object({ path: z.string() }),
  });
}

async function buildEvalAgent(model: LanguageModelV2) {
  const runtime = await createMastraAgentRuntime({
    // modelOverride bypasses createProvider entirely: the scripted fixture is
    // the model, provider 'openai' keeps the full hosted instruction/tool
    // composition. Same cast precedent as createListingOnlyModel — a concrete
    // LanguageModelV2 satisfies the MastraModelConfig runtime contract.
    modelOverride: model as unknown as MastraModelConfig,
    runtime: { apiKey: 'eval-key', provider: 'openai' },
    tools: { [WEATHER_TOOL_ID]: makeWeatherTool() },
  });
  return runtime.agent;
}

async function buildPlanModeEvalAgent(model: LanguageModelV2) {
  const runtime = await createMastraAgentRuntime({
    modelOverride: model as unknown as MastraModelConfig,
    runtime: { apiKey: 'eval-key', planMode: true, provider: 'openai' },
    tools: {
      [WEATHER_TOOL_ID]: makeWeatherTool(),
      [WRITE_TOOL_ID]: makeWriteTool(),
    },
  });
  return runtime.agent;
}

interface FlowOutcome {
  readonly gateResults?: { id: string; passed: boolean; score: number }[];
  readonly verdict?: string;
}

function toFlowResult(name: string, outcome: FlowOutcome): AgentBehaviorFlowResult {
  return {
    gateResults: outcome.gateResults ?? [],
    name,
    // A gates-supplied run always yields a verdict; its absence means the
    // suite is miswired — surface loudly, never a fabricated pass.
    verdict: outcome.verdict ?? 'missing-verdict',
  };
}

function collectFailures(flows: readonly AgentBehaviorFlowResult[]): string[] {
  const failures: string[] = [];
  for (const flow of flows) {
    if (flow.verdict !== 'passed') {
      const failedGates = flow.gateResults
        .filter((gate) => !gate.passed)
        .map((gate) => gate.id)
        .join(', ');
      failures.push(
        `${flow.name}: verdict=${flow.verdict}${failedGates ? ` gates=[${failedGates}]` : ''}`
      );
    }
  }
  return failures;
}

/** The deterministic merge gate: tool selection, error-free execution, and plan mode. */
export async function runAgentBehaviorEvaluation(): Promise<AgentBehaviorEvaluationReport> {
  const toolSelectionAgent = await buildEvalAgent(
    createToolCallingEvalModel({
      finalText: 'It is 21C in Paris.',
      input: JSON.stringify({ city: 'Paris' }),
      toolName: WEATHER_TOOL_ID,
    })
  );
  const toolSelection = await runEvals({
    data: [{ input: 'What is the weather in Paris?' }],
    gates: [calledToolGate(WEATHER_TOOL_ID)],
    target: toolSelectionAgent,
  });

  const errorFreeAgent = await buildEvalAgent(
    createToolCallingEvalModel({
      finalText: 'Done without errors.',
      input: JSON.stringify({ city: 'Lyon' }),
      toolName: WEATHER_TOOL_ID,
    })
  );
  const errorFree = await runEvals({
    data: [{ input: 'Check the weather in Lyon.' }],
    gates: [calledToolGate(WEATHER_TOOL_ID), noToolErrorsGate()],
    target: errorFreeAgent,
  });

  const planModeAgent = await buildPlanModeEvalAgent(
    createPlanModeInventoryEvalModel({
      finalText: 'I stayed read-only while planning.',
      forbiddenInput: JSON.stringify({ content: 'unsafe', path: 'plan.txt' }),
      forbiddenToolName: MODEL_FACING_WRITE_TOOL_ID,
      safeInput: JSON.stringify({ city: 'Berlin' }),
      safeToolName: WEATHER_TOOL_ID,
    })
  );
  const planMode = await runEvals({
    data: [{ input: 'Investigate first and do not modify the workspace.' }],
    gates: [calledToolGate(WEATHER_TOOL_ID), noToolErrorsGate()],
    target: planModeAgent,
  });

  const flows = [
    toFlowResult('tool-selection', toolSelection as FlowOutcome),
    toFlowResult('error-free-run', errorFree as FlowOutcome),
    toFlowResult('plan-mode-tool-filter', planMode as FlowOutcome),
  ];
  const failures = collectFailures(flows);
  return { failures, flows, passed: failures.length === 0 };
}

export interface AgentBehaviorAdvisoryReport {
  readonly averageScore: number;
  readonly thresholdPassed: boolean;
  readonly verdict: string;
}

/** A deterministic threshold miss proves advisory drift yields `scored`, never a failed gate. */
export async function runAdvisoryAgentBehaviorEvaluation(): Promise<AgentBehaviorAdvisoryReport> {
  const agent = await buildEvalAgent(createTextOnlyEvalModel('The response is stable.'));
  const outcome = await runEvals({
    data: [
      { groundTruth: 'The response is stable.', input: 'Return the stable response.' },
      { groundTruth: 'The response improved.', input: 'Return the improved response.' },
    ],
    scorers: [{ scorer: responseExactMatchScorer(), threshold: { min: 0.75 } }],
    target: agent,
  });
  const threshold = outcome.thresholdResults?.find(
    (result) => result.id === 'response-exact-match'
  );
  if (!threshold || outcome.verdict !== 'scored') {
    throw new Error('advisory eval did not produce the expected scored threshold verdict');
  }
  return {
    averageScore: threshold.averageScore,
    thresholdPassed: threshold.passed,
    verdict: outcome.verdict,
  };
}

/**
 * Design-integrity control (hybrid-eval rule: an instrument that cannot fail
 * is not evidence): a model that answers WITHOUT calling the required tool
 * must flunk the calledTool gate.
 */
export async function runMisbehavingControlEvaluation(): Promise<AgentBehaviorEvaluationReport> {
  const misbehavingAgent = await buildEvalAgent(
    createTextOnlyEvalModel('It is probably sunny somewhere.')
  );
  const outcome = await runEvals({
    data: [{ input: 'What is the weather in Paris?' }],
    gates: [calledToolGate(WEATHER_TOOL_ID)],
    target: misbehavingAgent,
  });
  const flows = [toFlowResult('tool-selection-control', outcome as FlowOutcome)];
  const failures = collectFailures(flows);
  return { failures, flows, passed: failures.length === 0 };
}
