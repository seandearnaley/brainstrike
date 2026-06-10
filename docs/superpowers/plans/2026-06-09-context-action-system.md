# Context Action System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a typed, capability-gated context action system (targets → actions → registry) with a Radix ContextMenu renderer, shipped on the file explorer tree and collection browser, with a `window.platform` desktop bridge for Reveal in Finder.

**Architecture:** A new headless package `@brainstrike/context-actions` owns the `ContextTarget` discriminated union, `ContextAction` definitions, a pure filtering registry, and a `ClipboardService`. `packages/ui` gains a Radix ContextMenu wrapper plus `ActionRegistryProvider`/`ActionContextMenu`. Surfaces adapt their node models into targets; the app shell composes the registry with platform-appropriate capabilities. Desktop-only actions are HIDDEN on web (capability absence), never shown disabled. No silent fallbacks: every action resolves to an `ActionOutcome` and failures toast + log.

**Tech Stack:** TypeScript strict, React 19, Radix UI (`@radix-ui/react-context-menu`), Zustand-adjacent existing stores (untouched), Vitest + Testing Library, Playwright, Electron IPC (`createDesktopIpcRegistry` pattern), pnpm workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-06-09-context-action-system-design.md`

**Conventions that apply to every task:**
- TypeScript strict, no `any` (use `unknown` + narrowing; one documented widening cast is allowed in `defineContextAction`).
- Kebab-case filenames; PascalCase component exports; `use-*` hook files.
- Run `pnpm dlx ultracite fix` before each commit (lefthook also runs checks).
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All commands run from the repo root unless stated otherwise.

**One naming deviation from the spec (intentional):** the desktop IPC domain/channels use `shell` (`shell:show-item-in-folder`) instead of `platform`, because `apps/desktop/src/platform/` and `main-platform-ipc.ts` already use "platform" for IPC *infrastructure*. The renderer-facing bridge keeps the spec name `window.platform`.

---

### Task 1: Scaffold `packages/context-actions`

**Files:**
- Create: `packages/context-actions/package.json`
- Create: `packages/context-actions/tsconfig.json`
- Create: `packages/context-actions/tsconfig.test.json`
- Create: `packages/context-actions/tsup.config.ts`
- Create: `packages/context-actions/vitest.config.mts`
- Create: `packages/context-actions/src/index.ts`
- Modify: `tsconfig.json` (root — add path mapping)

The scaffold clones `packages/platform-utils` (the smallest canonical package). React is a peer dependency for the `icon?: ComponentType` type only.

- [ ] **Step 1: Create `packages/context-actions/package.json`**

```json
{
  "name": "@brainstrike/context-actions",
  "description": "Headless context action system: targets, actions, registry, capability gating",
  "version": "0.1.0",
  "devDependencies": {
    "@types/node": "^25.6.0",
    "@types/react": "^19.2.14",
    "happy-dom": "^20.9.0",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.4"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "peerDependencies": {
    "react": "^19.2.4"
  },
  "scripts": {
    "build": "node ../../scripts/rimraf.mjs dist && tsc -b . && tsup src/index.ts --format esm,cjs --dts --out-dir dist",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:coverage": "pnpm run test --coverage --coverage.reporter=json --coverage.reporter=lcov --coverage.reporter=text",
    "test:watch": "vitest",
    "type-check": "tsc --noEmit && tsc --noEmit --project tsconfig.test.json"
  },
  "type": "module",
  "types": "./dist/index.d.ts"
}
```

- [ ] **Step 2: Create `packages/context-actions/tsconfig.json`**

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
    "rootDir": "src",
    "outDir": "dist",
    "declarationDir": "dist",
    "types": ["node"],
    "strictNullChecks": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.*", "**/__tests__/**"]
}
```

- [ ] **Step 3: Create `packages/context-actions/tsconfig.test.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vitest/globals", "node"],
    "skipLibCheck": true,
    "strictNullChecks": true
  },
  "include": ["src/**/*", "**/*.test.*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 4: Create `packages/context-actions/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: !options.watch,
}));
```

- [ ] **Step 5: Create `packages/context-actions/vitest.config.mts`**

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
```

- [ ] **Step 6: Create `packages/context-actions/src/index.ts`** (placeholder so the package compiles; Task 2 replaces it)

```ts
export const CONTEXT_ACTIONS_PACKAGE = '@brainstrike/context-actions';
```

- [ ] **Step 7: Add the root tsconfig path mapping**

In the root `tsconfig.json` `compilerOptions.paths`, add (alphabetical placement near the other `@brainstrike/*` entries):

```json
"@brainstrike/context-actions": [
  "packages/context-actions/src"
],
```

- [ ] **Step 8: Install and verify**

Run: `pnpm install`
Expected: lockfile updated, new workspace project listed (42 projects).

Run: `pnpm --filter @brainstrike/context-actions type-check`
Expected: PASS (no output errors).

- [ ] **Step 9: Commit**

```bash
git add packages/context-actions tsconfig.json pnpm-lock.yaml
git commit -m "feat(context-actions): scaffold headless context-actions package"
```

---

### Task 2: Core types, `defineContextAction`, and registry (TDD)

**Files:**
- Create: `packages/context-actions/src/types.ts`
- Create: `packages/context-actions/src/registry.ts`
- Create: `packages/context-actions/src/__tests__/registry.test.ts`
- Modify: `packages/context-actions/src/index.ts`

- [ ] **Step 1: Create `packages/context-actions/src/types.ts`**

```ts
import type { ComponentType } from 'react';

/**
 * Discriminated union describing WHAT was right-clicked. Surfaces adapt their
 * own node models into these shapes; renderers and actions never see surface
 * types. New surfaces add new kinds here.
 */
export type ContextTarget =
  | {
      kind: 'file-entry';
      name: string;
      /** Path relative to the picked root folder (both platforms). */
      relativePath: string;
      /** Absolute filesystem path on desktop; null on web (no such concept). */
      absolutePath: string | null;
      entryType: 'file' | 'directory';
      rootFolderId: string;
    }
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'collection-file'; id: string; name: string; path: string | null }
  | { kind: 'chunk'; id: string; content: string }
  | { kind: 'embedding'; id: string; vectorId: string };

export type ContextTargetKind = ContextTarget['kind'];

export type TargetOf<K extends ContextTargetKind> = Extract<ContextTarget, { kind: K }>;

/**
 * Capabilities are constructed by the app shell from the bridges that actually
 * exist (web never constructs 'fs.reveal'). An action missing a required
 * capability is HIDDEN — never disabled, never a stub that fails at click time.
 */
export type CapabilityKey = 'clipboard' | 'fs.reveal' | 'fs.openPath';

export type ActionOutcome = { ok: true; message?: string } | { ok: false; error: string };

export interface ClipboardService {
  writeText: (text: string) => Promise<ActionOutcome>;
}

export interface PlatformFsService {
  showItemInFolder: (absolutePath: string) => Promise<ActionOutcome>;
  openPath: (absolutePath: string) => Promise<ActionOutcome>;
}

export interface ActionServices {
  clipboard?: ClipboardService;
  platformFs?: PlatformFsService;
}

/** Menu group; determines ordering and separator placement. */
export type ActionGroup = 'tree' | 'copy' | 'navigate' | 'inspect' | 'danger';

export interface ContextAction<K extends ContextTargetKind = ContextTargetKind> {
  /** Stable id, namespaced by domain: 'file.copy-relative-path'. */
  id: string;
  label: string | ((target: TargetOf<K>) => string);
  icon?: ComponentType<{ className?: string }>;
  group: ActionGroup;
  appliesTo: readonly K[];
  /** Missing capability ⇒ item HIDDEN (spec decision: hide, don't disable). */
  requiredCapabilities?: readonly CapabilityKey[];
  /** Data-shaped gating ⇒ item HIDDEN (e.g. Copy Full Path with null absolutePath). */
  isVisible?: (target: TargetOf<K>) => boolean;
  /** Transient gating ⇒ item rendered DISABLED (e.g. content still loading). */
  isEnabled?: (target: TargetOf<K>) => boolean;
  run: (target: TargetOf<K>, services: ActionServices) => Promise<ActionOutcome>;
}

export type AnyContextAction = ContextAction;

/**
 * Widens a kind-narrowed action for heterogeneous storage. Safe because the
 * registry only invokes target-taking callbacks with targets whose kind is in
 * `appliesTo`, which restores the narrow type at runtime.
 */
export function defineContextAction<K extends ContextTargetKind>(
  action: ContextAction<K>
): AnyContextAction {
  return action as unknown as AnyContextAction;
}
```

- [ ] **Step 2: Write the failing registry test — `packages/context-actions/src/__tests__/registry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createActionRegistry } from '../registry';
import {
  type ActionOutcome,
  type ContextTarget,
  defineContextAction,
} from '../types';

const fileTarget: ContextTarget = {
  kind: 'file-entry',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  absolutePath: '/Users/dev/project/docs/notes.md',
  entryType: 'file',
  rootFolderId: '/Users/dev/project',
};

const webFileTarget: ContextTarget = {
  ...fileTarget,
  absolutePath: null,
  rootFolderId: 'root-uuid',
};

const chunkTarget: ContextTarget = { kind: 'chunk', id: 'c1', content: 'hello' };

const ok: ActionOutcome = { ok: true };

function makeActions() {
  return {
    copyName: defineContextAction({
      id: 'file.copy-name',
      label: 'Copy Name',
      group: 'copy',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
    copyFullPath: defineContextAction({
      id: 'file.copy-full-path',
      label: 'Copy Full Path',
      group: 'copy',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['clipboard'] as const,
      isVisible: (target) => target.absolutePath !== null,
      run: async () => ok,
    }),
    reveal: defineContextAction({
      id: 'file.reveal',
      label: 'Reveal in Finder',
      group: 'navigate',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['fs.reveal'] as const,
      isVisible: (target) => target.absolutePath !== null,
      run: async () => ok,
    }),
    copyContent: defineContextAction({
      id: 'collection.copy-content',
      label: 'Copy Content',
      group: 'copy',
      appliesTo: ['chunk'] as const,
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
  };
}

describe('createActionRegistry', () => {
  it('filters by appliesTo kind', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const groups = registry.actionsFor(chunkTarget);
    const ids = groups.flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).toEqual(['collection.copy-content']);
  });

  it('hides actions whose required capability is missing (web)', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard']),
      services: {},
    });
    const ids = registry
      .actionsFor(fileTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).not.toContain('file.reveal');
    expect(ids).toContain('file.copy-name');
  });

  it('hides actions whose isVisible returns false (null absolutePath)', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const ids = registry
      .actionsFor(webFileTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).toEqual(['file.copy-name']);
  });

  it('orders groups tree → copy → navigate → inspect → danger and omits empty groups', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const groups = registry.actionsFor(fileTarget);
    expect(groups.map((group) => group.group)).toEqual(['copy', 'navigate']);
  });

  it('merges surface-local actions and groups them with global ones', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: [actions.copyName],
      capabilities: new Set(['clipboard']),
      services: {},
    });
    const local = defineContextAction({
      id: 'local.expand',
      label: 'Expand',
      group: 'tree',
      appliesTo: ['file-entry'] as const,
      run: async () => ok,
    });
    const groups = registry.actionsFor(fileTarget, [local]);
    expect(groups.map((group) => group.group)).toEqual(['tree', 'copy']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/context-actions test`
