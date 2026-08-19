export const DESKTOP_IPC_CHANNELS = {
  agent: {
    assistantGetAuth: 'assistant:get-auth',
    assistantGetUrl: 'assistant:get-url',
    chat: 'agent:chat',
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
  },
  fileExports: {
    saveToDownloads: 'file-exports:save-to-downloads',
  },
  files: {
    addRoot: 'fs:addRoot',
    exists: 'fs:exists',
    parserHostParse: 'parser-host:parse',
    readDirectory: 'fs:readDirectory',
    readFile: 'fs:readFile',
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
  git: {
    aheadBehind: 'git:aheadBehind',
    commit: 'git:commit',
    commitFiles: 'git:commitFiles',
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
    resolveTrustedRootIds: 'hooks:resolve-trusted-root-ids',
  },
  mcp: {
    configCreateSample: 'mcp:config:createSample',
    configGet: 'mcp:config:get',
    configGetPath: 'mcp:config:getPath',
    configReadText: 'mcp:config:readText',
    configSelectPath: 'mcp:config:selectPath',
    configSetPath: 'mcp:config:setPath',
    configUnwatch: 'mcp:config:unwatch',
    configUpdated: 'mcp:config:updated',
    configWatch: 'mcp:config:watch',
    configWriteText: 'mcp:config:writeText',
    toolsDisable: 'mcp:tools:disable',
    toolsDisableServer: 'mcp:tools:disableServer',
    toolsEnable: 'mcp:tools:enable',
    toolsEnableServer: 'mcp:tools:enableServer',
    toolsGetStats: 'mcp:tools:getStats',
    toolsList: 'mcp:tools:list',
    toolsReset: 'mcp:tools:reset',
    toolsUpdated: 'mcp:tools:updated',
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
    getAllKeys: 'storage:getAllKeys',
    getItem: 'storage:getItem',
    removeItem: 'storage:removeItem',
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
} as const;

export const DESKTOP_PRELOAD_IPC_CHANNELS = DESKTOP_IPC_CHANNELS;
