# MCP Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click installs of the official remote MCP servers for Linear, GitHub, Atlassian and GitLab from Settings → AI Tools → MCP Config.

**Architecture:** A typed catalog lives in `@brainstrike/assistant-contract/mcp-catalog`. The host's `McpSettingsAuthority`, which already owns the profile's MCP config file, gains `installCatalogServer`. It resolves the entry, stores a GitHub token through a new bearer credential writer, appends the server with `jsonc-parser` (comments survive), and commits through the same write → reload path as `writeConfigText`. A new host method `mcp/config/install` carries the request from a new settings-ui `McpCatalogSection`, wired in the desktop renderer.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Effect Schema (protocol), `jsonc-parser` 3.3, React 19, `@brainstrike/ui`, Vitest + Testing Library, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-18-mcp-catalog-design.md`

## Global Constraints

- TypeScript strict, no `any`. With `exactOptionalPropertyTypes`, supply optional properties with a conditional spread (`...(token === undefined ? {} : { token })`), never `token: undefined`.
- Biome: object keys and JSX props sorted alphabetically, block statements, at most 1000 code lines per file, cognitive complexity at most 20 per function. Kebab-case file names.
- The MCP config grammar is imported only from `@brainstrike/assistant-contract/mcp-config`, and the catalog only from `@brainstrike/assistant-contract/mcp-catalog`. Neither is re-exported from the package root (`scripts/__tests__/mcp-config-schema-ownership.test.mjs`). The catalog declares no `Schema.Struct`/`Union` shapes.
- Never log, print or echo a token value. Tests use fixture tokens only.
- Every refusal is a visible failure result with a specific message. No fallback endpoint, no silent overwrite, no partial state left behind unreported.
- No vendor sign-in and no real credentials in this change (spec D5). The app-flow check uses a disposable profile, never `~/Documents/BrainStrike-dev/**` or `~/Library/Application Support/@brainstrike/**`.
- Red first: each test is run and seen failing before its implementation is written.
- One commit per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Hooks run normally; never `--no-verify`.
- Downstream packages type-check against built `dist`. After changing a package that others import, build it before type-checking its consumers (commands are in each task).

## File Map

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/assistant-contract/src/mcp-catalog.ts` | Create | Catalog data, lookup, server-entry builder, install request type |
| `packages/assistant-contract/package.json` | Modify | `./mcp-catalog` subpath export |
| `packages/assistant-contract/src/__tests__/mcp-catalog.test.ts` | Create | Catalog decodes through the config grammar |
| `packages/host-capabilities/src/mcp/bearer-credential.ts` | Modify | `createSecretsMcpBearerCredentialWriter` |
| `packages/host-capabilities/__tests__/mcp-bearer-credential-writer.test.ts` | Create | Writer behavior and factory-reset sweep |
| `packages/host-capabilities/src/mcp/settings-authority.ts` | Modify | `installCatalogServer`, shared `#commitConfigText` |
| `packages/host-capabilities/__tests__/mcp-settings-authority-harness.ts` | Modify | In-memory bearer writer |
| `packages/host-capabilities/__tests__/mcp-settings-authority-catalog.test.ts` | Create | Install behavior |
| `apps/desktop/src/__tests__/main/mcp-host-service.test.ts` | Modify | New required authority option |
| `packages/agent-host/src/protocol-mcp-settings.ts` | Modify | `mcp/config/install` params/result |
| `packages/agent-host/src/ports.ts` | Modify | `HostMcpSettingsService.installCatalogServer` |
| `packages/agent-host/src/mcp-settings-connection.ts` | Modify | Handler |
| `packages/agent-host/__tests__/mcp-settings-connection.test.ts` | Modify | Routing test |
| `packages/host-capabilities/src/mcp/desktop-node-mcp.ts` | Modify | Compose the writer into the authority |
| `packages/host-capabilities/__tests__/desktop-mcp-diagnostics.test.ts` | Modify | Widened credentials fake |
| `packages/settings-ui/src/settings/external-link.ts` | Create | Shared external-link click helper (extracted); resolves the failure message |
| `packages/settings-ui/src/settings/__tests__/external-link.test.ts` | Create | Helper outcomes |
| `packages/settings-ui/src/settings/secrets/credential-inventory/credential-oauth-actions.tsx` | Modify | Use the extracted helper; show a link failure |
| `packages/settings-ui/src/settings/tools/types.ts` | Modify | `installMcpCatalogServer` operation |
| `packages/settings-ui/src/settings/tools/mcp-catalog-section.tsx` | Create | Catalog cards and token dialog |
| `packages/settings-ui/src/settings/tools/mcp-config-panel.tsx` | Modify | Render the section; reload editor after install |
| `packages/settings-ui/src/settings/tools/__tests__/mcp-catalog-section.test.tsx` | Create | Section behavior |
| `packages/settings-ui/src/settings/tools/__tests__/mcp-config-panel.test.tsx` | Modify | Panel integration |
| `apps/desktop/src/renderer/components/settings/page-content.tsx` | Modify | Route the operation to `mcp/config/install` |
| `apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx` | Modify | Routing test |

---

### Task 1: Catalog data in the contract

**Files:**
- Create: `packages/assistant-contract/src/mcp-catalog.ts`
- Modify: `packages/assistant-contract/package.json` (the `exports` map)
- Test: `packages/assistant-contract/src/__tests__/mcp-catalog.test.ts`

**Interfaces:**
- Consumes: `McpServerInput` (type) and `parseMcpServerValue` from `packages/assistant-contract/src/mcp-config.ts`; `parseConfiguredMcpServerId` from `src/mcp-host.ts`.
- Produces (all from `@brainstrike/assistant-contract/mcp-catalog`):
  - `MCP_CATALOG_ACCESS: readonly ['read-write', 'read-only']`
  - `type McpCatalogAccess = 'read-write' | 'read-only'`
  - `type McpCatalogEntry` (discriminated on `auth: 'oauth' | 'token'`; token entries carry `token: { createUrl: string; label: string }`; all carry `description`, `docsUrl`, `id`, `name`, `urls: { 'read-only'?: string; 'read-write': string }`)
  - `MCP_CATALOG: readonly McpCatalogEntry[]`
  - `interface McpCatalogCredentialReference { id: string; store: 'mcp-credentials' }`
  - `interface McpCatalogInstallRequest { access: McpCatalogAccess; catalogId: string; token?: string }`
  - `findMcpCatalogEntry(catalogId: string): McpCatalogEntry | undefined`
  - `mcpCatalogServerInput(entry, access, credential?): McpServerInput`. It throws `"<Name> has no <access> endpoint"`, `"<Name> signs in with OAuth and takes no token"` or `"<Name> needs a stored token"`.

- [ ] **Step 1: Write the failing test**

Create `packages/assistant-contract/src/__tests__/mcp-catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  findMcpCatalogEntry,
  MCP_CATALOG,
  MCP_CATALOG_ACCESS,
  mcpCatalogServerInput,
} from '../mcp-catalog.js';
import { parseMcpServerValue } from '../mcp-config.js';
import { parseConfiguredMcpServerId } from '../mcp-host.js';

const REFERENCE = { id: '00000000-0000-4000-8000-000000000001', store: 'mcp-credentials' } as const;

function entry(id: string) {
  const found = findMcpCatalogEntry(id);
  if (!found) {
    throw new Error(`catalog entry ${id} is missing`);
  }
  return found;
}

describe('MCP catalog', () => {
  it('lists Linear, GitHub, Atlassian and GitLab once each, by valid server name', () => {
    expect(MCP_CATALOG.map(({ id }) => id)).toEqual(['linear', 'github', 'atlassian', 'gitlab']);
    for (const { id } of MCP_CATALOG) {
      expect(parseConfiguredMcpServerId(id)).toBe(id);
    }
  });

  it('builds a server entry the config grammar accepts for every offered access', () => {
    for (const catalogEntry of MCP_CATALOG) {
      for (const access of MCP_CATALOG_ACCESS) {
        const url = catalogEntry.urls[access];
        if (url === undefined) {
          continue;
        }
        const credential = catalogEntry.auth === 'token' ? REFERENCE : undefined;
        const server = parseMcpServerValue(mcpCatalogServerInput(catalogEntry, access, credential));
        expect(server).toMatchObject({
          name: catalogEntry.id,
          protocol: 'auto',
          transport: 'streamable-http',
          url,
        });
        expect(server.startup).toBe(
          catalogEntry.auth === 'oauth' ? 'authentication-required' : 'automatic'
        );
      }
    }
  });

  it('offers read-only only where the vendor server enforces it', () => {
    expect(
      MCP_CATALOG.filter(({ urls }) => urls['read-only'] !== undefined).map(({ id }) => id)
    ).toEqual(['linear', 'github']);
  });

  it('writes a token entry as a bearer reference, never as a header', () => {
    expect(mcpCatalogServerInput(entry('github'), 'read-only', REFERENCE)).toEqual({
      auth: { credential: REFERENCE, type: 'bearer' },
      name: 'github',
      protocol: 'auto',
      transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/readonly',
    });
  });

  it('refuses a build that does not match the entry', () => {
    expect(() => mcpCatalogServerInput(entry('linear'), 'read-write', REFERENCE)).toThrow(
      'Linear signs in with OAuth and takes no token'
    );
    expect(() => mcpCatalogServerInput(entry('github'), 'read-write')).toThrow(
      'GitHub needs a stored token'
    );
    expect(() => mcpCatalogServerInput(entry('gitlab'), 'read-only')).toThrow(
      'GitLab has no read-only endpoint'
    );
    expect(findMcpCatalogEntry('jira')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/assistant-contract exec vitest run src/__tests__/mcp-catalog.test.ts`
Expected: FAIL, `Failed to resolve import "../mcp-catalog.js"`.

- [ ] **Step 3: Write the catalog**

Create `packages/assistant-contract/src/mcp-catalog.ts`:

```ts
import type { McpServerInput } from './mcp-config.js';

/**
 * Curated official remote MCP servers that Settings installs in one click
 * (docs/superpowers/specs/2026-10-18-mcp-catalog-design.md). Endpoints and auth
 * were verified against each vendor on 2026-10-18; re-verify before changing one.
 */