Expected: FAIL — `../registry` does not exist.

- [ ] **Step 4: Create `packages/context-actions/src/registry.ts`**

```ts
import type {
  ActionGroup,
  ActionServices,
  AnyContextAction,
  CapabilityKey,
  ContextTarget,
} from './types';

export interface GroupedActions {
  group: ActionGroup;
  actions: AnyContextAction[];
}

export interface ActionRegistry {
  actionsFor: (
    target: ContextTarget,
    localActions?: readonly AnyContextAction[]
  ) => GroupedActions[];
  capabilities: ReadonlySet<CapabilityKey>;
  services: ActionServices;
}

const GROUP_ORDER: readonly ActionGroup[] = ['tree', 'copy', 'navigate', 'inspect', 'danger'];

export interface CreateActionRegistryOptions {
  actions: readonly AnyContextAction[];
  capabilities: ReadonlySet<CapabilityKey>;
  services: ActionServices;
}

export function createActionRegistry({
  actions,
  capabilities,
  services,
}: CreateActionRegistryOptions): ActionRegistry {
  function isUsable(action: AnyContextAction, target: ContextTarget): boolean {
    if (!action.appliesTo.includes(target.kind)) {
      return false;
    }
    for (const capability of action.requiredCapabilities ?? []) {
      if (!capabilities.has(capability)) {
        return false;
      }
    }
    if (action.isVisible && !action.isVisible(target)) {
      return false;
    }
    return true;
  }

  function actionsFor(
    target: ContextTarget,
    localActions: readonly AnyContextAction[] = []
  ): GroupedActions[] {
    const usable = [...actions, ...localActions].filter((action) => isUsable(action, target));
    return GROUP_ORDER.map((group) => ({
      group,
      actions: usable.filter((action) => action.group === group),
    })).filter((grouped) => grouped.actions.length > 0);
  }

  return { actionsFor, capabilities, services };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/context-actions test`
Expected: PASS (5 tests).

- [ ] **Step 6: Replace `packages/context-actions/src/index.ts` with real exports**

```ts
export {
  type ActionRegistry,
  type CreateActionRegistryOptions,
  createActionRegistry,
  type GroupedActions,
} from './registry';
export {
  type ActionGroup,
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type CapabilityKey,
  type ClipboardService,
  type ContextAction,
  type ContextTarget,
  type ContextTargetKind,
  defineContextAction,
  type PlatformFsService,
  type TargetOf,
} from './types';
```

- [ ] **Step 7: Type-check and commit**

Run: `pnpm --filter @brainstrike/context-actions type-check`
Expected: PASS.

```bash
git add packages/context-actions
git commit -m "feat(context-actions): add target/action types and filtering registry"
```

---

### Task 3: Path helpers (TDD)

**Files:**
- Create: `packages/context-actions/src/paths.ts`
- Create: `packages/context-actions/src/__tests__/paths.test.ts`
- Modify: `packages/context-actions/src/index.ts`

These helpers let the file-entry adapter derive `absolutePath`/`relativePath` from the data itself (desktop `IFileNode.path` is absolute — see `packages/file-system/src/adapters/electron-adapter.ts:382` `path.join(_handle.path, entry.name)`; web fixture/handle paths are root-relative). No platform sniffing.

- [ ] **Step 1: Write the failing test — `packages/context-actions/src/__tests__/paths.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { isAbsolutePath, toRelativePath } from '../paths';

describe('isAbsolutePath', () => {
  it('detects POSIX absolute paths', () => {
    expect(isAbsolutePath('/Users/dev/project/file.ts')).toBe(true);
  });

  it('detects Windows drive paths', () => {
    expect(isAbsolutePath('C:\\Users\\dev\\file.ts')).toBe(true);
    expect(isAbsolutePath('c:/Users/dev/file.ts')).toBe(true);
  });

  it('detects UNC paths', () => {
    expect(isAbsolutePath('\\\\server\\share\\file.ts')).toBe(true);
  });

  it('rejects relative paths (web file nodes)', () => {
    expect(isAbsolutePath('docs/notes.md')).toBe(false);
    expect(isAbsolutePath('notes.md')).toBe(false);
  });
});

describe('toRelativePath', () => {
  it('strips a POSIX root prefix', () => {
    expect(toRelativePath('/root/project/docs/notes.md', '/root/project')).toBe('docs/notes.md');
  });

  it('strips a root prefix that already ends with a separator', () => {
    expect(toRelativePath('/root/project/docs/notes.md', '/root/project/')).toBe('docs/notes.md');
  });

  it('strips a Windows root prefix', () => {
    expect(toRelativePath('C:\\proj\\docs\\notes.md', 'C:\\proj')).toBe('docs\\notes.md');
  });

  it('returns relative paths unchanged', () => {
    expect(toRelativePath('docs/notes.md', 'root-uuid')).toBe('docs/notes.md');
  });

  it('returns the absolute path unchanged when the root does not prefix it', () => {
    expect(toRelativePath('/elsewhere/file.ts', '/root/project')).toBe('/elsewhere/file.ts');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/context-actions test`
Expected: FAIL — `../paths` does not exist.

- [ ] **Step 3: Create `packages/context-actions/src/paths.ts`**

```ts
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || WINDOWS_DRIVE_PATH.test(path);
}

/**
 * Strips `rootPath` from an absolute `path`. Relative paths (web file nodes)
 * pass through unchanged. An absolute path outside the root also passes
 * through unchanged rather than guessing.
 */
export function toRelativePath(path: string, rootPath: string): string {
  if (!isAbsolutePath(path)) {
    return path;
  }
  const separator = path.includes('\\') ? '\\' : '/';
  const prefix = rootPath.endsWith(separator) ? rootPath : `${rootPath}${separator}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/context-actions test`
Expected: PASS.

- [ ] **Step 5: Add to `packages/context-actions/src/index.ts`**

```ts
export { isAbsolutePath, toRelativePath } from './paths';
```

- [ ] **Step 6: Commit**

```bash
git add packages/context-actions
git commit -m "feat(context-actions): add path helpers for absolute/relative derivation"
```

---

### Task 4: ClipboardService (TDD)

**Files:**
- Create: `packages/context-actions/src/clipboard.ts`
- Create: `packages/context-actions/src/__tests__/clipboard.test.ts`
- Modify: `packages/context-actions/src/index.ts`

Policy (per the no-silent-fallbacks rule): if the Electron bridge (`window.clipboard`) EXISTS but its write fails, report the failure — do NOT mask a broken bridge by falling through to `navigator.clipboard`. The web API is used only when the Electron bridge is absent.

- [ ] **Step 1: Write the failing test — `packages/context-actions/src/__tests__/clipboard.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClipboardService } from '../clipboard';

type MutableWindow = Window & {
  clipboard?: { writeText?: (text: string) => boolean };
};

const mutableWindow = window as MutableWindow;

afterEach(() => {
  mutableWindow.clipboard = undefined;
  vi.restoreAllMocks();
});

describe('createClipboardService', () => {
  it('prefers the Electron bridge when present', async () => {
    const writeText = vi.fn().mockReturnValue(true);
    mutableWindow.clipboard = { writeText };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('reports an Electron bridge failure instead of silently falling back', async () => {
    mutableWindow.clipboard = { writeText: vi.fn().mockReturnValue(false) };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome.ok).toBe(false);
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('uses navigator.clipboard when no Electron bridge exists', async () => {
    const navigatorSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: true });
    expect(navigatorSpy).toHaveBeenCalledWith('hello');
  });

  it('reports navigator.clipboard rejections', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: false, error: 'denied' });
  });

  it('reports when no clipboard exists at all', async () => {
    vi.stubGlobal('navigator', {});

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/context-actions test`
Expected: FAIL — `../clipboard` does not exist.

- [ ] **Step 3: Create `packages/context-actions/src/clipboard.ts`**

```ts
import type { ActionOutcome, ClipboardService } from './types';

interface ElectronClipboardBridge {
  writeText?: (text: string) => boolean;
}

function resolveElectronClipboard(): ElectronClipboardBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { clipboard?: ElectronClipboardBridge }).clipboard;
  return typeof bridge?.writeText === 'function' ? bridge : null;
}

