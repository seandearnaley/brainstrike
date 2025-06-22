# .codex/setup.sh - Optimized setup for CI environments with limited resources
set -euo pipefail

# Set Codex environment variable for proper detection
export CODEX_ENV=true

# Enable pnpm via corepack (Node 20+ already present)
corepack enable

# Install dependencies with frozen lockfile for reproducible builds
pnpm install --frozen-lockfile

# Install system dependencies for headless Electron testing
# Xvfb is required for Electron apps in headless environments
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y xvfb
  echo "✅ Xvfb installed for headless Electron testing"
fi

# Install only Chromium browser with system dependencies
# This saves time and space compared to installing all browsers
npx playwright install --with-deps chromium

# Prevent re-downloading browsers on subsequent runs
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Cache browsers in a shared location for better performance
export PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/pwbrowsers
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# Set up virtual display environment for Electron E2E tests
# This ensures xvfb-maybe can detect the headless environment properly
unset DISPLAY  # Ensure no display is set so xvfb-maybe activates

echo "Setup complete: Playwright ready for Codex with optimized single-worker configuration"
echo "Headless Electron testing: Xvfb installed and configured"
echo "Environment: CODEX_ENV=$CODEX_ENV"