export const MCP_CATALOG_ACCESS = ['read-write', 'read-only'] as const;
export type McpCatalogAccess = (typeof MCP_CATALOG_ACCESS)[number];

export interface McpCatalogToken {
  /** Where the user creates the token the install asks for. */
  readonly createUrl: string;
  /** The kind of token, as the vendor names it. */
  readonly label: string;
}

interface McpCatalogEntryBase {
  readonly description: string;
  readonly docsUrl: string;
  /** The configured server name an install writes; also the catalog key. */
  readonly id: string;
  readonly name: string;
  /** `read-only` exists only where the vendor's server enforces it. */
  readonly urls: { readonly 'read-only'?: string; readonly 'read-write': string };
}

export type McpCatalogEntry =
  | (McpCatalogEntryBase & { readonly auth: 'oauth' })
  | (McpCatalogEntryBase & { readonly auth: 'token'; readonly token: McpCatalogToken });

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    auth: 'oauth',
    description: 'Issues, projects, cycles and documents in your Linear workspace.',
    docsUrl: 'https://linear.app/docs/mcp',
    id: 'linear',
    name: 'Linear',
    urls: {
      'read-only': 'https://mcp.linear.app/mcp/readonly',
      'read-write': 'https://mcp.linear.app/mcp',
    },
  },
  {
    auth: 'token',
    description: 'Repositories, issues, pull requests and Actions on github.com.',
    docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    id: 'github',
    name: 'GitHub',
    token: {
      createUrl: 'https://github.com/settings/personal-access-tokens/new',
      label: 'Fine-grained personal access token',
    },
    urls: {
      'read-only': 'https://api.githubcopilot.com/mcp/readonly',
      'read-write': 'https://api.githubcopilot.com/mcp/',
    },
  },
  {
    auth: 'oauth',
    description: 'Jira and Confluence on your Atlassian Cloud site.',
    docsUrl:
      'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/',
    id: 'atlassian',
    name: 'Atlassian',
    urls: { 'read-write': 'https://mcp.atlassian.com/v2/mcp' },
  },
  {
    auth: 'oauth',
    description: 'Projects, merge requests, issues and pipelines on gitlab.com.',
    docsUrl: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
    id: 'gitlab',
    name: 'GitLab',
    urls: { 'read-write': 'https://gitlab.com/api/v4/mcp' },
  },
];

export interface McpCatalogCredentialReference {
  readonly id: string;
  readonly store: 'mcp-credentials';
}

/** One install request from Settings; `token` only for a token entry. */
export interface McpCatalogInstallRequest {
  readonly access: McpCatalogAccess;
  readonly catalogId: string;
  readonly token?: string;
}

export function findMcpCatalogEntry(catalogId: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === catalogId);
}

/**
 * The config server entry one catalog install appends. A token entry needs the
 * reference to its stored token; an OAuth entry takes none.
 */
export function mcpCatalogServerInput(
  entry: McpCatalogEntry,
  access: McpCatalogAccess,
  credential?: McpCatalogCredentialReference
): McpServerInput {
  const url = entry.urls[access];
  if (url === undefined) {
    throw new Error(`${entry.name} has no ${access} endpoint`);
  }
  if (entry.auth === 'oauth') {
    if (credential !== undefined) {
      throw new Error(`${entry.name} signs in with OAuth and takes no token`);
    }
    return {
      auth: { type: 'oauth-user' },
      name: entry.id,
      protocol: 'auto',
      transport: 'streamable-http',
      url,
    };
  }
  if (credential === undefined) {
    throw new Error(`${entry.name} needs a stored token`);
  }
  return {
    auth: { credential: { id: credential.id, store: credential.store }, type: 'bearer' },
    name: entry.id,
    protocol: 'auto',
    transport: 'streamable-http',
    url,
  };
}
```

In `packages/assistant-contract/package.json`, add this entry to `exports`, directly after `"./mcp-config"`, in the same shape:

```json
    "./mcp-catalog": {
      "types": "./dist/mcp-catalog.d.ts",
      "import": "./dist/mcp-catalog.js",
      "require": "./dist/mcp-catalog.js"
    },
```

Do not add an export to `packages/assistant-contract/src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes, then type-check and build**

Run: `pnpm --filter @brainstrike/assistant-contract exec vitest run src/__tests__/mcp-catalog.test.ts`
Expected: PASS (5 tests).

Run: `pnpm --filter @brainstrike/assistant-contract type-check && pnpm --filter @brainstrike/assistant-contract build && node --test scripts/__tests__/mcp-config-schema-ownership.test.mjs`
Expected: all exit 0; `dist/mcp-catalog.js` exists.

- [ ] **Step 5: Commit**

```bash
git add packages/assistant-contract/src/mcp-catalog.ts packages/assistant-contract/src/__tests__/mcp-catalog.test.ts packages/assistant-contract/package.json
git commit -m "feat(mcp): curated catalog of official Linear, GitHub, Atlassian and GitLab remote servers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bearer credential writer

**Files:**
- Modify: `packages/host-capabilities/src/mcp/bearer-credential.ts` (append after `createSecretsMcpBearerCredentialAuthority`)
- Test: `packages/host-capabilities/__tests__/mcp-bearer-credential-writer.test.ts`

**Interfaces:**
- Consumes: `SecretsService` (`saveKey`, `deleteKey`) from `@brainstrike/agent-host/credential-contract`; the existing `McpBearerCredentialReference`, `McpBearerCredentialFailure`, `mcpBearerCredentialStorageKey` and `isBearerToken` in the same file.
- Produces:
  - `interface McpBearerCredentialWriter { create(token: string): Promise<McpBearerCredentialReference>; delete(reference: McpBearerCredentialReference): Promise<void> }`
  - `createSecretsMcpBearerCredentialWriter(secrets: Pick<SecretsService, 'deleteKey' | 'saveKey'>, newId?: () => string): McpBearerCredentialWriter`. `create` rejects a malformed token with `McpBearerCredentialFailure` code `mcp-bearer-credential-malformed` before any write. `delete` throws `'MCP bearer credential could not be removed'` when the store removed nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/host-capabilities/__tests__/mcp-bearer-credential-writer.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createHostCredentials, type HostCredentials } from '../src/index.js';
import {
  createSecretsMcpBearerCredentialAuthority,
  createSecretsMcpBearerCredentialWriter,
  mcpBearerCredentialStorageKey,
} from '../src/mcp/bearer-credential.js';
import { memoryCredentialBackend } from './fixtures/memory-credential-backend.js';

const ID = '00000000-0000-4000-8000-000000000002';
const TOKEN = 'github_pat_fixture0123456789';
const opened: HostCredentials[] = [];

function credentials() {
  const memory = memoryCredentialBackend();
  const host = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  opened.push(host);
  return { host, memory };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((host) => host.close()));
});

describe('MCP bearer credential writer', () => {
  it('stores a token under a fresh reference that the bearer reader resolves', async () => {
    const { host, memory } = credentials();
    const writer = createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID);

    const reference = await writer.create(TOKEN);

    expect(reference).toEqual({ id: ID, store: 'mcp-credentials' });
    expect([...memory.entries.keys()]).toEqual([mcpBearerCredentialStorageKey(reference)]);
    await expect(
      createSecretsMcpBearerCredentialAuthority(host.secrets()).inspect(reference)
    ).resolves.toEqual({ state: 'stored' });
    expect(JSON.stringify(reference)).not.toContain(TOKEN);
  });

  it('refuses a malformed token before anything is stored', async () => {
    const { host, memory } = credentials();
    const writer = createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID);

    await expect(writer.create('has a space')).rejects.toMatchObject({
      code: 'mcp-bearer-credential-malformed',
    });
    expect(memory.entries.size).toBe(0);
  });

  it('removes a stored token and reports a removal that found nothing', async () => {
    const { host, memory } = credentials();
    const writer = createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID);
    const reference = await writer.create(TOKEN);

    await writer.delete(reference);

    expect(memory.entries.size).toBe(0);
    await expect(writer.delete(reference)).rejects.toThrow(
      'MCP bearer credential could not be removed'
    );
  });

  it("is swept by the factory reset's clearAll with every other secret", async () => {
    const { host, memory } = credentials();
    const reference = await createSecretsMcpBearerCredentialWriter(host.secrets(), () => ID).create(
      TOKEN
    );

    await expect(host.secrets().clearAll()).resolves.toBe(true);

    expect(memory.entries.has(mcpBearerCredentialStorageKey(reference))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/host-capabilities exec vitest run __tests__/mcp-bearer-credential-writer.test.ts`
