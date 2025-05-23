import { getBaseUrl, getPortsToCheck, DEFAULT_PORT } from "../src/config/server";

// Helper to log messages during server detection
function log(message: string, level: "info" | "error" = "info") {
	const timestamp = new Date().toISOString();
	const prefix = level === "error" ? "❌" : "✓";
	console.log(`${prefix} ${timestamp} - ${message}`);
}

// Function to check if dev server is running and get its port
async function findRunningDevServer(): Promise<number | null> {
        // First check the default development port
        try {
                log(`Checking default port ${DEFAULT_PORT} first...`);
                const response = await fetch(getBaseUrl(DEFAULT_PORT), {
                        method: "GET",
                        signal: AbortSignal.timeout(3000),
                });

                log(`Response from ${DEFAULT_PORT}: status=${response.status}`);

                const html = await response.text();
                log(`Got HTML content from port ${DEFAULT_PORT}, length=${html.length}`);

                const isVite = html.includes("vite") || html.includes("data-vite");
                const isBrainstrike = html.includes("brainstrike-web");

                log(
                        `Markers on port ${DEFAULT_PORT}: isVite=${isVite}, isBrainstrike=${isBrainstrike}`,
                );

                if (response.ok && (isVite || isBrainstrike)) {
                        log(`Found dev server running on port ${DEFAULT_PORT}`);
                        return DEFAULT_PORT;
                }
        } catch (error) {
                log(`Port ${DEFAULT_PORT} not available: ${error}`, "error");
        }

	// Then check the configured ports from server.ts
	const portsToCheck = getPortsToCheck();
	log("Starting server detection for configured ports...");

	for (const port of portsToCheck) {
		try {
			log(`Checking port ${port}...`);

			const response = await fetch(getBaseUrl(port), {
				method: "GET",
				signal: AbortSignal.timeout(3000),
			});

			log(`Response from ${port}: status=${response.status}`);

			const html = await response.text();
			log(`Got HTML content from port ${port}, length=${html.length}`);

			// Check for specific markers in your app's HTML
			const isVite = html.includes("vite") || html.includes("data-vite");
			const isBrainstrike = html.includes("brainstrike-web");

			log(
				`Markers on port ${port}: isVite=${isVite}, isBrainstrike=${isBrainstrike}`,
			);

			if (response.ok && (isVite || isBrainstrike)) {
				log(`Found dev server running on port ${port}`);
				return port;
			}
			log(`Port ${port} has a server but not our app`, "error");
		} catch (error) {
			log(`Port ${port} not available: ${error}`, "error");
		}
	}

	log("No suitable server found on any port", "error");
	return null;
}

async function globalSetup() {
	log("Starting global setup...");
	log(`CI environment: ${process.env.CI ? "true" : "false"}`);
	log(`Current working directory: ${process.cwd()}`);

	try {
		// Only try to find running server if we're not in CI
		if (!process.env.CI) {
                        const runningPort = await findRunningDevServer();
                        if (runningPort) {
                                process.env.BASE_URL = getBaseUrl(runningPort);
                                log(`Using existing dev server at ${process.env.BASE_URL}`);
                        } else {
                                log(
                                        "No development server found. Will use the one configured in webServer",
                                        "error",
                                );
                                // Don't throw error - let the webServer config handle it
                                process.env.BASE_URL = getBaseUrl(DEFAULT_PORT); // Default to configured port
                                log(`Defaulting to ${process.env.BASE_URL}`);
                        }
		} else {
			log("Running in CI environment, skipping server detection");
		}
	} catch (error) {
		log(`Error in global setup: ${error}`, "error");
		// Continue anyway to let the webServer config try
	}
}

export default globalSetup;
