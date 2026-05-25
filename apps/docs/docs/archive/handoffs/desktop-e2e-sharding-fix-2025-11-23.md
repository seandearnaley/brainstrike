---
title: "Desktop E2E Sharding Fix 2025 11 23"
---

# Handoff: Desktop E2E Sharding Fix (Port Collision)

**Date:** November 23, 2025
**Status:** Fix Implemented & Type Checked
**Priority:** High (Blocking CI)

## 🚨 The Issue
The `desktop-e2e` CI job was failing when running parallel shards (e.g., Shard 1/2 and Shard 2/2).
- **Symptom:** One shard launches Electron, the other crashes immediately with `[Electron Stderr]: Waiting for the debugger to disconnect...`.
- **Root Cause:** Both shards were colliding on the same remote debugging port. Playwright defaults to `--remote-debugging-port=0` (random ephemeral port), but in some environments (GitHub Actions runners sharing network interfaces or `act`), this randomness failed to provide isolation, causing both processes to bind to the same port or conflict.

## 🛠️ The Fix
We enforced **deterministic, unique debugging ports** based on the shard index.

### 1. Fixture Update (`apps/desktop/e2e/fixtures/electron-fixture.ts`)
Updated the `electron` worker fixture to calculate a unique port:
```typescript
// apps/desktop/e2e/fixtures/electron-fixture.ts
export const test = base.extend<ElectronTestFixtures, ElectronWorkerFixtures>({
  electron: [
    async ({}, use, workerInfo) => {
      // Access shard info from workerInfo.config.shard
      const shard = workerInfo.config.shard;
      // Base port 9222 + shard index (e.g., 9223, 9224)
      const debugPort = shard ? 9222 + shard.current : undefined;
      const harness = new ElectronHarness(debugPort);
      // ...
    },
    { scope: 'worker' },
  ],
});
```

### 2. Helper Update (`apps/desktop/e2e/utils/electron-helpers.ts`)
Updated `launchElectronApp` to accept `debugPort` and explicitly pass it to Electron:
```typescript
// apps/desktop/e2e/utils/electron-helpers.ts
function createLaunchOptions(..., debugPort?: number) {
  // ...
  // Explicitly set the port if provided, overriding Playwright's default (0)
  ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []),
  // ...
}
```

## 🔍 Verification & Next Steps

### Verified
- **Type Check:** Passed (`pnpm run type-check`).
  - *Note:* Fixed a type error where `testInfo.shard` was used instead of `workerInfo.config.shard` in the worker-scoped fixture.

### Action Items for Next Developer
1. **Run Local CI Verification:**
   Execute the local CI script to confirm the fix works in the `act` container environment:
   ```bash
   pnpm test:e2e:desktop
   ```
   *Expected Result:* Both shards should launch Electron without colliding.

2. **Monitor CI:**
   Push changes and verify GitHub Actions `desktop-e2e` job passes.

## 💡 Key Learnings for Agents/Devs
- **Worker Fixture Scope:** In Playwright `scope: 'worker'` fixtures, the 3rd argument is `workerInfo` (type `WorkerInfo`), NOT `testInfo`.
- **Shard Info Location:** `WorkerInfo` does not have a `shard` property directly. Shard info is located in `workerInfo.config.shard`.
- **Port Isolation:** When debugging parallel process crashes, always suspect resource collisions (ports, user data dirs) first. Explicitly assigning resources based on worker/shard index is a robust fix.







