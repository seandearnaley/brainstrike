import { Schema } from 'effect';
/**
 * A completed model step, as Hosted Web returns it to a client that records
 * its runs (BST-1940; owner decision, 16 Oct: the proxy returns its step).
 * It carries exactly what the agent host commits as `model.step` for the same
 * AI SDK step result (the response messages, the model and the usage), so the
 * browser commits the step the host would have, from one source.
 *
 * It goes out as it completes, as an out-of-band data frame (`2:`), ahead of
 * its step's `finish-step` part, in the order the host commits them.
 *
 * Opt-in: only a request that asks to record its steps receives these parts,
 * so a client that keeps its own transcript never stores them.
 */
export const MODEL_STEP_DATA_NAME = 'brainstrike.model-step';
export const AssistantModelStepDataSchema = Schema.Struct({
  messages: Schema.mutable(Schema.Array(Schema.MutableJson)),
  model: Schema.MutableJson,
  stepNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  usage: Schema.MutableJson,
});
export type AssistantModelStepData = (typeof AssistantModelStepDataSchema)['Type'];
/**
 * Each AI SDK `fullStream` part of a recorded turn, as the host's run loop
 * consumes it, so the browser streams and commits the turn as the host does
 * (BST-1940): its text and reasoning parts are live telemetry, every other
 * part commits as `stream.chunk`. A part goes out as it arrives, as an
 * out-of-band data frame, which never slices the turn's visible text; the
 * provider's response headers stay on the server.
 */
export const MODEL_STREAM_PART_DATA_NAME = 'brainstrike.stream-part';
export const AssistantModelStreamPartSchema = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String.check(Schema.isMinCodePoints(1)) }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);
export type AssistantModelStreamPart = (typeof AssistantModelStreamPartSchema)['Type'];
/** The `runConfig.custom` key a client sets to receive its turn's steps and stream parts. */
export const MODEL_STEP_RECORD_RUN_CONFIG_KEY = 'brainstrike.recordModelSteps';
/**
 * Whether a request asks for its turn's steps: `runConfig.custom[key]`, a
 * boolean when present. Anything else there is invalid, never read as off.
 */
export function readRecordModelStepsRunConfig(runConfig: unknown):
  | {
      readonly record: boolean;
    }
  | {
      readonly invalid: true;
    } {
  const custom =
    typeof runConfig === 'object' && runConfig !== null && !Array.isArray(runConfig)
      ? (runConfig as Record<string, unknown>)['custom']
      : undefined;
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    return { record: false };
  }
  const value = (custom as Record<string, unknown>)[MODEL_STEP_RECORD_RUN_CONFIG_KEY];
  if (value === undefined) {
    return { record: false };
  }
  return typeof value === 'boolean' ? { record: value } : { invalid: true };
}
