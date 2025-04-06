const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

// Find all test files
const testFiles = execSync('find src -type f -name "*.test.ts*"', {
	encoding: "utf8",
})
	.split("\n")
	.filter(Boolean);

// Process each file
testFiles.forEach((filePath) => {
	if (!fs.existsSync(filePath)) {
		console.log(`File not found: ${filePath}`);
		return;
	}

	let content = fs.readFileSync(filePath, "utf8");
	let updated = false;

	// Fix hook imports with double hyphens
	if (content.includes("use--")) {
		content = content.replace(/use--/g, "use-");
		updated = true;
	}

	// Fix store imports
	if (content.includes("useFileExplorerStore")) {
		content = content.replace(
			/(['"])(@\/stores\/|\.\.\/|\.\.\/\.\.\/stores\/)useFileExplorerStore(['"])/g,
			"$1$2use-file-explorer-store$3",
		);
		updated = true;
	}

	// Fix hook imports
	if (content.includes("@/hooks/use")) {
		content = content.replace(
			/(['"])@\/hooks\/use([A-Z][a-zA-Z]*)(['"])/g,
			"$1@/hooks/use-$2$3",
		);
		updated = true;
	}

	// Fix local hook imports
	if (content.includes("../use")) {
		content = content.replace(
			/(['"])\.\.\/use([A-Z][a-zA-Z]*)(['"])/g,
			"$1../use-$2$3",
		);
		updated = true;
	}

	// Fix factory imports
	if (content.includes("fileNode")) {
		content = content.replace(
			/(['"])(\.\.\/|\.\.\/\.\.\/|\.\.\/\.\.\/\.\.\/test\/factories\/)fileNode(['"])/g,
			"$1$2file-node$3",
		);
		updated = true;
	}

	// Fix component imports
	if (content.includes("ErrorBoundary")) {
		content = content.replace(
			/(['"])\.\.\/ErrorBoundary(['"])/g,
			"$1../error-boundary$2",
		);
		updated = true;
	}

	// Fix Settings component imports
	if (content.includes("ThemeSettings")) {
		content = content.replace(
			/(['"])@\/components\/custom\/Settings\/ThemeSettings(['"])/g,
			"$1@/components/custom/Settings/theme-settings$2",
		);
		updated = true;
	}

	// Fix ClientFileExplorer imports
	if (content.includes("ClientFileExplorer")) {
		content = content.replace(
			/(['"])@\/components\/custom\/ClientFileExplorer(['"])/g,
			"$1@/components/custom/client-file-explorer$2",
		);
		updated = true;
	}

	if (updated) {
		fs.writeFileSync(filePath, content);
		console.log(`Updated imports in: ${filePath}`);
	}
});

console.log("Test mock fixes completed!");
