#!/usr/bin/env node

/**
 * File naming convention migration script
 *
 * This script helps rename files to match our naming conventions:
 * - PascalCase → kebab-case for component files
 * - camelCase → kebab-case for utility files
 * - handleFixes for hook naming (useHook → use-hook)
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

// Configuration
const CONFIG = {
	// Files to transform
	transforms: {
		components: {
			dirs: ["src/components/custom"],
			transform: (filename) => {
				// PascalCase to kebab-case
				return filename
					.replace(/([a-z0-9])([A-Z])/g, "$1-$2") // Convert camelCase to kebab-case
					.toLowerCase();
			},
		},
		hooks: {
			dirs: ["src/hooks"],
			transform: (filename) => {
				// useHook.ts to use-hook.ts
				const prefix = filename.startsWith("use") ? "use-" : "";
				const nameWithoutPrefix = filename.startsWith("use")
					? filename.slice(3, 4).toLowerCase() + filename.slice(4)
					: filename;

				return (
					prefix +
					nameWithoutPrefix.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
				);
			},
		},
		utils: {
			dirs: ["src/utils", "src/lib", "src/constants"],
			transform: (filename) => {
				// camelCase to kebab-case
				return filename.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
			},
		},
	},

	// Directories to exclude
	excludeDirs: ["node_modules", ".next", ".git", "coverage", "dist", "build"],

	// Files to exclude from renaming
	excludeFiles: [
		".DS_Store",
		"page.tsx",
		"layout.tsx",
		"loading.tsx",
		"error.tsx",
		"not-found.tsx",
		"route.ts",
		"middleware.ts",
	],
};

// Helper to check if a file should be excluded
function shouldExclude(filename) {
	return CONFIG.excludeFiles.some(
		(pattern) => filename === pattern || filename.endsWith(`.${pattern}`),
	);
}

// Get all files in directory recursively
function getAllFiles(dir, fileList = []) {
	if (CONFIG.excludeDirs.some((excluded) => dir.includes(excluded))) {
		return fileList;
	}

	const files = fs.readdirSync(dir);

	files.forEach((file) => {
		const filePath = path.join(dir, file);

		if (fs.statSync(filePath).isDirectory()) {
			getAllFiles(filePath, fileList);
		} else if (!shouldExclude(file)) {
			fileList.push(filePath);
		}
	});

	return fileList;
}

// Get the appropriate transform for a file
function getTransform(file) {
	for (const [key, config] of Object.entries(CONFIG.transforms)) {
		for (const dir of config.dirs) {
			if (file.startsWith(dir)) {
				return config.transform;
			}
		}
	}
	return null;
}

// Rename a file and update imports in the codebase
function renameFile(oldPath, newPath) {
	if (oldPath === newPath) {
		return;
	}

	// Extract file names for logging
	const oldFile = path.basename(oldPath);
	const newFile = path.basename(newPath);

	console.log(`Renaming: ${oldPath} → ${newPath}`);

	// Ensure the target directory exists
	const targetDir = path.dirname(newPath);
	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true });
	}

	// Use git mv for tracked files, fs.renameSync for others
	try {
		const isTracked = execSync(`git ls-files --error-unmatch "${oldPath}"`, {
			stdio: "pipe",
			encoding: "utf8",
		});

		// If we get here, the file is tracked by git
		execSync(`git mv "${oldPath}" "${newPath}"`, { stdio: "inherit" });
	} catch (e) {
		// File isn't tracked by git, use normal rename
		fs.renameSync(oldPath, newPath);
	}

	// Update imports in the codebase
	// This is simplified and might need more complex handling for various import styles
	try {
		const oldImport = oldFile.replace(/\.[^/.]+$/, ""); // Remove extension
		const newImport = newFile.replace(/\.[^/.]+$/, ""); // Remove extension

		// Skip updating imports if only case changed
		if (oldImport.toLowerCase() === newImport.toLowerCase()) {
			return;
		}

		// Find files with potential import statements
		const files = getAllFiles("src");

		for (const file of files) {
			// Skip binary files and the renamed file itself
			if (file === oldPath || file === newPath) continue;

			const content = fs.readFileSync(file, "utf8");

			// Look for import statements
			// This is a simplistic approach and might need enhancement
			// for more complex import patterns
			const newContent = content.replace(
				new RegExp(`from ['"](.*?/)${oldImport}['"]`, "g"),
				`from "$1${newImport}"`,
			);

			if (content !== newContent) {
				console.log(`  • Updated imports in ${file}`);
				fs.writeFileSync(file, newContent, "utf8");
			}
		}
	} catch (error) {
		console.error(`Error updating imports: ${error.message}`);
	}
}

// Main function
function main() {
	console.log("🔄 Starting file naming convention migration...");

	// Process all files in directories
	for (const [key, config] of Object.entries(CONFIG.transforms)) {
		for (const dir of config.dirs) {
			if (!fs.existsSync(dir)) {
				console.log(`Directory ${dir} does not exist, skipping...`);
				continue;
			}

			const files = getAllFiles(dir);

			for (const filePath of files) {
				const dirname = path.dirname(filePath);
				const filename = path.basename(filePath);
				const extension = path.extname(filename);
				const nameWithoutExt = filename.slice(0, -extension.length);

				// Get the appropriate transform
				const transform = getTransform(filePath);
				if (!transform) continue;

				// Transform the filename
				const transformedName = transform(nameWithoutExt) + extension;

				// Skip if the name is already correct
				if (transformedName === filename) continue;

				// Rename the file
				const newPath = path.join(dirname, transformedName);
				renameFile(filePath, newPath);
			}
		}
	}

	console.log("✅ Migration complete!");
	console.log("");
	console.log(
		"⚠️ Note: While this script attempts to update imports, you may need to manually fix some imports.",
	);
	console.log(
		"Run your tests and build to verify everything is working correctly.",
	);
}

// Run script if executed directly, otherwise export functions
if (require.main === module) {
	main();
} else {
	module.exports = {
		renameFile,
		getTransform,
	};
}
