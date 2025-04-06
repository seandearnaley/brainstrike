const fs = require("node:fs");
const path = require("node:path");

// Files to process
const filesToFix = [
	"src/stores/__tests__/use-file-explorer-store.expand-collapse.test.ts",
	"src/stores/__tests__/use-file-explorer-store.folder-state-management.test.ts",
	"src/stores/__tests__/use-file-explorer-store.test.ts",
];

// Process each file
filesToFix.forEach((filePath) => {
	if (!fs.existsSync(filePath)) {
		console.log(`File not found: ${filePath}`);
		return;
	}

	const content = fs.readFileSync(filePath, "utf8");

	// Replace incorrect store import
	let updatedContent = content.replace(
		/from ['"]\.\.\/useFileExplorerStore['"]/g,
		"from '../use-file-explorer-store'",
	);

	// Replace any other imports that might be using the old naming convention
	updatedContent = updatedContent.replace(
		/from ['"]@\/stores\/useFileExplorerStore['"]/g,
		"from '@/stores/use-file-explorer-store'",
	);

	if (content !== updatedContent) {
		fs.writeFileSync(filePath, updatedContent);
		console.log(`Updated imports in: ${filePath}`);
	} else {
		console.log(`No changes needed in: ${filePath}`);
	}
});

console.log("Store test import fixes completed!");
