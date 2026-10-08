import { modelMessageSchema, type StepResult, type ToolSet } from 'ai';
import type { HostRunState } from './core-state.js';
import { jsonValue } from './json-value.js';
import type { HostEvent, HostLogRow } from './protocol.js';
import { hostStepInteractions } from './run-admission.js';

/**
 * A finished SDK step: its complete public messages and answerable
 * interactions share one FULL commit through HostCore's writer, including
 * when the provider stream is interrupted. Returns the messages it recorded.
 */
export async function commitHostModelStep(
  run: HostRunState,
  step: StepResult<ToolSet>,
  append: (events: readonly HostEvent[]) => Promise<HostLogRow[]>
): Promise<number> {
  const event: HostEvent = {
    messages: step.response.messages.map((message) => jsonValue(modelMessageSchema.parse(message))),
    model: jsonValue(step.model),
    runId: run.id,
    stepNumber: run.steps,
    type: 'model.step',
    usage: jsonValue(step.usage),
  };
  const rows = await append([event, ...hostStepInteractions(run, step.content)]);
  if (!rows[0]) {
    throw new Error('Model step was not committed');
  }
  return step.response.messages.length;
}
