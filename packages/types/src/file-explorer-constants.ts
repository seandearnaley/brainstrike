// Text file extensions that should be previewable
export const TEXT_FILE_EXTENSIONS = [
  // Programming languages
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.php',
  '.phtml',
  '.py',
  '.rb',
  '.java',
  '.cs',
  '.go',
  '.rust',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.mdx',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  // Config files
  '.env',
  '.gitignore',
  '.dockerignore',
  '.conf',
  '.config',
  '.ini',
  '.cfg',
  // Documentation
  '.txt',
  '.log',
  '.csv',
];

// Binary file extensions that should not be previewed
export const BINARY_FILE_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.class',
  '.jar',
  '.war',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.svg',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.wma',
  '.ogg',
  '.wav',
  '.flac',
];

export const IGNORED_PATHS: string[] = [
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.DS_Store',
];

// Minimum and Maximum allowed value for Folder Summary Threshold setting
export const MIN_FOLDER_SUMMARY_THRESHOLD = 0;
export const MAX_FOLDER_SUMMARY_THRESHOLD = 1000;

// Minimum and Maximum allowed value for Max Selection Count setting
export const MIN_MAX_SELECTION_COUNT = 1;
export const MAX_SELECTION_COUNT = 10_000;

// Minimum and Maximum allowed value for Token Budget setting
export const MIN_TOKEN_BUDGET = 1;
export const MAX_TOKEN_BUDGET = 100_000_000;
