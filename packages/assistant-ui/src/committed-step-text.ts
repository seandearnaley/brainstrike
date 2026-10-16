import type { ThreadAssistantMessage } from '@assistant-ui/react';
import { readToolTelemetryOmission } from '@brainstrike/assistant-contract/tool-telemetry';

type Part = ThreadAssistantMessage['content'][number];
type ToolPart = Extract<Part, { type: 'tool-call' }>;
type TextPart = Extract<Part, { type: 'reasoning' | 'text' }>;
type ProviderMetadata = ToolPart['providerMetadata'];

/**
 * The model's text and reasoning stream. The host sends it as uncommitted
 * `run/telemetry`; a step's committed `model.step` messages own its text
 * (ADR-0011 amendment), so a committed delta is never folded.
 */
export const MODEL_STREAM_TYPES: ReadonlySet<string> = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
]);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function providerMetadata(value: unknown): ProviderMetadata {
  const providers = asRecord(value);
  if (!providers || Object.values(providers).some((entry) => !asRecord(entry))) {
    return undefined;
  }
  // The owner has already validated JSON at the public HostLogRow boundary.
  return providers as ProviderMetadata;
}

export function mergeProviderMetadata(
  previous: ProviderMetadata,
  incoming: ProviderMetadata,
  ownership?: NonNullable<ProviderMetadata>[string]
): ProviderMetadata {
  const additions = ownership
    ? { ...incoming, brainstrike: { ...incoming?.['brainstrike'], ...ownership } }
    : incoming;
  if (!additions) {
    return previous;
  }
  let next = previous;
  for (const [namespace, fields] of Object.entries(additions)) {
    const before = previous?.[namespace];
    if (Object.entries(fields).every(([key, value]) => before?.[key] === value)) {
      continue;
    }
    next = { ...next, [namespace]: { ...before, ...fields } };
  }
  return next;
}

/**
 * Recorded Luna runs carry opaque reasoning without a displayable summary:
 * encrypted state, empty text. It stays in the host log and provider history,
 * never a transcript disclosure, whether committed or still streaming.
 */
function isOpaqueReasoning(type: unknown, text: string): boolean {
  return type === 'reasoning' && text.trim().length === 0;
}

/**
 * One live text or reasoning chunk applied to the open step's overlay part, or
 * undefined while reasoning has streamed nothing a person can read.
 */
function liveStreamPart(
  prior: Part | undefined,
  type: string,
  chunk: Readonly<Record<string, unknown>>
): TextPart | undefined {
  const partType = type.startsWith('reasoning') ? 'reasoning' : 'text';
  const previous = prior?.type === partType ? prior : undefined;
  const delta = typeof chunk['text'] === 'string' ? chunk['text'] : '';
  const text = (previous?.text ?? '') + (type.endsWith('-delta') ? delta : '');
  if (isOpaqueReasoning(partType, text)) {
    return;
  }
  const metadata = mergeProviderMetadata(
    previous?.providerMetadata,
    providerMetadata(chunk['providerMetadata'])
  );
  return {
    ...previous,
    type: partType,
    ...(metadata ? { providerMetadata: metadata } : {}),
    status:
      type.endsWith('-end') || (!type.endsWith('-start') && previous?.status?.type === 'complete')
        ? { type: 'complete' }
        : { type: 'running' },
    text,
  };
}

/** Where a live overlay entry is stored, and whether the next text block may join it. */
export interface LiveOverlayTarget {
  readonly joins: boolean;
  readonly key: string;
}

/**
 * The overlay part a live chunk writes. A text block that opens directly after
 * the step's streamed text (that text is still the message's last part) joins
 * it: providers split one answer into adjacent content blocks (Anthropic, mid-
 * sentence), which are one text, as a committed step's parts are. A block
 * after reasoning, a call or a replay notice starts its own part.
 */
export function liveOverlayTarget(
  run: {
    readonly overlay: ReadonlyMap<string, LiveOverlayTarget>;
    readonly partIndexes: ReadonlyMap<string, number>;
  },
  entry: { readonly joins?: true; readonly key: string },
  content: readonly Part[]
): LiveOverlayTarget {
  const known = run.overlay.get(entry.key);
  if (known) {
    return known;
  }
  const tail = content.length - 1;
  const joined = entry.joins
    ? [...run.overlay.values()].find(
        (target) => target.joins && run.partIndexes.get(target.key) === tail
      )
    : undefined;
  return joined ?? { joins: entry.joins === true, key: entry.key };
}

/**
 * Where one live telemetry chunk goes in the open step's overlay: its text or
 * reasoning part, or, when a late view's replay dropped the step's oldest
 * text, a notice that says so, never silently (ADR-0011 amendment).
 */
