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
  /** Sent to the running agent, which has not read it yet. */
  readonly unread?: true;
}

/** A person's message the host accepted for a run, its `run/input` command. */
export interface SentPersonInput {
  readonly commandId: string;
  readonly input: PersonInput;
  readonly runId: string;
}

/** The person's message a committed `run/input` command carries, until a run reads it. */
export function sentPersonInput(
  event: Readonly<Record<string, unknown>>
): SentPersonInput | undefined {
  if (event['type'] !== 'command.accepted' || event['method'] !== 'run/input') {
    return;
  }
  const params = record(event['payload']);
  const { commandId, prompt, runId } = params ?? {};
  if (typeof commandId !== 'string' || typeof runId !== 'string' || typeof prompt !== 'string') {
    throw new Error('A committed run/input has no command, run and prompt.');
  }
  const attachments = params?.['attachments'];
  const images = (Array.isArray(attachments) ? attachments : []).flatMap((attachment: unknown) => {
    const { data, mediaType } = record(attachment) ?? {};
    return typeof data === 'string' && typeof mediaType === 'string'
      ? [imageSource(data, mediaType)]
      : [];
  });
  return { commandId, input: { images, text: prompt, unread: true }, runId };
}

/** The `run/input` commands a committed `run.started` or `model.messages` says its run read. */
export function readInputIds(event: Readonly<Record<string, unknown>>): readonly string[] {
  const inputs = record(event['delivery'])?.['inputs'];
  return Array.isArray(inputs)
    ? inputs.filter((id: unknown): id is string => typeof id === 'string')
    : [];
}

/** A file part's image: the composer sends a data URL; bare base64 gets its media type. */
function imageSource(data: string, mediaType: string): string {
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;
}

/** The person's words and images a committed `model.messages` carries to the model, if it names an input. */
export function committedPersonInput(
  event: Readonly<Record<string, unknown>>
): PersonInput | undefined {
  if (readInputIds(event).length === 0) {
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
        ? [imageSource(data, mediaType)]
        : []
    ),
    // The host's reading of the message (mentioned files, skills) is the model's, not the person's.
    text: parts
      .flatMap(({ providerOptions, text, type }) =>
        type === 'text' && typeof text === 'string' && !readsForInput(providerOptions) ? [text] : []
      )
      .join('\n'),
  };
}

/** Whether a text part is what the host read for the message (`HOST_INPUT_CONTEXT`). */
function readsForInput(providerOptions: unknown): boolean {
  return record(record(providerOptions)?.['brainstrike'])?.['context'] === true;
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
  return value?.['unread'] === true ? { images, text, unread: true } : { images, text };
}
