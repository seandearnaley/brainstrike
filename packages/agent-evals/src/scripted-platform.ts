/**
 * The eval's trusted `--platform` compositions of the real standalone platform
 * (its tools, permission policy, storage and Memory).
 *
 * Scripted mode adds one trusted model, the agent-host scripted fixture
 * playing a task's script turn by turn. The model has its own identity,
 * `scripted::<task id>`, so every committed row that names the model names the
 * script that ran.
 *
 * A task that pins its input budget composes the platform with that pin in
 * every mode, so its thread crosses the compaction trigger on a small workspace.
 */
import type { HostPlatformFactory } from '@brainstrike/agent-host';
import { scriptedTurns } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  createHostPlatform,
  type StandaloneTrustedModel,
} from '@brainstrike/host-capabilities/platform';
import type { EvalScriptTurn } from './task.ts';

export const SCRIPTED_PROVIDER = 'scripted';
/** A scripted turn's final text when its script names none. */
const SCRIPTED_ANSWER = 'Host run completed.';

export interface ScriptedEvalModel {
  /** The catalog model whose budgets the script runs under (the task's `model`). */
  readonly budgets: string;
  /** The task's pinned input budget, when it has one. */
  readonly inputTokenLimit?: number;
  /** What the model answers a compaction's summarizer with; without one the summarizer fails. */
  readonly summary?: string;
  readonly taskId: string;
  /** The task's turns in order, each with the prompt that opens it. */
  readonly turns: readonly (EvalScriptTurn & { readonly prompt: string })[];
}

/** The run's `--model`: the scripted model's own `provider::modelId`. */
export function scriptedModelId(taskId: string): string {
  return `${SCRIPTED_PROVIDER}::${taskId}`;
}

/** The fixture's model, named for its task rather than the fixture's mock identity. */
function scriptedModel({
  summary,
  taskId,
  turns,
}: ScriptedEvalModel): StandaloneTrustedModel['model'] {
  const scripted = scriptedTurns(
    turns.map((turn) => ({ ...turn, answer: turn.answer ?? SCRIPTED_ANSWER })),
    summary
  );
  return {
    doGenerate: (options) => scripted.doGenerate(options),
    doStream: (options) => scripted.doStream(options),
    modelId: taskId,
    provider: SCRIPTED_PROVIDER,
    specificationVersion: scripted.specificationVersion,
    supportedUrls: scripted.supportedUrls,
  };
}

export function scriptedEvalPlatform(model: ScriptedEvalModel): HostPlatformFactory {
  const trusted = {
    ...(model.inputTokenLimit === undefined ? {} : { inputTokenLimit: model.inputTokenLimit }),
    models: [{ budgets: model.budgets, model: scriptedModel(model) }],
  };
  return (options, startup, launch) => createHostPlatform(options, startup, launch, trusted);
}

/** Replay and live modes of a task that pins its input budget: the catalog's models, pinned. */
export function pinnedEvalPlatform(inputTokenLimit: number): HostPlatformFactory {
  return (options, startup, launch) =>
    createHostPlatform(options, startup, launch, { inputTokenLimit });
}