export function createClipboardService(): ClipboardService {
  return {
    async writeText(text: string): Promise<ActionOutcome> {
      const electronClipboard = resolveElectronClipboard();
      if (electronClipboard?.writeText) {
        // A present-but-failing bridge is a bug to surface, not to mask with
        // the web API (no silent fallbacks).
        if (electronClipboard.writeText(text)) {
          return { ok: true };
        }
        return { ok: false, error: 'Desktop clipboard bridge rejected the write' };
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Clipboard write failed',
          };
        }
      }
      return { ok: false, error: 'No clipboard available in this environment' };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @brainstrike/context-actions test`
Expected: PASS.

- [ ] **Step 5: Add to `packages/context-actions/src/index.ts`**

```ts
export { createClipboardService } from './clipboard';
```

- [ ] **Step 6: Commit**

```bash
git add packages/context-actions
git commit -m "feat(context-actions): add ClipboardService with explicit failure reporting"
```

---

### Task 5: Test helper `createTestActionRegistry`

**Files:**
- Create: `packages/context-actions/src/testing.ts`
- Modify: `packages/context-actions/src/index.ts`

Consumers' component tests need a registry without real services. Exported from the main entry (it is tiny and has no test-runner imports).

- [ ] **Step 1: Create `packages/context-actions/src/testing.ts`**

```ts
import { type ActionRegistry, createActionRegistry } from './registry';
import type { ActionServices, AnyContextAction, CapabilityKey } from './types';

/**
 * Registry for component tests: all capabilities granted, services recorded
 * in-memory. Pass `actions` to exercise real definitions.
 */
export function createTestActionRegistry(
  options: {
    actions?: readonly AnyContextAction[];
    capabilities?: readonly CapabilityKey[];
    services?: ActionServices;
  } = {}
): { registry: ActionRegistry; writtenTexts: string[] } {
  const writtenTexts: string[] = [];
  const services: ActionServices = options.services ?? {
    clipboard: {
      writeText: (text: string) => {
        writtenTexts.push(text);
        return Promise.resolve({ ok: true as const });
      },
    },
  };
  const registry = createActionRegistry({
    actions: options.actions ?? [],
    capabilities: new Set(options.capabilities ?? ['clipboard', 'fs.reveal', 'fs.openPath']),
    services,
  });
  return { registry, writtenTexts };
}
```

- [ ] **Step 2: Add to `packages/context-actions/src/index.ts`**

```ts
export { createTestActionRegistry } from './testing';
```

- [ ] **Step 3: Verify, build, and commit**

Run: `pnpm --filter @brainstrike/context-actions type-check && pnpm --filter @brainstrike/context-actions test && pnpm --filter @brainstrike/context-actions build`
Expected: all PASS; `dist/` produced.

```bash
git add packages/context-actions
git commit -m "feat(context-actions): add createTestActionRegistry helper"
```

---

### Task 6: Radix ContextMenu wrapper in `packages/ui`

**Files:**
- Modify: `packages/ui/package.json` (add `@radix-ui/react-context-menu`)
- Create: `packages/ui/src/context-menu/context-menu.tsx`
- Create: `packages/ui/src/context-menu/index.ts`
- Modify: `packages/ui/src/index.ts`

Mirror `packages/ui/src/dropdown-menu.tsx` exactly (same class strings, `data-slot` attributes, React 19 ref-as-prop pattern).

- [ ] **Step 1: Add the dependency**

In `packages/ui/package.json` `dependencies`, add (alphabetical, next to the other Radix packages):

```json
"@radix-ui/react-context-menu": "^2.2.16",
```

Run: `pnpm install`
Expected: resolves cleanly. (If the registry serves a newer 2.x, use that — match the `^2.x` major.)

- [ ] **Step 2: Create `packages/ui/src/context-menu/context-menu.tsx`**

```tsx
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import type * as React from 'react';

import { cn } from '../lib/utils';

const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

const ContextMenuGroup = ContextMenuPrimitive.Group;

const ContextMenuPortal = ContextMenuPrimitive.Portal;

const ContextMenuSub = ContextMenuPrimitive.Sub;

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

const ContextMenuSubTrigger = ({
  className,
  inset,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
} & {
  ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.SubTrigger> | null>;
}) => (
  <ContextMenuPrimitive.SubTrigger
    className={cn(
      'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0',
      inset && 'pl-8',
      className
    )}
    data-slot="context-menu-sub-trigger"
    ref={ref}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto size-4" />
  </ContextMenuPrimitive.SubTrigger>
);
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent> & {
  ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.SubContent> | null>;
}) => (
  <ContextMenuPrimitive.SubContent
    className={cn(
      'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    data-slot="context-menu-sub-content"
    ref={ref}
    {...props}
  />
);
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content> & {
  ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Content> | null>;
}) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      className={cn(
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=open]:animate-in',
        className
      )}
      data-slot="context-menu-content"
      ref={ref}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
);
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = ({
  className,
  inset,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
} & { ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Item> | null> }) => (
  <ContextMenuPrimitive.Item
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0',
      inset && 'pl-8',
      className
    )}
    data-slot="context-menu-item"
    ref={ref}
    {...props}
  />
);
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuCheckboxItem = ({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem> & {
  ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem> | null>;
}) => (
  <ContextMenuPrimitive.CheckboxItem
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className
    )}
    data-slot="context-menu-checkbox-item"
    ref={ref}
    {...props}
  >
    <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="size-4" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
);
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName;

const ContextMenuRadioItem = ({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem> & {
  ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.RadioItem> | null>;
}) => (
  <ContextMenuPrimitive.RadioItem
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className
    )}
    data-slot="context-menu-radio-item"
    ref={ref}
    {...props}
  >
    <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
      <ContextMenuPrimitive.ItemIndicator>
        <Circle className="size-2 fill-current" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
);
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

const ContextMenuLabel = ({
  className,
  inset,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
} & { ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Label> | null> }) => (
  <ContextMenuPrimitive.Label
    className={cn('px-2 py-1.5 font-medium text-sm', inset && 'pl-8', className)}
    data-slot="context-menu-label"
    ref={ref}
    {...props}
  />
);
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator> & {
  ref?: React.RefObject<React.ElementRef<typeof ContextMenuPrimitive.Separator> | null>;
}) => (
  <ContextMenuPrimitive.Separator
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    data-slot="context-menu-separator"
    ref={ref}
    {...props}
  />
);
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn('ml-auto text-muted-foreground text-xs tracking-widest', className)}
    data-slot="context-menu-shortcut"
    {...props}
  />
);
ContextMenuShortcut.displayName = 'ContextMenuShortcut';

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
```

- [ ] **Step 3: Create `packages/ui/src/context-menu/index.ts`**

```ts
export * from './context-menu';
```

(The `ActionContextMenu` exports are added here in Task 7.)

- [ ] **Step 4: Export from `packages/ui/src/index.ts`**

Add alphabetically among the component exports:

```ts
export * from './context-menu';
```

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @brainstrike/ui type-check`
Expected: PASS.

```bash
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): add Radix ContextMenu wrapper components"
```

---

### Task 7: `ActionRegistryProvider` + `ActionContextMenu` (TDD)

**Files:**
- Modify: `packages/ui/package.json` (add `@brainstrike/context-actions` dependency)
- Modify: `packages/ui/tsconfig.json` (add project reference)
- Create: `packages/ui/src/context-menu/action-registry-provider.tsx`
- Create: `packages/ui/src/context-menu/action-context-menu.tsx`
- Create: `packages/ui/src/__tests__/action-context-menu.test.tsx`
- Modify: `packages/ui/src/context-menu/index.ts`

**Design notes (read before coding):**
- React's synthetic `contextmenu` event propagates inner→outer, so a row-level handler (which calls `controller.setTarget(...)`) always runs BEFORE the trigger wrapper's handler. `setTarget` writes a ref synchronously (for the same-event read) and schedules state (for rendering the menu content).
- If no row resolved a target, the wrapper calls `event.preventDefault()`; Radix's trigger uses `composeEventHandlers` with default-prevented checking, so the menu does not open. No empty menus.
- The target is NOT cleared on close — clearing in `onOpenChange(false)` can race a reopen right-click. A stale target behind a closed menu is inert; the next right-click overwrites it.
- Failures toast (destructive) AND log via `createLogger('ContextActions')`. Successes toast only if the action supplied a `message`.

- [ ] **Step 1: Wire the dependency**

In `packages/ui/package.json` `dependencies` add:

```json
"@brainstrike/context-actions": "workspace:*",
```

In `packages/ui/tsconfig.json` `references` add:

```json
{
  "path": "../context-actions"
}
```

Run: `pnpm install`

- [ ] **Step 2: Create `packages/ui/src/context-menu/action-registry-provider.tsx`**

```tsx
import type { ActionRegistry } from '@brainstrike/context-actions';
import { createContext, type ReactNode, useContext } from 'react';

const ActionRegistryContext = createContext<ActionRegistry | null>(null);

export function ActionRegistryProvider({
  registry,
  children,
}: {
  registry: ActionRegistry;
  children: ReactNode;
}) {
  return (
    <ActionRegistryContext.Provider value={registry}>{children}</ActionRegistryContext.Provider>
  );
}

/**
 * Strict accessor: a surface that renders an ActionContextMenu without a
 * mounted registry is a wiring bug, surfaced immediately (no silent no-op
 * menus). Tests wrap with createTestActionRegistry().
 */
export function useActionRegistry(): ActionRegistry {
  const registry = useContext(ActionRegistryContext);
  if (!registry) {
    throw new Error('useActionRegistry must be used inside an <ActionRegistryProvider>.');
  }
  return registry;
}
```

- [ ] **Step 3: Create `packages/ui/src/context-menu/action-context-menu.tsx`**

```tsx
import type { AnyContextAction, ContextTarget } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/utils';
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';
import { toast } from '../use-toast';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './context-menu';
import { useActionRegistry } from './action-registry-provider';

const logger = createLogger('ContextActions');

export interface ContextMenuTargetController {
  target: ContextTarget | null;
  targetRef: RefObject<ContextTarget | null>;
  setTarget: (target: ContextTarget | null) => void;
}

/**
 * Owns the "what was right-clicked" state. `setTarget` writes a ref
 * synchronously so the trigger wrapper can read it during the same
 * contextmenu event (row handlers run before the wrapper handler).
 */
export function useContextMenuTarget(): ContextMenuTargetController {
  const [target, setTargetState] = useState<ContextTarget | null>(null);
  const targetRef = useRef<ContextTarget | null>(null);
  const setTarget = useCallback((next: ContextTarget | null) => {
    targetRef.current = next;
    setTargetState(next);
  }, []);
  return { target, targetRef, setTarget };
}

export interface ActionContextMenuProps {
  controller: ContextMenuTargetController;
  localActions?: readonly AnyContextAction[];
  children: ReactNode;
}

export function ActionContextMenu({ controller, localActions, children }: ActionContextMenuProps) {
  const registry = useActionRegistry();
  const { target, targetRef, setTarget } = controller;
  const groups = target ? registry.actionsFor(target, localActions) : [];

  const handleRun = useCallback(
    (action: AnyContextAction, currentTarget: ContextTarget) => {
      void action.run(currentTarget, registry.services).then((outcome) => {
        if (outcome.ok) {
          if (outcome.message) {
            toast({ description: outcome.message });
          }
          return;
        }
        logger.error('Context action failed', {
          actionId: action.id,
          error: outcome.error,
          targetKind: currentTarget.kind,
        });
        toast({
          description: outcome.error,
          title: 'Action failed',
          variant: 'destructive',
        });
      });
    },
    [registry.services]
  );

  const handleWrapperContextMenu = useCallback(
    (event: React.MouseEvent) => {
      // The surface resets the target in a capture-phase handler, then row
      // handlers (inner, bubble) claim it by calling setTarget. By the time
      // this outer handler runs, a null ref means "no row claimed this
      // right-click" — prevent default so Radix does not open an empty menu.
      if (!targetRef.current) {
        event.preventDefault();
      }
    },
    [targetRef]
  );

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div className="contents" data-testid="action-context-menu-trigger" onContextMenu={handleWrapperContextMenu}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        {target
          ? groups.map((group, groupIndex) => (
              <Fragment key={group.group}>
                {groupIndex > 0 ? <ContextMenuSeparator /> : null}
                {group.actions.map((action) => {
                  const label =
                    typeof action.label === 'function' ? action.label(target) : action.label;
                  const Icon = action.icon;
                  const enabled = action.isEnabled ? action.isEnabled(target) : true;
                  return (
                    <ContextMenuItem
                      disabled={!enabled}
                      key={action.id}
                      onSelect={() => handleRun(action, target)}
                    >
                      {Icon ? <Icon className="mr-2 h-4 w-4" /> : null}
                      {label}
                    </ContextMenuItem>
                  );
                })}
              </Fragment>
            ))
          : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
```

Note: `setTarget` from the controller is unused inside `ActionContextMenu` itself — destructure only `{ target, targetRef }` if the linter flags it.

