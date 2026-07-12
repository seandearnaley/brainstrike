# Platform Contracts: Logging, Factory Reset

> Extracted from AGENTS.md (2026-07-12). Read before adding persistence or changing logging. Keep updated with the code.

## LOGGING (PINO V10)

Centralized logging: packages/utils/src/logger.ts

Usage:
- Use initializeLogging from @brainstrike/utils.
- Set runtime: browser | electron-main | electron-renderer.
- Desktop main:
  - Logs to console + ${app.getPath('logs')}/brainstrike.log
- Web/renderer:
  - Call initializeLogging in main.tsx.

Log levels:
- trace, debug, info, warn, error, fatal, silent
- Configure via:
  - setLogLevel(LogLevel.DEBUG)
  - LOG_LEVEL=debug (env)
- Priority: code > env > defaults.

Structured logs:
- Prefer objects:

  logger.info('User authenticated', { userId: '123', method: 'oauth' });

Scoped loggers:
- createLogger('FileImporter')

Sensitive data:
- Auto-redacts: apiKey, password, token, secret, authorization, cookie
- Add more via redactPaths.

Testing:
- Use addLogListener instead of mocking console.

---

## FACTORY RESET CONTRACT

“Factory Reset Brainstrike” = true fresh start.

Rules:
- Wiping DB alone is NOT enough.
- Renderer must boot as if never used.

Implementation:
- Update:
  - packages/preferences/src/settings/system/factory-reset-helpers.ts
  - Ensure clearPersistentUiState() includes:
    - All new persistent UI store keys (e.g. `hook-trust-store` — the
      security-sensitive per-root hook approvals; reset drops every approval so a
      re-mounted repo's hooks require fresh review — see TOOL-LIFECYCLE HOOKS).
    - Electron renderer storage bridge.
    - IndexedDB (enumerated + fallback list).
    - CacheStorage.

If you add new persistence (Caches API, service worker, filesystem handles, etc.):
- Document it next to the helper.
- Integrate into reset pipeline.
- Otherwise stale embeddings/providers may reappear.

Desktop reset order:
1. Dispose embeddings.
2. Clear UI state.
3. Purge DB tables (job_queue, embedding_sets, etc.).
4. Reload renderer.
Do not skip reload.

Add tests when changing reset behavior.

---


