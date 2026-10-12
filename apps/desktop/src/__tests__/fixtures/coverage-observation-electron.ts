import type { IndexerPort, ScopedCoverageRequest, ScopedIndexerPort } from '@brainstrike/indexer';
import { app, BrowserWindow, ipcMain } from 'electron';
import { configureDesktopRendererTarget } from '../../desktop-renderer-target';
import { registerIndexSearchIpcHandlers } from '../../ipc-index-search';
import { createNativeScopedSearchCapability } from '../../native-scoped-search';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { assignWindowRole } from '../../window-role';

const profile = process.env['BRAINSTRIKE_COVERAGE_PROOF_PROFILE'];
const preload = process.env['BRAINSTRIKE_COVERAGE_PROOF_PRELOAD'];
const document = process.env['BRAINSTRIKE_COVERAGE_PROOF_DOCUMENT'];
if (!(profile && preload && document)) {
  throw new Error('Coverage transport proof requires explicit profile, preload and document.');
}
app.setPath('userData', profile);
configureDesktopRendererTarget({
  kind: 'built-renderer',
  launchMode: 'built',
  rendererPath: document,
});
const scope = { kind: 'workspace', rootId: 'root' } as const;
const storeId = 'a'.repeat(64);
let revision = 0;
let calls = 0;
const unused = async (): Promise<never> => {
  throw new Error('Unexpected transport-fixture operation.');
};
const port: IndexerPort & ScopedIndexerPort = {
  close: unused,
  commitFile: unused,
  commitScopedFile: unused,
  commitScopedTextFile: unused,
  commitTextFile: unused,
  configureVectorProfile: unused,
  coverage: unused,
  coverageBatch: async (input) => {
    calls += 1;
    if (calls === 5) {
      throw new Error('Native source or saved profile changed during search.');
    }
    if (calls === 1 || calls === 3 || calls === 6) {
      revision += 1;
    }
    return (input as readonly ScopedCoverageRequest[]).map(({ scope: requested }) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      counts: { chunks: 1, indexedFiles: 1, missingVectors: 1, vectors: 0 },
      profile: null,
      profileHash: null,
      scope: requested,
      storeId,
      vectorCoverageComplete: false,
    }));
  },
  coverageScope: unused,
  destroy: unused,
  info: async () => ({
    dbPath: '/synthetic/transport-control.sqlite',
    embedding: { indexMode: 'text-only' },
    journalMode: 'wal',
    pid: process.pid,
    readerQueryOnly: 1,
    storeId,
    vecVersion: '0.1.9',
    writerThreadId: 1,
  }),
  prepareFile: unused,
  prepareScopedFile: unused,
  removeFile: unused,
  removeScopedFile: unused,
  replaceFileBindings: unused,
  search: unused,
  searchScopes: unused,
  verifyManifest: unused,
  verifyScopedManifest: unused,
};
const capability = createNativeScopedSearchCapability({
  openQuery: unused,
  rebuild: unused,
  withRead: (work) =>
    work({
      // Each scripted revision is a saved-authority transition: scan progress alone
      // never invalidates an observation (5762617e0).
      getAuthority: async () => ({
        bindings: [],
        collectionId: 'collection',
        generation: 1 + revision,
        profile: null,
        queryPlan: undefined,
        readiness: [{ generation: 1, mutationRevision: revision, scanComplete: true, scope }],
        rootIds: ['root'],
      }),
      port,
    }),
});
const unregister = registerIndexSearchIpcHandlers(capability, {
  rootsRegistered: async () => {
    throw new Error('Unexpected root registration in read-only test');
  },
});
ipcMain.handle(DESKTOP_IPC_CHANNELS.embeddingHost.getStatus, () => ({
  active: false,
  lastError: null,
  runtimeId: 'embedding-host:stopped',
  runtimeKind: 'embedding-host',
  state: 'stopped',
}));
app.on('will-quit', unregister);
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload, sandbox: true },
    });
    assignWindowRole(window, 'visible-ui');
    await window.loadFile(document);
  })
  .catch((error: unknown) => {
    process.stderr.write(String(error));
    app.exit(1);
  });