export function liveOverlayEntry(
  step: number,
  chunk: unknown
):
  | {
      /** A model text block, which may join the step's text it directly follows. */
      readonly joins?: true;
      readonly key: string;
      readonly part: (prior: Part | undefined) => TextPart | undefined;
    }
  | undefined {
  const live = asRecord(chunk);
  const type = live?.['type'];
  if (!(live && typeof type === 'string')) {
    return;
  }
  const omission = readToolTelemetryOmission(live);
  if (omission) {
    // A call's omission belongs to its command's live output, not to the reply.
    return omission.toolCallId === undefined
      ? {
          key: `live:${JSON.stringify([step, 'omitted'])}`,
          part: () => ({
            status: { type: 'complete' },
            text: `Earlier reply text not shown (${Math.ceil(omission.omittedBytes / 1024)} KB)`,
            type: 'text',
          }),
        }
      : undefined;
  }
  if (!MODEL_STREAM_TYPES.has(type)) {
    return;
  }
  const partType = type.startsWith('reasoning') ? 'reasoning' : 'text';
  return {
    ...(partType === 'text' ? { joins: true as const } : {}),
    key: `live:${JSON.stringify([step, partType, live['id'] ?? null])}`,
    part: (prior) => liveStreamPart(prior, type, live),
  };
}

/** A committed text or reasoning message part, or undefined for any other part. */
function committedTextPart(entry: unknown): TextPart | undefined {
  const content = asRecord(entry);
  const type = content?.['type'];
  if (!((type === 'text' || type === 'reasoning') && typeof content?.['text'] === 'string')) {
    return;
  }
  if (isOpaqueReasoning(type, content['text'])) {
    return;
  }
  const metadata = providerMetadata(content['providerOptions']);
  return {
    ...(metadata ? { providerMetadata: metadata } : {}),
    status: { type: 'complete' },
    text: content['text'],
    type,
  };
}

/** A text part directly after the step's text joins it; anything else is its own part. */
function appendStepText(pending: TextPart[], part: TextPart): void {
  const previous = pending.at(-1);
  if (!(part.type === 'text' && previous?.type === 'text')) {
    pending.push(part);
    return;
  }
  const metadata = mergeProviderMetadata(previous.providerMetadata, part.providerMetadata);
  pending[pending.length - 1] = {
    ...previous,
    ...(metadata ? { providerMetadata: metadata } : {}),
    text: previous.text + part.text,
  };
}

/**
 * A step's committed text and reasoning, in its assistant messages' order. Each
 * part names the tool part it precedes (`tool:<callId>`), so a reload keeps the
 * model's order of text and calls. Adjacent text parts are one text: providers
 * split an answer into content blocks (Anthropic, mid-sentence).
 */
export function committedStepParts(
  messages: unknown
): readonly { readonly anchor?: string; readonly part: TextPart }[] {
  const parts: { readonly anchor?: string; readonly part: TextPart }[] = [];
  let pending: TextPart[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const item = asRecord(message);
    if (item?.['role'] !== 'assistant' || !Array.isArray(item['content'])) {
      continue;
    }
    for (const entry of item['content']) {
      const text = committedTextPart(entry);
      const call = asRecord(entry);
      if (text) {
        appendStepText(pending, text);
      } else if (call?.['type'] === 'tool-call' && typeof call['toolCallId'] === 'string') {
        const anchor = `tool:${call['toolCallId']}`;
        parts.push(...pending.map((part) => ({ anchor, part })));
        pending = [];
      }
    }
  }
  parts.push(...pending.map((part) => ({ part })));
  return parts;
}

/** Content without the keyed part; later indexes close the gap. */
export function withoutIndexedPart(
  content: readonly Part[],
  indexes: Map<string, number>,
  key: string
): readonly Part[] | undefined {
  const index = indexes.get(key);
  if (index === undefined) {
    return;
  }
  indexes.delete(key);
  for (const [other, position] of indexes) {
    if (position > index) {
      indexes.set(other, position - 1);
    }
  }
  return content.filter((_part, at) => at !== index);
}

/** Content with the part inserted before its anchor part, or appended without one. */
export function withIndexedPart(
  content: readonly Part[],
  indexes: Map<string, number>,
  key: string,
  part: Part,
  anchor?: string
): readonly Part[] {
  const at = (anchor === undefined ? undefined : indexes.get(anchor)) ?? content.length;
  for (const [other, position] of indexes) {
    if (position >= at) {
      indexes.set(other, position + 1);
    }
  }
  indexes.set(key, at);
  const next = [...content];
  next.splice(at, 0, part);
  return next;
}
