/**
 * A scripted language model for the live-loop suites.
 *
 * These suites drive the REAL Mastra agent loop against the REAL host tools,
 * with only the language model faked. They used to fake it by selecting the
 * built-in local provider and injecting a `LocalLlmHostClient` — no API key,
 * no network. That provider was retired (it is embeddings-only now), so the
 * model is scripted one layer lower instead: at the language model the
 * provider factory would have returned.
 *
 * The script is a function of the tool calls the loop has ALREADY completed,
 * which is how the llm-host clients were written too: it reads the prompt
 * rather than counting turns, so an extra loop iteration cannot silently
 * shift the script.
 */

import type { RuntimeData } from '@brainstrike/agent';

/**
 * The slice of the AI SDK's language-model surface this harness needs,
 * declared locally on purpose: `apps/desktop` does not depend on
 * `@ai-sdk/provider` (only `packages/agent` does), and the model reaches the
 * run through `modelOverride`, which Mastra accepts structurally.
 */
type ScriptedStreamPart = Record<string, unknown>;

interface ScriptedCallOptions {
  readonly prompt: unknown;
  readonly tools?: readonly { readonly name: string }[] | undefined;
}

const USAGE = { inputTokens: 8, outputTokens: 4, totalTokens: 12 } as const;

export interface ScriptedToolCall {
  /** Tool arguments, serialized for the wire exactly as a provider would. */
  readonly input: unknown;
  readonly toolCallId: string;
  /** The SANITIZED tool name the loop advertises (e.g. `brainstrike_globWorkspace`). */
  readonly toolName: string;
}

export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ScriptedTurn =
  | {
      readonly kind: 'text';
      readonly chunks: readonly string[];
      /** Provider usage for this turn's `finish` part; defaults to a small fixture. */
      readonly usage?: ScriptedUsage;
    }
  | { readonly kind: 'tool-call'; readonly calls: readonly ScriptedToolCall[] };

export interface ScriptedChatModel {
  readonly modelId: string;
  /** Sanitized tool names the loop offered, one entry per call. */
  readonly offeredToolNames: string[][];
  /** Every prompt the loop sent, in order — the request-inspection seam. */
  readonly prompts: unknown[];
  readonly provider: string;
  readonly specificationVersion: 'v2';
}

function enqueue(parts: readonly ScriptedStreamPart[]): ReadableStream<ScriptedStreamPart> {
  return new ReadableStream<ScriptedStreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function turnParts(turn: ScriptedTurn): ScriptedStreamPart[] {
  const parts: ScriptedStreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (turn.kind === 'text') {
    const id = 'text-final';
    parts.push({ id, type: 'text-start' });
    for (const chunk of turn.chunks) {
      parts.push({ delta: chunk, id, type: 'text-delta' });
    }
    parts.push({ id, type: 'text-end' });
    const usage = turn.usage
      ? { ...turn.usage, totalTokens: turn.usage.inputTokens + turn.usage.outputTokens }
      : USAGE;
    parts.push({ finishReason: 'stop', type: 'finish', usage });
    return parts;
  }
  for (const call of turn.calls) {
    parts.push({
      input: JSON.stringify(call.input),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: 'tool-call',
    });
  }
  parts.push({ finishReason: 'tool-calls', type: 'finish', usage: USAGE });
  return parts;
}

/** Tool names that already have a RESULT in this prompt, oldest first. */
export function completedToolNames(prompt: unknown): string[] {
  const names: string[] = [];
  for (const message of Array.isArray(prompt) ? prompt : []) {
    if ((message as { role?: unknown }).role !== 'tool') {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    for (const part of Array.isArray(content) ? content : []) {
      const name = (part as { toolName?: unknown }).toolName;
      if (typeof name === 'string') {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Build a scripted model. `script` receives the tool names completed SO FAR in
 * this run (and the raw prompt, for suites that assert on prompt content) and
 * returns the turn to stream.
 *
 * The completed set is CUMULATIVE across turns, not read off the current prompt
 * alone. The loop's projection-safe history filter can drop a tool call whose
 * model projection degraded, and a script that re-derived "has this tool run?"
 * from each prompt would then request the same tool again and spin the loop.
 */
export function createScriptedChatModel(
  script: (completed: readonly string[], prompt: unknown) => ScriptedTurn
): ScriptedChatModel {
  const prompts: unknown[] = [];
  const offeredToolNames: string[][] = [];
  const completed = new Set<string>();
  const model = {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by the live-loop suites')),
    doStream: (options: ScriptedCallOptions) => {
      prompts.push(options.prompt);
      offeredToolNames.push((options.tools ?? []).map((tool) => tool.name));
      for (const name of completedToolNames(options.prompt)) {
        completed.add(name);
      }
      return Promise.resolve({
        stream: enqueue(turnParts(script([...completed], options.prompt))),
      });
    },
    modelId: 'scripted-live-loop-model',
    offeredToolNames,
    prompts,
    provider: 'scripted',
    specificationVersion: 'v2' as const,
    supportedUrls: {},
  };
  return model as unknown as ScriptedChatModel;
}

/**
 * The provider/model the live loops declare while the model itself is scripted.
 *
 * `ollama` (registry `runtime: 'local'`) is deliberate, and it is what the
 * retired built-in local provider used to give these suites for free: a LOCAL
 * runtime skips Mastra catalog tool search (`isHostedProviderRuntime`), so the
 * run's tools stay EAGER. Declare a hosted provider instead and every non-core
 * tool becomes deferred behind `search_tools`/`load_tool` — the scripted
 * model's direct call then emits `tool.started` and never executes. These
 * suites are about the host tools, not about deferred discovery, which has its
 * own coverage.
 *
 * No endpoint is contacted and no key is read: `modelOverride` bypasses
 * `createProvider` entirely, and ollama is keyless (`authType: 'none'`).
 */
const SCRIPTED_LOOP_PROVIDER = 'ollama';
const SCRIPTED_LOOP_MODEL_ID = 'scripted-live-loop-model';

/**
 * The run options a live-loop suite needs to drive the REAL loop with a
 * scripted model. `model` is passed at the OPTIONS level deliberately:
 * `createMastraAgentRuntime` reads `options.model ?? getDefaultModel(provider)`,
 * and a local-runtime provider has no registry default, so leaving it on
 * `runtime` alone resolves the model name to '' and fails schema validation.
 */
export function scriptedLoopOptions(model: ScriptedChatModel): {
  model: string;
  modelOverride: never;
  runtime: RuntimeData;
} {
  return {
    model: SCRIPTED_LOOP_MODEL_ID,
    modelOverride: asModelOverride(model),
    runtime: {
      model: SCRIPTED_LOOP_MODEL_ID,
      provider: SCRIPTED_LOOP_PROVIDER,
    } as RuntimeData,
  };
}

/**
 * `modelOverride` takes Mastra's `MastraModelConfig`; a concrete language model
 * satisfies it at runtime. Same cast precedent as `createListingOnlyModel` and
 * the agent-behavior eval runner.
 */
function asModelOverride(model: ScriptedChatModel): never {
  return model as unknown as never;
}