**Implementation caveat:** without a reset, a right-click on empty background would read the STALE target from a previous row click (no row handler runs to overwrite it). The convention that makes background clicks correct: rows call `controller.setTarget(target)`; the surface ALSO attaches `onContextMenuCapture={() => controller.setTarget(null)}` on the element it passes as `children`, which runs before any row handler (capture phase, outer→inner) and resets the ref on every right-click. Apply this in Tasks 9 and 11. Add this line to the `ActionContextMenuProps` JSDoc:

```
/**
 * Convention: the direct child surface MUST attach
 * `onContextMenuCapture={() => controller.setTarget(null)}` so every
 * right-click starts with a clean target before row handlers claim it.
 */
```

- [ ] **Step 4: Write the failing component test — `packages/ui/src/__tests__/action-context-menu.test.tsx`**

```tsx
import { createTestActionRegistry, defineContextAction } from '@brainstrike/context-actions';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ActionContextMenu,
  ActionRegistryProvider,
  useContextMenuTarget,
} from '../context-menu';

const copyName = defineContextAction({
  id: 'file.copy-name',
  label: 'Copy Name',
  group: 'copy',
  appliesTo: ['file-entry'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: async (target, services) => {
    if (!services.clipboard) {
      return { ok: false, error: 'Clipboard service unavailable' };
    }
    const outcome = await services.clipboard.writeText(target.name);
    return outcome.ok ? { ok: true, message: 'Name copied' } : outcome;
  },
});

const revealAction = defineContextAction({
  id: 'file.reveal',
  label: 'Reveal in Finder',
  group: 'navigate',
  appliesTo: ['file-entry'] as const,
  requiredCapabilities: ['fs.reveal'] as const,
  run: async () => ({ ok: true }),
});

function Harness() {
  const controller = useContextMenuTarget();
  return (
    <ActionContextMenu controller={controller} localActions={[]}>
      <div
        onContextMenuCapture={() => controller.setTarget(null)}
        role="treegrid"
      >
        <div
          data-testid="row-a"
          onContextMenu={() =>
            controller.setTarget({
              kind: 'file-entry',
              name: 'notes.md',
              relativePath: 'docs/notes.md',
              absolutePath: '/root/docs/notes.md',
              entryType: 'file',
              rootFolderId: '/root',
            })
          }
        >
          notes.md
        </div>
        <div data-testid="background">background</div>
      </div>
    </ActionContextMenu>
  );
}

function renderHarness(capabilities?: readonly ('clipboard' | 'fs.reveal')[]) {
  const { registry, writtenTexts } = createTestActionRegistry({
    actions: [copyName, revealAction],
    ...(capabilities ? { capabilities } : {}),
  });
  render(
    <ActionRegistryProvider registry={registry}>
      <Harness />
    </ActionRegistryProvider>
  );
  return { writtenTexts };
}

describe('ActionContextMenu', () => {
  it('opens on row right-click and lists applicable actions', async () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByTestId('row-a'));
    expect(await screen.findByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeInTheDocument();
  });

  it('hides capability-gated actions when the capability is missing', async () => {
    renderHarness(['clipboard']);
    fireEvent.contextMenu(screen.getByTestId('row-a'));
    expect(await screen.findByRole('menuitem', { name: 'Copy Name' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
  });

  it('runs the action with services on item select', async () => {
    const { writtenTexts } = renderHarness();
    fireEvent.contextMenu(screen.getByTestId('row-a'));
    const item = await screen.findByRole('menuitem', { name: 'Copy Name' });
    fireEvent.click(item);
    await waitFor(() => {
      expect(writtenTexts).toEqual(['notes.md']);
    });
  });

  it('does not open a menu when right-clicking outside any row', () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByTestId('background'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @brainstrike/ui test -- --run src/__tests__/action-context-menu.test.tsx`
Expected: FAIL (exports missing) until Step 6, then iterate.

Note: Radix ContextMenu in jsdom may require `fireEvent.contextMenu` to include pointer coordinates; if the menu does not open, use `fireEvent.contextMenu(element, { clientX: 10, clientY: 10 })`. If `onSelect` does not fire from `fireEvent.click`, use `fireEvent.pointerDown` + `fireEvent.pointerUp` or Testing Library `userEvent` — fix the test mechanics, not the component, as long as the behavior assertions stand.

- [ ] **Step 6: Export from `packages/ui/src/context-menu/index.ts`**

```ts
export { ActionContextMenu, type ActionContextMenuProps, type ContextMenuTargetController, useContextMenuTarget } from './action-context-menu';
export { ActionRegistryProvider, useActionRegistry } from './action-registry-provider';
export * from './context-menu';
```

- [ ] **Step 7: Run the tests until they pass**

Run: `pnpm --filter @brainstrike/ui test -- --run src/__tests__/action-context-menu.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 8: Type-check and commit**

Run: `pnpm --filter @brainstrike/ui type-check`
Expected: PASS.

```bash
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): add ActionRegistryProvider and ActionContextMenu renderer"
```

---

### Task 8: File-entry adapter + actions in `file-explorer-ui` (TDD)

**Files:**
- Modify: `packages/file-explorer-ui/package.json` (add `@brainstrike/context-actions`)
- Modify: `packages/file-explorer-ui/tsconfig.json` (add reference `{ "path": "../context-actions" }`)
- Create: `packages/file-explorer-ui/src/context-actions/file-entry-target.ts`
- Create: `packages/file-explorer-ui/src/context-actions/file-entry-actions.ts`
- Create: `packages/file-explorer-ui/src/context-actions/index.ts`
- Create: `packages/file-explorer-ui/src/context-actions/__tests__/file-entry-target.test.ts`
- Create: `packages/file-explorer-ui/src/context-actions/__tests__/file-entry-actions.test.ts`
- Modify: `packages/file-explorer-ui/src/index.ts` (re-export `fileEntryActions`)

- [ ] **Step 1: Wire the dependency** (package.json `dependencies` + tsconfig `references` as listed above), then `pnpm install`.

- [ ] **Step 2: Write the failing adapter test — `packages/file-explorer-ui/src/context-actions/__tests__/file-entry-target.test.ts`**

```ts
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { fileNodeToTarget } from '../file-entry-target';

const baseNode: Omit<IFileNode, 'path' | 'rootFolderId' | 'type'> = {
  depth: 1,
  handle: {} as IFileNode['handle'],
  name: 'notes.md',
  selectionState: 'unchecked',
};

