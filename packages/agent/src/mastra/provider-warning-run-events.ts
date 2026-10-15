/**
 * Provider call warnings as run-event rows (BST-1701).
 *
 * The capture half lives in `providers/provider-call-warnings.ts`, at the
 * model, because Mastra 1.64 drops the adapter's `stream-start` part and never
 * carries its `warnings` array onto the stream. This module is the
 * PRESENTATION half: it turns those recorded facts into always-visible
 * run-event chunks. Their wording is shared with the CLI-first host in
 * `@brainstrike/assistant-contract` (`provider-call-warnings.ts`).
 *
 * The split is the one `mcp-discovery-diagnostics.ts` made for BST-1602, and
 * for the same reason: the capture layer must not decide how loudly to report,
 * and `stream-run-event-chunks.ts` is the leaf every other streaming concern
 * depends on, so it cannot import a provider module.
 */
import {
  PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
  providerCallWarningDetail,
  providerCallWarningLabel,
  providerCallWarningMetadata,
} from '@brainstrike/assistant-contract';
import type {
  ProviderCallWarning,
  ProviderCallWarningSink,
} from '../providers/provider-call-warnings';
import type { StreamChunk } from '../types';
import { makeRunDetailEventChunk } from '../tool-projection/stream-run-event-chunks';

// The wording is shared with the host path (assistant-contract).
export {
  MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS,
  PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
} from '@brainstrike/assistant-contract';

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
      providerCallWarningLabel(warning),
      providerCallWarningDetail(warning),
      providerCallWarningMetadata(warning)
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
