# Desktop E2E Flakiness Investigation Handoff

**Date**: 2025-12-03
**Branch**: `desktop-e2e-flake`
**PR**: #504

## Problem Statement

Desktop E2E tests are incredibly flaky on GitHub CI with 4 shards. Tests timeout waiting for Electron windows. Shards fail randomly - sometimes 1 fails, sometimes all 4, sometimes 3. This is 100% a race condition.

## Root Cause Identification

### The ACTUAL Problem (Not Solved)

**Electron main process produces NO stdout/stderr output in failing shards.**

Evidence from CI logs:
```
[DEBUG][HYP-H] Heartbeat: 5776ms elapsed, stdout=false, stderr=false
[DEBUG][HYP-H] Heartbeat: 10779ms elapsed, stdout=false, stderr=false
... continues for 100+ seconds with stdout=false, stderr=false ...
```

This means:
1. `electron.launch()` returns successfully (Playwright connects via CDP)
2. BUT the Electron main process NEVER executes any JavaScript
3. The first `console.log` in `main.js` is never reached
4. This is a **native-level crash or hang** in Electron, not a JavaScript issue

### Pre-flight Check Also Fails
```
[DEBUG][HYP-F] Electron version check FAILED: Command failed: "...electron" --version 2>&1
```

Running `electron --version` fails in failing shards but presumably works in passing shards.

## What Was Tried (And Why It Failed)

### 1. BrowserWindow Sandbox Disabling
**File**: `apps/desktop/src/create-window.ts`
- Added `sandbox: false` in CI for `webPreferences`
- **Why it didn't help**: This controls renderer process isolation, NOT the Chromium-level sandbox that affects main process startup
- The `--no-sandbox` flag was already being passed to Chromium

### 2. Increased Timeouts
**File**: `apps/desktop/e2e/utils/electron-helpers.ts`
- Increased `firstWindow()` timeout from 60s to 120s
- Increased `electron.launch()` timeout from 90s to 150s
- **Why it didn't help**: The window NEVER appears. Waiting longer for something that never happens doesn't help.

### 3. Retry Logic for Launch
**File**: `apps/desktop/e2e/utils/electron-helpers.ts`
- Added 3 retry attempts with 30s timeout per attempt
- Progressive delays between retries
- **Why it didn't help**: Same underlying issue - Electron hangs before executing JS, so retrying the same broken launch just repeats the failure.

## Key Observations

### Passing vs Failing Shards

**Shard 2 (often passes)**:
- `electron.launch()` returns in ~1-2 seconds
- `firstWindow()` returns ~650ms later
- "Electron app launched successfully" appears

**Shards 1, 3, 4 (often fail)**:
- `electron.launch()` returns (sometimes takes 5+ seconds)
- "Waiting for first window..." logged
- `stdout=false, stderr=false` for 100+ seconds
- Test timeout reached, NO window ever created

### Display Configuration
Each shard gets unique Xvfb display:
- Shard 1: `:91`
- Shard 2: `:92`
- Shard 3: `:93`
- Shard 4: `:94`

Display assignment appears correct but `xdpyinfo` is not available to verify.

## Theories for Root Cause

### 1. Xvfb Not Ready
The virtual display may not be fully initialized when Electron tries to use it. Shards that start slightly later (after Xvfb is ready) succeed.

### 2. Resource Exhaustion
4 shards starting simultaneously on the same runner may exhaust memory/CPU, causing some Electron processes to hang during native initialization.

### 3. Electron 39 + Chromium 142 Bug
There may be a bug in Electron 39's native initialization code that causes hangs under certain conditions (display timing, resource contention, etc.).

### 4. CDP Connection Race
Playwright may connect to Electron's CDP port before Electron is fully initialized, causing the main process to deadlock.

## Files Modified (Current State)

1. **`apps/desktop/src/create-window.ts`**
   - Conditional `sandbox: false` in CI
   - `isTestMode` detection for CI and `--test-mode` flag

2. **`apps/desktop/src/__tests__/create-window.test.ts`**
   - Updated tests for sandbox behavior

3. **`apps/desktop/e2e/utils/electron-helpers.ts`**
   - Retry logic (3 attempts, 30s timeout each)
   - `attemptElectronLaunch()` helper
   - `logEnvironmentDiagnostics()` helper
   - Various debug logging

## Recommended Next Steps

### High Priority - Root Cause Investigation

1. **Add native process monitoring**: Use `process.on('beforeExit')` or similar to detect if Electron main process even starts