Expected: FAIL, `createSecretsMcpBearerCredentialWriter is not a function`.

- [ ] **Step 3: Write the writer**

In `packages/host-capabilities/src/mcp/bearer-credential.ts`, change the `SecretsService` import to stay a type import (it already is) and append:

```ts
/** Stores and removes the tokens that `bearer` config references name. */
export interface McpBearerCredentialWriter {
  /** Stores `token` under a fresh reference; a malformed token is refused before any write. */
  create(token: string): Promise<McpBearerCredentialReference>;
  /** Removes a stored token; throws when the store reports nothing was removed. */
  delete(reference: McpBearerCredentialReference): Promise<void>;
}

/** The one writer of `mcp-credentials:<uuid>` secrets; the reader above resolves them. */
export function createSecretsMcpBearerCredentialWriter(
  secrets: Pick<SecretsService, 'deleteKey' | 'saveKey'>,
  newId: () => string = () => crypto.randomUUID()
): McpBearerCredentialWriter {
  return {
    async create(token) {
      if (!isBearerToken(token)) {
        throw new McpBearerCredentialFailure('mcp-bearer-credential-malformed');
      }
      const reference: McpBearerCredentialReference = { id: newId(), store: 'mcp-credentials' };
      if (!(await secrets.saveKey(mcpBearerCredentialStorageKey(reference), token))) {
        throw new Error('MCP bearer credential could not be stored');
      }
      return reference;
    },
    async delete(reference) {
      if (!(await secrets.deleteKey(mcpBearerCredentialStorageKey(reference)))) {
        throw new Error('MCP bearer credential could not be removed');
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/host-capabilities exec vitest run __tests__/mcp-bearer-credential-writer.test.ts`
Expected: PASS (4 tests).

Run: `pnpm --filter @brainstrike/host-capabilities type-check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/host-capabilities/src/mcp/bearer-credential.ts packages/host-capabilities/__tests__/mcp-bearer-credential-writer.test.ts
git commit -m "feat(mcp): bearer credential writer stores and removes mcp-credentials tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Install on the settings authority

**Files:**
- Modify: `packages/host-capabilities/src/mcp/settings-authority.ts` (imports at lines 1-39; options at lines 58-65; `writeConfigText` at lines 218-245)
- Modify: `packages/host-capabilities/__tests__/mcp-settings-authority-harness.ts`
- Modify: `apps/desktop/src/__tests__/main/mcp-host-service.test.ts:146` (constructor options)
- Test: `packages/host-capabilities/__tests__/mcp-settings-authority-catalog.test.ts`

**Interfaces:**
- Consumes: Task 1's `findMcpCatalogEntry`, `mcpCatalogServerInput` and `McpCatalogInstallRequest`; Task 2's `McpBearerCredentialWriter` and `McpBearerCredentialReference`; `parseMcpConfig` and `McpConfigWriteResult` from `./config-file.js`; `applyEdits` and `modify` from `jsonc-parser`.
- Produces:
  - `McpSettingsAuthorityOptions.bearerCredentials: McpBearerCredentialWriter` (required).
  - `McpSettingsAuthority.installCatalogServer(request: McpCatalogInstallRequest): Promise<McpConfigWriteResult>`.
  - Refusal messages, exact strings:
    - `Unknown MCP catalog entry "<id>".`
    - `<Name> has no <access> endpoint.`
    - `<Name> signs in with OAuth and takes no token.`
    - `<Name> needs a token.`
    - `Fix the MCP config before installing <Name>: <parse error>`
    - `An MCP server named "<id>" is already configured.`
    - `<Name> token was not stored: <cause>`
    - `<write error>; the stored <Name> token could not be removed: <cause>`
  - Harness: `bearer: { stored: Map<string, string>; writer }`, where `writer.create` and `writer.delete` are `vi.fn` mocks.

- [ ] **Step 1: Give the harness an in-memory bearer writer**

In `packages/host-capabilities/__tests__/mcp-settings-authority-harness.ts`, add this import after the `config-file.js` import block:

```ts
import type {
  McpBearerCredentialReference,
  McpBearerCredentialWriter,
} from '../src/mcp/bearer-credential.js';
```

Add this function above `createSettingsHarness`:

```ts
/** The profile's MCP token store, in memory: fresh ids, and removal of a missing token fails. */
function createBearerCredentials() {
  const stored = new Map<string, string>();
  let next = 0;
  const writer = {
    create: vi.fn(async (token: string): Promise<McpBearerCredentialReference> => {
      next += 1;
      const id = `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
      stored.set(id, token);
      return { id, store: 'mcp-credentials' };
    }),
    delete: vi.fn(async (reference: McpBearerCredentialReference): Promise<void> => {
      if (!stored.delete(reference.id)) {
        throw new Error('MCP bearer credential could not be removed');
      }
    }),
  } satisfies McpBearerCredentialWriter;
  return { stored, writer };
}
```

In `createSettingsHarness`, create it next to the runtime and pass it to the authority:

```ts
  const bearer = createBearerCredentials();
  // …existing realFile / configFile setup unchanged…
  const authority = new McpSettingsAuthority({
    bearerCredentials: bearer.writer,
    configFile,
    extensionStore: settings.store,
    runtime: fake.runtime,
    userDataDir,
  });
```

Add `bearer,` to the returned object, between `authority,` and `configFile,`.

- [ ] **Step 2: Write the failing test**

Create `packages/host-capabilities/__tests__/mcp-settings-authority-catalog.test.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsHarness, type SettingsHarness } from './mcp-settings-authority-harness.js';

const COMMENTED = `{
  // keep this comment
  "servers": [
    // and this one
  ]
}
`;
const TOKEN = 'github_pat_fixture0123456789';

let harness: SettingsHarness | undefined;

async function started(content = COMMENTED): Promise<SettingsHarness> {
  harness = await createSettingsHarness();
  await mkdir(path.dirname(harness.configPath), { recursive: true });
  await writeFile(harness.configPath, content, 'utf8');
  await harness.authority.start();
  return harness;
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

describe('MCP catalog install', () => {
  it('appends the OAuth server, keeps the comments and commits it to the runtime', async () => {
    const h = await started();

    await expect(
      h.authority.installCatalogServer({ access: 'read-only', catalogId: 'linear' })
    ).resolves.toEqual({ path: h.configPath, success: true });

    const text = await readFile(h.configPath, 'utf8');
    expect(text).toContain('// keep this comment');
    expect(text).toContain('// and this one');
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [
        expect.objectContaining({
          auth: { type: 'oauth-user' },
          name: 'linear',
          startup: 'authentication-required',
          url: 'https://mcp.linear.app/mcp/readonly',
        }),
      ],
    });
    expect(h.bearer.writer.create).not.toHaveBeenCalled();
  });

  it('stores a token entry and writes only its reference to the file', async () => {
    const h = await started();

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({ path: h.configPath, success: true });

    expect(await readFile(h.configPath, 'utf8')).not.toContain(TOKEN);
    const [stored] = [...h.bearer.stored];
    expect(stored?.[1]).toBe(TOKEN);
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [
        expect.objectContaining({
          auth: { credential: { id: stored?.[0], store: 'mcp-credentials' }, type: 'bearer' },
          name: 'github',
          url: 'https://api.githubcopilot.com/mcp/',
        }),
      ],
    });
  });

  it('refuses a server name that is already configured and leaves the file untouched', async () => {
    const existing = JSON.stringify({
      servers: [
        {
          auth: { type: 'oauth-user' },
          name: 'linear',
          protocol: 'auto',
          transport: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
        },
      ],
    });
    const h = await started(existing);

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'linear' })
    ).resolves.toEqual({
      error: 'An MCP server named "linear" is already configured.',
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(existing);
  });

  it('refuses while the config does not parse and never overwrites it', async () => {
    const broken = '{ "servers": [ { "name": "x" ';
    const h = await started(broken);

    const result = await h.authority.installCatalogServer({
      access: 'read-write',
      catalogId: 'gitlab',
    });

    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error).toMatch(
      /^Fix the MCP config before installing GitLab: invalid_mcp_config/u
    );
    expect(await readFile(h.configPath, 'utf8')).toBe(broken);
  });

  it('refuses mismatched requests before touching the token store or the file', async () => {
    const h = await started();
    const refused = (error: string) => ({ error, path: h.configPath, success: false });

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'jira' })
    ).resolves.toEqual(refused('Unknown MCP catalog entry "jira".'));
    await expect(
      h.authority.installCatalogServer({ access: 'read-only', catalogId: 'gitlab' })
    ).resolves.toEqual(refused('GitLab has no read-only endpoint.'));
    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'linear', token: TOKEN })
    ).resolves.toEqual(refused('Linear signs in with OAuth and takes no token.'));
    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github' })
    ).resolves.toEqual(refused('GitHub needs a token.'));
    expect(h.bearer.writer.create).not.toHaveBeenCalled();
    expect(await readFile(h.configPath, 'utf8')).toBe(COMMENTED);
  });

  it('reports a token the store refuses and leaves the file untouched', async () => {
    const h = await started();
    h.bearer.writer.create.mockRejectedValueOnce(new Error('MCP bearer credential is malformed'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      error: 'GitHub token was not stored: MCP bearer credential is malformed',
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(COMMENTED);
  });

  it('removes the stored token when the config write fails', async () => {
    const h = await started();
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      error: 'disk full',
      path: h.configPath,
      success: false,
    });

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({ error: 'disk full', path: h.configPath, success: false });
    expect(h.bearer.writer.delete).toHaveBeenCalledOnce();
    expect(h.bearer.stored.size).toBe(0);
  });

  it('reports both failures when the token cannot be removed after a failed write', async () => {
    const h = await started();
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      error: 'disk full',
      path: h.configPath,
      success: false,
    });
    h.bearer.writer.delete.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      error: 'disk full; the stored GitHub token could not be removed: keychain locked',
      path: h.configPath,
      success: false,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/host-capabilities exec vitest run __tests__/mcp-settings-authority-catalog.test.ts`
Expected: FAIL, `h.authority.installCatalogServer is not a function`.

- [ ] **Step 4: Implement the install**

In `packages/host-capabilities/src/mcp/settings-authority.ts`:

Add these imports to the existing import block (keep it sorted the way Biome sorts it):

```ts
import {
  findMcpCatalogEntry,
  type McpCatalogInstallRequest,
  mcpCatalogServerInput,
} from '@brainstrike/assistant-contract/mcp-catalog';
import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser';
import type { McpBearerCredentialReference, McpBearerCredentialWriter } from './bearer-credential.js';
```

Replace the `./config-file.js` type import with:

```ts
import {
  type LoadedMcpConfig,
  type McpConfigFile,
  type McpConfigWriteResult,
  parseMcpConfig,
  type ResolvedMcpConfig,
} from './config-file.js';
```

Below `const MAX_MCP_CONFIG_TEXT_BYTES = 1_000_000;` add:

```ts
const CONFIG_FORMATTING: FormattingOptions = { eol: '\n', insertSpaces: true, tabSize: 2 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

In `McpSettingsAuthorityOptions`, add as the first member:

```ts
  /** The one writer of the `mcp-credentials` tokens a catalog install stores. */
  readonly bearerCredentials: McpBearerCredentialWriter;
```

Replace the body of `writeConfigText` from `const restartWatcher = …` through `return result;` with a call to a new shared helper, so the method reads:

```ts
  writeConfigText({
    content,
  }: HostParams<'mcp/config/write'>): Promise<HostResults['mcp/config/write']> {
    return this.#trackOperation(async (lifecycleEpoch) => {
      const configPath = await this.options.configFile.path();
      if (content.trim().length === 0) {
        return { error: 'MCP config content cannot be empty', path: configPath, success: false };
      }
      if (Buffer.byteLength(content, 'utf-8') > MAX_MCP_CONFIG_TEXT_BYTES) {
        return {
          error: `MCP config exceeds ${MAX_MCP_CONFIG_TEXT_BYTES} bytes`,
          path: configPath,
          success: false,
        };
      }
      return await this.#commitConfigText(content, lifecycleEpoch);
    });
  }

  /**
   * Appends one catalog server to the config (spec 2026-10-18 §4.2). A token
   * entry stores its token first and removes it again when the write fails.
   */
  installCatalogServer(request: McpCatalogInstallRequest): Promise<McpConfigWriteResult> {
    return this.#trackOperation(async (lifecycleEpoch) => {
      const configPath = await this.options.configFile.path();
      const refuse = (error: string): McpConfigWriteResult => ({
        error,
        path: configPath,
        success: false,
      });
      const entry = findMcpCatalogEntry(request.catalogId);
      if (!entry) {
        return refuse(`Unknown MCP catalog entry "${request.catalogId}".`);
      }
      if (entry.urls[request.access] === undefined) {
        return refuse(`${entry.name} has no ${request.access} endpoint.`);
      }
      if (entry.auth === 'oauth' && request.token !== undefined) {
        return refuse(`${entry.name} signs in with OAuth and takes no token.`);
      }
      if (entry.auth === 'token' && request.token === undefined) {
        return refuse(`${entry.name} needs a token.`);
      }
      const document = await this.options.configFile.readText(true);
      if (document.error !== undefined) {
        return refuse(`Fix the MCP config before installing ${entry.name}: ${document.error}`);
      }
      if (parseMcpConfig(document.content).servers.some(({ name }) => name === entry.id)) {
        return refuse(`An MCP server named "${entry.id}" is already configured.`);
      }
      let credential: McpBearerCredentialReference | undefined;
      if (request.token !== undefined) {
        try {
          credential = await this.options.bearerCredentials.create(request.token);
        } catch (error) {
          return refuse(`${entry.name} token was not stored: ${errorMessage(error)}`);
        }
      }
      const server = mcpCatalogServerInput(entry, request.access, credential);
      const content = applyEdits(
        document.content,
        modify(document.content, ['servers', -1], server, { formattingOptions: CONFIG_FORMATTING })
      );
      const result = await this.#commitConfigText(content, lifecycleEpoch);
      if (result.success || credential === undefined) {
        return result;
      }
      try {
        await this.options.bearerCredentials.delete(credential);
        return result;
      } catch (error) {
        return refuse(
          `${result.error}; the stored ${entry.name} token could not be removed: ${errorMessage(error)}`
        );
      }
    });
  }

  /** Writes config text on this lifecycle and reloads it; the watcher pauses across the write. */
  async #commitConfigText(content: string, lifecycleEpoch: number): Promise<McpConfigWriteResult> {
    const restartWatcher = this.#unwatch !== null;
    this.#stopWatcher();
    const result = await this.options.configFile.writeText(content);
    if (restartWatcher) {
      await this.#restartWatcherForLifecycle(lifecycleEpoch);
    }
    if (result.success) {
      logger.info('MCP config text updated', { path: result.path });
      await this.#reloadForLifecycle(lifecycleEpoch);
    }
    return result;
  }
