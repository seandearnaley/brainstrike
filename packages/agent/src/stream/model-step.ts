/**
 * A completed AI SDK step as the agent host commits it (`model.step`): the
 * response messages as `modelMessageSchema` reads them, the model and the
 * usage, each a JSON value. Core commits these fields, and Hosted Web returns
 * them to a client that records its runs (BST-1940), so both commit the same
 * step from one mapping.
 */
import { modelMessageSchema, type StepResult, type ToolSet } from 'ai';

type Json = boolean | number | string | null | Json[] | { readonly [key: string]: Json };

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export interface ModelStepFields {
  readonly messages: Json[];
  readonly model: Json;
  readonly usage: Json;
}

export function modelStepFields(step: StepResult<ToolSet>): ModelStepFields {
  return {
    messages: step.response.messages.map((message) => json(modelMessageSchema.parse(message))),
    model: json(step.model),
    usage: json(step.usage),
  };
}