describe('fileNodeToTarget', () => {
  it('maps a desktop node (absolute path) to a target with absolutePath', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      path: '/Users/dev/project/docs/notes.md',
      rootFolderId: '/Users/dev/project',
      type: 'file',
    });
    expect(target).toEqual({
      kind: 'file-entry',
      name: 'notes.md',
      relativePath: 'docs/notes.md',
      absolutePath: '/Users/dev/project/docs/notes.md',
      entryType: 'file',
      rootFolderId: '/Users/dev/project',
    });
  });

  it('maps a web node (relative path) to a target with null absolutePath', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      path: 'docs/notes.md',
      rootFolderId: 'root-uuid',
      type: 'file',
    });
    expect(target).toEqual({
      kind: 'file-entry',
      name: 'notes.md',
      relativePath: 'docs/notes.md',
      absolutePath: null,
      entryType: 'file',
      rootFolderId: 'root-uuid',
    });
  });

  it('maps directories', () => {
    const target = fileNodeToTarget({
      ...baseNode,
      name: 'docs',
      path: 'docs',
      rootFolderId: 'root-uuid',
      type: 'directory',
    });
    expect(target?.kind).toBe('file-entry');
    expect(target && target.kind === 'file-entry' ? target.entryType : null).toBe('directory');
  });

  it('returns null for loadMore pseudo-nodes', () => {
    expect(
      fileNodeToTarget({
        ...baseNode,
        name: 'Load more…',
        path: '__load_more__',
        rootFolderId: 'root-uuid',
        type: 'loadMore',
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @brainstrike/file-explorer-ui test -- --run src/context-actions/__tests__/file-entry-target.test.ts`
Expected: FAIL — module missing. (If this package's vitest include patterns miss the new directory, check its `vitest.config` and add `src/context-actions/**/__tests__/**` to the include list.)

- [ ] **Step 4: Create `packages/file-explorer-ui/src/context-actions/file-entry-target.ts`**

```ts
import {
  type ContextTarget,
  isAbsolutePath,
  toRelativePath,
} from '@brainstrike/context-actions';
import type { IFileNode } from '@brainstrike/types';

/**
 * Adapts an IFileNode into the shared ContextTarget shape. Desktop nodes carry
 * absolute paths (electron adapter joins from the absolute root); web nodes
 * carry root-relative paths — the data itself tells us which.
 */
export function fileNodeToTarget(node: IFileNode): ContextTarget | null {
  if (node.type === 'loadMore') {
    return null;
  }
  const absolute = isAbsolutePath(node.path) ? node.path : null;
  return {
    kind: 'file-entry',
    name: node.name,
    relativePath: absolute ? toRelativePath(node.path, node.rootFolderId) : node.path,
    absolutePath: absolute,
    entryType: node.type,
    rootFolderId: node.rootFolderId,
  };
}
```

- [ ] **Step 5: Run adapter tests — expect PASS.**

- [ ] **Step 6: Write the failing actions test — `packages/file-explorer-ui/src/context-actions/__tests__/file-entry-actions.test.ts`**

```ts
import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import {
  copyFullPathAction,
  copyNameAction,
  copyRelativePathAction,
  fileEntryActions,
  revealInOsAction,
} from '../file-entry-actions';

const desktopTarget: ContextTarget = {
  kind: 'file-entry',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  absolutePath: '/root/docs/notes.md',
  entryType: 'file',
  rootFolderId: '/root',
};

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    platformFs: {
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
      openPath: vi.fn().mockResolvedValue({ ok: true }),
    },
  } satisfies ActionServices;
}

describe('fileEntryActions', () => {
  it('exports the four global actions', () => {
    expect(fileEntryActions.map((action) => action.id)).toEqual([
      'file.copy-name',
      'file.copy-relative-path',
      'file.copy-full-path',
      'file.reveal-in-os',
    ]);
  });

  it('copy-name writes the file name', async () => {
    const services = makeServices();
    const outcome = await copyNameAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('notes.md');
    expect(outcome).toEqual({ ok: true, message: 'Name copied' });
  });

  it('copy-relative-path writes the relative path', async () => {
    const services = makeServices();
    await copyRelativePathAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('docs/notes.md');
  });

  it('copy-full-path writes the absolute path and is hidden without one', async () => {
    const services = makeServices();
    await copyFullPathAction.run(desktopTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('/root/docs/notes.md');
    expect(copyFullPathAction.isVisible?.({ ...desktopTarget, absolutePath: null })).toBe(false);
  });

  it('reveal calls showItemInFolder and fails loudly without the service', async () => {
    const services = makeServices();
    await revealInOsAction.run(desktopTarget, services);
    expect(services.platformFs.showItemInFolder).toHaveBeenCalledWith('/root/docs/notes.md');

    const outcome = await revealInOsAction.run(desktopTarget, { clipboard: services.clipboard });
    expect(outcome.ok).toBe(false);
  });

  it('clipboard failures propagate as the action outcome', async () => {
    const services = makeServices();
    services.clipboard.writeText.mockResolvedValue({ ok: false, error: 'denied' });
    const outcome = await copyNameAction.run(desktopTarget, services);
    expect(outcome).toEqual({ ok: false, error: 'denied' });
  });
});
```

- [ ] **Step 7: Run to verify it fails, then create `packages/file-explorer-ui/src/context-actions/file-entry-actions.ts`**

```ts
import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { Copy, FolderOpen } from 'lucide-react';

type FileEntryTarget = TargetOf<'file-entry'>;

async function copyToClipboard(
  services: ActionServices,
  text: string,
  successMessage: string
): Promise<ActionOutcome> {
  if (!services.clipboard) {
    return { ok: false, error: 'Clipboard service unavailable' };
  }
  const outcome = await services.clipboard.writeText(text);
  return outcome.ok ? { ok: true, message: successMessage } : outcome;
}

function revealLabel(): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
  return platform.toLowerCase().startsWith('mac') ? 'Reveal in Finder' : 'Reveal in File Explorer';
}

const copyName: ContextAction<'file-entry'> = {
  id: 'file.copy-name',
  label: 'Copy Name',
  icon: Copy,
  group: 'copy',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['clipboard'],
  run: (target, services) => copyToClipboard(services, target.name, 'Name copied'),
};

const copyRelativePath: ContextAction<'file-entry'> = {
  id: 'file.copy-relative-path',
  label: 'Copy Relative Path',
  icon: Copy,
  group: 'copy',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['clipboard'],
  run: (target, services) =>
    copyToClipboard(services, target.relativePath, 'Relative path copied'),
};

const copyFullPath: ContextAction<'file-entry'> = {
  id: 'file.copy-full-path',
  label: 'Copy Full Path',
  icon: Copy,
  group: 'copy',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['clipboard'],
  isVisible: (target) => target.absolutePath !== null,
  run: (target, services) => {
    if (target.absolutePath === null) {
      return Promise.resolve<ActionOutcome>({
        ok: false,
        error: 'No absolute path available for this entry',
      });
    }
    return copyToClipboard(services, target.absolutePath, 'Full path copied');
  },
};

const revealInOs: ContextAction<'file-entry'> = {
  id: 'file.reveal-in-os',
  label: () => revealLabel(),
  icon: FolderOpen,
  group: 'navigate',
  appliesTo: ['file-entry'],
  requiredCapabilities: ['fs.reveal'],
  isVisible: (target) => target.absolutePath !== null,
  run: async (target: FileEntryTarget, services) => {
    if (!services.platformFs) {
      return { ok: false, error: 'Platform file-system service unavailable' };
    }
    if (target.absolutePath === null) {
      return { ok: false, error: 'No absolute path available for this entry' };
    }
    return await services.platformFs.showItemInFolder(target.absolutePath);
  },
};

export const copyNameAction = defineContextAction(copyName);
export const copyRelativePathAction = defineContextAction(copyRelativePath);
export const copyFullPathAction = defineContextAction(copyFullPath);
export const revealInOsAction = defineContextAction(revealInOs);

export const fileEntryActions: readonly AnyContextAction[] = [
  copyNameAction,
  copyRelativePathAction,
  copyFullPathAction,
  revealInOsAction,
];
```

Note: the test calls `copyNameAction.run(desktopTarget, ...)` on the WIDENED action — the widened `run` accepts any `ContextTarget`, which is fine at the test callsite.

- [ ] **Step 8: Create `packages/file-explorer-ui/src/context-actions/index.ts` and re-export**

```ts
export {
  copyFullPathAction,
  copyNameAction,
  copyRelativePathAction,
  fileEntryActions,
  revealInOsAction,
} from './file-entry-actions';
export { fileNodeToTarget } from './file-entry-target';
```

In `packages/file-explorer-ui/src/index.ts`, add:

```ts
export * from './context-actions';
```

- [ ] **Step 9: Run both test files — expect PASS. Type-check. Commit.**

```bash
git add packages/file-explorer-ui pnpm-lock.yaml
git commit -m "feat(file-explorer-ui): add file-entry target adapter and global actions"
```

---

### Task 9: Wire the file explorer tree

**Files:**
- Modify: `packages/file-explorer-ui/src/tree/optimized-file-tree.tsx`
- Create: `packages/file-explorer-ui/src/tree/__tests__/optimized-file-tree-context-menu.test.tsx` (or extend the existing OptimizedFileTree test file if one covers rendering)

- [ ] **Step 1: Add the menu wiring to `OptimizedFileTree`**

In `packages/file-explorer-ui/src/tree/optimized-file-tree.tsx`:

Add imports:

```tsx
import { ActionContextMenu, useContextMenuTarget } from '@brainstrike/ui';
import type { TreeNode } from '@brainstrike/ui';
import { fileNodeToTarget } from '../context-actions/file-entry-target';
```

(Confirm `TreeNode` is exported from `@brainstrike/ui`; it is re-exported via `export * from './tree-table'` → `types.ts`. If the import collides with an existing import line from `@brainstrike/ui` in this file, merge into that line.)

Inside the component body (near the other handlers, before the `return`):

```tsx
const contextMenuController = useContextMenuTarget();
const handleRowContextMenu = useCallback(
  (_nodeId: string, node: TreeNode<FileTreeRowData>, _event: React.MouseEvent) => {
    contextMenuController.setTarget(fileNodeToTarget(node.data.fileNode));
  },
  [contextMenuController.setTarget]
);
```

Wrap the existing scroll-container div (the one with `data-testid="file-tree-scroll-container"`) with the menu, and add the capture-phase reset:

```tsx
return (
  <FileTreeSelectionContext.Provider value={selectionContextValue}>
    <ActionContextMenu controller={contextMenuController}>
      <div
        className="relative h-full min-h-0 flex-1 overflow-y-auto"
        data-testid="file-tree-scroll-container"
        onContextMenuCapture={() => contextMenuController.setTarget(null)}
      >
        {/* ...existing inner content unchanged, but add onRowContextMenu to TreeTable: */}
      </div>
    </ActionContextMenu>
  </FileTreeSelectionContext.Provider>
);
```

And on the `<TreeTable …>` element add:

```tsx
onRowContextMenu={handleRowContextMenu}
```

Check `FileTreeRowData.fileNode` is the right property (it is — `optimized-file-tree-model.ts:28-36`).

- [ ] **Step 2: Write the integration test — `packages/file-explorer-ui/src/tree/__tests__/optimized-file-tree-context-menu.test.tsx`**

Model the render setup on the EXISTING OptimizedFileTree tests in `packages/file-explorer-ui/src/tree/__tests__/` (they already construct the provider/store scaffolding this component needs — reuse their helpers verbatim). The new assertions:

```tsx
// inside the existing render harness, wrapped additionally with:
//   <ActionRegistryProvider registry={createTestActionRegistry({ actions: fileEntryActions }).registry}>
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { fileEntryActions } from '../../context-actions';

it('opens a context menu with copy actions on file row right-click', async () => {
  // render tree with a file node 'docs/notes.md' using the existing harness
  fireEvent.contextMenu(screen.getByText('notes.md'), { clientX: 8, clientY: 8 });
  expect(await screen.findByRole('menuitem', { name: 'Copy Relative Path' })).toBeInTheDocument();
  // Web-style fixture nodes have relative paths → no absolute-path actions:
  expect(screen.queryByRole('menuitem', { name: 'Copy Full Path' })).not.toBeInTheDocument();
});

it('copies the relative path through the registry clipboard service', async () => {
  const { registry, writtenTexts } = createTestActionRegistry({ actions: fileEntryActions });
  // render with this registry
  fireEvent.contextMenu(screen.getByText('notes.md'), { clientX: 8, clientY: 8 });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Relative Path' }));
  await waitFor(() => expect(writtenTexts).toContain('docs/notes.md'));
});
```

- [ ] **Step 3: Run the new test file**

Run: `pnpm --filter @brainstrike/file-explorer-ui test -- --run src/tree/__tests__/optimized-file-tree-context-menu.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run the FULL file-explorer-ui suite — existing tests now render `ActionContextMenu`, which throws without a provider**

Run: `pnpm --filter @brainstrike/file-explorer-ui test`
For each failure complaining about `useActionRegistry must be used inside an <ActionRegistryProvider>`, wrap that test's render in:

```tsx
<ActionRegistryProvider registry={createTestActionRegistry().registry}>…</ActionRegistryProvider>
```

If many files fail identically, add the provider once inside the shared render helper those tests use (preferred — look for a common `renderTree`/harness util in `__tests__`).
Expected after fixes: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm --filter @brainstrike/file-explorer-ui type-check`

```bash
git add packages/file-explorer-ui
git commit -m "feat(file-explorer-ui): wire context menu into OptimizedFileTree"
```

---

### Task 10: Collection targets + actions in `db-explorer` (TDD)

**Files:**
- Modify: `packages/db-explorer/package.json` (add `@brainstrike/context-actions`) and its `tsconfig.json` references (`{ "path": "../context-actions" }`)
- Create: `packages/db-explorer/src/context-actions/collection-target.ts`
- Create: `packages/db-explorer/src/context-actions/collection-actions.ts`
- Create: `packages/db-explorer/src/context-actions/index.ts`
- Create: `packages/db-explorer/src/context-actions/__tests__/collection-actions.test.ts`
- Modify: `packages/db-explorer/src/index.ts` (re-export `collectionActions`)

`parseNodeId` is file-local in `collection-browser-view.tsx:99`. Move the prefix-stripping concern into the adapter by passing the ALREADY-PARSED `originalId` in (the view keeps calling its local `parseNodeId`).

- [ ] **Step 1: Wire the dependency** (package.json + tsconfig references), `pnpm install`.

- [ ] **Step 2: Write the failing test — `packages/db-explorer/src/context-actions/__tests__/collection-actions.test.ts`**

```ts
import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import { browserNodeToTarget } from '../collection-target';
import { collectionActions, copyContentAction, copyIdAction } from '../collection-actions';

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
  } satisfies ActionServices;
}

describe('browserNodeToTarget', () => {
  it('maps a collection node', () => {
    expect(
      browserNodeToTarget({ nodeType: 'collection', originalId: 'set-1', name: 'My Docs' })
    ).toEqual({ kind: 'collection', id: 'set-1', name: 'My Docs' });
  });

  it('maps a file node with its recorded path', () => {
    expect(
      browserNodeToTarget({
        nodeType: 'file',
        originalId: 'file-1',
        name: 'notes.md',
        path: 'docs/notes.md',
      })
    ).toEqual({ kind: 'collection-file', id: 'file-1', name: 'notes.md', path: 'docs/notes.md' });
  });

  it('maps a chunk node with content', () => {
    expect(
      browserNodeToTarget({ nodeType: 'chunk', originalId: 'c-1', content: 'hello world' })
    ).toEqual({ kind: 'chunk', id: 'c-1', content: 'hello world' });
  });

  it('maps an embedding node', () => {
    expect(
      browserNodeToTarget({ nodeType: 'embedding', originalId: 'e-1', vectorId: 'v-1' })
    ).toEqual({ kind: 'embedding', id: 'e-1', vectorId: 'v-1' });
  });

  it('returns null for group headers', () => {
    expect(browserNodeToTarget({ nodeType: 'group', originalId: 'g-1' })).toBeNull();
  });
});

describe('collection actions', () => {
  const chunkTarget: ContextTarget = { kind: 'chunk', id: 'c-1', content: 'hello world' };

  it('exports copy-id and copy-content', () => {
    expect(collectionActions.map((action) => action.id)).toEqual([
      'collection.copy-id',
      'collection.copy-content',
    ]);
  });

  it('copy-id applies to all collection-browser kinds and writes the id', async () => {
    expect(copyIdAction.appliesTo).toEqual(['collection', 'collection-file', 'chunk', 'embedding']);
    const services = makeServices();
    const outcome = await copyIdAction.run(chunkTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('c-1');
    expect(outcome).toEqual({ ok: true, message: 'ID copied' });
  });

  it('copy-content writes chunk content', async () => {
    const services = makeServices();
    await copyContentAction.run(chunkTarget, services);
    expect(services.clipboard.writeText).toHaveBeenCalledWith('hello world');
  });
});
```

- [ ] **Step 3: Run to verify failure, then create `packages/db-explorer/src/context-actions/collection-target.ts`**

```ts
import type { ContextTarget } from '@brainstrike/context-actions';

export interface BrowserNodeDescriptor {
  /** The collection-browser node type discriminator ('collection' | 'file' | 'chunk' | 'embedding' | 'group'). */
  nodeType: string;
  /** Node id with the type prefix already stripped (collection-browser-view's parseNodeId). */
  originalId: string;
  name?: string;
  path?: string | null;
  content?: string;
  vectorId?: string;
}

export function browserNodeToTarget(descriptor: BrowserNodeDescriptor): ContextTarget | null {
  switch (descriptor.nodeType) {
    case 'collection':
      return { kind: 'collection', id: descriptor.originalId, name: descriptor.name ?? '' };
    case 'file':
      return {
        kind: 'collection-file',
        id: descriptor.originalId,
        name: descriptor.name ?? '',
        path: descriptor.path ?? null,
      };
    case 'chunk':
      return { kind: 'chunk', id: descriptor.originalId, content: descriptor.content ?? '' };
    case 'embedding':
      return {
        kind: 'embedding',
        id: descriptor.originalId,
        vectorId: descriptor.vectorId ?? descriptor.originalId,
      };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Create `packages/db-explorer/src/context-actions/collection-actions.ts`**

```ts
import {
  type ActionOutcome,
  type ActionServices,
  type AnyContextAction,
  defineContextAction,
} from '@brainstrike/context-actions';
import { Copy } from 'lucide-react';

async function copyToClipboard(
  services: ActionServices,
  text: string,
  successMessage: string
): Promise<ActionOutcome> {
  if (!services.clipboard) {
    return { ok: false, error: 'Clipboard service unavailable' };
  }
  const outcome = await services.clipboard.writeText(text);
  return outcome.ok ? { ok: true, message: successMessage } : outcome;
}

export const copyIdAction = defineContextAction({
  id: 'collection.copy-id',
  label: 'Copy ID',
  icon: Copy,
  group: 'copy',
  appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.id, 'ID copied'),
});

export const copyContentAction = defineContextAction({
  id: 'collection.copy-content',
  label: 'Copy Content',
  icon: Copy,
  group: 'copy',
  appliesTo: ['chunk'] as const,
  requiredCapabilities: ['clipboard'] as const,
  run: (target, services) => copyToClipboard(services, target.content, 'Content copied'),
});

export const collectionActions: readonly AnyContextAction[] = [copyIdAction, copyContentAction];
```

Note: inside `defineContextAction`, `run`'s target parameter is inferred from `appliesTo` as `TargetOf<'collection' | 'collection-file' | 'chunk' | 'embedding'>` — every member of that union carries `id: string`, so `target.id` compiles under strict mode with no casts. Do not widen with `as`.

- [ ] **Step 5: Create the barrel + re-export**

`packages/db-explorer/src/context-actions/index.ts`:

```ts
export { collectionActions, copyContentAction, copyIdAction } from './collection-actions';
export { type BrowserNodeDescriptor, browserNodeToTarget } from './collection-target';
```

Add to `packages/db-explorer/src/index.ts`:

```ts
export * from './context-actions';
```

- [ ] **Step 6: Run tests — expect PASS. Type-check. Commit.**

```bash
git add packages/db-explorer pnpm-lock.yaml
git commit -m "feat(db-explorer): add collection target adapter and copy actions"
```

---

### Task 11: Migrate the collection browser's bespoke menu

**Files:**
- Modify: `packages/db-explorer/src/components/collection-browser-view.tsx`
- Test: extend the existing collection-browser-view test file in `packages/db-explorer/src/components/__tests__/` (find it with `ls packages/db-explorer/src/components/__tests__/`), or `packages/db-explorer/src/__tests__/` — wrap renders in `ActionRegistryProvider` as in Task 9 Step 4.

This replaces the coordinate-state + force-open DropdownMenu (lines ~980–1027 and ~1272–1336) with `ActionContextMenu`. Behavior preserved: Expand/Collapse, Expand All Children (files), Inspect, Select (multi-select mode only), Copy ID — plus NEW Copy Content on chunks.

- [ ] **Step 1: Replace the context-menu state and handler**

Remove the `contextMenu` state block (lines ~980–987), `handleContextMenu` (990–1021), `closeContextMenu` (1024–1026), `handleContextExpand` (1029–1034), `handleContextExpandAllChildren` (1037–1062), `handleContextInspect` (1065–1073), `handleContextCopyId` (1076–1084).

Add imports (merge with existing `@brainstrike/ui` import lines):

```tsx
import {
  ActionContextMenu,
  useContextMenuTarget,
} from '@brainstrike/ui';
import { type AnyContextAction, defineContextAction } from '@brainstrike/context-actions';
import { browserNodeToTarget } from '../context-actions/collection-target';
```

(Adjust the relative import depth to match the file's location: from `src/components/` it is `../context-actions/collection-target`.)

Add the new state + handler where the old block was:

```tsx
const contextMenuController = useContextMenuTarget();
// Surface-local metadata the local actions close over (prefixed nodeId for the
// expand store, child availability for menu visibility).
const [contextMenuMeta, setContextMenuMeta] = useState<{
  nodeId: string;
  nodeType: string;
  hasChildren: boolean;
} | null>(null);

const handleContextMenu = useCallback(
  (nodeId: string, nodeType: string, data: BrowserNodeData, _event: React.MouseEvent) => {
    const { originalId } = parseNodeId(nodeId);
    const hasChildren =
      nodeType === 'group'
        ? true
        : nodeType === 'collection'
          ? records.some(
              (record) =>
                activeCollectionId === null || record.embeddingSetId === activeCollectionId
            )
          : nodeType === 'file'
            ? records.some(
                (record) =>
                  record.id === originalId &&
                  (activeCollectionId === null || record.embeddingSetId === activeCollectionId) &&
                  (record.chunksCount ?? 0) > 0
              )
            : nodeType === 'chunk'
              ? chunks.some((chunk) => chunk.id === originalId && chunk.hasEmbedding)
              : false;
    setContextMenuMeta({ nodeId, nodeType, hasChildren });
    contextMenuController.setTarget(
      browserNodeToTarget({
        nodeType,
        originalId,
        ...(typeof (data as { name?: unknown }).name === 'string'
          ? { name: (data as { name: string }).name }
          : {}),
        ...(typeof (data as { path?: unknown }).path === 'string'
          ? { path: (data as { path: string }).path }
          : {}),
        ...(typeof (data as { content?: unknown }).content === 'string'
          ? { content: (data as { content: string }).content }
          : {}),
        ...(typeof (data as { vectorId?: unknown }).vectorId === 'string'
          ? { vectorId: (data as { vectorId: string }).vectorId }
          : {}),
      })
    );
  },
  [records, chunks, activeCollectionId, contextMenuController.setTarget]
);
```

(If `BrowserNodeData`'s union members make direct property access cleaner than the `in`/typeof probing above — e.g. if it has a discriminant — prefer direct narrowing. Check `packages/ui/src/collection-browser/types.ts` and use the cleanest strictly-typed form. The probing form above is the worst-case fallback and compiles under strict mode.)

- [ ] **Step 2: Define the surface-local actions (closures over component state)**

```tsx
const localContextActions = useMemo<readonly AnyContextAction[]>(() => {
  if (!contextMenuMeta) {
    return [];
  }
  const { nodeId, nodeType, hasChildren } = contextMenuMeta;
  const actions: AnyContextAction[] = [];

  if (hasChildren) {
    actions.push(
      defineContextAction({
        id: 'collection-browser.toggle-expand',
        label: () => (expandedIdsSet.has(nodeId) ? 'Collapse' : 'Expand'),
        icon: ChevronRight,
        group: 'tree',
        appliesTo: ['collection', 'collection-file', 'chunk'] as const,
        run: async () => {
          toggleExpanded(nodeId);
          return { ok: true };
        },
      })
    );
    if (nodeType === 'file') {
      actions.push(
        defineContextAction({
          id: 'collection-browser.expand-all-children',
          label: 'Expand All Children',
          icon: ChevronsUpDown,
          group: 'tree',
          appliesTo: ['collection-file'] as const,
          run: async () => {
            const { originalId } = parseNodeId(nodeId);
            const fileChunks = await ensureFileChunksLoaded(originalId);
            const childIds = [
              nodeId,
              ...fileChunks
                .filter((chunk) => chunk.hasEmbedding)
                .map((chunk) => `chunk-${chunk.id}`),
            ];
            expandIds(childIds);
            return { ok: true };
          },
        })
      );
    }
  }

  actions.push(
    defineContextAction({
      id: 'collection-browser.inspect',
      label: 'Inspect',
      icon: Eye,
      group: 'inspect',
      appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
      run: async () => {
        setSelectedId(nodeId);
        if (isInspectorCollapsed) {
          handleInspectorCollapse(false);
        }
        return { ok: true };
      },
    })
  );

  if (multiSelectEnabled) {
    actions.push(
      defineContextAction({
        id: 'collection-browser.select',
        label: 'Select',
        icon: SquareCheck,
        group: 'inspect',
        appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
        run: async () => {
          setSelectedId(nodeId);
          return { ok: true };
        },
      })
    );
  }

  return actions;
}, [
  contextMenuMeta,
  expandedIdsSet,
  toggleExpanded,
  ensureFileChunksLoaded,
  expandIds,
  setSelectedId,
  isInspectorCollapsed,
  handleInspectorCollapse,
  multiSelectEnabled,
]);
```

Group/collection nodes: the old menu also offered Expand on `group` and `collection` types, but `browserNodeToTarget` returns null for `group` (no menu on group headers — Radix suppression handles it; acceptable v1 simplification since groups already expand on click). If product behavior must keep group expand, add a `{ kind: 'collection', … }` mapping for groups instead — decide while implementing and note it in the PR.

- [ ] **Step 3: Replace the JSX**

Delete the entire `{contextMenu && (<DropdownMenu …>…)}` block (old lines 1272–1336). Remove now-unused imports if any (`DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`, `DropdownMenuTrigger`, `Copy` — keep icons still used by `bulkActions` and local actions: `ChevronsUpDown`, `ChevronRight`, `Eye`, `SquareCheck`, `Copy` stays if `bulkActions` uses it).

Wrap the `<CollectionBrowser …>` element:

```tsx
<ActionContextMenu controller={contextMenuController} localActions={localContextActions}>
  <div
    className="h-full min-h-0"
    onContextMenuCapture={() => contextMenuController.setTarget(null)}
  >
    <CollectionBrowser
      …existing props unchanged, keep onContextMenu={handleContextMenu}…
    />
  </div>
</ActionContextMenu>
```

(The wrapper div must not break the panel layout — `h-full min-h-0` preserves the flex sizing. Verify visually/by tests.)

- [ ] **Step 4: Migrate `bulkActions` copy-ids to the ClipboardService? NO.**

Out of scope — the bulk action bar is not a context menu. Leave `bulkActions` untouched (its inline `navigator.clipboard` stays; flagged follow-up in the spec covers consolidation).

- [ ] **Step 5: Run db-explorer tests; fix provider wrapping as in Task 9 Step 4**

Run: `pnpm --filter @brainstrike/db-explorer test`
Wrap failing renders with `ActionRegistryProvider` + `createTestActionRegistry({ actions: collectionActions })`.

Add/extend a test asserting the new menu works end-to-end in this surface (in the existing collection-browser-view test file):

```tsx
it('copies a chunk id from the context menu', async () => {
  const { registry, writtenTexts } = createTestActionRegistry({ actions: collectionActions });
  // render collection-browser-view with a chunk row visible, wrapped in the provider
  fireEvent.contextMenu(screen.getByText(/chunk/i), { clientX: 8, clientY: 8 });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy ID' }));
  await waitFor(() => expect(writtenTexts.length).toBeGreaterThan(0));
});
```

(Adapt the row locator to the harness's fixture data.)

- [ ] **Step 6: Type-check and commit**

```bash
git add packages/db-explorer
git commit -m "refactor(db-explorer): migrate collection browser menu to context action system"
```

---

### Task 12: Desktop `window.platform` bridge (TDD)

**Files:**
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts`
- Modify: `apps/desktop/src/platform/desktop-ipc-registry.ts` (add `'shell'` to `DesktopIpcDomain`)
- Create: `apps/desktop/src/ipc-shell.ts`
- Create: `apps/desktop/src/__tests__/ipc-shell.test.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Add channels and domain**

`desktop-ipc-channels.ts` — add alphabetically inside `DESKTOP_IPC_CHANNELS` (between `secrets` and `storage`):

```ts
shell: {
  openPath: 'shell:open-path',
  showItemInFolder: 'shell:show-item-in-folder',
},
```

`desktop-ipc-registry.ts` — extend the union:

```ts
export type DesktopIpcDomain =
  | 'agent'
  | 'chunking-host'
  | 'db'
  | 'diagnostics'
  | 'embeddings'
  | 'files'
  | 'llm-host'
  | 'logging'
  | 'mcp'
  | 'preferences'
  | 'runtime'
  | 'shell'
  | 'storage'
  | 'tools';
```

- [ ] **Step 2: Write the failing test — `apps/desktop/src/__tests__/ipc-shell.test.ts`**

(Check how existing `apps/desktop/src/__tests__/` tests stub Electron — e.g. the ipc-runtime or main-platform tests — and follow the same stubbing convention. The handlers take injected dependencies precisely so tests need no Electron.)

```ts
import { describe, expect, it, vi } from 'vitest';
import { createShellIpcHandlers } from '../ipc-shell';

function makeShell() {
  return {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  };
}

describe('shell IPC handlers', () => {
  it('reveals a valid absolute path', async () => {
    const shell = makeShell();
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.showItemInFolder('/Users/dev/project/file.ts');
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/Users/dev/project/file.ts');
    expect(result).toEqual({ ok: true });
  });

  it.each(['', '   ', 'relative/path.ts', 42, null, undefined, { path: '/x' }])(
    'rejects invalid payload %p without touching shell',
    async (payload) => {
      const shell = makeShell();
      const handlers = createShellIpcHandlers({ shell });
      const result = await handlers.showItemInFolder(payload);
      expect(result.ok).toBe(false);
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    }
  );

  it('propagates shell.openPath error strings as failures', async () => {
    const shell = makeShell();
    shell.openPath.mockResolvedValue('No application found');
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.openPath('/Users/dev/file.xyz');
    expect(result).toEqual({ ok: false, error: 'No application found' });
  });

  it('opens a valid absolute path', async () => {
    const shell = makeShell();
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.openPath('/Users/dev/file.pdf');
    expect(shell.openPath).toHaveBeenCalledWith('/Users/dev/file.pdf');
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run to verify it fails, then create `apps/desktop/src/ipc-shell.ts`**

```ts
import { ipcMain, shell as electronShell } from 'electron';
import path from 'node:path';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export interface ShellIpcResult {
  ok: boolean;
  error?: string;
}

interface ShellLike {
  openPath: (target: string) => Promise<string>;
  showItemInFolder: (target: string) => void;
}

interface ShellIpcDependencies {
  shell: ShellLike;
}

function validateAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

export function createShellIpcHandlers({ shell }: ShellIpcDependencies) {
  return {
    openPath: async (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return { ok: false, error: 'openPath requires a non-empty absolute path string' };
      }
      const errorMessage = await shell.openPath(absolutePath);
      return errorMessage.length > 0 ? { ok: false, error: errorMessage } : { ok: true };
    },
    showItemInFolder: (rawPath: unknown): Promise<ShellIpcResult> => {
      const absolutePath = validateAbsolutePath(rawPath);
      if (!absolutePath) {
        return Promise.resolve({
          ok: false,
          error: 'showItemInFolder requires a non-empty absolute path string',
        });
      }
      shell.showItemInFolder(absolutePath);
      return Promise.resolve({ ok: true });
    },
  };
}

export function registerShellIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createShellIpcHandlers({ shell: electronShell });

  registry.registerInvoke('shell', DESKTOP_IPC_CHANNELS.shell.showItemInFolder, (_event, rawPath: unknown) =>
    handlers.showItemInFolder(rawPath)
  );
  registry.registerInvoke('shell', DESKTOP_IPC_CHANNELS.shell.openPath, (_event, rawPath: unknown) =>
    handlers.openPath(rawPath)
  );

  return () => {
    registry.unregisterAll();
  };
}
```

- [ ] **Step 4: Run the tests — expect PASS.** (Note: importing `electron` at module top in a vitest node environment can throw; if it does, follow the existing desktop test convention — most ipc-* test files mock `electron` with `vi.mock('electron', …)` or the module under test splits pure handlers from registration. `createShellIpcHandlers` is pure; if the `electron` import still breaks the test file, move `createShellIpcHandlers` + `validateAbsolutePath` into `apps/desktop/src/ipc-shell-handlers.ts` (no electron import) and keep registration in `ipc-shell.ts`. Mirror whatever `ipc-runtime`'s tests do.)

- [ ] **Step 5: Expose the preload bridge**

In `apps/desktop/src/preload.ts`, immediately after the existing clipboard bridge (line ~915), add:

```ts
// Platform shell bridge: reveal/open absolute paths in the OS file manager.
if (shouldExposeBridge('platform')) {
  contextBridge.exposeInMainWorld('platform', {
    openPath: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.shell.openPath, absolutePath),
    showItemInFolder: (absolutePath: string) =>
      ipcRenderer.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.shell.showItemInFolder, absolutePath),
  });
}
```

(`DESKTOP_PRELOAD_IPC_CHANNELS` is already imported in preload.ts; verify and reuse the existing import.)

- [ ] **Step 6: Type the bridge in `apps/desktop/src/types/electron.d.ts`**

Inside the `Window` interface, alongside the other bridges:

```ts
platform?: {
  openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
  showItemInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
};
```

- [ ] **Step 7: Register in `apps/desktop/src/main.ts`**

Add to the unregister variable block (near line 602):

```ts
let unregisterShellIpcHandlers: null | (() => void) = null;
```

Add the import near the other ipc imports (line ~51):

```ts
import { registerShellIpcHandlers } from './ipc-shell';
```

Register next to the other registrations (after line 831's `registerDesktopDiagnosticsIpcHandlers` block):

```ts
unregisterShellIpcHandlers = registerShellIpcHandlers();
```

Clean up in the `will-quit` handler where the other unregister calls live (search `unregisterMainIpcHandlers` around line 1356):

```ts
if (unregisterShellIpcHandlers) {
  unregisterShellIpcHandlers();
  unregisterShellIpcHandlers = null;
}
```

- [ ] **Step 8: Type-check the desktop app, run its unit tests, commit**

Run: `pnpm --filter @brainstrike/desktop type-check && pnpm --filter @brainstrike/desktop test`
Expected: PASS.

```bash
git add apps/desktop
git commit -m "feat(desktop): add window.platform shell bridge (reveal/open absolute paths)"
```

---

### Task 13: Compose the registry in `app-shell` and mount the provider

**Files:**
- Modify: `packages/app-shell/package.json` (add `@brainstrike/context-actions`; `@brainstrike/file-explorer-ui` and `@brainstrike/db-explorer` are likely already deps — verify with `grep '"@brainstrike' packages/app-shell/package.json` and add whichever is missing)
- Modify: `packages/app-shell/tsconfig.json` references accordingly
- Create: `packages/app-shell/src/context-action-registry.ts`
- Create: `packages/app-shell/src/__tests__/context-action-registry.test.ts`
- Modify: `packages/app-shell/src/root-layout-content.tsx`

- [ ] **Step 1: Create `packages/app-shell/src/context-action-registry.ts`**

```ts
import {
  type ActionRegistry,
  type ActionServices,
  type CapabilityKey,
  createActionRegistry,
  createClipboardService,
} from '@brainstrike/context-actions';
import { collectionActions } from '@brainstrike/db-explorer';
import { fileEntryActions } from '@brainstrike/file-explorer-ui';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('ContextActionRegistry');

interface PlatformBridge {
  openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
  showItemInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>;
}

function resolvePlatformBridge(): PlatformBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { platform?: Partial<PlatformBridge> }).platform;
  if (!bridge) {
    return null;
  }
  if (
    typeof bridge.showItemInFolder !== 'function' ||
    typeof bridge.openPath !== 'function'
  ) {
    // A partially-formed bridge is a wiring bug, not a missing capability —
    // log loudly instead of silently downgrading to web behavior.
    logger.error('window.platform bridge is malformed; shell actions disabled', {
      hasOpenPath: typeof bridge.openPath === 'function',
      hasShowItemInFolder: typeof bridge.showItemInFolder === 'function',
    });
    return null;
  }
  return bridge as PlatformBridge;
}

export function createAppActionRegistry(): ActionRegistry {
  const services: ActionServices = { clipboard: createClipboardService() };
  const capabilities = new Set<CapabilityKey>(['clipboard']);

  const platformBridge = resolvePlatformBridge();
  if (platformBridge) {
    services.platformFs = {
      openPath: async (absolutePath) => {
        const result = await platformBridge.openPath(absolutePath);
        return result.ok
          ? { ok: true }
          : { ok: false, error: result.error ?? 'Open failed' };
      },
      showItemInFolder: async (absolutePath) => {
        const result = await platformBridge.showItemInFolder(absolutePath);
        return result.ok
          ? { ok: true }
          : { ok: false, error: result.error ?? 'Reveal failed' };
      },
    };
    capabilities.add('fs.reveal');
    capabilities.add('fs.openPath');
  }

  return createActionRegistry({
    actions: [...fileEntryActions, ...collectionActions],
    capabilities,
    services,
  });
}
```

- [ ] **Step 2: Write the test — `packages/app-shell/src/__tests__/context-action-registry.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppActionRegistry } from '../context-action-registry';

