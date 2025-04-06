// Text file extensions that should be previewable
export const TEXT_FILE_EXTENSIONS = [
	// Programming languages
	".ts",
	".tsx",
	".js",
	".jsx",
	".php",
	".phtml",
	".py",
	".rb",
	".java",
	".cs",
	".go",
	".rust",
	".c",
	".cpp",
	".h",
	".hpp",
	".css",
	".scss",
	".less",
	".html",
	".htm",
	".xml",
	".json",
	".yaml",
	".yml",
	".md",
	".mdx",
	".sql",
	".sh",
	".bash",
	".zsh",
	// Config files
	".env",
	".gitignore",
	".dockerignore",
	".conf",
	".config",
	".ini",
	".cfg",
	// Documentation
	".txt",
	".log",
	".csv",
];

// Binary file extensions that should not be previewed
export const BINARY_FILE_EXTENSIONS = [
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".zip",
	".tar",
	".gz",
	".7z",
	".rar",
	".exe",
	".dll",
	".so",
	".dylib",
	".class",
	".jar",
	".war",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".svg",
	".mp3",
	".mp4",
	".avi",
	".mov",
	".wmv",
	".wma",
	".ogg",
	".wav",
	".flac",
];

export const DEFAULT_INCLUDE_FILTERS = [
	"*.tsx",
	"*.ts",
	"*.js",
	"*.jsx",
	"*.json",
];

export const DEFAULT_EXCLUDE_FILTERS = ["node_modules"];

// export const IGNORED_PATHS = ['.git', '.DS_Store'];

export const IGNORED_PATHS = [];
