import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { runEvals } from '@mastra/core/evals';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import type { ToolDiscoverySearchObservation } from '../mastra/tool-search-runtime';
import { resolveProviderApiKey } from '../providers/key-resolver';
import {
  calledToolGate,
  collectToolActivity,
  noToolErrorsGate,
  responseContainsGroundTruthScorer,
} from './agent-behavior-gates';

const MODEL_FACING_CONTEXT_TOOL_ID = 'brainstrike_listWorkspaceContext';
const EXPECTED_MAIN_ROOT = '/workspace-main';

export const TOOL_DISCOVERY_LIVE_EVAL_CASES = [
  {
    id: 'openai-mini-workspace-context',
    model: 'gpt-5.4-mini',
    prompt:
      'Use the workspace context listing capability. Reply with the focused workspace root path only.',
    provider: 'openai',
  },
  {
    id: 'anthropic-haiku-workspace-context',
    model: 'claude-haiku-4-5',
    prompt:
      'Use the workspace context listing capability and reply with only the focused root path.',
    provider: 'anthropic',
  },
] as const;

export interface ToolDiscoveryLiveEvalCaseResult {
  readonly finalResponse: string;
  readonly finalToolChoice: string | undefined;
  readonly id: string;
  readonly model: string;
  readonly passed: boolean;
  readonly provider: string;
  readonly searchObservations: readonly ToolDiscoverySearchObservation[];
  readonly selectedToolIds: readonly string[];
  readonly thresholdResults: readonly {
    readonly averageScore: number;
    readonly id: string;
    readonly passed: boolean;
  }[];
  readonly verdict: string;
}

export interface ToolDiscoveryLiveEvalReport {
  readonly cases: readonly ToolDiscoveryLiveEvalCaseResult[];
  readonly passed: boolean;
}

function makeLiveEvalTools() {
  return {
    [NATIVE_TOOL_ID.executeCommand]: createTool({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.executeCommand],
      execute: async () => ({ durationMs: 0, exitCode: 0, stderr: '', stdout: 'wrong-root' }),
      id: NATIVE_TOOL_ID.executeCommand,
      inputSchema: z.object({ command: z.string() }),
    }),
    [NATIVE_TOOL_ID.globWorkspace]: createTool({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.globWorkspace],
      execute: async () => ({ matches: ['wrong-root/file.ts'] }),
      id: NATIVE_TOOL_ID.globWorkspace,
      inputSchema: z.object({ pattern: z.string().optional() }),
    }),
    [NATIVE_TOOL_ID.listWorkspaceContext]: createTool({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorkspaceContext],
      execute: async () => ({
        type: 'text' as const,
        value: `workspace context | main=${EXPECTED_MAIN_ROOT} | focused_root_id=workspace-main`,
      }),
      id: NATIVE_TOOL_ID.listWorkspaceContext,
      inputSchema: z.object({ detail: z.boolean().optional() }),
    }),
  };
}

async function runLiveEvalCase(
  evalCase: (typeof TOOL_DISCOVERY_LIVE_EVAL_CASES)[number]
): Promise<ToolDiscoveryLiveEvalCaseResult> {
  const apiKey = resolveProviderApiKey(evalCase.provider);
  if (!apiKey) {
    throw new Error(
      `Live tool-discovery eval requires a configured ${evalCase.provider} API key for ${evalCase.id}`
    );
  }

  const runtime = await createMastraAgentRuntime({
    model: evalCase.model,
    runtime: { apiKey, model: evalCase.model, provider: evalCase.provider },
    tools: makeLiveEvalTools(),
  });
  const processor = runtime.toolSearchProcessor;
  if (!processor) {
    await runtime.dispose();
    throw new Error(`Live tool-discovery eval ${evalCase.id} did not install catalog discovery`);
  }

  const searchObservations: ToolDiscoverySearchObservation[] = [];
  const selectedToolIds: string[] = [];
  let finalResponse = '';
  let finalToolChoice: string | undefined;
  const unsubscribe = processor.subscribeSearchObservations((observation) => {
    searchObservations.push(observation);
  });

  try {
    const outcome = await runEvals({
      data: [{ groundTruth: EXPECTED_MAIN_ROOT, input: evalCase.prompt }],
      onItemComplete: ({ targetResult }) => {
        const toolNames = collectToolActivity(targetResult).toolNames;
        for (const toolName of toolNames) {
          if (!selectedToolIds.includes(toolName)) {
            selectedToolIds.push(toolName);
          }
        }
        finalToolChoice = toolNames.find(
          (toolName) => toolName !== 'search_tools' && toolName !== 'load_tool'
        );
        finalResponse = targetResult.text;
      },
      scorers: [
        { scorer: calledToolGate(MODEL_FACING_CONTEXT_TOOL_ID), threshold: { min: 1 } },
        { scorer: noToolErrorsGate(), threshold: { min: 1 } },
        { scorer: responseContainsGroundTruthScorer(), threshold: { min: 1 } },
      ],
      target: runtime.agent,
      // Brainstrike owns processors at the per-call seam because stream calls
      // may also install token/history processors. runEvals targets the bare
      // Agent by default, so pass the real discovery processor explicitly or
      // the evaluation would never expose search_tools.
      targetOptions: { inputProcessors: [processor], maxSteps: 12 },
    });
    const thresholdResults = (outcome.thresholdResults ?? []).map((result) => ({
      averageScore: result.averageScore,
      id: result.id,
      passed: result.passed,
    }));
    const passed =
      thresholdResults.length === 3 && thresholdResults.every((result) => result.passed);
    return {
      finalResponse,
      finalToolChoice,
      id: evalCase.id,
      model: evalCase.model,
      passed,
      provider: evalCase.provider,
      searchObservations,
      selectedToolIds,
      thresholdResults,
      verdict: outcome.verdict ?? 'missing-verdict',
    };
  } finally {
    unsubscribe();
    await runtime.dispose();
  }
}

/** Opt-in, networked advisory matrix. Missing credentials fail explicitly. */
export async function runToolDiscoveryLiveEvaluation(): Promise<ToolDiscoveryLiveEvalReport> {
  const cases: ToolDiscoveryLiveEvalCaseResult[] = [];
  for (const evalCase of TOOL_DISCOVERY_LIVE_EVAL_CASES) {
    cases.push(await runLiveEvalCase(evalCase));
  }
  return { cases, passed: cases.every((result) => result.passed) };
}