type MutableWindow = Window & { platform?: unknown };

afterEach(() => {
  (window as MutableWindow).platform = undefined;
  vi.restoreAllMocks();
});

describe('createAppActionRegistry', () => {
  it('grants only clipboard on web (no window.platform)', () => {
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('clipboard')).toBe(true);
    expect(registry.capabilities.has('fs.reveal')).toBe(false);
  });

  it('grants fs capabilities when window.platform is fully formed', () => {
    (window as MutableWindow).platform = {
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('fs.reveal')).toBe(true);
    expect(registry.capabilities.has('fs.openPath')).toBe(true);
    expect(registry.services.platformFs).toBeDefined();
  });

  it('treats a malformed bridge as absent (and the actions stay hidden)', () => {
    (window as MutableWindow).platform = { showItemInFolder: vi.fn() };
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('fs.reveal')).toBe(false);
    expect(registry.services.platformFs).toBeUndefined();
  });
});
```

Run: `pnpm --filter @brainstrike/app-shell test -- --run src/__tests__/context-action-registry.test.ts`
Expected: FAIL before Step 1's file exists / PASS after. (Order the TDD loop as usual: write test → red → implement → green.)

- [ ] **Step 3: Mount the provider in `packages/app-shell/src/root-layout-content.tsx`**

Add imports:

```tsx
import { ActionRegistryProvider } from '@brainstrike/ui';
import { createAppActionRegistry } from './context-action-registry';
```

In the component that returns the `<AppLayout>` tree (line ~291), create the registry once:

```tsx
const actionRegistry = useMemo(() => createAppActionRegistry(), []);
```

Wrap the children of `<AppLayout>` (outside `ChunkingWorkerProvider`, so every surface in every tab sees it):

```tsx
<AppLayout …>
  <ActionRegistryProvider registry={actionRegistry}>
    <ChunkingWorkerProvider …>
      …existing content unchanged…
    </ChunkingWorkerProvider>
  </ActionRegistryProvider>
