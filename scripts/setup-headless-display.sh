#!/bin/bash

# Setup script for headless display environment in CI
# This script ensures Xvfb is available for Electron E2E testing

set -e

echo "🔧 Setting up headless display environment for Electron E2E tests..."

# Check if we're in a CI environment
if [ "$CI" = "true" ] || [ "$CODEX_ENV" = "true" ] || [ "$GITHUB_ACTIONS" = "true" ]; then
  echo "📦 CI environment detected, setting up Xvfb..."
  
  # Check if we're on Linux (where Xvfb is needed)
  if [ "$(uname)" = "Linux" ]; then
    echo "🐧 Linux detected, checking for Xvfb..."
    
    # Check if Xvfb is already available
    if command -v Xvfb >/dev/null 2>&1; then
      echo "✅ Xvfb is already installed"
    else
      echo "📦 Installing Xvfb..."
      
      # Try to install Xvfb using available package managers
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq
        sudo apt-get install -y xvfb
      elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y xorg-x11-server-Xvfb
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y xorg-x11-server-Xvfb
      elif command -v apk >/dev/null 2>&1; then
        sudo apk add --no-cache xvfb
      else
        echo "❌ No supported package manager found. Please install Xvfb manually."
        exit 1
      fi
      
      echo "✅ Xvfb installed successfully"
    fi
    
    # Verify Xvfb is working
    if command -v Xvfb >/dev/null 2>&1; then
      echo "✅ Xvfb is available and ready"
    else
      echo "❌ Xvfb installation failed"
      exit 1
    fi
    
  else
    echo "🍎 Non-Linux OS detected ($(uname)), Xvfb not needed"
  fi
  
else
  echo "💻 Local development environment detected, no setup needed"
fi

echo "🚀 Headless display environment setup complete!" 