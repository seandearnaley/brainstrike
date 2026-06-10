export const FileExplorerStrings = {
  // Component Titles
  title: 'Context Explorer',

  // Button Labels
  selectRoot: 'Select Root',
  addFolder: 'Add Folder',
  refresh: 'Refresh',

  // Toast Messages
  success: {
    title: 'Success',
    refreshSuccess: 'File tree refreshed successfully.',
    rootDirectorySelected: 'Successfully set the root directory.',
    contextCopied: 'The context has been copied to your clipboard.',
    contextDownloaded: 'The context has been downloaded.',
    // Deprecated report-named keys intentionally reuse context wording for UX consistency during migration.
    /** @deprecated Use `contextCopied`. */
    reportCopied: 'The context has been copied to your clipboard.',
    /** @deprecated Use `contextDownloaded`. */
    reportDownloaded: 'The context has been downloaded.',
  },

  error: {
    title: 'Error',
    browserCompatibility: 'Browser Compatibility Error',
    noRootDirectory: 'No root directory selected.',
    refreshFailed: 'Failed to refresh file tree',
    rootDirectoryFailed: 'Failed to select root directory',
    contextGenerationFailed: 'Failed to generate context',
    contextCopyFailed: 'Failed to generate or copy context',
    /** @deprecated Use `contextGenerationFailed`. */
    reportGenerationFailed: 'Failed to generate context',
    /** @deprecated Use `contextCopyFailed`. */
    reportCopyFailed: 'Failed to generate or copy context',
    fileLoadFailed: 'Failed to load file',
    selectionLimitExceeded: 'Cannot select more files. Maximum selection limit reached.',
  },

  loading: {
    title: 'Please Wait',
    rootDirectory: 'Loading root directory...',
    selectingRoot: 'Selecting Root Directory...',
    generatingContext: 'Generating Context...',
    /** @deprecated Use `generatingContext`. */
    generatingReport: 'Generating Context...',
    refreshing: 'Refreshing file tree...',
  },

  prompts: {
    chooseDirectory: 'Please choose a directory from the file picker',
    waitForContext: 'Please wait while we prepare your context',
    /** @deprecated Use `waitForContext`. */
    waitForReport: 'Please wait while we prepare your context',
    waitForLoading: 'Please wait while we load the file tree',
    /** @deprecated Use `waitForContext`. */
    reportGenerating: 'Context is currently being generated...',
  },

  inlineFixture: {
    settingLabel: 'Enable Inline Fixture',
    settingDescription:
      'Loads a scripted mock project so you can test without accessing the local filesystem.',
    enableSuccess: 'Inline fixture enabled.',
    disableSuccess: 'Inline fixture disabled.',
    enableError: 'Unable to enable the inline fixture.',
    disableError: 'Unable to disable the inline fixture.',
    noAccessFallbackTitle: 'Demo Mode Enabled',
    noAccessFallbackDescription:
      'Local directory picker is not available in this browser. Using built-in mock project instead.',
  },

  // File Names
  fileNames: {
    context: 'context.txt',
    /** @deprecated Use `context`. */
    report: 'context.txt',
  },

  // Status Messages
  status: {
    noFilesFound: 'No matching files found',
    noFilesWithFilters: 'No files match the current filters',
    noRootSelected: 'Please select a root directory to begin',
    currentDirectory: 'Current Directory:',
    activeFilters: 'Active Filters:',
    includeFilters: 'Include:',
    excludeFilters: 'Exclude:',
    regexMode: 'Regex Mode:',
    on: 'On',
    off: 'Off',
    quickFilter: 'Quick Filter:',
  },
} as const;
