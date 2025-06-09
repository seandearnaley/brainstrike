import path from "node:path";
import process from "node:process";
import { devices } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";
import { getBaseUrl, DEFAULT_PORT } from "@brainstrike/server-config";

// Environment variable names
const baseUrlEnv = 'BASE_URL';
const ciEnv = 'CI';

// Default to the server config port (8080) since that's where our dev server runs
const baseURL = process.env[baseUrlEnv] || getBaseUrl(DEFAULT_PORT);
const serverURL = getBaseUrl(DEFAULT_PORT);

// Make sure to log important info
console.log(`Playwright config: Using baseURL=${baseURL}`);
console.log(`Current working directory: ${process.cwd()}`);
console.log(`Test directory: ${path.resolve("./e2e")}`);

const config: PlaywrightTestConfig = {
	testDir: "./e2e",
	fullyParallel: false, // Run tests sequentially for easier debugging
	forbidOnly: !!process.env[ciEnv],
	retries: process.env[ciEnv] ? 2 : 0,
	workers: process.env[ciEnv] ? 1 : 1, // Use single worker in CI, single worker in local for consistency
	timeout: 30000, // 30 seconds per test
	reporter: [["html", { open: "never" }], ["list"]],
        use: {
                baseURL,
                headless: true,
                // headless: !!process.env[ciEnv], // Run headless in CI, non-headless in local dev
                trace: process.env[ciEnv] ? "on" : "on-first-retry",
                screenshot: "only-on-failure",
                video: "on-first-retry",
                testIdAttribute: "data-testid",
        },
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	globalSetup: "./e2e/global-setup.ts",
	// Web server configuration - handles both CI and local development
        webServer: {
                command: 'npm run dev',
                url: serverURL,
                reuseExistingServer: !process.env[ciEnv],
                timeout: 60000,
                stderr: "pipe",
                stdout: "pipe",
        },
};

export default config;
