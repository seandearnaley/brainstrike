# .codex/setup.sh - Optimized setup for CI environments with limited resources
set -euo pipefail

# Set Codex environment variable for proper detection
export CODEX_ENV=true

# Enable pnpm via corepack (Node 20+ already present)
corepack enable

# Install dependencies with frozen lockfile for reproducible builds
pnpm install --frozen-lockfile

# Install only Chromium browser with system dependencies
# This saves time and space compared to installing all browsers
npx playwright install --with-deps chromium

# Prevent re-downloading browsers on subsequent runs
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Cache browsers in a shared location for better performance
export PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/pwbrowsers
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

echo "Setup complete: Playwright ready for Codex with optimized single-worker configuration"
echo "Environment: CODEX_ENV=$CODEX_ENV"