```

Place `#commitConfigText` with the other private `#…ForLifecycle` helpers near line 695 if Biome's member ordering asks for it; behavior is identical.

In `apps/desktop/src/__tests__/main/mcp-host-service.test.ts`, add the new required option to the `new McpSettingsAuthority({…})` call (first key, sorted):

```ts
      bearerCredentials: { create: vi.fn(), delete: vi.fn() },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/host-capabilities exec vitest run __tests__/mcp-settings-authority-catalog.test.ts __tests__/mcp-settings-authority.test.ts __tests__/mcp-settings-authority-status.test.ts __tests__/mcp-settings-authority-preferences.test.ts`
Expected: PASS. The three existing authority suites still pass after the `#commitConfigText` extraction.

Run: `pnpm --filter @brainstrike/host-capabilities type-check && pnpm --filter @brainstrike/host-capabilities exec biome check src/mcp/settings-authority.ts`
Expected: exit 0, no line-cap or complexity error. If `noExcessiveCognitiveComplexity` fires on `installCatalogServer`, move the four request checks (unknown id → token mismatch) into a module-level `function catalogRequestRefusal(request): string | undefined` and keep the method body otherwise unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/host-capabilities/src/mcp/settings-authority.ts packages/host-capabilities/__tests__/mcp-settings-authority-harness.ts packages/host-capabilities/__tests__/mcp-settings-authority-catalog.test.ts apps/desktop/src/__tests__/main/mcp-host-service.test.ts
git commit -m "feat(mcp): the settings authority installs a catalog server into the profile config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Host method `mcp/config/install` and desktop host composition

**Files:**
- Modify: `packages/agent-host/src/protocol-mcp-settings.ts:116-175`
- Modify: `packages/agent-host/src/ports.ts:538-570` (`HostMcpSettingsService`)
- Modify: `packages/agent-host/src/mcp-settings-connection.ts:66-70`
- Modify: `packages/agent-host/__tests__/mcp-settings-connection.test.ts`
- Modify: `packages/host-capabilities/src/mcp/settings-authority.ts` (signature only)
- Modify: `packages/host-capabilities/src/mcp/desktop-node-mcp.ts:10, 129-135, 230-238`
- Modify: `packages/host-capabilities/__tests__/desktop-mcp-diagnostics.test.ts:178-181`

