# Web App Coverage Refactoring Plan

## Problem

The `@brainstrike/web` package reports **6.3% statement coverage** for `assistant-stream-helpers.ts` despite having **13 passing tests** that exercise every exported function. The API route files (`route.ts`, `status/route.ts`) report **0% coverage** despite having their own test suites (6 tests for chat route, 4 for assistant route, 2 for status route).

The root cause is **module-level `vi.mock()` replacing the real module with stubs**, so v8 coverage never sees the original source code execute.

## Current Coverage (Measured 2026-03)

| File | Statements | Tests | Root Cause |
|------|-----------|-------|------------|
| `src/assistant-stream-helpers.ts` | 6.3% (7/112) | 13 | `vi.mock('@brainstrike/agent')` replaces all agent imports |
| `src/app/api/assistant/route.ts` | 0% (0/19) | 4 | Same mock; route re-exports mocked helpers |
| `src/app/api/assistant/status/route.ts` | 0% (0/4) | 2 | Same mock chain |
| `src/main.tsx` | 48.9% (23/47) | Indirect | DOM bootstrap untestable in happy-dom |
| `src/server/assistant-config.ts` | 83.3% (10/12) | Via route tests | Two branches uncovered |

Total web coverage: **L 65.41% | F 50.00% | B 36.60% | S 46.37%**

## Why Mocking Kills Coverage

When a test file does:

```ts
vi.mock('@brainstrike/agent', () => ({
  toAiSdkStyleStream: vi.fn(),
  resolveDataStreamSession: vi.fn(),
  // ...
}));
```

Vitest's module loader replaces the **entire** `@brainstrike/agent` module with the mock factory's return value. The real `assistant-stream-helpers.ts` source code is loaded and instrumented by v8, but every call it makes to `@brainstrike/agent` hits the mock — meaning the coverage provider records "this line was reached" only for the import statements and function definitions, not for the actual logic inside each function.

The same problem applies to `vi.mock('../server/assistant-config')` — the config resolution code is entirely stubbed out.

## Refactoring Options

### Option A: Use `vi.spyOn` instead of `vi.mock` (Recommended)

**Effort:** Medium (1-2 hours per test file)
**Coverage gain:** ~+40% statements for assistant-stream-helpers alone

Replace full module mocks with targeted spies on specific functions:

```ts
// BEFORE (kills coverage):
vi.mock('@brainstrike/agent', () => ({
  toAiSdkStyleStream: vi.fn(),
  resolveDataStreamSession: vi.fn(),
  // ...
}));

// AFTER (preserves coverage):
import * as agent from '@brainstrike/agent';

beforeEach(() => {
  vi.spyOn(agent, 'toAiSdkStyleStream').mockResolvedValue(mockStream);
  vi.spyOn(agent, 'resolveDataStreamSession').mockReturnValue(undefined);
});
```

**Caveats:**
- `vi.spyOn` requires the original module to be importable in the test environment (happy-dom). If `@brainstrike/agent` has Node.js-only dependencies, this approach may fail with import errors.
- Some agent functions may have side effects at import time that are undesirable in tests.
- The vitest config already aliases `@brainstrike/agent` to its source via `resolve.alias`, so the real module _is_ loaded — it's just immediately replaced by `vi.mock`.

**Files to modify:**
1. `apps/web/src/__tests__/assistant-stream-helpers.test.ts` — Replace `vi.mock('@brainstrike/agent')` with spies
2. `apps/web/src/app/api/assistant/__tests__/route.test.ts` — Same pattern
3. `apps/web/src/app/api/chat/__tests__/route.test.ts` — Already uses `vi.importActual` partial mock; may need lighter touch

### Option B: Use `vi.mock` with `vi.importActual` (Partial Mock)

**Effort:** Low (30 min per file)
**Coverage gain:** Partial — only the non-mocked functions get coverage

Keep `vi.mock` but spread the actual module and only override specific functions:

```ts
vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
  return {
    ...actual,
    toAiSdkStyleStream: vi.fn(), // Only mock what you must
  };
});
```

