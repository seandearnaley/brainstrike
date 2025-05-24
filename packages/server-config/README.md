# @brainstrike/server-config

Server configuration helpers for BrainStrike services.

## Installation

```bash
pnpm add @brainstrike/server-config
```

## Usage

```ts
import { DEFAULT_PORT, getBaseUrl } from "@brainstrike/server-config";

console.log(`Running on ${getBaseUrl(DEFAULT_PORT)}`);
```
