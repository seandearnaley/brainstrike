# @brainstrike/utils

Shared formatting, filtering, path, event, error and context helpers. Root is routed by [`index.ts`](src/index.ts); narrow subpaths are in [`package.json`](package.json).

- Keep utilities independent of app and feature runtimes.
- Path helpers format and compare; they never authorize filesystem access.
- A helper must not become a durable writer, hidden retry or platform fallback.