**Interfaces:**
- Consumes: Task 1's `MCP_CATALOG_ACCESS`; Task 2's `createSecretsMcpBearerCredentialWriter`; Task 3's `installCatalogServer`.
- Produces:
  - Host method `mcp/config/install`, params `{ access: 'read-write' | 'read-only'; catalogId: string; token?: string }`, result `{ path: string; success: true } | { error: string; path: string; success: false }`.
  - `HostMcpSettingsService.installCatalogServer(request: HostParams<'mcp/config/install'>): Promise<HostResults['mcp/config/install']>`.
  - `DesktopNodeMcpCredentials.secrets(): Pick<SecretsService, 'deleteKey' | 'getKey' | 'listProviders' | 'saveKey'>`.

- [ ] **Step 1: Write the failing routing test**

Append to `packages/agent-host/__tests__/mcp-settings-connection.test.ts`, inside the `describe('host MCP settings methods', …)` block:

```ts
  it('routes a catalog install, token included, to the settings authority', async () => {
    const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
    const installCatalogServer = vi.fn(async () => ({ path: '/tmp/mcp.json', success: true }));
    bindHostMcpSettingsMethods(
      (method, request) => {
        handlers.set(method, request as (params: unknown) => Promise<unknown>);
      },
      { sendNotification: vi.fn(async () => undefined) } as unknown as MessageConnection,
      { installCatalogServer } as unknown as HostMcpSettingsService,
      'desktop-ui'
    );
    const install = handlers.get('mcp/config/install');
    if (!install) {
      throw new Error('mcp/config/install was not bound');
    }
    const request = { access: 'read-write', catalogId: 'github', token: 'fixture-token' };

    await expect(install(request)).resolves.toEqual({ path: '/tmp/mcp.json', success: true });
    expect(installCatalogServer).toHaveBeenCalledWith(request);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/agent-host exec vitest run __tests__/mcp-settings-connection.test.ts`
Expected: FAIL, `mcp/config/install was not bound`.

- [ ] **Step 3: Declare the method, the port and the handler**

In `packages/agent-host/src/protocol-mcp-settings.ts`, add the import:

```ts
import { MCP_CATALOG_ACCESS } from '@brainstrike/assistant-contract/mcp-catalog';
```

Above `export const MCP_SETTINGS_METHOD_SCHEMAS`, add a shared result schema:

```ts
/** A config write or catalog install: the file it changed, or why nothing changed. */
const McpConfigWriteResultSchema = Schema.Union(
  [
    Schema.Struct({ path: Schema.String, success: Schema.Literal(true) }),
    Schema.Struct({ error: Schema.String, path: Schema.String, success: Schema.Literal(false) }),
  ],
  { mode: 'oneOf' }
);
```

In `MCP_SETTINGS_METHOD_SCHEMAS`, add before `'mcp/config/path'`:

```ts
  /** Appends one curated catalog server; `token` only for a token entry, stored by the host. */
  'mcp/config/install': Schema.Struct({
    access: Schema.Literals(MCP_CATALOG_ACCESS),
    catalogId: Id,
    token: Schema.optional(Schema.String),
  }),
```

In `MCP_SETTINGS_RESULT_SCHEMAS`, add before `'mcp/config/path'`:

```ts
  'mcp/config/install': McpConfigWriteResultSchema,
```

and replace the inline `'mcp/config/write': Schema.Union([...], { mode: 'oneOf' })` with:

```ts
  'mcp/config/write': McpConfigWriteResultSchema,
```

In `packages/agent-host/src/ports.ts`, add to `HostMcpSettingsService` after `extensions()`:

```ts
  /** Appends one catalog server to the profile's config, storing its token when it has one. */
  installCatalogServer(
    request: HostParams<'mcp/config/install'>
  ): Promise<HostResults['mcp/config/install']>;
```

In `packages/agent-host/src/mcp-settings-connection.ts`, add after the `'mcp/config/write'` handler:

```ts
  handle('mcp/config/install', (params) => visible(() => service().installCatalogServer(params)));
```

In `packages/host-capabilities/src/mcp/settings-authority.ts`, change the method signature to match its siblings, and drop the now-unused `McpCatalogInstallRequest` import:

```ts
  installCatalogServer(
    request: HostParams<'mcp/config/install'>
  ): Promise<HostResults['mcp/config/install']> {
```

- [ ] **Step 4: Compose the writer in the desktop MCP host**

In `packages/host-capabilities/src/mcp/desktop-node-mcp.ts`:

```ts
import {
  createSecretsMcpBearerCredentialAuthority,
  createSecretsMcpBearerCredentialWriter,
} from './bearer-credential.js';
```

```ts
/** The profile credential store Main and this host share. */
export interface DesktopNodeMcpCredentials {
  /** MCP bearer tokens behind the host's credential gate: read by transports, written by catalog installs. */
  secrets(): Pick<SecretsService, 'deleteKey' | 'getKey' | 'listProviders' | 'saveKey'>;
  /** The raw accounts: this host is the one writer of its MCP OAuth records. */
  store(): McpOAuthCredentialStorage;
}
```

In the `new DesktopMcpSettingsAuthority({ … })` options, add as the first key:

```ts
      bearerCredentials: createSecretsMcpBearerCredentialWriter({
        deleteKey: (key) => credentials.secrets().deleteKey(key),
        saveKey: (key, value) => credentials.secrets().saveKey(key, value),
      }),
```

In `packages/host-capabilities/__tests__/desktop-mcp-diagnostics.test.ts`, widen the credentials fake:

```ts
      secrets: () => ({
        deleteKey: async () => false,
        getKey: async () => null,
        listProviders: async () => [],
        saveKey: async () => false,
      }),
```

- [ ] **Step 5: Run the tests, build, and type-check every consumer**

Run: `pnpm --filter @brainstrike/agent-host exec vitest run __tests__/mcp-settings-connection.test.ts`
Expected: PASS (3 tests).

Run: `pnpm turbo run build --filter=@brainstrike/agent-host --filter=@brainstrike/host-capabilities`
Expected: exit 0.

Run: `pnpm --filter @brainstrike/agent-host type-check && pnpm --filter @brainstrike/host-capabilities type-check && pnpm --filter @brainstrike/desktop type-check`
Expected: exit 0. `apps/desktop/src/agent-host-platform/desktop-node-platform.ts` passes `host.auth.secrets()`. If its type lacks `saveKey`/`deleteKey`, the compiler names the site: pass the full `SecretsService` the host already holds there instead of a narrower view. Fix every site it names before running more tests.

Run: `pnpm --filter @brainstrike/host-capabilities exec vitest run __tests__/desktop-mcp-diagnostics.test.ts __tests__/mcp-settings-authority-catalog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-host/src/protocol-mcp-settings.ts packages/agent-host/src/ports.ts packages/agent-host/src/mcp-settings-connection.ts packages/agent-host/__tests__/mcp-settings-connection.test.ts packages/host-capabilities/src/mcp/settings-authority.ts packages/host-capabilities/src/mcp/desktop-node-mcp.ts packages/host-capabilities/__tests__/desktop-mcp-diagnostics.test.ts
git commit -m "feat(mcp): host method mcp/config/install reaches the desktop settings authority

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Catalog section in Settings

**Files:**
- Create: `packages/settings-ui/src/settings/external-link.ts`
- Test: `packages/settings-ui/src/settings/__tests__/external-link.test.ts`
- Modify: `packages/settings-ui/src/settings/secrets/credential-inventory/credential-oauth-actions.tsx:13-28, 89`
- Modify: `packages/settings-ui/src/settings/tools/types.ts` (`ToolsSettingsOperations`)
- Create: `packages/settings-ui/src/settings/tools/mcp-catalog-section.tsx`
- Modify: `packages/settings-ui/src/settings/tools/mcp-config-panel.tsx` (render tree at about line 395)
- Test: `packages/settings-ui/src/settings/tools/__tests__/mcp-catalog-section.test.tsx`
- Modify: `packages/settings-ui/src/settings/tools/__tests__/mcp-config-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1's `MCP_CATALOG`, `McpCatalogAccess`, `McpCatalogEntry` and `McpCatalogInstallRequest`; `McpHostSnapshot` from `@brainstrike/assistant-contract`; the existing `getMcpServerStatus` and `subscribeMcpServerStatus` operations.
- Produces:
  - `openExternalLink(event: MouseEvent<HTMLAnchorElement>, url: string): Promise<string | undefined>` — resolves to the failure message when the desktop bridge could not open the link (owner ruling 2026-10-18: link failures are surfaced, never swallowed); `undefined` when it opened, or on web where the native anchor navigates.
  - `ToolsSettingsOperations.installMcpCatalogServer?: (request: McpCatalogInstallRequest) => Promise<{ success: true; path: string } | { success: false; path: string; error: string }>`
  - `McpCatalogSection` with props `{ blockedReason?: string | undefined; getMcpServerStatus; installMcpCatalogServer; onInstalled: () => Promise<void>; subscribeMcpServerStatus? }`
  - Test ids:
    - `mcp-catalog`
    - `mcp-catalog-card-<id>`
    - `mcp-catalog-installed-<id>`
    - `mcp-catalog-error-<id>`
    - `mcp-catalog-blocked`
    - `mcp-catalog-status-error`

