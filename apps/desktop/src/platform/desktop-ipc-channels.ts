/**
 * The renderer and Main share ONE Electron IPC connection: the renderer calls
 * `invoke(DESKTOP_IPC_INVOKE_CHANNEL, method, ...args)` and Main answers from one
 * dispatcher (`desktop-ipc-registry.ts`); Main sends every push on
 * DESKTOP_IPC_PUSH_CHANNEL as a `{ method, payload }` envelope, with any
 * transferred ports beside it. The names below are the methods that ride it.
 */
export const DESKTOP_IPC_INVOKE_CHANNEL = 'brainstrike:invoke';
export const DESKTOP_IPC_PUSH_CHANNEL = 'brainstrike:push';

/** One push from Main: the method a renderer listener subscribed to, and its payload. */
export interface DesktopIpcPush {
  readonly method: string;
  readonly payload?: unknown;
}

export const DESKTOP_IPC_CHANNELS = {
  agent: {
    hostConnect: 'agent:host-connect',
    hostConnected: 'agent:host-connected',
    hostDisconnected: 'agent:host-disconnected',
    // A damaged state store's recovery actions (BST-1880): restart the agent host
    // this app launched, so its store reopens and re-checks; show the data folder.
    hostRestart: 'agent:host-restart',
    prepareClose: 'agent:prepare-close',
    showDataFolder: 'agent:show-data-folder',
  },
  appMenu: {
    // One-way main→renderer push: the app menu's Settings… item (⌘, / Ctrl+,)
    // triggers this on the FOCUSED window so the renderer opens Settings.
    openSettings: 'app-menu:open-settings',
  },
  // Settings › Updates (BST-2367): whether update checks offer beta releases.
  appUpdates: {
    checkNow: 'app-updates:check-now',
    getPreferences: 'app-updates:get-preferences',
    getStatus: 'app-updates:get-status',
    restartToUpdate: 'app-updates:restart-to-update',
    setBetaUpdates: 'app-updates:set-beta-updates',
    // Main→renderer push: every change of the update status (BST-2356).
    statusChanged: 'app-updates:status-changed',
  },
  // Embedded browser (BST-1174). Invoke methods drive the main-process
  // BrowserViewManager; `tabsChanged` is a main→renderer push.
  browser: {
    closeTab: 'browser:closeTab',
    createTab: 'browser:createTab',
    goBack: 'browser:goBack',
    goForward: 'browser:goForward',
    listTabs: 'browser:listTabs',
    navigate: 'browser:navigate',
    reload: 'browser:reload',
    setBounds: 'browser:setBounds',
    setOccluded: 'browser:setOccluded',
    showTab: 'browser:showTab',
    tabsChanged: 'browser:tabsChanged',
  },
  clipboard: {
    writeImage: 'clipboard:write-image',
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
    clearAll: 'db:clearAll',
    getUserDataPath: 'db:getUserDataPath',
    resetLocal: 'db:resetLocal',
  },
  diagnostics: {
    countByFingerprint: 'desktop-diagnostics:count-by-fingerprint',
    getSnapshot: 'desktop-diagnostics:get-snapshot',
    getUnseenCounts: 'desktop-diagnostics:get-unseen-counts',
    listCrashDumps: 'desktop-diagnostics:list-crash-dumps',
    queryEvents: 'desktop-diagnostics:query-events',
    readMainLogWindow: 'desktop-diagnostics:read-main-log-window',
    readProcessCounters: 'desktop-diagnostics:read-process-counters',
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
  hooks: {
    getProjectHooksForReview: 'hooks:get-project-hooks-for-review',
    trustProjectHooks: 'hooks:trust-project-hooks',
    untrustProjectHooks: 'hooks:untrust-project-hooks',
  },
  indexSearch: {
    configChanged: 'index-search:config-changed',
    coverage: 'index-search:coverage',
    coverageBatch: 'index-search:coverage-batch',
    embedQuery: 'index-search:embed-query',
    fileChunks: 'index-search:file-chunks',
    grep: 'index-search:grep',
    lifecycleChanged: 'index-search:lifecycle-changed',
    readConfig: 'index-search:read-config',
    rebuild: 'index-search:rebuild',
    resetConfig: 'index-search:reset-config',
    rootsRegistered: 'index-search:roots-registered',
    search: 'index-search:search',
    status: 'index-search:status',
    updateConfig: 'index-search:update-config',
  },
  // Logging settings/ingest surface; `platform/logging-api-contract.ts`
  // re-exports this group as LOGGING_API_CHANNELS (its validators need
  // @brainstrike/logging, which a preload cannot require).
  logging: {
    durableRecord: 'logging:durable-record',
    getBufferedLogs: 'logging:get-buffered-logs',
    getPreferences: 'logging:get-preferences',
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
  modelCatalog: {
    initializeProviderDefaults: 'model-catalog:initialize-provider-defaults',
    read: 'model-catalog:read',
    setModels: 'model-catalog:set-models',
    setProvider: 'model-catalog:set-provider',
  },
  preferences: {
    settingsClearAll: 'settings:clearAll',
  },
  runtime: {
    noteReloadIntent: 'app:lifecycle:note-reload-intent',
    requestReload: 'app:lifecycle:request-reload',
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
  storage: {
    clear: 'storage:clear',
    clearAllForE2e: 'storage:clearAllForE2e',
    getAllKeys: 'storage:getAllKeys',
    getItem: 'storage:getItem',
    removeItem: 'storage:removeItem',
    seedMainOwnedForE2e: 'storage:seedMainOwnedForE2e',
    setItem: 'storage:setItem',
  },
  threadGroups: { readRoots: 'thread-groups:read-roots', request: 'thread-groups:request' },
  userPersonas: {
    list: 'user-personas:list',
  },
  viewFilterPresets: { request: 'view-filter-presets:request' },
  // Native focus of the host BrowserWindow (BST-1864). `isFocused` is the ONLY
  // invoke: the value for the asking window, served on request so a renderer
  // that (re)loads after a focus change still reads the truth. `changed` is a
  // main→renderer push (`focus`/`blur` of that window).
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
    // the mount bookkeeping all stay on one path.
    openFolderPicker: 'workspace:open-folder-picker',
    // One-way main→renderer push: argv / open-file / second-instance / File ▸
    // Open Recent ask the FOCUSED window to CONNECT a path. A request, never a
    // grant — the renderer routes it through `fs:addRootByPath`, whose gates
    // decide.
    openPath: 'workspace:open-path',
    // The ONLY method in this domain that runs renderer→main. Invoked by
    // `WorkspaceConnectHost` the instant it subscribes to `openPath` above —
    // main gates delivery on BOTH the window having finished loading AND this
    // ping, because `did-finish-load`/`did-stop-loading` only prove the
    // DOCUMENT loaded, not that React has mounted the host and its
    // push listener exists yet.
    openPathReady: 'workspace:open-path-ready',
  },
} as const;
