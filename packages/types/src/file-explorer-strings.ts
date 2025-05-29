export const FileExplorerStrings = {
  // Component Titles
  title: 'Context Explorer',

  // Button Labels
  selectRoot: 'Select Root',
  refresh: 'Refresh',

  // Toast Messages
  success: {
    title: 'Success',
    refreshSuccess: 'File tree refreshed successfully.',
    rootDirectorySelected: 'Successfully set the root directory.',
    reportCopied: 'The report has been copied to your clipboard.',
  },

  error: {
    title: 'Error',
    browserCompatibility: 'Browser Compatibility Error',
    noRootDirectory: 'No root directory selected.',
    refreshFailed: 'Failed to refresh file tree',
    rootDirectoryFailed: 'Failed to select root directory',
    reportGenerationFailed: 'Failed to generate report',
    reportCopyFailed: 'Failed to generate or copy report',
    fileLoadFailed: 'Failed to load file',
    selectionLimitExceeded: 'Cannot select more files. Maximum selection limit reached.',
  },

  loading: {
    title: 'Please Wait',
    rootDirectory: 'Loading root directory...',
    selectingRoot: 'Selecting Root Directory...',
    generatingReport: 'Generating Report...',
    refreshing: 'Refreshing file tree...',
    cancelling: 'Cancelling...',
  },

  prompts: {
    chooseDirectory: 'Please choose a directory from the file picker',
    waitForReport: 'Please wait while we prepare your report',
    waitForLoading: 'Please wait while we load the file tree',
    reportGenerating: 'Report is currently being generated...',
  },

  // File Names
  fileNames: {
    report: 'report.txt',
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