</AppLayout>
```

`useMemo` with `[]` is correct here: the preload bridge exists before React mounts, so capability detection at first render is stable for the window's lifetime.

- [ ] **Step 4: Run app-shell tests, type-check, commit**

Run: `pnpm --filter @brainstrike/app-shell test && pnpm --filter @brainstrike/app-shell type-check`
Fix any app-shell tests that render `RootLayoutContent` if module resolution needs the new deps built (`pnpm --filter @brainstrike/context-actions build` first if a test imports dist).

```bash
git add packages/app-shell pnpm-lock.yaml
git commit -m "feat(app-shell): compose context action registry and mount provider"
```

---

### Task 14: Web E2E smoke — copy relative path from the file tree

**Files:**
- Modify: `apps/web/e2e/utils/file-explorer-setup.ts` (thread a `clipboard` flag)
- Create: `apps/web/e2e/file-tree-context-menu.test.ts`

- [ ] **Step 1: Thread the clipboard option through bootstrap**

In `apps/web/e2e/utils/file-explorer-setup.ts`:
- Add to `ExplorerBootstrapOptions`:

```ts
/**
 * Install the clipboard mock so navigator.clipboard.writeText logs to the
 * console (asserted via page console messages).
 */
clipboard?: boolean;
```

- In `bootstrapFileExplorer`, destructure `clipboard = false` and change the `mockBrowserApis` call to:

```ts
await mockBrowserApis(page, projectName, tree, { clipboard });
```

- [ ] **Step 2: Create `apps/web/e2e/file-tree-context-menu.test.ts`**

```ts
import { expect, test } from '@playwright/test';
import { bootstrapFileExplorer } from './utils/file-explorer-setup';
import type { FileTree } from './utils/mock-fs';

