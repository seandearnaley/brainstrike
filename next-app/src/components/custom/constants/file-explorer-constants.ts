export const FileExplorerStrings = {
  // Component Titles
  TITLE: 'Context Explorer',

  // Button Labels
  SELECT_ROOT: 'Select Root',
  REFRESH: 'Refresh',

  // Toast Messages
  SUCCESS: {
    TITLE: 'Success',
    REFRESH_SUCCESS: 'File tree refreshed successfully.',
    ROOT_DIRECTORY_SELECTED: 'Successfully set the root directory.',
    REPORT_COPIED: 'The report has been copied to your clipboard.',
  },

  ERROR: {
    TITLE: 'Error',
    BROWSER_COMPATIBILITY: 'Browser Compatibility Error',
    NO_ROOT_DIRECTORY: 'No root directory selected.',
    REFRESH_FAILED: 'Failed to refresh file tree',
    ROOT_DIRECTORY_FAILED: 'Failed to select root directory',
    REPORT_GENERATION_FAILED: 'Failed to generate report',
    REPORT_COPY_FAILED: 'Failed to generate or copy report',
    FILE_LOAD_FAILED: 'Failed to load file',
    SELECTION_LIMIT_EXCEEDED: 'Cannot select more files. Maximum selection limit reached.',
  },

  LOADING: {
    TITLE: 'Please Wait',
    ROOT_DIRECTORY: 'Loading root directory...',
    SELECTING_ROOT: 'Selecting Root Directory...',
    GENERATING_REPORT: 'Generating Report...',
    REFRESHING: 'Refreshing file tree...',
  },

  PROMPTS: {
    CHOOSE_DIRECTORY: 'Please choose a directory from the file picker',
    WAIT_FOR_REPORT: 'Please wait while we prepare your report',
    WAIT_FOR_LOADING: 'Please wait while we load the file tree',
    REPORT_GENERATING: 'Report is currently being generated...',
  },

  // File Names
  FILE_NAMES: {
    REPORT: 'report.txt',
  },

  // Status Messages
  STATUS: {
    NO_FILES_FOUND: 'No matching files found',
    NO_FILES_WITH_FILTERS: 'No files match the current filters',
    NO_ROOT_SELECTED: 'Please select a root directory to begin',
    CURRENT_DIRECTORY: 'Current Directory:',
    ACTIVE_FILTERS: 'Active Filters:',
    INCLUDE_FILTERS: 'Include:',
    EXCLUDE_FILTERS: 'Exclude:',
    REGEX_MODE: 'Regex Mode:',
    ON: 'On',
    OFF: 'Off',
    QUICK_FILTER: 'Quick Filter:',
  },
} as const;
