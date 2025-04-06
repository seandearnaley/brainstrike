#!/usr/bin/env node

/**
 * File and folder naming convention validation script
 *
 * This script enforces our naming conventions:
 * - Component files: kebab-case.tsx
 * - Hook files: use-*.ts
 * - Route folders: kebab-case
 * - Utility files: kebab-case.ts
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

// Configuration
const CONFIG = {
	// File patterns to validate
	patterns: {
		components: {
			dirs: ["src/components/ui", "src/components/custom"],
			pattern: /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(tsx|ts)$/,
			message: "Component files must use kebab-case: e.g., file-explorer.tsx",
		},
		hooks: {
			dirs: ["src/hooks"],
			pattern: /^use-[a-z][a-z0-9]*(-[a-z0-9]+)*\.(ts|tsx)$/,
			message:
				"Hook files must use kebab-case and start with use-: e.g., use-auth.ts",
		},
		routes: {
			dirs: ["src/app"],
			pattern:
				/^([a-z][a-z0-9]*(-[a-z0-9]+)*|page|layout|loading|error|route|not-found|global)(\.[a-z]+)?\.(tsx|ts)$/,
			message: "Route files must use kebab-case: e.g., user-profile.tsx",
		},
		utils: {
			dirs: ["src/utils", "src/lib"],
			pattern: /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(ts|tsx|js)$/,
			message: "Utility files must use kebab-case: e.g., string-utils.ts",
		},
		constants: {
			dirs: ["src/constants"],
			pattern: /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(ts|tsx|js)$/,
			message: "Constant files must use kebab-case: e.g., api-constants.ts",
		},
	},

	// Folder patterns to validate
	folderPatterns: {
		components: {
			dirs: ["src/components/custom"],
			pattern: /^([A-Z][a-zA-Z0-9]*|[a-z][a-z0-9]*(-[a-z0-9]+)*)$/,
			message:
				"Component folders must use kebab-case or PascalCase: e.g., user-profile/ or UserProfile/",
		},
		routes: {
			dirs: ["src/app"],
			pattern: /^([a-z][a-z0-9]*(-[a-z0-9]+)*|\(.*\)|\[.*\]|__tests__)$/,
			message:
				"Route folders must use kebab-case: e.g., user-profile/ (except for special Next.js patterns like (group) or [slug])",
		},
	},

	// Files/folders to ignore
	ignorePatterns: [
		".DS_Store",
		"node_modules",
		".next",
		".git",
		"coverage",
		".vercel",
		"dist",
		"build",
		"__tests__",
	],

	// Special exceptions like Next.js special files
	exceptions: [
		"page.tsx",
		"layout.tsx",
		"loading.tsx",
		"error.tsx",
		"not-found.tsx",
		"route.ts",
		"global.css",
		"middleware.ts",
		"test.tsx",
		".test.tsx",
		".test.ts",
	],
};

// Utils
function isException(filename) {
	for (const exception of CONFIG.exceptions) {
		if (filename.endsWith(exception)) {
			return true;
		}
	}
	const nameWithoutExt = filename.split(".")[0];
	if (nameWithoutExt.startsWith("[") && nameWithoutExt.endsWith("]")) {
		return true; // Next.js dynamic route parameter
	}
	return false;
}

function shouldIgnore(path) {
	for (const pattern of CONFIG.ignorePatterns) {
		if (path.includes(pattern)) {
			return true;
		}
	}
	return false;
}

// Get all files changed in the current branch
function getChangedFiles() {
	try {
		// Get all tracked files in the repo
		const gitFiles = execSync("git ls-files", { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter((file) => file.startsWith("src/"));

		// Also get untracked files
		const untrackedFiles = execSync(
			"git ls-files --others --exclude-standard",
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean)
			.filter((file) => file.startsWith("src/"));

		return [...gitFiles, ...untrackedFiles];
	} catch (error) {
		console.error("Error getting git files:", error);
		return [];
	}
}

// Check if a file matches the pattern
function validateFile(file, patternConfig) {
	const basename = path.basename(file);
	const dirname = path.dirname(file);

	// Skip exceptions
	if (isException(basename) || shouldIgnore(file)) {
		return true;
	}

	// Check if the directory is one we should validate
	let shouldValidate = false;
	for (const dir of patternConfig.dirs) {
		if (file.startsWith(dir)) {
			shouldValidate = true;
			break;
		}
	}

	// Skip if not in a directory we care about
	if (!shouldValidate) {
		return true;
	}

	// Check against the pattern
	if (!patternConfig.pattern.test(basename)) {
		console.error(
			`Error: ${file} does not follow the naming convention. ${patternConfig.message}`,
		);
		return false;
	}

	return true;
}

// Check if a folder matches the pattern
function validateFolder(folder, patternConfig) {
	const basename = path.basename(folder);

	// Skip if we should ignore
	if (shouldIgnore(folder)) {
		return true;
	}

	// Check if the directory is one we should validate
	let shouldValidate = false;
	for (const dir of patternConfig.dirs) {
		if (folder.startsWith(dir)) {
			shouldValidate = true;
			break;
		}
	}

	// Skip if not in a directory we care about
	if (!shouldValidate) {
		return true;
	}

	// Check against the pattern
	if (!patternConfig.pattern.test(basename)) {
		console.error(
			`Error: Folder ${folder} does not follow the naming convention. ${patternConfig.message}`,
		);
		return false;
	}

	return true;
}

// Main function
function main() {
	console.log("🔍 Validating file and folder naming conventions...");

	const files = getChangedFiles();
	let hasErrors = false;

	// Check files
	for (const file of files) {
		// Skip directories
		if (!file.includes(".")) continue;

		let isValid = true;

		// Check file against all patterns
		for (const [key, patternConfig] of Object.entries(CONFIG.patterns)) {
			isValid = validateFile(file, patternConfig) && isValid;
		}

		if (!isValid) {
			hasErrors = true;
		}
	}

	// Get directories
	const directories = new Set();
	for (const file of files) {
		const dir = path.dirname(file);
		if (!shouldIgnore(dir)) {
			directories.add(dir);
		}
	}

	// Check directories
	for (const dir of directories) {
		let isValid = true;

		// Check directory against all patterns
		for (const [key, patternConfig] of Object.entries(CONFIG.folderPatterns)) {
			isValid = validateFolder(dir, patternConfig) && isValid;
		}

		if (!isValid) {
			hasErrors = true;
		}
	}

	if (hasErrors) {
		console.error("❌ File naming convention validation failed!");
		process.exit(1);
	} else {
		console.log("✅ File naming convention validation passed!");
	}
}

main();