const tree: FileTree = {
  docs: {
    'notes.md': null,
  },
  'readme.md': null,
};

test.describe('File tree context menu', { tag: '@smoke' }, () => {
  test('copies the relative path of a nested file', async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on('console', (message) => consoleMessages.push(message.text()));

    await bootstrapFileExplorer(page, { tree, clipboard: true });

    // Expand the docs directory, then right-click the nested file.
    await page.getByText('docs', { exact: true }).click();
    const fileRow = page.getByText('notes.md', { exact: true });
    await expect(fileRow).toBeVisible();
    await fileRow.click({ button: 'right' });

    const copyRelative = page.getByRole('menuitem', { name: 'Copy Relative Path' });
    await expect(copyRelative).toBeVisible();

    // Desktop-only actions must be hidden on web.
    await expect(page.getByRole('menuitem', { name: 'Copy Full Path' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Reveal in/ })).toHaveCount(0);

    await copyRelative.click();

    // Success toast confirms the outcome surfaced to the user.
    await expect(page.getByText('Relative path copied')).toBeVisible();

    // The clipboard mock logs the written text to the console.
    await expect
      .poll(() => consoleMessages.some((text) => text.includes('docs/notes.md')))
      .toBe(true);
  });
});
```

(Adapt the expand/locator steps to the actual tree row affordances if `getByText('docs').click()` toggles selection instead of expansion — the existing `file-explorer.test.ts` shows the correct expansion gesture; mirror it. The assertions that matter: menu opens, relative-path item present, desktop items absent, toast appears, clipboard received `docs/notes.md`.)

- [ ] **Step 3: Run the test**

Run (from repo root): `pnpm --filter @brainstrike/web exec playwright test e2e/file-tree-context-menu.test.ts`
Expected: PASS. (Check `apps/web/package.json` for the canonical e2e script name — e.g. `test:e2e` — and prefer it if it sets required env/config.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e
git commit -m "test(web): e2e smoke for file tree context menu copy relative path"
```

---

### Task 15: Documentation + full verification gate

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a "CONTEXT ACTION SYSTEM" section to AGENTS.md** (after the TREEGRID CONVERGENCE CONTRACT section, matching its style):

```markdown
## CONTEXT ACTION SYSTEM

Right-click menus are projections of a shared action system. Do not hand-roll
per-surface context menus (coordinate state + positioned DropdownMenu is the
legacy pattern; it was removed from the collection browser).

Layers:
- Headless core: packages/context-actions — ContextTarget union, ContextAction,
  createActionRegistry, ClipboardService, path helpers. No React rendering, no
  Electron imports.
- Renderer: packages/ui/src/context-menu — Radix ContextMenu wrapper +
  ActionRegistryProvider + ActionContextMenu + useContextMenuTarget.
- Composition: packages/app-shell/src/context-action-registry.ts builds the
  registry (capabilities from the bridges that exist) and mounts the provider
  in root-layout-content.tsx.
- Desktop bridge: window.platform (preload) → 'shell' IPC domain →
  apps/desktop/src/ipc-shell.ts (validates absolute paths).

Rules:
- Capability gating hides actions (no disabled "available on desktop" items).
  Web simply never constructs 'fs.reveal'. No isElectron() checks in action or
  menu code.
- Every action run resolves to ActionOutcome; failures MUST toast + log
  (createLogger('ContextActions')). No silent fallbacks: a present-but-broken
  bridge reports failure, never degrades quietly.
- Adding an action: define it with defineContextAction in the owning feature
  package, add it to that package's exported action array, cover run/gating in
  unit tests.
- Adding a surface: add a target kind to ContextTarget, write a node→target
  adapter, set the target in the surface's row contextmenu handler, reset it
  with onContextMenuCapture on the container, wrap with ActionContextMenu.
  Surface-local actions (closures over surface stores) go through the
  localActions prop, not the global registry.
- Adding a capability: extend CapabilityKey, construct it in
  createAppActionRegistry only when the backing bridge is fully formed.

When changing this flow, update this section and the related tests.
```

- [ ] **Step 2: Run ultracite and the full gate**

```bash
pnpm dlx ultracite fix
pnpm check
```

Expected: clean build, lint, type check, and unit tests all green in the same run. Iterate on failures until everything passes together (the team bar — CI double-checks, it does not discover).

Known flake: `db#test` under turbo concurrency — re-run in isolation if it fails (`pnpm --filter @brainstrike/db test`).

- [ ] **Step 3: Run both E2E smokes locally if time permits**

Web: the Task 14 test. Desktop smoke runs in CI on the PR.

- [ ] **Step 4: Final commit**

```bash
git add AGENTS.md
git commit -m "docs: document the context action system in AGENTS.md"
```

---

## Post-plan notes for the executor

- **Files intentionally NOT touched:** `packages/ui/src/assistant-ui-panel/markdown-text.tsx` (its ad-hoc clipboard is a flagged follow-up), `bulkActions` in collection-browser-view (not a context menu), TreeTable internals (we only consume its existing `onRowContextMenu`), workspace tabs / CodeSurface / assistant panel (future target kinds).
- **Deferred:** "Open in Default App" action (bridge support ships; action does not), cmdk command palette, keybinding registry.
- **If Radix ContextMenu fights jsdom** in any component test, prefer switching that test to the vitest browser project (`pnpm --filter @brainstrike/ui test:browser`) over weakening assertions.
- The spec is the arbiter for behavior questions: `docs/superpowers/specs/2026-06-09-context-action-system-design.md`.
