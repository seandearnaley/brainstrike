import { defineConfig, devices } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";
import { DEFAULT_PORT, getBaseUrl } from "./src/config/server";

// Default to port 3000, but this will be overridden by global setup if needed
const baseURL = process.env.BASE_URL || getBaseUrl(DEFAULT_PORT);

const config: PlaywrightTestConfig = {
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI
		? [
				["html", { open: "never" }],
				["json", { outputFile: "test-results/e2e-results.json" }],
				["list"],
			]
		: [
				["html"],
				["json", { outputFile: "test-results/e2e-results.json" }],
				["list"],
			],
	use: {
		baseURL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	globalSetup: "./e2e/global-setup.ts",
	// Only start a web server if we're in CI or no existing server was found
	webServer:
		process.env.CI || !process.env.BASE_URL
			? {
					command: process.env.CI
						? "npm run build && npm run serve-static"
						: "npm run dev",
					url: baseURL,
					reuseExistingServer: !process.env.CI,
					timeout: process.env.CI ? 120000 : 60000,
					stderr: "pipe",
					stdout: "pipe",
				}
			: undefined,
};

export default config;
