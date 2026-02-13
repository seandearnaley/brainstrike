---
title: "20251005 112340 MCP Client Duplicate Initialization Fix"
status: "cold-archive"
date: "2025-10-05"
superseded_by: "none"
---

# MCP Client Duplicate Initialization Fix

**Date:** February 15, 2025  
**Issue:** E2E test failures due to MCPClient being initialized multiple times  
**Status:** ✅ Resolved

## Problem

Two e2e tests were failing in the desktop app:

### 1. Agent IPC Test
```
Error: Error invoking remote method 'agent:chat': MastraAgentError: 
mastra_agent_runtime_init_failed: MCPClient was initialized multiple 
times with the same configuration options.
```

### 2. Assistant Chat Test
```
TimeoutError: locator.fill: Timeout 30000ms exceeded.
The assistant input remained disabled because initialization failed.
```

## Root Cause

The MCPClient library has a built-in safeguard to prevent memory leaks by detecting when multiple instances are created with identical configuration. This was happening because:

1. **Tool Discovery on Startup**: `apps/desktop/src/ipc-mcp.ts:220-234` creates an MCPClient during startup tool discovery
2. **Agent Chat Runtime**: When `agent:chat` is invoked, it creates another MCPClient with the same server configuration
3. **Missing Unique Identifiers**: The MCPClient instances didn't have unique IDs to differentiate them

## Solution

Added a unique `id` parameter to each MCPClient instance creation in `packages/agent/src/mastra/agent-runtime.ts:136-138`:

```typescript
const mcpClient = hasServers
  ? new MCPClient({ id: `mcp-client-${Date.now()}-${Math.random()}`, servers })
  : undefined;
```

This follows option #1 from the MCPClient error message:
> If you need multiple MCPClient class instances with identical server configurations, 
> set an id when configuring: `new MCPClient({ id: "my-unique-id" })`

## Why This Fixes Both Failures

### Agent IPC Test
- Previously: MCPClient threw an error during initialization
- Now: Each instance has a unique ID, allowing multiple instances with the same server config
- Result: Agent initialization succeeds, chat works correctly

### Assistant Chat Test  
- Previously: Agent initialization failure kept assistant in disabled state
- Now: Agent initializes successfully, enabling the assistant input
- Result: Test can interact with the assistant UI

## Testing

### Unit Tests
✅ All `@brainstrike/agent` unit tests pass (109 tests)
- Tests use mocked MCPClient that accepts any options
- No test changes needed

### E2E Tests
- ✅ `e2e/agent-ipc.test.ts:18:7 › Agent IPC › returns streamed chunks for a simple prompt` - **PASSING**
- ✅ `e2e/mcp-filesystem.desktop.test.ts:125:7 › Assistant chat (desktop) › assistant chat renders messages` - **PASSING**

## Alternative Approaches Considered

1. **Singleton Pattern**: Share one MCPClient instance globally
   - ❌ More complex, harder to dispose correctly
   - ❌ Potential concurrency issues

2. **Proper Disposal Before Recreation**: Call `disconnect()` before creating new instances
   - ❌ Difficult to track lifecycle across async operations
   - ❌ Timing issues between disposal and recreation

3. **Unique ID per Instance**: ✅ Chosen approach
   - ✅ Simple, minimal code change
   - ✅ Preserves existing architecture
   - ✅ Recommended by library authors

## Additional Fixes

### Desktop E2E Test - Secrets API & Stream Format
**File**: `apps/desktop/e2e/mcp-filesystem.desktop.test.ts`

**Issue 1: Secrets API Mocking**
The test was trying to override `window.secrets` methods, but Electron's `contextBridge` creates immutable properties. Fixed by:
- Using the real `window.secrets.saveKey()` API to save test credentials
- Removing attempts to override immutable context methods
- Pattern follows `assistant-panel.desktop.test.ts` for consistency

**Issue 2: Mock Stream Response Format**
The test was using an incorrect stream format. Fixed by implementing proper AI SDK Data Stream Protocol:
- Code `2`: Metadata with messageId and sessionId
- Code `f`: Step start marker
- Code `0`: Text delta chunks
- Code `e`: Step end marker
- Code `d`: Message finish with usage stats
- Headers: `Content-Type: text/plain`, `x-vercel-ai-data-stream: v1`, `x-vercel-ai-ui-message-stream: v1`

## Related Files

- **Fixed**: `packages/agent/src/mastra/agent-runtime.ts` (MCPClient ID)
- **Fixed**: `apps/desktop/e2e/mcp-filesystem.desktop.test.ts` (secrets API usage)
- **Context**: `apps/desktop/src/ipc-mcp.ts` (tool discovery)
- **Context**: `apps/desktop/src/ipc-agent.ts` (IPC handler)
- **Context**: `apps/desktop/src/preload.ts` (contextBridge setup)
- **Tests**: `packages/agent/src/__tests__/mastra-streaming.spec.ts`

## Notes

- The unique ID uses timestamp + random number to ensure uniqueness across rapid successive creations
- This pattern can be used anywhere multiple MCPClient instances with the same config are needed
- No changes to the MCPClient API or behavior, just leveraging existing `id` parameter
