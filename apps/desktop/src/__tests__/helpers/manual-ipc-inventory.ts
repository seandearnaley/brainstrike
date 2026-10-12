import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

export type ManualIpcRegistrationStatus =
  | 'remaining-migration'
  | 'separate-capability'
  | 'separate-protocol';

export interface ManualIpcRegistration {
  readonly channel: string;
  readonly kind: 'event' | 'invoke';
  readonly reason: string;
  readonly status: ManualIpcRegistrationStatus;
}

function classify(
  status: ManualIpcRegistrationStatus,
  reason: string,
  entries: readonly (readonly [channel: string, kind: ManualIpcRegistration['kind']])[]
): ManualIpcRegistration[] {
  return entries.map(([channel, kind]) => ({ channel, kind, reason, status }));
}

/**
 * Explicit complement of the pure-contract invoke registry. Adding or removing
 * a production registration requires classifying it here, so the migration
 * inventory cannot silently drift.
 */
export const MANUAL_PRODUCTION_REGISTRATIONS: readonly ManualIpcRegistration[] = [
  ...classify(
    'separate-protocol',
    'Bidirectional worker, logging, or workspace lifecycle protocol with event channels.',
    [
      [DESKTOP_IPC_CHANNELS.logging.getBufferedLogs, 'invoke'],
      [DESKTOP_IPC_CHANNELS.logging.getPreferences, 'invoke'],
      [DESKTOP_IPC_CHANNELS.logging.ingestBufferedRecord, 'event'],
      [DESKTOP_IPC_CHANNELS.logging.openDestination, 'invoke'],
      [DESKTOP_IPC_CHANNELS.logging.selectDestination, 'invoke'],
      [DESKTOP_IPC_CHANNELS.logging.setPreferences, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.cancelAllBackfills, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.cancelBackfill, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.enqueueBackfill, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.getBackfillsInFlight, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.ensureStarted, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.getStatus, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.reportStatus, 'event'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.reset, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.stop, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.chunkBatch, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.chunkFile, 'invoke'],
      [DESKTOP_IPC_CHANNELS.chunkingHost.reportResponse, 'event'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.ensureStarted, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.getStatus, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.reportStatus, 'event'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.reset, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.stop, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddings, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.cancelDocumentEmbeddings, 'invoke'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.reportDocumentEmbeddingsResponse, 'event'],
      [DESKTOP_IPC_CHANNELS.embeddingHost.reportQueryEmbeddingResponse, 'event'],
      [DESKTOP_IPC_CHANNELS.llmHost.ensureStarted, 'invoke'],
      [DESKTOP_IPC_CHANNELS.llmHost.getStatus, 'invoke'],
      [DESKTOP_IPC_CHANNELS.llmHost.reportStatus, 'event'],
      [DESKTOP_IPC_CHANNELS.llmHost.reset, 'invoke'],
      [DESKTOP_IPC_CHANNELS.llmHost.stop, 'invoke'],
      [DESKTOP_IPC_CHANNELS.llmHost.cancel, 'invoke'],
      [DESKTOP_IPC_CHANNELS.llmHost.generate, 'invoke'],
      [DESKTOP_IPC_CHANNELS.llmHost.reportProgress, 'event'],
      [DESKTOP_IPC_CHANNELS.llmHost.reportResponse, 'event'],
      [DESKTOP_IPC_CHANNELS.llmHost.warmup, 'invoke'],
      [DESKTOP_IPC_CHANNELS.workspace.openPathReady, 'event'],
    ]
  ),
  ...classify(
    'separate-capability',
    'Parser-host authority is exposed only to the chunking renderer.',
    [[DESKTOP_IPC_CHANNELS.files.parserHostParse, 'invoke']]
  ),
  ...classify(
    'remaining-migration',
    'Renderer-facing domain still uses handwritten registration and preload routing.',
    [
      [DESKTOP_IPC_CHANNELS.diagnostics.getSnapshot, 'invoke'],
      [DESKTOP_IPC_CHANNELS.diagnostics.readMainLogWindow, 'invoke'],
      [DESKTOP_IPC_CHANNELS.diagnostics.readProcessCounters, 'invoke'],
      [DESKTOP_IPC_CHANNELS.shell.openExternal, 'invoke'],
      [DESKTOP_IPC_CHANNELS.shell.openPath, 'invoke'],
      [DESKTOP_IPC_CHANNELS.shell.showItemInFolder, 'invoke'],
      [DESKTOP_IPC_CHANNELS.fileExports.saveToDownloads, 'invoke'],
      [DESKTOP_IPC_CHANNELS.assistantCheckpoint.availability, 'invoke'],
      [DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertEntry, 'invoke'],
      [DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertRun, 'invoke'],
      [DESKTOP_IPC_CHANNELS.hooks.getProjectHooksForReview, 'invoke'],
      [DESKTOP_IPC_CHANNELS.hooks.resolveTrustedRootIds, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.clearAll, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.delete, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.envBootstrap, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.get, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.getCredential, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.list, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.listStored, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.save, 'invoke'],
      [DESKTOP_IPC_CHANNELS.secrets.saveCredential, 'invoke'],
      [DESKTOP_IPC_CHANNELS.providerAuth.cancel, 'invoke'],
      [DESKTOP_IPC_CHANNELS.providerAuth.disconnect, 'invoke'],
      [DESKTOP_IPC_CHANNELS.providerAuth.start, 'invoke'],
      [DESKTOP_IPC_CHANNELS.providerAuth.status, 'invoke'],
      [DESKTOP_IPC_CHANNELS.agent.chat, 'invoke'],
      [DESKTOP_IPC_CHANNELS.runtime.listModels, 'invoke'],
      [DESKTOP_IPC_CHANNELS.runtime.probe, 'invoke'],
      [DESKTOP_IPC_CHANNELS.runtime.resolveOllamaCapabilities, 'invoke'],
      [DESKTOP_IPC_CHANNELS.runtime.verifyEmbeddingDimensions, 'invoke'],
      [DESKTOP_IPC_CHANNELS.runtime.noteReloadIntent, 'invoke'],
      [DESKTOP_IPC_CHANNELS.runtime.powerSnapshot, 'invoke'],
      [DESKTOP_IPC_CHANNELS.agent.assistantGetAuth, 'invoke'],
      [DESKTOP_IPC_CHANNELS.agent.assistantGetUrl, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.closeTab, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.createTab, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.goBack, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.goForward, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.listTabs, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.navigate, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.reload, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.selectTab, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.setBounds, 'invoke'],
      [DESKTOP_IPC_CHANNELS.browser.setOccluded, 'invoke'],
    ]
  ),
];
