import { getBaseUrl, getPortsToCheck } from "../src/config/server";

// Helper to log messages during server detection
function log(message: string, level: "info" | "error" = "info") {
	const timestamp = new Date().toISOString();
	const prefix = level === "error" ? "❌" : "✓";
	console.log(`${prefix} ${timestamp} - ${message}`);
}

// Function to check if dev server is running and get its port
async function findRunningDevServer(): Promise<number | null> {
	const portsToCheck = getPortsToCheck();
	log("Starting server detection...");

	for (const port of portsToCheck) {
		try {
			log(`Checking port ${port}...`);

			const response = await fetch(getBaseUrl(port));
			const html = await response.text();

			// Check for specific markers in your app's HTML
			const isVite = html.includes("vite") || html.includes("data-vite");
			const isBrainstrike = html.includes("brainstrike-web");

			if (response.ok && (isVite || isBrainstrike)) {
				log(`Found dev server running on port ${port}`);
				return port;
			}
		} catch (error) {
			log(`Port ${port} not available: ${error}`, "error");
		}
	}

	log("No suitable server found on any port", "error");
	return null;
}

async function globalSetup() {
	log("Starting global setup...");

	// Only try to find running server if we're not in CI
	if (!process.env.CI) {
		const runningPort = await findRunningDevServer();
		if (runningPort) {
			process.env.BASE_URL = getBaseUrl(runningPort);
			log(`Using existing dev server at ${process.env.BASE_URL}`);
		} else {
			throw new Error(
				"No development server found. Please start the Vite dev server first.",
			);
		}
	} else {
		log("Running in CI environment, skipping server detection");
	}
}

export default globalSetup;
