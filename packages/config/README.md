# @brainstrike/config

Shared TypeScript, Biome and browser/Playwright configuration, consumed directly from source and JSON.

- TypeScript: [`tsconfig/base.json`](tsconfig/base.json) holds the strict checks and bundler-style module resolution.
  - Consumers type-check their dependencies' source under their own options.
  - A package whose emitted output Node runs directly sets NodeNext in its own tsconfig.
  - Include/exclude and emission belong to the consuming package.
- Biome: `/biome` and `/biome/base`.
- `/playwright-environment`: environment and CLI configuration for Playwright.
- `/vitest-browser`: browser project and provider helpers. Each package's own config chooses its projects.
- An environment setting named CI does not authorize hosted workflows.
- There is no `build` script.
