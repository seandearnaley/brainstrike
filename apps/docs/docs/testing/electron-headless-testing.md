---
title: Electron Headless Testing
sidebar_position: 4
---

# Electron Headless Testing Setup

This document explains how to run Electron E2E tests in headless CI environments like Codex, GitHub Actions, and other containerized environments.

## The Problem

Electron applications are based on Chromium and require a display server to function. In headless CI environments (like Docker containers, Codex, etc.), there's no GUI available, which causes Electron apps to fail to launch with errors like:

```
Failed to create session.
unknown error: Chrome failed to start: exited abnormally.
(unknown error: DevToolsActivePort file doesn't exist)
```

## The Canonical Solution

The **official Electron-recommended solution** is to use **Xvfb (X Virtual Framebuffer)** with the **`xvfb-maybe`** package. This approach is:

1. **Canonical**: Documented in the official Electron testing guide
2. **Idiomatic**: Used by the Electron ecosystem and major projects
3. **Cross-platform**: Works on Linux (where needed) and is a no-op on Windows/macOS

## How It Works

### Xvfb (X Virtual Framebuffer)
- A virtual display server that implements the X11 display server protocol
- Performs all graphical operations in memory without showing any screen output
- Exactly what we need for headless testing

### xvfb-maybe Package
- Automatically detects if Xvfb is needed (Linux + no DISPLAY variable)
- On Linux headless environments: runs commands with `xvfb-run`
- On Windows/macOS or environments with displays: runs commands normally
- Zero configuration required

## Implementation

### 1. Package Installation

```bash
pnpm add -D xvfb-maybe
```

### 2. Package.json Scripts

```json
{
  "scripts": {
    "test:e2e": "xvfb-maybe npx playwright test",
    "test:e2e:ui": "xvfb-maybe npx playwright test --ui",
    "test:e2e:debug": "xvfb-maybe npx playwright test --debug"
  }
}
```

### 3. System Dependencies Setup

#### Codex Environment
Xvfb is automatically installed during the Codex setup process (`.codex/setup.sh`). No additional setup required.

#### Other CI Environments
The `scripts/setup-headless-display.sh` script automatically installs Xvfb in other CI environments:

```bash
# Run before E2E tests in non-Codex CI
pnpm run setup:headless
```

### 4. Enhanced Electron Launch Arguments

The Playwright configuration includes CI-optimized launch arguments:

```typescript
const ciArgs = getCILaunchArgs(); // From @brainstrike/config
const launchOptions = {
  args: [...baseArgs, ...ciArgs],
  // ... other options
};
```

These arguments include:
- `--no-sandbox`: Required for containerized environments
- `--disable-dev-shm-usage`: /dev/shm is limited in CI
- `--disable-gpu`: No GPU acceleration needed in headless
- `--disable-features=VizDisplayCompositor`: Helps with headless stability

## Environment Detection

The system automatically detects CI environments:

- **Codex**: `CODEX_ENV=true`
- **GitHub Actions**: `GITHUB_ACTIONS=true`
- **General CI**: `CI=true`

And applies appropriate optimizations:
- Resource limits (workers, timeouts)
- Launch arguments
- Retry strategies

## Usage

### Local Development
```bash
pnpm run test:e2e  # Works normally (xvfb-maybe is a no-op)
```

### Codex Environment
```bash
# Xvfb is pre-installed during setup, just run tests
pnpm run test:e2e:desktop
```

### Other CI Environments
```bash
pnpm run setup:headless  # Install Xvfb if needed
pnpm run test:e2e        # Automatically uses xvfb-run on Linux
```

### Manual Xvfb Usage (if needed)
```bash
# Manual approach (not recommended, use xvfb-maybe instead)
xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" npx playwright test
```

## Benefits

1. **Zero Configuration**: Works automatically across all environments
2. **Reliable**: Official Electron-recommended approach
3. **Efficient**: Only uses Xvfb when actually needed
4. **Maintainable**: Standard solution used by the ecosystem
5. **Cross-platform**: Handles Windows, macOS, and Linux correctly

## Troubleshooting

### Xvfb Not Available
If you get "Xvfb not found" errors, install it manually:

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y xvfb

# CentOS/RHEL
sudo yum install -y xorg-x11-server-Xvfb

# Alpine
sudo apk add --no-cache xvfb
```

### Display Issues
If you still get display-related errors:

1. Ensure `xvfb-maybe` is in your command
2. Check that Xvfb is installed (`which Xvfb`)
3. Verify no DISPLAY variable is set in CI
4. Check Electron launch arguments include `--no-sandbox`

## References

- [Electron Official Testing Guide](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)
- [xvfb-maybe Package](https://www.npmjs.com/package/xvfb-maybe)
- [Playwright Electron Testing](https://playwright.dev/docs/api/class-electronapplication) 