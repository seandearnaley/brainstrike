import { getBaseUrl, getPortsToCheck } from "@brainstrike/server-config";

// Helper to log messages during server detection
function log(message: string, level: "info" | "error" = "info") {
	const timestamp = new Date().toISOString();
	const prefix = level === "error" ? "❌" : "✓";
	console.log(`${prefix} ${timestamp} - ${message}`);
}

// Function to check if dev server is running and get its port
async function findRunningDevServer(): Promise<number | null> {
	// First check Vite's default port 5173
	try {
		log("Checking Vite port 5173 first...");
		const response = await fetch("http://localhost:5173", {
			method: "GET",
			signal: AbortSignal.timeout(3000),
		});

		log(`Response from 5173: status=${response.status}`);

		const html = await response.text();
		log(`Got HTML content from port 5173, length=${html.length}`);

		const isVite = html.includes("vite") || html.includes("data-vite");
		const isBrainstrike = html.includes("brainstrike-web");

		log(
			`Markers on port 5173: isVite=${isVite}, isBrainstrike=${isBrainstrike}`,
		);

		if (response.ok && (isVite || isBrainstrike)) {
			log("Found Vite dev server running on port 5173");
			return 5173;
		}
	} catch (error) {
		log(`Port 5173 not available: ${error}`, "error");
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
				// If port is 5173, use exact string for Vite
				if (runningPort === 5173) {
					process.env.BASE_URL = "http://localhost:5173";
				} else {
					process.env.BASE_URL = getBaseUrl(runningPort);
				}
				log(`Using existing dev server at ${process.env.BASE_URL}`);
			} else {
				log(
					"No development server found. Will use the one configured in webServer",
					"error",
				);
				// Don't throw error - let the webServer config handle it
				process.env.BASE_URL = "http://localhost:5173"; // Default to Vite port
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
