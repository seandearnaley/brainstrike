export const FileExplorerStrings = {
  // Button Labels
  // Multi-root: a single consolidated action. The workspace can hold many roots,
  // so the toolbar always offers "Add Folder to Workspace" (no Select Root / Add
  // Folder split, no per-root focus implied).
  addFolderToWorkspace: 'Add Folder to Workspace',

  error: {
    browserCompatibility: 'Browser Compatibility Error',
    contextCopyFailed: 'Failed to generate or copy context',
    contextGenerationFailed: 'Failed to generate context',
    fileLoadFailed: 'Failed to load file',
    noRootDirectory: 'No folder selected.',
    refreshFailed: 'Failed to refresh file tree',
    /** @deprecated Use `contextCopyFailed`. */
    reportCopyFailed: 'Failed to generate or copy context',
    /** @deprecated Use `contextGenerationFailed`. */
    reportGenerationFailed: 'Failed to generate context',
    rootDirectoryFailed: 'Failed to add folder',
    selectionLimitExceeded: 'Cannot select more files. Maximum selection limit reached.',
    title: 'Error',
  },

  // File Names
  fileNames: {
    context: 'context.txt',
    /** @deprecated Use `context`. */
    report: 'context.txt',
  },

  inlineFixture: {
    disableError: 'Unable to disable the inline fixture.',
    disableSuccess: 'Inline fixture disabled.',
    enableError: 'Unable to enable the inline fixture.',
    enableSuccess: 'Inline fixture enabled.',
    noAccessFallbackDescription:
      'Local directory picker is not available in this browser. Using built-in mock project instead.',
    noAccessFallbackTitle: 'Demo Mode Enabled',
    settingDescription:
      'Loads a scripted mock project so you can test without accessing the local filesystem.',
    settingLabel: 'Enable Inline Fixture',
  },

  loading: {
    generatingContext: 'Generating Context...',
    /** @deprecated Use `generatingContext`. */
    generatingReport: 'Generating Context...',
    refreshing: 'Refreshing file tree...',
    rootDirectory: 'Loading folder...',
    selectingRoot: 'Adding folder...',
    title: 'Please Wait',
  },

  prompts: {
    chooseDirectory: 'Please choose a folder from the file picker',
    /** @deprecated Use `waitForContext`. */
    reportGenerating: 'Context is currently being generated...',
    waitForContext: 'Please wait while we prepare your context',
    waitForLoading: 'Please wait while we load the file tree',
    /** @deprecated Use `waitForContext`. */
    waitForReport: 'Please wait while we prepare your context',
  },
  refresh: 'Refresh',

  // Status Messages
  status: {
    activeFilters: 'Active Filters:',
    currentDirectory: 'Current Directory:',
    excludeFilters: 'Exclude:',
    includeFilters: 'Include:',
    noFilesFound: 'No matching files found',
    noFilesWithFilters: 'No files match the current filters',
    noRootSelected: 'Add a folder to your workspace to begin',
    off: 'Off',
    on: 'On',
    quickFilter: 'Quick Filter:',
    regexMode: 'Regex Mode:',
  },

  // Toast Messages
  success: {
    contextCopied: 'The context has been copied to your clipboard.',
    contextDownloaded: 'The context has been downloaded.',
    refreshSuccess: 'File tree refreshed successfully.',
    // Deprecated report-named keys intentionally reuse context wording for UX consistency during migration.
    /** @deprecated Use `contextCopied`. */
    reportCopied: 'The context has been copied to your clipboard.',
    /** @deprecated Use `contextDownloaded`. */
    reportDownloaded: 'The context has been downloaded.',
    rootDirectorySelected: 'Folder added to the workspace.',
    title: 'Success',
  },
  // Component Titles
  title: 'Context Explorer',
} as const;
