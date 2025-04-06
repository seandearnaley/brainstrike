#!/bin/bash

# Script to debug token issues with semantic-release
# Usage: ./scripts/debug-tokens.sh

echo "=== Semantic Release Token Debugging ==="
echo ""

# Check if GH_TOKEN is set (primary token for semantic-release)
if [ -n "$GH_TOKEN" ]; then
  echo "✅ GH_TOKEN is set"
  
  # Check if token has correct format
  if [[ "$GH_TOKEN" == ghp_* || "$GH_TOKEN" == github_pat_* ]]; then
    echo "✅ GH_TOKEN has correct format"
  else
    echo "⚠️ GH_TOKEN does not have expected format (should start with 'ghp_' or 'github_pat_')"
    echo "   This might be fine if you're using a different token format or a custom token"
  fi
  
  # Check token length
  TOKEN_LENGTH=${#GH_TOKEN}
  if [ $TOKEN_LENGTH -lt 30 ]; then
    echo "❌ GH_TOKEN seems too short (length: $TOKEN_LENGTH). Typical tokens are longer."
  else
    echo "✅ GH_TOKEN length looks reasonable"
  fi
else
  echo "❌ GH_TOKEN is not set - this is required for semantic-release"
  echo "   Make sure to add it to your repository secrets"
fi

# Check if GITHUB_TOKEN is set (for reference)
if [ -n "$GITHUB_TOKEN" ]; then
  echo "ℹ️ GITHUB_TOKEN is also set (not used by our workflow)"
else
  echo "ℹ️ GITHUB_TOKEN is not set (this is expected, we use GH_TOKEN instead)"
fi

echo ""
echo "=== Repository Information ==="
echo ""

# Get repository information from package.json or git
REPO_URL=$(git config --get remote.origin.url || echo "Not found")
echo "Repository URL: $REPO_URL"

# Check if git user is configured
GIT_USER=$(git config --get user.name || echo "Not configured")
GIT_EMAIL=$(git config --get user.email || echo "Not configured")
echo "Git User: $GIT_USER"
echo "Git Email: $GIT_EMAIL"

echo ""
echo "=== Semantic Release Configuration ==="
echo ""

# Check if release.config.js exists
if [ -f "release.config.js" ]; then
  echo "✅ release.config.js found"
else
  echo "❌ release.config.js not found"
fi

# Check if semantic-release is installed
if npm list semantic-release > /dev/null 2>&1; then
  SEMANTIC_VERSION=$(npm list semantic-release | grep semantic-release | awk '{print $2}')
  echo "✅ semantic-release is installed (version: $SEMANTIC_VERSION)"
else
  echo "❌ semantic-release is not installed"
fi

# Check for GitHub plugins
if npm list @semantic-release/github > /dev/null 2>&1; then
  GITHUB_PLUGIN_VERSION=$(npm list @semantic-release/github | grep @semantic-release/github | awk '{print $2}')
  echo "✅ @semantic-release/github is installed (version: $GITHUB_PLUGIN_VERSION)"
else
  echo "❌ @semantic-release/github is not installed"
fi

echo ""
echo "=== Permissions Check ==="
echo ""

# Check if running in GitHub Actions
if [ -n "$GITHUB_ACTIONS" ]; then
  echo "Running in GitHub Actions environment"
  echo "Workflow: $GITHUB_WORKFLOW"
  echo "Repository: $GITHUB_REPOSITORY"
  echo "Ref: $GITHUB_REF"
  
  # Check if token has write permissions (can't actually check, just remind)
  echo "⚠️ Make sure your GH_TOKEN has the following permissions:"
  echo "  - contents: write (for creating tags and releases)"
  echo "  - issues: write (for commenting on issues)"
  echo "  - pull-requests: write (for commenting on PRs)"
  echo ""
  echo "For a personal access token (PAT), you need to select these scopes:"
  echo "  - repo (Full control of private repositories)"
  echo "  - workflow (Optional: if you need to trigger other workflows)"
else
  echo "Not running in GitHub Actions environment"
  echo "⚠️ For local testing, make sure to set GH_TOKEN environment variable"
fi

echo ""
echo "=== Workflow File Check ==="
echo ""

# Check if release.yml exists and uses GH_TOKEN
if [ -f ".github/workflows/release.yml" ]; then
  echo "✅ release.yml workflow file found"
  
  # Check if it uses GH_TOKEN
  if grep -q "GH_TOKEN" .github/workflows/release.yml; then
    echo "✅ release.yml references GH_TOKEN"
  else
    echo "❌ release.yml doesn't seem to reference GH_TOKEN"
  fi
else
  echo "❌ release.yml workflow file not found"
fi

echo ""
echo "=== Recommendations ==="
echo ""
echo "If you're still having issues:"
echo "1. Check that your GH_TOKEN has the correct permissions"
echo "2. Verify the token is correctly set in GitHub repository secrets"
echo "3. Try running 'GH_TOKEN=your_token npx semantic-release --dry-run --debug' locally"
echo "4. Make sure your workflow file consistently uses GH_TOKEN (not GITHUB_TOKEN)"
echo "5. Check that your token hasn't expired (GitHub PATs can expire)" 