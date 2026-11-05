import { record } from './committed-host-event-readers';

/**
 * ADR-0028 step 3b: a person's message that a running agent read at a step
 * boundary. It is drawn inside the agent's reply, where the agent read it.
 */
export const PERSON_INPUT_DATA_NAME = 'brainstrike.person-input';

export interface PersonInput {
  /** Each attached image, as a data URL. */
  readonly images: readonly string[];
  readonly text: string;
}

/** The person's words and images a committed `model.messages` carries to the model, if it names an input. */
export function committedPersonInput(
  event: Readonly<Record<string, unknown>>
): PersonInput | undefined {
  const inputs = record(event['delivery'])?.['inputs'];
  if (!(Array.isArray(inputs) && inputs.length > 0)) {
    return;
  }
  const [message] = Array.isArray(event['messages']) ? event['messages'] : [];
  const content = record(message)?.['content'];
  const parts = (Array.isArray(content) ? content : []).flatMap((part: unknown) => {
    const value = record(part);
    return value ? [value] : [];
  });
  return {
    images: parts.flatMap(({ data, mediaType, type }) =>
      type === 'file' && typeof data === 'string' && typeof mediaType === 'string'
        ? [`data:${mediaType};base64,${data}`]
        : []
    ),
    text: parts
      .flatMap(({ text, type }) => (type === 'text' && typeof text === 'string' ? [text] : []))
      .join('\n'),
  };
}

/** The data part's payload, as the projection stored it. */
export function readPersonInput(data: unknown): PersonInput {
  const value = record(data);
  const images = value?.['images'];
  const text = value?.['text'];
  if (
    !(Array.isArray(images) && images.every((image) => typeof image === 'string')) ||
    typeof text !== 'string'
  ) {
    throw new Error('A person input part has no text and images.');
  }
  return { images, text };
}
