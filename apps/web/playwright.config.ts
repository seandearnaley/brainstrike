import { defineConfig } from '@playwright/test';
import { getBaseUrl, DEFAULT_PORT } from '@brainstrike/server-config';

// Environment variable names
const baseUrlEnv = 'BASE_URL';

// Environment detection
const isCodex = !!process.env['CODEX_ENV']; // Custom env var for Codex
const isGitHubActions = !!process.env['GITHUB_ACTIONS']; // GitHub Actions standard env var
const isCI = !!process.env['CI'] || isCodex || isGitHubActions; // General CI detection

// Worker configuration based on environment
const getWorkerCount = () => {
	if (isCodex) return 1; // Codex has very limited resources
	if (isGitHubActions) return 2; // GitHub Actions free runners have 2 cores
	if (isCI) return 1; // Other CI environments, be conservative
	return 2; // Local development default
};

// Timeout configuration based on environment
const getGlobalTimeout = () => {
	if (isCodex) return 10 * 60 * 1000; // 10 minutes for Codex (15 min limit)
	if (isCI) return 15 * 60 * 1000; // 15 minutes for other CI
	return 0; // No global timeout for local development
};

// Default to the server config port (8080) since that's where our dev server runs
const baseURL = process.env[baseUrlEnv] || getBaseUrl(DEFAULT_PORT);
const serverURL = getBaseUrl(DEFAULT_PORT);

// Log environment detection for debugging
console.log(`Web Playwright config:`);
console.log(`  Codex: ${isCodex}`);
console.log(`  GitHub Actions: ${isGitHubActions}`);
console.log(`  General CI: ${isCI}`);
console.log(`  Workers: ${getWorkerCount()}`);
console.log(`  Global timeout: ${getGlobalTimeout() / 1000}s`);
console.log(`  Base URL: ${baseURL}`);

export default defineConfig({
	testDir: './e2e',
	
	// Global timeout based on environment
	globalTimeout: getGlobalTimeout(),
	
	// Per-test timeout
	timeout: 60_000,
	
	// Parallel execution based on environment
	fullyParallel: !isCodex, // Codex should avoid parallel execution
	
	// Fail the build on CI if you accidentally left test.only in the source code
	forbidOnly: isCI,
	
	// Retry strategy based on environment
	retries: isCI ? (isCodex ? 1 : 2) : 0, // Fewer retries for Codex to save time
	
	// Worker count based on environment capabilities
	workers: getWorkerCount(),
	
	// Reporter configuration
	reporter: isCI 
		? [['blob', { outputDir: 'blob-report' }], ['list']]
		: [['html', { open: 'never' }], ['list']],
	
	use: {
		baseURL,
		
		// Headless mode for CI environments
		headless: isCI,
		
		// CI-optimized launch options for resource-constrained environments
		...(isCI && {
			launchOptions: {
				args: [
					'--no-sandbox',
					'--disable-dev-shm-usage', // /dev/shm is tiny in CI
					'--disable-setuid-sandbox',
					'--disable-gpu',
					...(isCodex ? ['--disable-web-security'] : []), // Extra flags for Codex
				]
			}
		}),
		
		// Tracing and media capture
		trace: isCI ? 'on-first-retry' : 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		testIdAttribute: 'data-testid',
	},
	
	// Single project for Chromium only
	projects: [
		{
			name: 'chromium',
			use: {
				// Use Chromium with CI-optimized settings
				channel: 'chromium',
			},
		},
	],
	
	globalSetup: './e2e/global-setup.ts',
	
	// Web server configuration - optimized for CI
	webServer: {
		command: isCI ? 'pnpm run start' : 'pnpm run dev',
		url: serverURL,
		reuseExistingServer: !isCI,
		timeout: 60000, // 1 minute timeout for server startup
		stderr: 'pipe',
		stdout: 'pipe',
	},
});