- [ ] **Step 1: Extract the external-link helper and surface its failures**

Create `packages/settings-ui/src/settings/external-link.ts`:

```ts
import type { MouseEvent } from 'react';

/**
 * Desktop denies renderer navigation to external origins, so a link click routes
 * through the `window.platform.openExternal` bridge when it exists; without that
 * bridge (web) the native anchor navigation does the job.
 */
type OpenExternal = (target: string) => Promise<{ error?: string; ok: boolean }>;

/** Resolves to why the link did not open, or `undefined` when it opened (or the anchor navigates). */
export async function openExternalLink(
  event: MouseEvent<HTMLAnchorElement>,
  url: string
): Promise<string | undefined> {
  const platform = (window as unknown as { platform?: { openExternal?: unknown } }).platform;
  const openExternal = platform?.openExternal;
  if (typeof openExternal !== 'function') {
    return undefined;
  }
  // Synchronous, before the first await: the click's default navigation is cancelled.
  event.preventDefault();
  try {
    const result = await (openExternal as OpenExternal)(url);
    return result.ok ? undefined : (result.error ?? 'The link could not be opened.');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
```

In `credential-oauth-actions.tsx`:
- Delete the local `openVerificationUri` function. Keep the first sentence of its doc comment as a one-line comment above the anchor: `{/* The device flow hands the verification URI to the renderer, so this link must actually work. */}`.
- Import `openExternalLink` from `'../../external-link'`.
- In the component that renders the anchor, add `const [linkError, setLinkError] = useState<string | null>(null);` and change the anchor's handler to
  `onClick={(event) => void openExternalLink(event, status.verificationUri).then((failure) => setLinkError(failure === undefined ? null : `Couldn't open link: ${failure}`))}`.
  Render `{linkError ? <p className="text-destructive text-xs" data-testid={`credential-oauth-link-error-${slot.id}`} role="alert">{linkError}</p> : null}` directly after the anchor.
- Remove the `MouseEvent` type import if it's now unused.
- Create `packages/settings-ui/src/settings/__tests__/external-link.test.ts` (red first) covering:
  - with no `window.platform`, it resolves `undefined` and does not call `preventDefault`;
  - with `openExternal` resolving `{ ok: true }`, it resolves `undefined` and calls `preventDefault` once;
  - with `{ ok: false, error: 'Blocked protocol: file:' }`, it resolves `'Blocked protocol: file:'`;
  - with `{ ok: false }`, it resolves `'The link could not be opened.'`;
  - with a rejecting `openExternal`, it resolves the rejection's message.
  Set and delete `window.platform` per test, and pass `{ preventDefault: vi.fn() } as unknown as MouseEvent<HTMLAnchorElement>` as the event.

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/__tests__/external-link.test.ts src/settings/secrets`
Expected: PASS.

- [ ] **Step 2: Add the operation type**

In `packages/settings-ui/src/settings/tools/types.ts`, add the import:

```ts
import type { McpCatalogInstallRequest } from '@brainstrike/assistant-contract/mcp-catalog';
```

and add to `ToolsSettingsOperations`, after `getTools`:

```ts
  /** Install one catalog server into the profile's MCP config (desktop only). */
  installMcpCatalogServer?: (
    request: McpCatalogInstallRequest
  ) => Promise<{ success: true; path: string } | { success: false; path: string; error: string }>;
```

- [ ] **Step 3: Write the failing section test**

Create `packages/settings-ui/src/settings/tools/__tests__/mcp-catalog-section.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { type McpHostSnapshot, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpCatalogSection } from '../mcp-catalog-section';

const PATH = '/tmp/mcp.config.json';

function snapshot(...ids: string[]): McpHostSnapshot {
  return {
    revision: ids.length,
    servers: ids.map((id) => ({
      configuredProtocol: 'auto',
      configuredServerId: parseConfiguredMcpServerId(id),
      generation: 1,
      state: 'authentication-required',
      transport: 'streamable-http',
    })),
  };
}

function props(overrides: Partial<Parameters<typeof McpCatalogSection>[0]> = {}) {
  return {
    getMcpServerStatus: vi.fn(async () => snapshot()),
    installMcpCatalogServer: vi.fn(async () => ({ path: PATH, success: true as const })),
    onInstalled: vi.fn(async () => undefined),
    ...overrides,
  };
}

function card(id: string) {
  return within(screen.getByTestId(`mcp-catalog-card-${id}`));
}

afterEach(cleanup);

