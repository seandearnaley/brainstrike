export const DESKTOP_IPC_CHANNELS = {
  agent: {
    assistantGetUrl: 'assistant:get-url',
    chat: 'agent:chat',
    previewContextSelectionUpdate: 'assistant:preview-context-selection-update',
    rootTreeSelectionUpdate: 'assistant:root-tree-selection-update',
    workspaceContextSelectionUpdate: 'assistant:workspace-context-selection-update',
    workspaceContextTapestryUpdate: 'assistant:workspace-context-tapestry-update',
  },
  assistantCheckpoint: {
    revertEntry: 'assistant-checkpoint:revert-entry',
    revertRun: 'assistant-checkpoint:revert-run',
  },
  clipboard: {
    writeText: 'clipboard:write-text',
  },
  commandPalette: {
    // One-way main→renderer push: the app menu's Cmd+K accelerator triggers
    // this on the FOCUSED window so the renderer opens the ⌘K palette.
    open: 'command-palette:open',
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
  },
  git: {
    aheadBehind: 'git:aheadBehind',
    commit: 'git:commit',
    diff: 'git:diff',
    pull: 'git:pull',
    push: 'git:push',
    stage: 'git:stage',
    status: 'git:status',
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
  preferences: {
    layoutLoad: 'layout:load',
    layoutSave: 'layout:save',
    settingsClearAll: 'settings:clearAll',
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
    get: 'secrets:get',
    list: 'secrets:list',
    listStored: 'secrets:listStored',
    save: 'secrets:save',
  },
  shell: {
    openExternal: 'shell:open-external',
    openPath: 'shell:open-path',
    showItemInFolder: 'shell:show-item-in-folder',
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
  tools: {
    execute: 'tools:execute',
  },
} as const;

export const DESKTOP_PRELOAD_IPC_CHANNELS = DESKTOP_IPC_CHANNELS;
