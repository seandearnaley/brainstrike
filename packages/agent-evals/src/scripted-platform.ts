/**
 * Scripted mode's trusted `--platform` composition: the real standalone
 * platform (its tools, permission policy, storage and Memory) with one trusted
 * model, the agent-host scripted-model fixture playing a task's script. The
 * model has its own identity, `scripted::<task id>`, so every committed row
 * that names the model names the script that ran.
 */
import type { HostPlatformFactory } from '@brainstrike/agent-host';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  createHostPlatform,
  type StandaloneTrustedModel,
} from '@brainstrike/host-capabilities/platform';
import type { EvalScript } from './task.js';

export const SCRIPTED_PROVIDER = 'scripted';

export interface ScriptedEvalModel {
  /** The catalog model whose budgets the script runs under (the task's `model`). */
  readonly budgets: string;
  readonly script: EvalScript;
  readonly taskId: string;
}

/** The run's `--model`: the scripted model's own `provider::modelId`. */
export function scriptedModelId(taskId: string): string {
  return `${SCRIPTED_PROVIDER}::${taskId}`;
}

/** The fixture's model, named for its task rather than the fixture's mock identity. */
function scriptedModel({ script, taskId }: ScriptedEvalModel): StandaloneTrustedModel['model'] {
  const scripted = scriptedToolSequence(script.calls);
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
  const trusted = { models: [{ budgets: model.budgets, model: scriptedModel(model) }] };
  return (options, startup, launch) => createHostPlatform(options, startup, launch, trusted);
}
