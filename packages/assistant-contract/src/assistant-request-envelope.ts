const ASSISTANT_MESSAGE_ID_WIRE_KEY = 'unstable_assistantMessageId';

export const ASSISTANT_REQUEST_ENVELOPE_KEYS = [
  'data',
  'messages',
  'runConfig',
  ASSISTANT_MESSAGE_ID_WIRE_KEY,
] as const;

export interface AssistantRequestEnvelope {
  readonly data?: unknown;
  readonly messages: readonly unknown[];
  readonly runConfig?: unknown;
  // biome-ignore lint/style/useNamingConvention: assistant-ui transport field.
  readonly unstable_assistantMessageId?: string;
}

export interface CreateAssistantRequestEnvelopeInput {
  readonly assistantMessageId?: string;
  readonly data?: unknown;
  readonly messages: readonly unknown[];
  readonly runConfig?: unknown;
}

/**
 * Create the exact request shape understood by Brainstrike assistant servers.
 * Assistant-ui model-context and thread bookkeeping fields are deliberately
 * absent: the server owns runtime configuration and message topology.
 */
export function createAssistantRequestEnvelope(
  input: CreateAssistantRequestEnvelopeInput
): AssistantRequestEnvelope {
  return {
    ...(input.data === undefined ? {} : { data: input.data }),
    messages: input.messages,
    ...(input.runConfig === undefined ? {} : { runConfig: input.runConfig }),
    ...(input.assistantMessageId
      ? { [ASSISTANT_MESSAGE_ID_WIRE_KEY]: input.assistantMessageId }
      : {}),
  };
}
