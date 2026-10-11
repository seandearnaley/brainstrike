export const DESKTOP_IPC_CHANNELS = {
  agent: {
    assistantGetAuth: 'assistant:get-auth',
    assistantGetUrl: 'assistant:get-url',
    hostConnect: 'agent:host-connect',
    hostConnected: 'agent:host-connected',
    hostDisconnected: 'agent:host-disconnected',
    previewContextSelectionUpdate: 'assistant:preview-context-selection-update',
    rootTreeSelectionUpdate: 'assistant:root-tree-selection-update',
    workspaceContextSelectionUpdate: 'assistant:workspace-context-selection-update',
    workspaceContextTapestryUpdate: 'assistant:workspace-context-tapestry-update',
  },
  assistantCheckpoint: {
    availability: 'assistant-checkpoint:availability',
    revertEntry: 'assistant-checkpoint:revert-entry',
    revertRun: 'assistant-checkpoint:revert-run',
  },
  // Embedded browser pane (BST-1174). Invoke channels drive the main-process
  // BrowserViewManager; `tabsChanged` is a one-way main→renderer push (like
  // changes.invalidated) and is NEVER registered on the invoke registry.
  browser: {
    closeTab: 'browser:closeTab',
    createTab: 'browser:createTab',
    goBack: 'browser:goBack',
    goForward: 'browser:goForward',
    listTabs: 'browser:listTabs',
    navigate: 'browser:navigate',
    reload: 'browser:reload',
    selectTab: 'browser:selectTab',
    setBounds: 'browser:setBounds',
    setOccluded: 'browser:setOccluded',
    tabsChanged: 'browser:tabsChanged',
  },
  changes: {
    applyRewind: 'changes:applyRewind',
    fileDiff: 'changes:fileDiff',
    finalizeRewinds: 'changes:finalizeRewinds',
    // One-way main→renderer push (BST-1161, spec §6): the git-metadata
    // watcher observed external git activity on a repository. NOT an
    // ipcMain.handle channel — never registered on the registry.
    invalidated: 'changes:invalidated',
    inventory: 'changes:inventory',
    redoRewind: 'changes:redoRewind',
    resolveView: 'changes:resolveView',
    rewindPreview: 'changes:rewindPreview',
  },
  // Hidden chunking host (renderer-only inference, docs/agents/local-inference.md).
  // `request`/`progress`/`status` are one-way main→host pushes; `report*` are
  // host→main sends. Pinned equal to the @brainstrike/worker-runtime
  // descriptor in chunking-host-shared.ts by desktop-ipc-channel-contract.test.ts.
  chunkingHost: {
    chunkBatch: 'chunking-host:chunk-batch',
    chunkFile: 'chunking-host:chunk-file',
    ensureStarted: 'chunking-host:ensure-started',
    getStatus: 'chunking-host:get-status',
    progress: 'chunking-host:progress',
    reportResponse: 'chunking-host:report-response',
    reportStatus: 'chunking-host:report-status',
    request: 'chunking-host:request',
    reset: 'chunking-host:reset',
    status: 'chunking-host:status',
    stop: 'chunking-host:stop',
  },
  clipboard: {
    writeText: 'clipboard:write-text',
  },
  commandPalette: {
    // One-way main→renderer push: the app menu's Cmd+K accelerator triggers
    // this on the FOCUSED window so the renderer opens the ⌘K palette.
    open: 'command-palette:open',
  },
  commandSessions: {
    list: 'command-sessions:list',
    read: 'command-sessions:read',
    remove: 'command-sessions:remove',
    stop: 'command-sessions:stop',
    write: 'command-sessions:write',
  },
  contextFiles: {
    scan: 'context-files:scan',
  },
  db: {
    applyManagedCacheBatch: 'db:managed-cache:apply-batch',
    clearAll: 'db:clearAll',
    diagnostics: 'db:diagnostics',
    exec: 'db:exec',
    getUserDataPath: 'db:getUserDataPath',
    insertChunksAndEnqueueEmbeddingJobs: 'db:chunks:insert-and-enqueue-embedding-jobs',
    integrityChanged: 'db:integrity:changed',
    integrityState: 'db:integrity:state',
    invalidateManagedCacheEntriesByIdentity: 'db:managed-cache:invalidate-by-identity',
    liveQueryRefresh: 'db:live-query:refresh',
    liveQueryStart: 'db:live-query:start',
    liveQueryStop: 'db:live-query:stop',
    liveQueryUpdate: 'db:live-query:update',
    ping: 'db:ping',
    query: 'db:query',
    resetLocal: 'db:resetLocal',
    schedulerSnapshot: 'db:scheduler:snapshot',
    test: 'db:test',
    transaction: 'db:transaction',
  },
  diagnostics: {
    getSnapshot: 'desktop-diagnostics:get-snapshot',
    readMainLogWindow: 'desktop-diagnostics:read-main-log-window',
    readProcessCounters: 'desktop-diagnostics:read-process-counters',
  },
  // Hidden embedding host; same pinning as chunkingHost (embedding-host-shared.ts).
  embeddingHost: {
    backfillProgress: 'embedding-host:backfill-progress',
    cancelAllBackfills: 'embedding-host:cancel-all-backfills',
    cancelBackfill: 'embedding-host:cancel-backfill',
    cancelDocumentEmbeddings: 'embedding-host:cancel-document-embeddings',
    cancelQueryEmbedding: 'embedding-host:cancel-query-embedding',
    command: 'embedding-host:command',
    documentEmbeddings: 'embedding-host:document-embeddings',
    documentEmbeddingsCancel: 'embedding-host:document-embeddings-cancel',
    documentEmbeddingsRequest: 'embedding-host:document-embeddings-request',
    enqueueBackfill: 'embedding-host:enqueue-backfill',
    ensureStarted: 'embedding-host:ensure-started',
    getBackfillsInFlight: 'embedding-host:get-backfills-in-flight',
    getStatus: 'embedding-host:get-status',
    queryEmbedding: 'embedding-host:query-embedding',
    queryEmbeddingCancel: 'embedding-host:query-embedding-cancel',
    queryEmbeddingRequest: 'embedding-host:query-embedding-request',
    reportDocumentEmbeddingsResponse: 'embedding-host:report-document-embeddings-response',
    reportQueryEmbeddingResponse: 'embedding-host:report-query-embedding-response',
    reportStatus: 'embedding-host:report-status',
    reset: 'embedding-host:reset',
    status: 'embedding-host:status',
    stop: 'embedding-host:stop',
  },
  fileExports: {
    saveToDownloads: 'file-exports:save-to-downloads',
  },
  files: {
    addRoot: 'fs:addRoot',
    addRootByPath: 'fs:addRootByPath',
    deleteRootData: 'fs:deleteRootData',
    exists: 'fs:exists',
    listRecentRoots: 'fs:listRecentRoots',
    parserHostParse: 'parser-host:parse',
    readDirectory: 'fs:readDirectory',
    readFile: 'fs:readFile',
    readFileByAbsolutePath: 'fs:readFileByAbsolutePath',
    readFileByPath: 'fs:readFileByPath',
    removeRoot: 'fs:removeRoot',
    requestDirectoryAccess: 'fs:requestDirectoryAccess',
    restoreLastFolder: 'fs:restoreLastFolder',
    restoreRoots: 'fs:restoreRoots',
    saveLastFolder: 'fs:saveLastFolder',
    unwatch: 'fs:unwatch',
    watch: 'fs:watch',
    watchEvent: 'fs:watch-event',
    watchHealth: 'fs:watch-health',
    watchRetry: 'fs:watch-retry',
    watchTelemetry: 'fs:watch-telemetry',
  },
  forge: {
    identity: 'forge:identity',
    prStatus: 'forge:prStatus',
    // One-way main→renderer push (BST-1391): a forge observation changed for a
    // (repository, branch). NOT an ipcMain.handle channel — never registered
    // on the invoke registry, exactly like changes.invalidated.
    prUpdated: 'forge:prUpdated',
    refresh: 'forge:refresh',
  },
  git: {
    aheadBehind: 'git:aheadBehind',
    commit: 'git:commit',
    commitFiles: 'git:commitFiles',
    createBranch: 'git:createBranch',
    diff: 'git:diff',
    fetch: 'git:fetch',
    history: 'git:history',
    pull: 'git:pull',
    push: 'git:push',
    repository: 'git:repository',
    stage: 'git:stage',
    status: 'git:status',
    structuredFileDiff: 'git:structuredFileDiff',
    switchBranch: 'git:switchBranch',
    unstage: 'git:unstage',
  },
  hooks: {
    getProjectHooksForReview: 'hooks:get-project-hooks-for-review',
    trustProjectHooks: 'hooks:trust-project-hooks',
    untrustProjectHooks: 'hooks:untrust-project-hooks',
  },
  indexSearch: {
    coverage: 'index-search:coverage',
    coverageBatch: 'index-search:coverage-batch',
    grep: 'index-search:grep',
    rebuild: 'index-search:rebuild',
    rootsRegistered: 'index-search:roots-registered',
    search: 'index-search:search',
    status: 'index-search:status',
  },
  // Hidden local-LLM host; same pinning as chunkingHost (llm-host-shared.ts).
  llmHost: {
    cancel: 'llm-host:cancel',
    ensureStarted: 'llm-host:ensure-started',
    generate: 'llm-host:generate',
    getStatus: 'llm-host:get-status',
    progress: 'llm-host:progress',
    reportProgress: 'llm-host:report-progress',
    reportResponse: 'llm-host:report-response',
    reportStatus: 'llm-host:report-status',
    request: 'llm-host:request',
    reset: 'llm-host:reset',
    status: 'llm-host:status',
    stop: 'llm-host:stop',
    warmup: 'llm-host:warmup',
  },
  // Logging settings/ingest surface; `platform/logging-api-contract.ts`
  // re-exports this group as LOGGING_API_CHANNELS (its validators need
  // @brainstrike/logging, which a preload cannot require).
  logging: {
    durableRecord: 'logging:durable-record',
    getBufferedLogs: 'logging:get-buffered-logs',
    getPreferences: 'logging:get-preferences',
    ingestBufferedRecord: 'logging:ingest-buffered-record',
    openDestination: 'logging:open-destination',
    preferencesUpdated: 'logging:preferences-updated',
    selectDestination: 'logging:select-destination',
    setPreferences: 'logging:set-preferences',
  },
  mcp: {
    appsPrepareShell: 'mcp:apps:prepareShell',
    appsReleaseShell: 'mcp:apps:releaseShell',
    configSelectPath: 'mcp:config:selectPath',
  },
  notesVault: {
    // One-way main→renderer push: a watched vault directory changed. Pushed to
    // the OWNING renderer's WebContents only — NOT an ipcMain.handle channel,
    // so it is never registered on the registry (see notes-vault-ipc-handlers.ts).
    changed: 'notes-vault:changed',
    createDirectory: 'notes-vault:create-directory',
    deleteEntry: 'notes-vault:delete-entry',
    ensureDefaultVault: 'notes-vault:ensure-default-vault',
    listDirectory: 'notes-vault:list-directory',
    pickDirectory: 'notes-vault:pick-directory',
    readFile: 'notes-vault:read-file',
    registerRoot: 'notes-vault:register-root',
    rename: 'notes-vault:rename',
    statEntry: 'notes-vault:stat-entry',
    unwatch: 'notes-vault:unwatch',
    watch: 'notes-vault:watch',
    writeFile: 'notes-vault:write-file',
  },
  preferences: {
    layoutLoad: 'layout:load',
    layoutSave: 'layout:save',
    settingsClearAll: 'settings:clearAll',
  },
  // Provider OAuth engine (BST-1355). Renderer-visible surface is STATUS
  // ONLY — token material never crosses these channels (legal gate BST-1351
  // constraint 3; pinned by provider-auth-ipc tests).
  providerAuth: {
    cancel: 'provider-auth:cancel',
    disconnect: 'provider-auth:disconnect',
    start: 'provider-auth:start',
    status: 'provider-auth:status',
  },
  quickOpen: {
    // One-way main→renderer push: the app menu's Cmd+P accelerator triggers
    // this on the FOCUSED window so the renderer opens the ⌘P quick-open finder.
    open: 'quick-open:open',
  },
  runtime: {
    listModels: 'runtime:listModels',
    noteReloadIntent: 'app:lifecycle:note-reload-intent',
    powerSnapshot: 'app:power-snapshot',
    powerState: 'app:power-state',
    probe: 'runtime:probe',
    resolveOllamaCapabilities: 'runtime:resolveOllamaCapabilities',
    verifyEmbeddingDimensions: 'runtime:verifyEmbeddingDimensions',
  },
  secrets: {
    clearAll: 'secrets:clearAll',
    delete: 'secrets:delete',
    // Read-only env bootstrap projection (BST-1363). Reports which .env files
    // loaded, how many variables applied, line-precise parse failures, and the
    // NAMES of allow-listed variables currently set — never a value.
    envBootstrap: 'secrets:envBootstrap',
    get: 'secrets:get',
    // Typed credential channels (BST-1348): separate channels rather than
    // versioned payloads on save/get.
    getCredential: 'secrets:getCredential',
    list: 'secrets:list',
    listStored: 'secrets:listStored',
    save: 'secrets:save',
    saveCredential: 'secrets:saveCredential',
  },
  shell: {
    openExternal: 'shell:open-external',
    openPath: 'shell:open-path',
    showItemInFolder: 'shell:show-item-in-folder',
  },
  skills: {
    scan: 'skills:scan',
  },
  storage: {
    clear: 'storage:clear',
    clearAllForE2e: 'storage:clearAllForE2e',
    getAllKeys: 'storage:getAllKeys',
    getItem: 'storage:getItem',
    removeItem: 'storage:removeItem',
    seedMainOwnedForE2e: 'storage:seedMainOwnedForE2e',
    setItem: 'storage:setItem',
  },
  terminal: {
    create: 'terminal:create',
    // One-way main→renderer pushes (pty output / exit). Not ipcMain.handle
    // channels — see terminal-ipc-handlers.ts.
    data: 'terminal:data',
    destroy: 'terminal:destroy',
    exit: 'terminal:exit',
    resize: 'terminal:resize',
    write: 'terminal:write',
  },
  userCommands: {
    list: 'user-commands:list',
  },
  userPersonas: {
    list: 'user-personas:list',
  },
  /**
   * Scoped read/write for the single canonical vector-preferences record
   * (BST-1380). Hidden inference hosts must observe the SAME device preference
   * the visible UI writes, but must not receive the unrestricted `storage`
   * bridge. These channels accept no key — main pins the record server-side —
   * so they can neither enumerate nor address any other persisted store.
   */
  vectorPreferences: {
    clear: 'vector-preferences:clear',
    read: 'vector-preferences:read',
    write: 'vector-preferences:write',
  },
  // Native focus of the host BrowserWindow (BST-1864). `isFocused` is the ONLY
  // invoke: the value for the asking window, served on request so a renderer
  // that (re)loads after a focus change still reads the truth. `changed` is a
  // one-way main→renderer push (`focus`/`blur` of that window) — NOT an
  // ipcMain.handle channel, never registered on the invoke registry.
  windowFocus: {
    changed: 'window-focus:changed',
    isFocused: 'window-focus:is-focused',
  },
  workspace: {
    // One-way main→replacement-renderer challenge. Main publishes a fresh
    // reset generation only after the new main-frame navigation reaches
    // `dom-ready`; preload captures it and the mounted renderer echoes it in
    // `openPathReady`. This is deliberately explicit because Electron may
    // preserve RenderFrameHost identity across reloads.
    factoryResetGeneration: 'workspace:factory-reset-generation',
    // One-way main→renderer push: File ▸ Open Folder… asks the FOCUSED window
    // to run its ordinary picker flow, so the grant, the recents recording and
    // the mount bookkeeping all stay on one path. NOT an `ipcMain.handle`
    // channel.
    openFolderPicker: 'workspace:open-folder-picker',
    // One-way main→renderer push: argv / open-file / second-instance / File ▸
    // Open Recent ask the FOCUSED window to CONNECT a path. A request, never a
    // grant — the renderer routes it through `fs:addRootByPath`, whose gates
    // decide. NOT an `ipcMain.handle` channel.
    openPath: 'workspace:open-path',
    // The ONLY channel in this domain that runs renderer→main. Sent by
    // `WorkspaceConnectHost` the instant it subscribes to `openPath` above —
    // main gates delivery on BOTH the window having finished loading AND this
    // ping, because `did-finish-load`/`did-stop-loading` only prove the
    // DOCUMENT loaded, not that React has mounted the host and its
    // `ipcRenderer.on` listener exists yet. NOT an `ipcMain.handle` channel.
    openPathReady: 'workspace:open-path-ready',
  },
  worktrees: {
    adopt: 'worktrees:adopt',
    archive: 'worktrees:archive',
    checkoutStatus: 'worktrees:checkoutStatus',
    create: 'worktrees:create',
    createBranchHere: 'worktrees:createBranchHere',
    createContext: 'worktrees:createContext',
    getSettings: 'worktrees:getSettings',
    inspectArchive: 'worktrees:inspectArchive',
    list: 'worktrees:list',
    managedPaths: 'worktrees:managedPaths',
    restore: 'worktrees:restore',
    setSettings: 'worktrees:setSettings',
  },
} as const;

export const DESKTOP_PRELOAD_IPC_CHANNELS = DESKTOP_IPC_CHANNELS;
