# @brainstrike/server-config

Server configuration helpers for BrainStrike services.

## Installation

Add the config helpers to another workspace via pnpm workspace linking.

```bash
# Add to a specific workspace (example: apps/desktop)
pnpm add @brainstrike/server-config --filter @brainstrike/desktop

# Or declare it manually in that workspace package.json
"dependencies": {
  "@brainstrike/server-config": "workspace:*"
}
```

## Usage

```ts
import { DEFAULT_PORT, getBaseUrl } from "@brainstrike/server-config";

console.log(`Running on ${getBaseUrl(DEFAULT_PORT)}`);
```