describe('MCP catalog section', () => {
  it('lists the four vendors and offers read-only only on Linear and GitHub', async () => {
    render(<McpCatalogSection {...props()} />);

    for (const id of ['linear', 'github', 'atlassian', 'gitlab']) {
      expect(await screen.findByTestId(`mcp-catalog-card-${id}`)).toBeInTheDocument();
    }
    expect(card('linear').getByRole('tab', { name: 'Read-only' })).toBeInTheDocument();
    expect(card('github').getByRole('tab', { name: 'Read-only' })).toBeInTheDocument();
    expect(card('atlassian').queryByRole('tab')).not.toBeInTheDocument();
    expect(card('gitlab').queryByRole('tab')).not.toBeInTheDocument();
    expect(card('github').getByText('Token')).toBeInTheDocument();
    expect(card('linear').getByText('OAuth')).toBeInTheDocument();
  });

  it('installs with the chosen access, then shows Installed and reloads the editor', async () => {
    const getMcpServerStatus = vi.fn(async () => snapshot());
    getMcpServerStatus.mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot('linear'));
    const p = props({ getMcpServerStatus });
    render(<McpCatalogSection {...p} />);

    fireEvent.mouseDown(await card('linear').findByRole('tab', { name: 'Read-only' }));
    fireEvent.click(card('linear').getByRole('button', { name: 'Install' }));

    expect(await screen.findByTestId('mcp-catalog-installed-linear')).toHaveTextContent(
      'Installed'
    );
    expect(p.installMcpCatalogServer).toHaveBeenCalledWith({
      access: 'read-only',
      catalogId: 'linear',
    });
    expect(p.onInstalled).toHaveBeenCalledOnce();
  });

  it('marks an already configured server Installed with no Install button', async () => {
    render(<McpCatalogSection {...props({ getMcpServerStatus: vi.fn(async () => snapshot('gitlab')) })} />);

    expect(await screen.findByTestId('mcp-catalog-installed-gitlab')).toBeInTheDocument();
    expect(card('gitlab').queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('sends a pasted GitHub token once, trimmed, and closes the dialog', async () => {
    const p = props();
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('github').findByRole('button', { name: 'Install' }));
    const field = await screen.findByLabelText('Fine-grained personal access token');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: '  github_pat_fixture  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(p.installMcpCatalogServer).toHaveBeenCalledWith({
        access: 'read-write',
        catalogId: 'github',
        token: 'github_pat_fixture',
      })
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Fine-grained personal access token')).not.toBeInTheDocument()
    );
  });

  it('shows the host refusal on the card and keeps Install available', async () => {
    const p = props({
      installMcpCatalogServer: vi.fn(async () => ({
        error: 'An MCP server named "atlassian" is already configured.',
        path: PATH,
        success: false as const,
      })),
    });
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('atlassian').findByRole('button', { name: 'Install' }));

    expect(await screen.findByTestId('mcp-catalog-error-atlassian')).toHaveTextContent(
      'An MCP server named "atlassian" is already configured.'
    );
    expect(card('atlassian').getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(p.onInstalled).not.toHaveBeenCalled();
  });

  it('blocks installs while the config editor holds unsaved text', async () => {
    render(<McpCatalogSection {...props({ blockedReason: 'Save or reload the config editor before installing.' })} />);

    expect(await screen.findByTestId('mcp-catalog-blocked')).toHaveTextContent(
      'Save or reload the config editor before installing.'
    );
    expect(card('linear').getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('shows a link that failed to open on the card instead of dropping it', async () => {
    const openExternal = vi.fn(async () => ({ error: 'Blocked by policy', ok: false }));
    Object.assign(window, { platform: { openExternal } });
    try {
      render(<McpCatalogSection {...props()} />);
      fireEvent.click(await card('gitlab').findByRole('link', { name: 'Docs' }));

      expect(await screen.findByTestId('mcp-catalog-error-gitlab')).toHaveTextContent(
        "Couldn't open link: Blocked by policy"
      );
      expect(openExternal).toHaveBeenCalledWith(
        'https://docs.gitlab.com/user/model_context_protocol/mcp_server/'
      );
    } finally {
      Reflect.deleteProperty(window, 'platform');
    }
  });

  it('says so when the installed servers cannot be read', async () => {
    render(
      <McpCatalogSection
        {...props({ getMcpServerStatus: vi.fn(async () => Promise.reject(new Error('host closed'))) })}
      />
    );

    expect(await screen.findByTestId('mcp-catalog-status-error')).toHaveTextContent(
      'Installed servers could not be read: host closed'
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/tools/__tests__/mcp-catalog-section.test.tsx`
Expected: FAIL, `Failed to resolve import "../mcp-catalog-section"`.

- [ ] **Step 5: Write the section**

Create `packages/settings-ui/src/settings/tools/mcp-catalog-section.tsx`:

```tsx
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import {
  MCP_CATALOG,
  type McpCatalogAccess,
  type McpCatalogEntry,
  type McpCatalogInstallRequest,
} from '@brainstrike/assistant-contract/mcp-catalog';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { openExternalLink } from '../external-link';
import type { ToolsSettingsOperations } from './types';

type InstallCatalogServer = NonNullable<ToolsSettingsOperations['installMcpCatalogServer']>;
type InstallResult = Awaited<ReturnType<InstallCatalogServer>>;
type TokenEntry = Extract<McpCatalogEntry, { auth: 'token' }>;

export interface McpCatalogSectionProps {
  /** Set while the config editor holds unsaved text that an install would leave stale. */
  blockedReason?: string | undefined;
  getMcpServerStatus: NonNullable<ToolsSettingsOperations['getMcpServerStatus']>;
  installMcpCatalogServer: InstallCatalogServer;
  onInstalled: () => Promise<void>;
  subscribeMcpServerStatus?: ToolsSettingsOperations['subscribeMcpServerStatus'];
}

const ACCESS_LABELS: Record<McpCatalogAccess, string> = {
  'read-only': 'Read-only',
  'read-write': 'Read & write',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredIds(snapshot: McpHostSnapshot): ReadonlySet<string> {
  return new Set(snapshot.servers.map(({ configuredServerId }) => configuredServerId));
}

/** One-click installs of the curated official remote MCP servers (spec 2026-10-18). */
export function McpCatalogSection({
  blockedReason,
  getMcpServerStatus,
  installMcpCatalogServer,
  onInstalled,
  subscribeMcpServerStatus,
}: McpCatalogSectionProps) {
  const [configured, setConfigured] = useState<ReadonlySet<string>>(() => new Set());
  const [statusError, setStatusError] = useState<string | null>(null);

  const readStatus = useCallback(async () => {
    try {
      setConfigured(configuredIds(await getMcpServerStatus()));
      setStatusError(null);
    } catch (error) {
      setStatusError(errorText(error));
    }
  }, [getMcpServerStatus]);

  useEffect(() => {
    void readStatus();
    return subscribeMcpServerStatus?.((snapshot) => setConfigured(configuredIds(snapshot)));
  }, [readStatus, subscribeMcpServerStatus]);

  const install = useCallback(
    async (request: McpCatalogInstallRequest): Promise<InstallResult> => {
      const result = await installMcpCatalogServer(request);
      if (result.success) {
        await readStatus();
        await onInstalled();
      }
      return result;
    },
    [installMcpCatalogServer, onInstalled, readStatus]
  );

  return (
    <Card data-testid="mcp-catalog">
      <CardHeader>
        <CardTitle>MCP catalog</CardTitle>
        <CardDescription>
          Official remote MCP servers. Installing adds the server to this profile&apos;s MCP config.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {statusError ? (
          <p className="text-destructive text-sm" data-testid="mcp-catalog-status-error" role="alert">
            Installed servers could not be read: {statusError}
          </p>
        ) : null}
        {blockedReason ? (
          <p className="text-muted-foreground text-sm" data-testid="mcp-catalog-blocked">
            {blockedReason}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {MCP_CATALOG.map((entry) => (
            <McpCatalogCard
              blocked={blockedReason !== undefined}
              entry={entry}
              installed={configured.has(entry.id)}
              key={entry.id}
              onInstall={install}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface McpCatalogCardProps {
  blocked: boolean;
  entry: McpCatalogEntry;
  installed: boolean;
  onInstall: (request: McpCatalogInstallRequest) => Promise<InstallResult>;
}

function McpCatalogCard({ blocked, entry, installed, onInstall }: McpCatalogCardProps) {
  const [access, setAccess] = useState<McpCatalogAccess>('read-write');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  const submit = async (token?: string): Promise<boolean> => {
    setError(null);
    setPending(true);
    try {
      const result = await onInstall({
        access,
        catalogId: entry.id,
        ...(token === undefined ? {} : { token }),
      });
      if (!result.success) {
        setError(result.error);
        return false;
      }
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setPending(false);
    }
  };

  const handleInstall = () => {
    if (entry.auth === 'token') {
      setTokenOpen(true);
      return;
    }
    void submit();
  };

  const reportLinkFailure = (failure: string | undefined) => {
    if (failure !== undefined) {
      setError(`Couldn't open link: ${failure}`);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={`mcp-catalog-card-${entry.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{entry.name}</span>
        <Badge variant="outline">{entry.auth === 'oauth' ? 'OAuth' : 'Token'}</Badge>
      </div>
      <p className="text-muted-foreground text-xs">{entry.description}</p>
      {entry.urls['read-only'] !== undefined && !installed ? (
        <Tabs
          onValueChange={(value) => setAccess(value === 'read-only' ? 'read-only' : 'read-write')}
          value={access}
        >
          <TabsList aria-label={`${entry.name} access`} size="sm">
            <TabsTrigger value="read-write">{ACCESS_LABELS['read-write']}</TabsTrigger>
            <TabsTrigger value="read-only">{ACCESS_LABELS['read-only']}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <a
          className="text-primary text-xs underline"
          href={entry.docsUrl}
          onClick={(event) => void openExternalLink(event, entry.docsUrl).then(reportLinkFailure)}
          rel="noreferrer"
          target="_blank"
        >
          Docs
        </a>
        {installed ? (
          <Badge data-testid={`mcp-catalog-installed-${entry.id}`} variant="secondary">
            Installed
          </Badge>
        ) : (
          <Button disabled={blocked || pending} onClick={handleInstall} size="sm">
            {pending ? 'Installing…' : 'Install'}
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-destructive text-xs" data-testid={`mcp-catalog-error-${entry.id}`} role="alert">
          {error}
        </p>
      ) : null}
      {entry.auth === 'token' ? (
        <McpCatalogTokenDialog
          entry={entry}
          error={error}
          onLinkFailure={reportLinkFailure}
          onOpenChange={setTokenOpen}
          onSubmit={submit}
          open={tokenOpen}
          pending={pending}
        />
      ) : null}
    </div>
  );
}

interface McpCatalogTokenDialogProps {
  entry: TokenEntry;
  error: string | null;
  onLinkFailure: (failure: string | undefined) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (token: string) => Promise<boolean>;
  open: boolean;
  pending: boolean;
}

/** The token goes straight to the install request and is cleared when it returns. */
function McpCatalogTokenDialog({
  entry,
  error,
  onLinkFailure,
  onOpenChange,
  onSubmit,
  open,
  pending,
}: McpCatalogTokenDialogProps) {
  const [token, setToken] = useState('');
  const inputId = useId();
  const trimmed = token.trim();

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setToken('');
    }
    onOpenChange(next);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed.length === 0) {
      return;
    }
    const installed = await onSubmit(trimmed);
    setToken('');
    if (installed) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Install {entry.name}</DialogTitle>
            <DialogDescription>
              BrainStrike stores the token in your system keychain and writes only a reference to it
              in the MCP config.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={inputId}>{entry.token.label}</Label>
            <Input
              autoComplete="off"
              id={inputId}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              value={token}
            />
            <a
              className="text-primary text-xs underline"
              href={entry.token.createUrl}
              onClick={(event) =>
                void openExternalLink(event, entry.token.createUrl).then(onLinkFailure)
              }
              rel="noreferrer"
              target="_blank"
            >
              Create a token
            </a>
            {error ? (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => handleOpenChange(false)} type="button" variant="secondary">
              Cancel
            </Button>
            <Button disabled={pending || trimmed.length === 0} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Run the section test to verify it passes**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/tools/__tests__/mcp-catalog-section.test.tsx`
Expected: PASS (8 tests). Radix `Tabs` activates on `mouseDown` in jsdom; if the "Read-only" tab does not switch, use `fireEvent.keyDown(tab, { key: 'Enter' })` the way `unified-tools-settings.test.tsx` drives its tabs.

- [ ] **Step 7: Write the failing panel test**

Append to `packages/settings-ui/src/settings/tools/__tests__/mcp-config-panel.test.tsx` (add `type McpHostSnapshot` to an `@brainstrike/assistant-contract` import at the top):

```tsx
describe('MCP catalog in the config panel', () => {
  const emptySnapshot: McpHostSnapshot = { revision: 0, servers: [] };

  it('renders the catalog only when the install capability exists', async () => {
    const without = operations();
    without.getMcpServerStatus = vi.fn(async () => emptySnapshot);
    const { unmount } = render(<McpConfigPanel onConfigChanged={vi.fn()} operations={without} />);
    await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    expect(screen.queryByTestId('mcp-catalog')).not.toBeInTheDocument();
    unmount();
  });

  it('blocks installs while the editor is dirty and reloads the editor after an install', async () => {
    const ops = operations();
    ops.getMcpServerStatus = vi.fn(async () => emptySnapshot);
    ops.installMcpCatalogServer = vi.fn(async () => ({ path, success: true as const }));
    const onConfigChanged = vi.fn(async () => undefined);
    render(<McpConfigPanel onConfigChanged={onConfigChanged} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    const gitlab = within(await screen.findByTestId('mcp-catalog-card-gitlab'));

    fireEvent.change(editor, { target: { value: `${validContent}\n` } });
    expect(gitlab.getByRole('button', { name: 'Install' })).toBeDisabled();

    fireEvent.change(editor, { target: { value: validContent } });
    fireEvent.click(gitlab.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(onConfigChanged).toHaveBeenCalledOnce());
    expect(ops.installMcpCatalogServer).toHaveBeenCalledWith({
      access: 'read-write',
      catalogId: 'gitlab',
    });
    expect(ops.readMcpConfigText).toHaveBeenCalledTimes(2);
  });
});
```

Add `waitFor` and `within` to the existing `@testing-library/react` import.

- [ ] **Step 8: Run the panel test to verify it fails**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/tools/__tests__/mcp-config-panel.test.tsx`
Expected: FAIL in the second new test, `Unable to find an element by: [data-testid="mcp-catalog-card-gitlab"]`.

- [ ] **Step 9: Render the section in the panel**

In `packages/settings-ui/src/settings/tools/mcp-config-panel.tsx`, import the section:

```ts
import { McpCatalogSection } from './mcp-catalog-section';
```

After `handleCancelReload`, add:

```ts
  const handleCatalogInstalled = useCallback(async () => {
    await loadDocument();
    await onConfigChanged();
  }, [loadDocument, onConfigChanged]);
```

In the returned tree, render it first inside `data-testid="mcp-config-editor-panel"`, before `<McpPathCard`:

```tsx
      {operations.installMcpCatalogServer && operations.getMcpServerStatus ? (
        <McpCatalogSection
          blockedReason={
            hasUnsavedChanges ? 'Save or reload the config editor before installing.' : undefined
          }
          getMcpServerStatus={operations.getMcpServerStatus}
          installMcpCatalogServer={operations.installMcpCatalogServer}
          onInstalled={handleCatalogInstalled}
          subscribeMcpServerStatus={operations.subscribeMcpServerStatus}
        />
      ) : null}
```

`loadDocument` and `hasUnsavedChanges` already exist in the component (`handleReload` uses both).

- [ ] **Step 10: Run the settings-ui tests and checks**

Run: `pnpm --filter @brainstrike/settings-ui exec vitest run src/settings/tools src/settings/secrets`
Expected: PASS.

Run: `pnpm --filter @brainstrike/settings-ui type-check && pnpm exec biome check packages/settings-ui/src/settings`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/settings-ui/src/settings/external-link.ts packages/settings-ui/src/settings/__tests__/external-link.test.ts packages/settings-ui/src/settings/secrets/credential-inventory/credential-oauth-actions.tsx packages/settings-ui/src/settings/tools/types.ts packages/settings-ui/src/settings/tools/mcp-catalog-section.tsx packages/settings-ui/src/settings/tools/mcp-config-panel.tsx packages/settings-ui/src/settings/tools/__tests__/mcp-catalog-section.test.tsx packages/settings-ui/src/settings/tools/__tests__/mcp-config-panel.test.tsx
git commit -m "feat(settings): MCP catalog cards install Linear, GitHub, Atlassian and GitLab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Desktop wiring and app-flow check

**Files:**
- Modify: `apps/desktop/src/renderer/components/settings/page-content.tsx:384-392`
- Modify: `apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx` (lines 95-114, 346-366, 445-452, 545-551)

**Interfaces:**
- Consumes: the `mcp/config/install` host method (Task 4); `ToolsSettingsOperations.installMcpCatalogServer` (Task 5).
- Produces: the desktop `installMcpCatalogServer` operation, present only when the window has the agent host's MCP settings.

- [ ] **Step 1: Write the failing routing test**

In `page-content-operations.test.tsx`:
- Add to `CapturedToolsOperations`:

```ts
  installMcpCatalogServer?: (request: {
    access: 'read-only' | 'read-write';
    catalogId: string;
    token?: string;
  }) => Promise<{ error?: string; path: string; success: boolean }>;
```

- Add to the fake `responses` map, before `'mcp/config/path'`:

```ts
    'mcp/config/install': () => ({ path: '/tmp/mcp.json', success: true }),
```

- In the test that asserts `writeMcpConfigText` routing (around line 545), add after that assertion:

```ts
    await expect(
      operations.installMcpCatalogServer?.({ access: 'read-only', catalogId: 'linear' })
    ).resolves.toEqual({ path: '/tmp/mcp.json', success: true });
    expect(settings.request).toHaveBeenCalledWith('mcp/config/install', {
      access: 'read-only',
      catalogId: 'linear',
    });
```

- In `'omits the host MCP settings operations where the window has no agent host'`, add:

```ts
    expect(operations).not.toHaveProperty('installMcpCatalogServer');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/desktop exec vitest run --config vitest.unit.config.mts src/__tests__/renderer/components/settings/page-content-operations.test.tsx`
Expected: FAIL, `operations.installMcpCatalogServer` is undefined, so the `resolves.toEqual` assertion fails.

- [ ] **Step 3: Route the operation**

In `apps/desktop/src/renderer/components/settings/page-content.tsx`, add the import:

```ts
import type { McpCatalogInstallRequest } from '@brainstrike/assistant-contract/mcp-catalog';
```

and in the `...(mcpSettings && { getMcpConfigPath, readMcpConfigText, setMcpConfigPath, writeMcpConfigText })` block, add between `getMcpConfigPath` and `readMcpConfigText`:

```ts
        installMcpCatalogServer: async (request: McpCatalogInstallRequest) =>
          await mcpSettings.request('mcp/config/install', request),
```

- [ ] **Step 4: Run the test and the desktop type-check**

Run: `pnpm --filter @brainstrike/desktop exec vitest run --config vitest.unit.config.mts src/__tests__/renderer/components/settings/page-content-operations.test.tsx`
Expected: PASS.

Run: `pnpm turbo run build --filter='@brainstrike/desktop^...' && pnpm --filter @brainstrike/desktop type-check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/components/settings/page-content.tsx apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx
git commit -m "feat(desktop): Settings routes MCP catalog installs to the agent host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: App-flow check on a disposable profile (no vendor sign-in)**

Build, then launch the built app against a throwaway profile. Run the launch in the background and keep its output file:

```bash
pnpm build
D=$(mktemp -d "${TMPDIR:-/tmp}/bs-mcp-catalog-XXXXXX")
mkdir -p "$D/userData" "$D/db"
cd apps/desktop
BRAINSTRIKE_AGENT_DEVTOOLS=1 BRAINSTRIKE_AGENT_DEVTOOLS_PORT=9233 \
BRAINSTRIKE_E2E_USER_DATA_DIR="$D/userData" BRAINSTRIKE_DB_ROOT_PATH="$D/db" \
BRAINSTRIKE_DB_PROFILE=live \
pnpm exec electron . --no-sandbox --brainstrike-desktop-launch-mode=built > "$D/electron.log" 2>&1
```

Drive the window over CDP on port 9233. The main window is the target in `http://127.0.0.1:9233/json` whose URL has no `?mode=`. Use a small Node client in the session scratchpad (Node 24 has global `fetch` and `WebSocket`): `Runtime.evaluate` for DOM queries and clicks, `Page.captureScreenshot` for proof.
1. Open Settings and the **AI Tools** category, then the **MCP Config** tab. Locate them by role and text in the DOM.
2. In `[data-testid="mcp-catalog-card-linear"]`, choose **Read-only**, then click **Install**.
3. Confirm `[data-testid="mcp-catalog-installed-linear"]` appears.
4. Confirm `"$D/userData/mcp/mcp.config.json"` now contains an entry with `"name": "linear"` and `"url": "https://mcp.linear.app/mcp/readonly"`, and still contains the template comments.
5. Open the **Tools** tab and confirm a Linear server row in the authentication-required state. Do **not** click Connect.
6. Capture a screenshot of the catalog card and the Tools row.

Stop with SIGTERM to the `Electron` process. Wait for "Graceful shutdown completed" in `$D/electron.log` (never `kill -9`), then `rm -rf "$D"`.

Expected: all six observations hold, and the log has no `Failed to load MCP config` or `MCP config watcher reload failed`. Report anything that doesn't hold as a failure, with the log excerpt.

---

## Validation summary (run after Task 6, before opening a PR)

```bash
pnpm --filter @brainstrike/assistant-contract test
pnpm --filter @brainstrike/host-capabilities test
pnpm --filter @brainstrike/agent-host test
pnpm --filter @brainstrike/settings-ui test
pnpm --filter @brainstrike/desktop test
pnpm type-check
node --test scripts/__tests__/mcp-config-schema-ownership.test.mjs
pnpm exec biome check packages/assistant-contract packages/host-capabilities packages/agent-host packages/settings-ui apps/desktop/src/renderer/components/settings
```

Report each command's actual result. If a suite was already red on `main`, say so with the failing test names and a `git log origin/main -- <test>` check; never describe a partial run as a full pass.