2. **Pre-warm Xvfb**: Add explicit Xvfb startup verification before running tests:
   ```bash
   sleep 2  # Let Xvfb fully initialize
   xdpyinfo -display :${SERVER_NUM} || exit 1
   ```

3. **Reduce shards to 2**: Test if reducing parallelism eliminates the issue

4. **Check Electron 39 issues**: Search Electron GitHub for issues related to Electron 39 + Linux + headless

### Medium Priority - Alternative Approaches

1. **Use `xvfb-run --auto-servernum`**: Let xvfb-run auto-assign display numbers instead of manual assignment

2. **Stagger shard startup**: Add delays between shard starts to reduce contention

3. **Consider Electron 38**: Downgrade if Electron 39 has known issues

### Low Priority - Workarounds

1. **Increase retries at Playwright level**: Already at 2 retries, could increase

2. **Run Desktop E2E serially**: Remove sharding for Desktop E2E tests only

## Technical Details

### Environment
- **Node.js**: 22.x
- **Electron**: 39.2.4 (Chromium 142)
- **Playwright**: 1.57.0
- **CI**: GitHub Actions Ubuntu latest
- **Display**: Xvfb with GLX extension

### Relevant Files
```
apps/desktop/
├── src/
│   ├── create-window.ts       # Window creation with sandbox config
│   ├── main.ts                # Main process entry (compiled to dist/main.js)
│   └── __tests__/
│       └── create-window.test.ts
├── e2e/
│   ├── utils/
│   │   └── electron-helpers.ts  # Launch/retry logic
│   └── *.test.ts
├── playwright.config.ts
└── dist/main.js               # Compiled main process

.github/workflows/test.yml     # CI workflow with xvfb-run
packages/config/src/playwright-environment.ts  # Shared Playwright config
```

### Key Log Patterns to Search For
- `stdout=false, stderr=false` - Main process not producing output
- `Electron version check FAILED` - Binary execution issue
- `HYP-H.*Heartbeat` - Heartbeat monitoring
- `Launch attempt` - Retry attempts

## Update: Session 2 (2025-12-03 21:00 UTC)

### What Was Tested

1. **Reduced shards from 4 to 2** - Modified `.github/workflows/test.yml`
2. **Added Xvfb pre-warming** - Replaced `xvfb-run` with manual Xvfb startup + 3s sleep

### Results (Run 19908574552)

- **Shard 2/2**: ✅ PASSED
- **Shard 1/2**: ❌ FAILED (same root cause)

### Key Finding

**Resource contention is NOT the primary cause.** Even with only 2 shards, Shard 1 still failed with the exact same symptoms:

```
[DEBUG][HYP-F] Electron version check FAILED: Command failed: "...electron" --version 2>&1
[DEBUG][HYP-H] Heartbeat: 5539ms elapsed, stdout=false, stderr=false
[DEBUG][HYP-H] Heartbeat: 10544ms elapsed, stdout=false, stderr=false
... (30 seconds of no output) ...
❌ Launch attempt 3 failed: electronApplication.firstWindow: Timeout 30000ms exceeded
```

The `electron --version` command itself fails - this is pure binary execution issue, not about displays or windows.

### Theories Eliminated

1. ~~Resource contention from 4 shards~~ - Still fails with 2 shards
2. ~~Xvfb timing~~ - Manual Xvfb with 3s pre-warm didn't help

### Remaining Theories

1. **Electron 39 binary issue** - Something specific to Electron 39.2.4 on GitHub CI Ubuntu runners
2. **Random native initialization failure** - Chromium/Electron has a non-deterministic startup bug
3. **Missing system dependency** - Some library or config needed by Electron is intermittently unavailable

### Recommended Next Steps (Updated Priority)

1. **HIGH: Check Electron GitHub issues** - Search for Electron 39 + Ubuntu + headless issues
2. **HIGH: Try Electron 38** - Downgrade to test if this is a regression
3. **MEDIUM: Run single shard** - Remove all parallelism to isolate the issue
4. **MEDIUM: Add pre-launch Electron binary verification** - Run `electron --version` before tests and fail fast if it doesn't work

## Conclusion

The root cause is NOT in JavaScript code. It's a native-level issue where Electron hangs or crashes before the V8 engine even starts executing JavaScript. This happens randomly and is likely related to:

1. ~~Timing/race conditions with Xvfb display initialization~~ (Tested, not the cause)
2. ~~Resource contention between parallel shards~~ (Tested, not the cause)
3. **Potentially a bug in Electron 39's startup code** (Most likely)

The fix requires investigating at the native/environment level, not the JavaScript level. **Next step should be testing with Electron 38 to determine if this is a regression.**
