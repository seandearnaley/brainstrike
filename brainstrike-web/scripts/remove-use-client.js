#!/usr/bin/env node

/**
 * This script removes 'use client' directives from all TypeScript and JavaScript files
 * in the src directory, as they're not needed in a Vite client-side application.
 */

const fs = require("node:fs");
const path = require("node:path");
const glob = require("glob");

function removeUseClientDirectives() {
	try {
		// Find all TypeScript and JavaScript files in the src directory
		const files = glob.sync("src/**/*.{ts,tsx,js,jsx}", {
			ignore: ["**/node_modules/**"],
		});

		console.log(`Found ${files.length} files to process`);
		let modifiedCount = 0;

		for (const file of files) {
			// Read the file content
			const content = fs.readFileSync(file, "utf8");

			// Check if the file contains 'use client' directive
			if (
				content.includes("'use client'") ||
				content.includes('"use client"')
			) {
				// Remove the directive and any empty lines that might result
				const newContent = content
					.replace(/(['"])use client\1;?\s*(\r?\n)+/g, "")
					.replace(/(['"])use client\1;?/g, "");

				// Write the modified content back to the file
				fs.writeFileSync(file, newContent, "utf8");
				modifiedCount++;
				console.log(`Removed 'use client' directive from ${file}`);
			}
		}

		console.log(
			`\nRemoved 'use client' directives from ${modifiedCount} files`,
		);
	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

removeUseClientDirectives();
