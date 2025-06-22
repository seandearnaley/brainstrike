# Playwright CI Optimization Guide

This document outlines the optimizations made to our Playwright configurations for better performance in different CI environments with varying resource constraints.

## Environment Detection

Our configurations now intelligently detect and optimize for different environments:

### Environment Variables
- **`CODEX_ENV`**: Custom variable set in Codex environments (very limited resources)
- **`GITHUB_ACTIONS`**: Standard GitHub Actions environment variable
- **`CI`**: General CI environment variable (fallback)

### Worker Configuration by Environment
```typescript
const getWorkerCount = () => {
  if (isCodex) return 1;        // Codex: Very limited resources
  if (isGitHubActions) return 2; // GitHub Actions: 2-core free runners
  if (isCI) return 1;           // Other CI: Conservative default
  return 2;                     // Local development
};
```

### Timeout Configuration by Environment
```typescript
const getGlobalTimeout = () => {
  if (isCodex) return 10 * 60 * 1000;  // 10 minutes (15 min hard limit)
  if (isCI) return 15 * 60 * 1000;     // 15 minutes for other CI
  return 0;                            // No timeout for local dev
};
```

## Key Optimizations by Environment

### 🔧 **Codex Environment** (Most Restrictive)
- **Workers**: 1 (single-core optimization)
- **Global Timeout**: 10 minutes (under 15-minute hard limit)
- **Retries**: 1 (minimal to save time)
- **Parallel Tests**: Disabled (`fullyParallel: false`)
- **Extra Browser Flags**: `--disable-web-security` for maximum compatibility

### 🚀 **GitHub Actions**
- **Workers**: 2 (matches free runner cores)
- **Global Timeout**: 15 minutes
- **Retries**: 2 (standard reliability)
- **Parallel Tests**: Enabled for web tests

### 🏢 **Other CI Environments**
- **Workers**: 1 (conservative default)
- **Global Timeout**: 15 minutes
- **Retries**: 2
- **Standard CI optimizations**

### 💻 **Local Development**
- **Workers**: 2 (can be increased based on your machine)
- **Global Timeout**: None
- **Retries**: 0 (fail fast for development)
- **Headless**: False (can see what's happening)

## Browser Launch Arguments (CI Only)

All CI environments include these optimized Chrome flags:
```typescript
launchOptions: {
  args: [
    '--no-sandbox',              // Disable sandboxing for CI
    '--disable-dev-shm-usage',   // /dev/shm is tiny in CI environments
    '--disable-setuid-sandbox',  // Additional sandbox disabling
    '--disable-gpu',             // Disable GPU for headless environments
    // Codex gets additional: '--disable-web-security'
  ]
}
```

## Setup Script Enhancement (`.codex/setup.sh`)

The setup script now:
1. **Sets `CODEX_ENV=true`** for proper environment detection
2. **Installs only Chromium** (saves ~150MB+ download time)
3. **Sets up browser caching** for performance across runs
4. **Uses frozen lockfile** for reproducible builds

## Usage Examples

### Setting Up Codex
```bash
# In your Codex setup script field:
export CODEX_ENV=true
./setup.sh
```

### GitHub Actions Workflow
```yaml
# GitHub Actions automatically sets GITHUB_ACTIONS=true
- name: Run E2E tests
  run: pnpm run test:e2e
```

### Other CI Environments
```bash
# Set CI=true for general CI detection
export CI=true
pnpm run test:e2e
```

### Local Development
```bash
# No environment variables needed
pnpm run test:e2e
```

## Performance Benefits by Environment

### Codex Optimizations
- ⚡ **Fastest possible startup** with single worker
- 🕐 **Time-bounded execution** (10 min max)
- 💾 **Minimal resource usage**
- 🔄 **Quick failure feedback** (1 retry only)

### GitHub Actions Optimizations
- 🚀 **Optimal core utilization** (2 workers)
- ⚖️ **Balanced reliability** (2 retries)
- 📊 **Efficient reporting**

### Local Development Benefits
- 👀 **Visual debugging** (non-headless)
- 🔄 **Fast iteration** (no retries)
- 🚫 **No artificial timeouts**

## Security Considerations

⚠️ **Important**: The `--no-sandbox` flag disables Chromium's security sandbox. This is acceptable for trusted CI environments running known code, but should not be used when:
- Running untrusted user-generated content
- Testing applications that handle sensitive data
- Running in environments where security isolation is critical

## Troubleshooting by Environment

### Codex Issues
- **Timeout errors**: Tests are taking too long, optimize test logic
- **Memory crashes**: Reduce test complexity or data size
- **Worker conflicts**: Ensure single worker is being used

### GitHub Actions Issues
- **Slow performance**: Check if 2 workers are being utilized
- **Resource limits**: Monitor action usage quotas

### General CI Issues
- **Environment detection**: Check logs for detected environment
- **Browser crashes**: Verify `--disable-dev-shm-usage` is applied
- **Setup failures**: Ensure proper browser installation with `--with-deps`

## Environment Detection Debugging

Both configurations log their detected environment:
```
Web Playwright config:
  Codex: true
  GitHub Actions: false
  General CI: true
  Workers: 1
  Global timeout: 600s
  Base URL: http://localhost:8080
```

## References

- [GitHub Actions Environment Variables](https://docs.github.com/en/actions/learn-github-actions/environment-variables)
- [Playwright CI Documentation](https://playwright.dev/docs/ci)
- [Chromium Command Line Switches](https://peter.sh/experiments/chromium-command-line-switches/)
- [OpenAI Codex Best Practices](https://community.openai.com/t/codex-cloud-environment-for-build-and-run-unit-tests/1263843) 