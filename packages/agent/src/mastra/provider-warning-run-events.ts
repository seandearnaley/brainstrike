/**
 * Provider call warnings as run-event rows (BST-1701).
 *
 * The capture half lives in `providers/provider-call-warnings.ts`, at the
 * model, because Mastra 1.64 drops the adapter's `stream-start` part and never
 * carries its `warnings` array onto the stream. This module is the
 * PRESENTATION half: it turns those recorded facts into always-visible
 * run-event chunks and is the only place that decides how they read.
 *
 * The split is the one `mcp-discovery-diagnostics.ts` made for BST-1602, and
 * for the same reason: the capture layer must not decide how loudly to report,
 * and `stream-run-event-chunks.ts` is the leaf every other streaming concern
 * depends on, so it cannot import a provider module.
 */
import { boundRunEventReason } from '@brainstrike/assistant-contract';
import type {
  ProviderCallWarning,
  ProviderCallWarningSink,
} from '../providers/provider-call-warnings';
import { UNRECOGNIZED_PROVIDER_WARNING_TYPE } from '../providers/provider-call-warnings';
import type { AssistantRunEventMetadata } from '../run-events';
import type { StreamChunk } from '../types';
import { truncateStreamDetail } from './mastra-chunk-decoding';
import { makeRunDetailEventChunk } from './stream-run-event-chunks';

export const PROVIDER_CALL_WARNING_RUN_EVENT_KIND = 'provider.request.warned' as const;

/** Cap for the rendered + persisted detail, using the one shared clamp. */
export const MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS = 240;
/** Reserve visible space for the explanation after the model identity. */
const MAX_PROVIDER_CALL_WARNING_ORIGIN_CHARS = 80;

/**
 * Per-type row headings. A MAP WITH A DEFAULT, not a filter: an unknown type
 * still gets a row, which is what makes this a consumer of the whole
 * `warnings` channel rather than an `unsupported`-only patch.
 */
const WARNING_LABELS: Readonly<Record<string, string>> = {
  compatibility: 'Provider used a compatibility mode',
  deprecated: 'Provider reported a deprecated setting',
  other: 'Provider reported a warning',
  unsupported: 'Provider ignored an unsupported setting',
  [UNRECOGNIZED_PROVIDER_WARNING_TYPE]: 'Provider reported a warning',
};

const DEFAULT_WARNING_LABEL = 'Provider reported a warning';

function labelFor(warning: ProviderCallWarning): string {
  return WARNING_LABELS[warning.type] ?? DEFAULT_WARNING_LABEL;
}

/**
 * The visible sentence. Both fields are optional in the spec, so a warning
 * that carries neither still says something true rather than rendering blank.
 */
function detailFor(warning: ProviderCallWarning): string {
  const parts = [warning.subject, warning.detail].filter(
    (part): part is string => part !== undefined
  );
  const body =
    parts.length === 0
      ? `The provider reported a "${warning.type}" warning about this request without any detail.`
      : parts.join(': ');
  const source =
    warning.origin === undefined
      ? ''
      : `${truncateStreamDetail(`${warning.origin.provider}/${warning.origin.modelId}`, MAX_PROVIDER_CALL_WARNING_ORIGIN_CHARS)}: `;
  return truncateStreamDetail(`${source}${body}`, MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS);
}

/**
 * Content-free metadata. `sanitizeAssistantRunEventMetadata` redacts by KEY,
 * so the keys stay descriptive and carry no provider prose - the sentence
 * lives in `detail`, where the one shared clamp already bounded it.
 */
function metadataFor(warning: ProviderCallWarning): AssistantRunEventMetadata {
  return {
    ...(warning.subject === undefined ? {} : { feature: boundRunEventReason(warning.subject) }),
    ...(warning.origin === undefined
      ? {}
      : {
          modelId: boundRunEventReason(warning.origin.modelId),
          provider: boundRunEventReason(warning.origin.provider),
        }),
    warningType: boundRunEventReason(warning.type),
  };
}

/**
 * One row per DISTINCT warning, always `status: 'failed'`.
 *
 * Never `'running'`: nothing is in flight - the provider has already decided
 * what it would not honor, so there is no span to close out and the row can
 * never spin. Never `'info'` either: the `worktree.*` breadcrumbs use `'info'`
 * for operations that SUCCEEDED, and this records a request the provider did
 * not carry out as written.
 */
export function makeProviderCallWarningChunks(
  warnings: readonly ProviderCallWarning[]
): StreamChunk[] {
  return warnings.map((warning) =>
    makeRunDetailEventChunk(
      PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
      'failed',
      labelFor(warning),
      detailFor(warning),
      metadataFor(warning)
    )
  );
}

/**
 * Yield the rows for everything the model has reported so far.
 *
 * Called from the stream loop rather than as a prelude (contrast
 * `makeMcpDiscoverySkipChunks`): a call warning does not exist until the
 * request has gone out, so there is nothing to say before the turn starts.
 * Draining per part surfaces it as soon as the adapter opens its stream, which
 * on every hosted provider is before the first token.
 */
export function* drainProviderCallWarningChunks(
  sink: ProviderCallWarningSink | undefined
): Generator<StreamChunk> {
  if (!sink) {
    return;
  }
  const warnings = sink.drain();
  if (warnings.length === 0) {
    return;
  }
  yield* makeProviderCallWarningChunks(warnings);
}