**Caveats:**
- `assistant-stream-helpers.ts` calls many agent functions (`convertAssistantUiMessages`, `sanitizeStreamChunk`, `assistantDataStreamSessions`, `resolveDataStreamSession`, `toAiSdkStyleStream`). Most of these make real HTTP calls or access external state, so they genuinely need mocking.
- The chat route test (`route.test.ts`) already uses this pattern — it spreads actual and only overrides `toAiSdkStyleStream`. This is why the chat route shows 88.4% coverage while the assistant route shows 0%.

**This is already the pattern used in the chat route tests. The assistant-stream-helpers and assistant route tests should be migrated to match.**

### Option C: Extract Pure Logic into Testable Modules

**Effort:** High (4-6 hours)
**Coverage gain:** High — pure functions get 100% coverage

Refactor `assistant-stream-helpers.ts` to separate pure logic from I/O:

```
assistant-stream-helpers.ts          (orchestrator — calls agent, writes HTTP)
├── stream-pipe.ts                   (pure: pipeStreamToResponse, writeChunkToResponse)
├── response-formatting.ts           (pure: writeResponseHeaders, flushResponse)
└── event-id.ts                      (pure: readLastEventId)
```

The extracted modules contain zero external dependencies and can be tested without any mocks, giving 100% coverage. The orchestrator file (`assistant-stream-helpers.ts`) would still need mocks but would be much smaller.

**Caveats:**
- This is a larger refactor that changes the module structure
- The extracted functions are small — the ROI per function is low
- Risk of over-engineering for coverage metrics

### Option D: Use `vi.mock` with `__mocks__` Directory

**Effort:** Medium
**Coverage gain:** None for the source module

This doesn't help — `__mocks__` still replaces the module entirely.

## Recommended Approach

**Use Option B (partial mock with `vi.importActual`) as the primary strategy**, matching the pattern already established in the chat route tests. This gives the best effort/coverage ratio.

### Step-by-step implementation:

#### 1. Refactor `assistant-stream-helpers.test.ts`

```ts
// Replace the full mock:
vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>(
    '@brainstrike/agent'
  );
  return {
    ...actual,
    // Only mock functions that make real HTTP/external calls:
    toAiSdkStyleStream: vi.fn(),
    assistantDataStreamSessions: { create: vi.fn() },
    resolveDataStreamSession: vi.fn(),
  };
});
```

This preserves coverage for: `convertAssistantUiMessages`, `sanitizeStreamChunk`, and any other pure utility functions from `@brainstrike/agent` that the helpers call.

#### 2. Refactor `assistant/route.test.ts`

Same pattern — spread actual, mock only `toAiSdkStyleStream` and session management.

#### 3. Keep `assistant-config` mock minimal

```ts
vi.mock('../server/assistant-config', async () => {
  const actual = await vi.importActual<typeof import('../server/assistant-config')>(
    '../server/assistant-config'
  );
  return {
    ...actual,
    resolveAssistantProviderConfig: vi.fn(),
  };
});
```

#### 4. Verify agent module is importable

Before making changes, verify the agent module loads cleanly in happy-dom:

```bash
pnpm --filter @brainstrike/web test -- --run \
  -t "agent module loads" \
  --reporter=verbose
```

If it fails with missing Node.js APIs, you'll need to add polyfills or use Option C for those specific functions.

## Expected Coverage After Refactoring

| File | Before | After (estimated) |
|------|--------|-------------------|
| `assistant-stream-helpers.ts` | 6.3% | ~70-80% |
| `api/assistant/route.ts` | 0% | ~60-70% |
| `api/assistant/status/route.ts` | 0% | ~80-90% |
| **Package total** | **46.37% S** | **~65-70% S** |

The remaining uncovered code would be:
- Error paths that require specific failure modes (network errors, abort signals)
- The `import.meta` guard in unused files
- `main.tsx` bootstrap (not testable in happy-dom)

## Risks

1. **Import side effects:** The real `@brainstrike/agent` module may initialize connections, register handlers, or import heavy dependencies when first loaded. Test in isolation first.
2. **Test flakiness:** Partial mocks can cause unexpected interactions between real and mocked code. Run the full suite multiple times after refactoring.
3. **Breaking existing tests:** The chat route tests already use partial mocks successfully, so the pattern is proven in this codebase. The risk is mainly in discovering that the assistant-specific agent functions have untestable side effects.

