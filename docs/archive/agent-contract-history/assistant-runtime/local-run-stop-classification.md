# Local run Stop classification

Contract: `assistant-runtime.md` § "Renderer safety net".

A local run's Stop is classified by the run's own abort signal, never by the error's shape, and the cancelled completion stores no reason.

On 2026-09-29 (BST-1862), making the web E2E `mockGatedLocalLlmHost.cancel` reject the held `generate`, as the real host does, showed that `createLocalModelAdapter` (`packages/assistant-ui/src/local-runtime-adapter.ts`) ended a Stop as `failed`. Its cancelled branch accepted only `error instanceof DOMException && error.name === 'AbortError'`, a shape the desktop bridge never delivers. The branch now also fires on the run's own `abortSignal.aborted`. A plain `Error` with no preceding Stop still fails the run.

Verified chain, read at `dc098965e`:

1. The engine aborts with `new DOMException('The operation was aborted.', 'AbortError')` (`packages/agent/src/providers/local/gemma4-engine.ts:1113-1117`, `throwIfAborted`).
2. The hidden host reports it as a serialized error report: `createLlmHostErrorReport` (`apps/desktop/src/llm-host-shared.ts:646-664`) keeps `errorMessage` and `errorStack` strings, not the error object.
3. Main rebuilds a plain `Error`: `LlmHostManager.interpretResponse` throws `createRequestFailure(enrichedMessage, code)` (`apps/desktop/src/llm-host-manager.ts:589-600`), and `createRequestFailure` is `new Error(message)` plus a `code` property (`:175-181`).
4. The `llm-host:generate` invoke handler (`apps/desktop/src/ipc-llm-host.ts:54-60`) rejects across IPC, and Electron serializes that rejection: "only the `message` property from the original error is provided to the renderer process" (`apps/desktop/node_modules/electron/electron.d.ts:9012-9014`, Electron 44.4.5).
5. The visible renderer's `window.llmHost.generate` is a bare `ipcRenderer.invoke` with no error mapping (`apps/desktop/src/preload.ts:858-874`), so the adapter sees a plain `Error` whose `name` is `'Error'` and whose message carries Electron's `Error invoking remote method '<channel>': ` envelope (the same envelope `stripIpcInvokeEnvelope` in `packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts` removes; a class name survives only inside that message text).
6. The adapter calls `llmHost.cancel(requestId)` from its own abort listener (`local-runtime-adapter.ts`, the `handleAbort` beside `llmHost.generate`), so `abortSignal.aborted` is already true when the rejection arrives. That signal is the only reliable evidence of a Stop.

The reason stored with a cancelled run is `undefined`. The data-stream Stop stores none: `useAssistantServerRunSession`'s `onCancel` calls `completePreparedRequest(..., 'cancelled', undefined, ...)` on every path (`packages/assistant-ui/src/use-assistant-server-run-session.ts`), and the request lifecycle writes `error` only when it is truthy. Passing the raw message would have persisted Electron's IPC wrapper text as the reason of a user Stop.

Tests: `packages/assistant-ui/src/__tests__/local-runtime-adapter.test.ts` (Stop with a plain-`Error` rejection completes `cancelled` with no reason and raises no `onError`; a plain `Error` with no Stop completes `failed`), and the web E2E `Stop cancels the held run` in `apps/web/e2e/assistant-thread-tab-runs.test.ts`, which reads the run row back as `cancelled`. The chain above was read from source; no packaged desktop run exercised a real Stop against the hidden host.
