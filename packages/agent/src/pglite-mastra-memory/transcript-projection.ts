import { stripProviderCitationMarkers } from '@brainstrike/assistant-contract/citation-markers';
import type { MastraDBMessage } from '@mastra/core/memory';
import {
  getTransformedToolPayload,
  hasTransformedToolPayload,
  type ToolPayloadTransformPhase,
} from '@mastra/core/tools';
import { readHookResultEnvelope } from '../tools/hook-runner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function unwrapHookResult(value: unknown): unknown {
  const envelope = readHookResultEnvelope(value);
  return envelope ? envelope.result : value;
}

function readTranscriptToolPayload(
  providerMetadata: unknown,
  phase: ToolPayloadTransformPhase,
  fallback: unknown
): unknown {
  const transformed = getTransformedToolPayload(providerMetadata, 'transcript', phase);
  const value = hasTransformedToolPayload(transformed) ? transformed.transformed : fallback;
  // The internal PostToolUse carrier must never cross the durable boundary,
  // even if transform metadata is absent or malformed.
  return unwrapHookResult(value);
}

interface PersistedInvocationProjection {
  readonly args: unknown;
  readonly errorText?: unknown;
  readonly result?: unknown;
}

function projectToolInvocationPartForTranscript(part: Record<string, unknown>): {
  readonly part: Record<string, unknown>;
  readonly projection?: PersistedInvocationProjection;
  readonly toolCallId?: string;
} {
  if (part['type'] !== 'tool-invocation' || !isRecord(part['toolInvocation'])) {
    return { part };
  }
  const invocation = part['toolInvocation'];
  const providerMetadata = part['providerMetadata'];
  const args = readTranscriptToolPayload(providerMetadata, 'input-available', invocation['args']);
  const toolCallId =
    typeof invocation['toolCallId'] === 'string' ? invocation['toolCallId'] : undefined;
  const state = invocation['state'];
  if (state === 'result') {
    const result = readTranscriptToolPayload(
      providerMetadata,
      'output-available',
      invocation['result']
    );
    return {
      part: {
        ...part,
        toolInvocation: { ...invocation, args, result },
      },
      projection: { args, result },
      ...(toolCallId ? { toolCallId } : {}),
    };
  }
  if (state === 'output-error') {
    const errorText = readTranscriptToolPayload(providerMetadata, 'error', invocation['errorText']);
    return {
      part: {
        ...part,
        toolInvocation: { ...invocation, args, errorText },
      },
      projection: { args, errorText },
      ...(toolCallId ? { toolCallId } : {}),
    };
  }
  return {
    part: {
      ...part,
      toolInvocation: { ...invocation, args },
    },
    projection: { args },
    ...(toolCallId ? { toolCallId } : {}),
  };
}

/**
 * Settled text, written once — see `StripProviderCitationMarkersOptions`. The
 * unterminated-span heuristic is only safe where a later render can undo a false
 * positive, and `saveMessages` is handed finished messages, so a trailing opener
 * here is far likelier to be a real Nerd Fonts glyph than a truncated marker.
 */
const TRANSCRIPT_STRIP_OPTIONS = { unterminated: 'keep' } as const;

/**
 * Strip provider citation markers from a visible ASSISTANT text part.
 *
 * The render seam cleans what the user SEES, but this store is the DURABLE
 * writer — markers left here are what thread search indexes (see
 * `thread-search-repository.ts`, which `string_agg`s `parts[].text`), what
 * embeddings encode, and what a copy of a reloaded message carries. Normalizing
 * on the way in keeps those readers clean without each one repeating the rule.
 *
 * `text` PARTS ONLY, deliberately. `reasoning` parts are persisted verbatim and
 * keep any markers in the row; nothing downstream reads them as prose (search
 * filters `type = 'text'`, `getCopyText()` does not join reasoning), and the one
 * consumer that renders them — `assistant-reasoning-part.tsx` — strips at read.
 * Widening this would mutate more durable content, irreversibly, for no reader
 * that needs it. Do not restate this projection as "everything downstream is
 * clean": it is these parts, for these readers.
 *
 * ASSISTANT ROWS ONLY (see the `role` gate in the caller). Providers emit these
 * markers on assistant text, so gating costs the fix nothing — while rewriting a
 * user row would be irreversible, would make a reloaded prompt differ from what
 * the user typed, and would change the history replayed to the model. It would
 * also contradict the renderer, where `UserMessageText` deliberately shows
 * user-authored text exactly as typed.
 *
 * Write-time only: rows persisted before this shipped keep their markers until
 * rewritten. Backfilling them is a data migration and is deliberately not done
 * here.
 */
function projectTextPartForTranscript(
  part: Record<string, unknown>
): Record<string, unknown> | null {
  if (part['type'] !== 'text' || typeof part['text'] !== 'string') {
    return null;
  }
  const stripped = stripProviderCitationMarkers(part['text'], TRANSCRIPT_STRIP_OPTIONS);
  if (stripped === part['text']) {
    return null;
  }
  return { ...part, text: stripped };
}

export function projectMessageContentForTranscript(
  content: MastraDBMessage['content'],
  role: MastraDBMessage['role']
): MastraDBMessage['content'] {
  if (!(isRecord(content) && content['format'] === 2 && Array.isArray(content['parts']))) {
    return content;
  }
  // Tool-invocation projection applies to every role (it strips internal hook
  // carriers); ONLY the citation strip is assistant-scoped.
  const stripsText = role === 'assistant';
  const byToolCallId = new Map<string, PersistedInvocationProjection>();
  let changed = false;
  const parts = content['parts'].map((part) => {
    if (!isRecord(part)) {
      return part;
    }
    const projectedText = stripsText ? projectTextPartForTranscript(part) : null;
    if (projectedText) {
      changed = true;
      return projectedText;
    }
    const projected = projectToolInvocationPartForTranscript(part);
    if (!projected.projection) {
      return part;
    }
    changed = true;
    if (projected.toolCallId) {
      byToolCallId.set(projected.toolCallId, projected.projection);
    }
    return projected.part;
  });

  // The flattened `content` string is the search extractor's fallback for rows
  // with no text parts, so it needs the same treatment as the parts themselves.
  const flattened = content['content'];
  let flattenedText: string | undefined;
  if (stripsText && typeof flattened === 'string') {
    const stripped = stripProviderCitationMarkers(flattened, TRANSCRIPT_STRIP_OPTIONS);
    if (stripped !== flattened) {
      flattenedText = stripped;
      changed = true;
    }
  }

  if (!changed) {
    return content;
  }

  const toolInvocations = Array.isArray(content['toolInvocations'])
    ? content['toolInvocations'].map((invocation) => {
        if (!isRecord(invocation) || typeof invocation['toolCallId'] !== 'string') {
          return invocation;
        }
        const projected = byToolCallId.get(invocation['toolCallId']);
        return projected ? { ...invocation, ...projected } : invocation;
      })
    : undefined;
  return {
    ...content,
    parts,
    ...(flattenedText === undefined ? {} : { content: flattenedText }),
    ...(toolInvocations ? { toolInvocations } : {}),
  } as MastraDBMessage['content'];
}
