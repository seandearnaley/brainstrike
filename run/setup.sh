#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

echo "Starting Playwright E2E setup..."

# 1. Ensure Playwright doesn't try to download browsers to a system cache during 'pnpm install'.
#    We want to control the download location.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
echo "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set to 1."

# 2. Install all project dependencies using pnpm.
#    This will install @playwright/test (version from your root package.json).
echo "Installing project dependencies with pnpm..."
pnpm install
echo "Project dependencies installed."

# 3. Define the path where Playwright browsers will be stored locally within your project.
#    Using './.pw-browsers' will create this hidden directory at the root of your monorepo.
#    Using a hidden directory can be cleaner to indicate it's a cache/artifact.
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/.pw-browsers"
echo "Playwright browsers will be installed to: ${PLAYWRIGHT_BROWSERS_PATH}"

# 4. Create the target directory for browsers if it doesn't exist.
mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}"
echo "Ensured browser download directory exists: ${PLAYWRIGHT_BROWSERS_PATH}"

# 5. Explicitly tell Playwright to download the required browser binaries
#    to the path defined above.
#    We use 'pnpm dlx @playwright/test install' to ensure the correct Playwright CLI is used.
#    IMPORTANT: We are NOT using '--with-deps' here. OS dependencies should be handled
#    in the Dockerfile or VM image of your offline runner. This script's job is
#    to download THE BROWSER BINARIES THEMSELVES.
echo "Installing Playwright browser binaries (Chromium, Firefox, WebKit)..."
pnpm dlx @playwright/test install chromium firefox webkit 
# Or specify only the browsers you need, e.g., 'pnpm dlx @playwright/test install chromium'
echo "Playwright browser binaries installation attempted."

# --- Verification Step (Optional but Recommended) ---
echo "Verifying downloaded browsers in ${PLAYWRIGHT_BROWSERS_PATH}..."
if [ -d "${PLAYWRIGHT_BROWSERS_PATH}/chromium-$(pnpm dlx @playwright/test --version | awk '{print $NF}')" ] || \
   [ -d "${PLAYWRIGHT_BROWSERS_PATH}/chromium-$(pnpm dlx playwright --version | awk '{print $NF}')" ] || \
   ls "${PLAYWRIGHT_BROWSERS_PATH}" | grep -q "chromium-"; then # Looser check for chromium folder
    echo "Chromium directory found."
else
    echo "WARNING: Chromium directory not found in ${PLAYWRIGHT_BROWSERS_PATH}. Check Playwright version and download."
fi
# Add similar checks for firefox and webkit if you install them.

echo "---------------------------------------------------------------------"
echo "Setup script finished."
echo "Offline runner will need OS dependencies for these browsers."
echo "Ensure PLAYWRIGHT_BROWSERS_PATH is set to ${PLAYWRIGHT_BROWSERS_PATH} in the offline environment."
echo "---------------------------------------------------------------------"