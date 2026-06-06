# Assistant Context-Tool Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assistant set tapestry range colors from a named palette and look up a symbol's exact line range without reading the whole file.

**Architecture:** Two additive features. (1) A shared color palette in `@brainstrike/types` (single source of truth) feeds a zod color enum on the tapestry tool input, threads through the IPC payload, and resolves to hex in `buildAssistantTapestryRange`. (2) A new read-only `brainstrike.findWorkspaceSymbol` tool greps a file for a symbol and returns a best-effort enclosing line range via a pure brace/indent heuristic. Prompt guidance steers the model to both.

**Tech Stack:** TypeScript, zod, Vitest, pnpm workspaces, Mastra `createTool`, React (Zustand store), Electron IPC.

**Spec:** `docs/superpowers/specs/2026-06-06-assistant-context-tools-design.md`

**Refinement vs spec:** the spec split the color names (agent) from the hex map (file-explorer-ui). This plan instead puts BOTH in `@brainstrike/types` — verified that `@brainstrike/agent` and `@brainstrike/app-shell` both depend on `@brainstrike/types` and app-shell does not depend on agent, so `@brainstrike/types` is the only clean single source of truth.

**Run the full gate after each task before committing:** from repo root `pnpm --filter <pkg> type-check && pnpm dlx ultracite check <changed files> && pnpm --filter <pkg> test -- --run`.

---

## Task 1: Shared tapestry color palette in `@brainstrike/types`

**Files:**
- Create: `packages/types/src/tapestry-colors.ts`
- Modify: `packages/types/src/index.ts` (add export)
- Test: `packages/types/src/__tests__/tapestry-colors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/types/src/__tests__/tapestry-colors.test.ts
import { describe, expect, it } from 'vitest';
import {
  TAPESTRY_COLOR_NAMES,
  TAPESTRY_COLOR_HEX,
  resolveTapestryColorHex,
} from '../tapestry-colors';

describe('tapestry-colors', () => {
  it('maps every name to a 6-digit hex', () => {
    for (const name of TAPESTRY_COLOR_NAMES) {
      expect(TAPESTRY_COLOR_HEX[name]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('resolveTapestryColorHex returns the mapped hex or undefined', () => {
    expect(resolveTapestryColorHex('blue')).toBe('#3b82f6');
    expect(resolveTapestryColorHex(undefined)).toBeUndefined();
    // @ts-expect-error invalid name is rejected at the type level
    expect(resolveTapestryColorHex('chartreuse')).toBeUndefined();
  });

  it('exposes the 9 expected names', () => {
    expect([...TAPESTRY_COLOR_NAMES]).toEqual([
      'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'gray',
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @brainstrike/types test -- --run tapestry-colors`
Expected: FAIL — cannot find module `../tapestry-colors`.

- [ ] **Step 3: Implement the module**

```ts
// packages/types/src/tapestry-colors.ts

/** Named colors the assistant may assign to a tapestry range. Order is the
 * display/auto-assign palette order and matches the file-explorer COLORS palette. */
export const TAPESTRY_COLOR_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;

export type TapestryColorName = (typeof TAPESTRY_COLOR_NAMES)[number];

/** Single source of truth for name -> hex. Keep in sync with the file-explorer
 * COLORS palette (first 8 match; gray is the de-emphasis color). */
export const TAPESTRY_COLOR_HEX: Record<TapestryColorName, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#6b7280',
};

export function resolveTapestryColorHex(
  name: TapestryColorName | undefined
): string | undefined {
  return name ? TAPESTRY_COLOR_HEX[name] : undefined;
}
```

- [ ] **Step 4: Add the export**

In `packages/types/src/index.ts`, add (alphabetically near other exports):

```ts
export * from './tapestry-colors';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/types test -- --run tapestry-colors`
Expected: PASS (3 tests).

- [ ] **Step 6: Gate + commit**

```bash
pnpm --filter @brainstrike/types type-check
pnpm dlx ultracite check packages/types/src/tapestry-colors.ts packages/types/src/__tests__/tapestry-colors.test.ts
git add packages/types/src/tapestry-colors.ts packages/types/src/__tests__/tapestry-colors.test.ts packages/types/src/index.ts
git commit -m "feat(types): shared tapestry color palette (names + hex)"
```

---

## Task 2: Add `color` to the tapestry tool input schema

**Files:**
- Modify: `packages/agent/src/tools/schemas.ts` (`WorkspaceTapestryRangeInputSchema`)
- Test: `packages/agent/src/tools/__tests__/schemas.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/tools/__tests__/schemas.test.ts
import { describe, expect, it } from 'vitest';
import { UpdateWorkspaceTapestrySelectionsInputSchema } from '../schemas';

describe('UpdateWorkspaceTapestrySelectionsInputSchema color', () => {
  const base = {
    updates: [{ path: '/a.ts', ranges: [{ startLine: 1, endLine: 3 }] }],
  };

  it('accepts an omitted color', () => {
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a valid named color', () => {
    const input = { updates: [{ path: '/a.ts', ranges: [{ startLine: 1, endLine: 3, color: 'blue' }] }] };
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects an unknown color name (no silent fallback)', () => {
    const input = { updates: [{ path: '/a.ts', ranges: [{ startLine: 1, endLine: 3, color: 'chartreuse' }] }] };
    expect(UpdateWorkspaceTapestrySelectionsInputSchema.safeParse(input).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @brainstrike/agent test -- --run schemas`
Expected: FAIL — the `color: 'blue'` case fails because `.strict()` rejects the unknown `color` key.

- [ ] **Step 3: Add `color` to the range schema**

In `packages/agent/src/tools/schemas.ts`, add the import at the top:

```ts
import { TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
```

Then extend `WorkspaceTapestryRangeInputSchema`:

```ts
const WorkspaceTapestryRangeInputSchema = z
  .object({
    startLine: z.number().int().positive().describe('1-based inclusive starting line'),
    endLine: z.number().int().positive().describe('1-based inclusive ending line'),
    isActive: z.boolean().optional().describe('Whether this range contributes to context output'),
    color: z
      .enum(TAPESTRY_COLOR_NAMES)
      .optional()
      .describe(
        'Optional named color to group related ranges (red, orange, yellow, green, cyan, blue, purple, pink, gray). Reuse the same color for the same concept. Omit to auto-assign.'
      ),
  })
  .strict();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/agent test -- --run schemas`
Expected: PASS (3 tests).

- [ ] **Step 5: Gate + commit**

```bash
pnpm --filter @brainstrike/agent type-check
pnpm dlx ultracite check packages/agent/src/tools/schemas.ts packages/agent/src/tools/__tests__/schemas.test.ts
git add packages/agent/src/tools/schemas.ts packages/agent/src/tools/__tests__/schemas.test.ts
git commit -m "feat(agent): accept optional named color on tapestry range input"
```

---

## Task 3: Thread `color` through the IPC payload + tool runner

**Files:**
- Modify: `packages/types/src/electron-api.ts` (`AssistantWorkspaceTapestryRangePayload`)
- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts` (updates mapping ~line 1187)
- Test: `apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts` (append; mirror the existing `updateWorkspaceTapestrySelections` broadcast test)

- [ ] **Step 1: Add `color` to the payload type**

In `packages/types/src/electron-api.ts`, extend the interface and import the type:

```ts
import type { TapestryColorName } from './tapestry-colors';

export interface AssistantWorkspaceTapestryRangePayload {
  color?: TapestryColorName;
  endLine: number;
  isActive?: boolean;
  startLine: number;
}
```

- [ ] **Step 2: Write the failing test**

Find the existing test in `assistant-tools.test.ts` that calls the `brainstrike.updateWorkspaceTapestrySelections` tool and captures the broadcast payload (search for `WORKSPACE_CONTEXT_TAPESTRY_EVENT` or `updateWorkspaceTapestrySelections`). Add a sibling test that passes a `color` and asserts it appears on the broadcast range. Concretely:

```ts
it('forwards a named range color to the tapestry broadcast payload', async () => {
  const workspaceRootPath = await createWorkspaceFixture();
  const sent: AssistantWorkspaceTapestryUpdatePayload[] = [];
  // Reuse the same window/webContents mock pattern the existing tapestry test uses;
  // capture payloads sent on WORKSPACE_CONTEXT_TAPESTRY_EVENT into `sent`.
  const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
  const tool = tools['brainstrike.updateWorkspaceTapestrySelections'];
  await tool.execute({
    context: {
      updates: [{ path: '/src/main.ts', ranges: [{ startLine: 1, endLine: 2, color: 'blue' }] }],
    },
  });
  const tapestry = sent.find((p) => p.updates?.length);
  expect(tapestry?.updates[0]?.ranges[0]).toMatchObject({ startLine: 1, endLine: 2, color: 'blue' });
  await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
});
```

Note: copy the exact window/webContents broadcast-capture setup from the existing tapestry test in the same file so the mock matches; only the `color` assertion is new.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @brainstrike/desktop test -- --run assistant-tools`
Expected: FAIL — broadcast range has no `color` (the runner drops it).

- [ ] **Step 4: Thread `color` in the updates mapping**

In `apps/desktop/src/assistant-server/assistant-tools.ts`, the mapping at ~line 1187 currently is:

```ts
      ranges: update.ranges.map((range) => ({
        startLine: range.startLine,
        endLine: range.endLine,
        ...(range.isActive === undefined ? {} : { isActive: range.isActive }),
      })),
```

Change it to also forward color:

```ts
      ranges: update.ranges.map((range) => ({
        startLine: range.startLine,
        endLine: range.endLine,
        ...(range.isActive === undefined ? {} : { isActive: range.isActive }),
        ...(range.color === undefined ? {} : { color: range.color }),
      })),
```

If a local runtime range metadata type annotates these objects and rejects `color`, add `color?: TapestryColorName` to that type (search `assistant-tools.ts` for the type of `updates`; it must be assignable to `AssistantWorkspaceTapestryUpdatePayload`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/desktop test -- --run assistant-tools`
Expected: PASS (existing tests + the new color test).

- [ ] **Step 6: Gate + commit**

```bash
pnpm --filter @brainstrike/types type-check && pnpm --filter @brainstrike/desktop type-check
pnpm dlx ultracite check packages/types/src/electron-api.ts apps/desktop/src/assistant-server/assistant-tools.ts apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts
git add packages/types/src/electron-api.ts apps/desktop/src/assistant-server/assistant-tools.ts apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts
git commit -m "feat(desktop): forward tapestry range color to the IPC broadcast"
```

---

## Task 4: Resolve `color` to hex in `buildAssistantTapestryRange` (renderer)

**Files:**
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts` (`buildAssistantTapestryRange` ~line 251)
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` (`handleTapestryUpdate` ~line 507)
- Test: `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts
import { describe, expect, it } from 'vitest';
import { buildAssistantTapestryRange } from '../assistant-ui-panel-wrapper-runtime';

describe('buildAssistantTapestryRange color', () => {
  const base = { compositeKey: 'folder::/a.ts', index: 0, startLine: 1, endLine: 3, isActive: true };

  it('uses the resolved hex when a named color is provided', () => {
    const range = buildAssistantTapestryRange({ ...base, color: 'blue' });
    expect(range.color).toBe('#3b82f6');
  });

  it('falls back to the deterministic color when color is omitted', () => {
    const range = buildAssistantTapestryRange(base);
    expect(range.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(range.color).not.toBe('#3b82f6'); // deterministic-by-key, not the named blue
  });
});
```

(If the deterministic fallback for this key happens to be `#3b82f6`, change `base.compositeKey` to a key whose `getAssistantTapestryColor` is not blue — verify by computing once.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @brainstrike/app-shell test -- --run assistant-ui-panel-wrapper-runtime`
Expected: FAIL — `buildAssistantTapestryRange` rejects the `color` arg / ignores it.

- [ ] **Step 3: Implement color resolution**

In `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts`, add the import:

```ts
import { resolveTapestryColorHex, type TapestryColorName } from '@brainstrike/types';
```

Update the signature + body of `buildAssistantTapestryRange` (currently around line 251):

```ts
export function buildAssistantTapestryRange(args: {
  color?: TapestryColorName;
  compositeKey: string;
  endLine: number;
  index: number;
  isActive: boolean | undefined;
  startLine: number;
}): TapestryRange {
  const internalRange = toolLineRangeToTapestryRange({
    startLine: args.startLine,
    endLine: args.endLine,
  });
  const rangeKey = `${args.compositeKey}:${args.index}:${args.startLine}:${args.endLine}`;
  return {
    id: `assistant-${rangeKey}`,
    startLine: internalRange.startLine,
    endLine: internalRange.endLine,
    isActive: args.isActive !== false,
    color: resolveTapestryColorHex(args.color) ?? getAssistantTapestryColor(rangeKey),
    userModified: true,
  };
}
```

- [ ] **Step 4: Pass `color` from the handler**

In `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`, the `handleTapestryUpdate` callback maps `update.ranges` into `buildAssistantTapestryRange({ compositeKey, index, startLine, endLine, isActive })`. Add `color: range.color`:

```ts
              buildAssistantTapestryRange({
                compositeKey,
                index,
                startLine: range.startLine,
                endLine: range.endLine,
                isActive: range.isActive,
                color: range.color,
              })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/app-shell test -- --run assistant-ui-panel-wrapper-runtime`
Expected: PASS (2 tests).

- [ ] **Step 6: Gate + commit**

```bash
pnpm --filter @brainstrike/app-shell type-check
pnpm dlx ultracite check packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts packages/app-shell/src/assistant-ui-panel-wrapper.tsx packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts
git add packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts packages/app-shell/src/assistant-ui-panel-wrapper.tsx packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts
git commit -m "feat(app-shell): apply agent-provided tapestry range color"
```

---

## Task 5: `findWorkspaceSymbol` block-range heuristic (pure)

**Files:**
- Create: `apps/desktop/src/assistant-server/find-workspace-symbol.ts`
- Test: `apps/desktop/src/__tests__/assistant-server/find-workspace-symbol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/__tests__/assistant-server/find-workspace-symbol.test.ts
import { describe, expect, it } from 'vitest';
import { findSymbolMatches } from '../../assistant-server/find-workspace-symbol';

const TS = `import x from 'y';

export function alpha(a: number): number {
  if (a > 0) {
    return a;
  }
  return 0;
}

const note = "function beta() { not real }";

export const gamma = 1;
`;

describe('findSymbolMatches', () => {
  it('returns the enclosing brace block for a function (1-based inclusive)', () => {
    const { matches } = findSymbolMatches(TS, 'alpha', { maxMatches: 5, contextLines: 1 });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ declarationLine: 3, startLine: 3, endLine: 8 });
  });

  it('treats a single-line const as a one-line range', () => {
    const { matches } = findSymbolMatches(TS, 'gamma', { maxMatches: 5, contextLines: 0 });
    expect(matches[0]).toMatchObject({ declarationLine: 12, startLine: 12, endLine: 12 });
  });

  it('ignores matches inside string/comment-only lines for block detection', () => {
    // 'beta' only appears inside a string; declaration line is the string line and
    // the block heuristic must not run off the end of the file.
    const { matches } = findSymbolMatches(TS, 'beta', { maxMatches: 5, contextLines: 0 });
    expect(matches[0]).toMatchObject({ declarationLine: 10, startLine: 10, endLine: 10 });
  });

  it('handles indent-based blocks (no braces)', () => {
    const py = ['def foo():', '    a = 1', '    return a', '', 'bar = 2'].join('\n');
    const { matches } = findSymbolMatches(py, 'foo', { maxMatches: 5, contextLines: 0 });
    expect(matches[0]).toMatchObject({ declarationLine: 1, startLine: 1, endLine: 3 });
  });

  it('respects maxMatches and reports truncated', () => {
    const many = ['a x', 'b x', 'c x', 'd x'].join('\n');
    const result = findSymbolMatches(many, 'x', { maxMatches: 2, contextLines: 0 });
    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('returns empty for no match', () => {
    const result = findSymbolMatches(TS, 'doesNotExist', { maxMatches: 5, contextLines: 0 });
    expect(result).toMatchObject({ matches: [], totalMatches: 0, truncated: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npx vitest run src/__tests__/assistant-server/find-workspace-symbol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure module**

```ts
// apps/desktop/src/assistant-server/find-workspace-symbol.ts

export interface SymbolMatch {
  declarationLine: number; // 1-based line where the query matched
  startLine: number; // 1-based inclusive enclosing block start
  endLine: number; // 1-based inclusive enclosing block end (best-effort)
  name: string; // trimmed declaration line text
  preview: string; // small numbered snippet around the declaration
}

export interface FindSymbolResult {
  matches: SymbolMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface FindSymbolOptions {
  maxMatches: number;
  contextLines: number;
}

/** Count net brace depth on a line, ignoring braces inside line/block comments
 * and string/template literals. Returns the delta to apply to running depth. */
function braceDelta(line: string): number {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inBlockComment = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      break; // rest of line is a comment
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
  }
  return depth;
}

function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/** Best-effort enclosing block end for the declaration at `declIndex` (0-based). */
function resolveBlockEndIndex(lines: string[], declIndex: number): number {
  // Find the first "{" at/after the declaration line within a short lookahead.
  const lookahead = Math.min(declIndex + 5, lines.length - 1);
  let openIndex = -1;
  let depthAtOpen = 0;
  for (let i = declIndex; i <= lookahead; i += 1) {
    const delta = braceDelta(lines[i] ?? '');
    if (delta > 0) {
      openIndex = i;
      depthAtOpen = delta;
      break;
    }
  }
  if (openIndex >= 0) {
    let depth = depthAtOpen;
    for (let i = openIndex + 1; i < lines.length; i += 1) {
      depth += braceDelta(lines[i] ?? '');
      if (depth <= 0) {
        return i;
      }
    }
    return lines.length - 1;
  }
  // Indent-based fallback (e.g. Python). Block = following lines indented deeper
  // than the declaration, stopping at the first line indented <= declaration that
  // is not blank.
  const declIndent = indentWidth(lines[declIndex] ?? '');
  let end = declIndex;
  for (let i = declIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) {
      continue;
    }
    if (indentWidth(line) <= declIndent) {
      break;
    }
    end = i;
  }
  return end;
}

function buildPreview(lines: string[], declIndex: number, contextLines: number): string {
  const start = Math.max(0, declIndex - contextLines);
  const end = Math.min(lines.length - 1, declIndex + contextLines);
  const out: string[] = [];
  for (let i = start; i <= end; i += 1) {
    out.push(`${i + 1}: ${lines[i] ?? ''}`);
  }
  return out.join('\n');
}

export function findSymbolMatches(
  content: string,
  query: string,
  options: FindSymbolOptions
): FindSymbolResult {
  const lines = content.split('\n');
  const declIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').includes(query)) {
      declIndexes.push(i);
    }
  }
  const totalMatches = declIndexes.length;
  const capped = declIndexes.slice(0, Math.max(0, options.maxMatches));
  const matches: SymbolMatch[] = capped.map((declIndex) => {
    const endIndex = resolveBlockEndIndex(lines, declIndex);
    return {
      declarationLine: declIndex + 1,
      startLine: declIndex + 1,
      endLine: endIndex + 1,
      name: (lines[declIndex] ?? '').trim(),
      preview: buildPreview(lines, declIndex, options.contextLines),
    };
  });
  return { matches, totalMatches, truncated: totalMatches > matches.length };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/__tests__/assistant-server/find-workspace-symbol.test.ts`
Expected: PASS (6 tests). If the string-only `beta` case detects a stray brace, confirm `braceDelta` ignores the `{`/`}` inside the double-quoted string (it should). Adjust the test's expected line numbers only if the fixture line numbering differs — never weaken the brace-in-string assertion.

- [ ] **Step 5: Gate + commit**

```bash
pnpm --filter @brainstrike/desktop type-check
pnpm dlx ultracite check apps/desktop/src/assistant-server/find-workspace-symbol.ts apps/desktop/src/__tests__/assistant-server/find-workspace-symbol.test.ts
git add apps/desktop/src/assistant-server/find-workspace-symbol.ts apps/desktop/src/__tests__/assistant-server/find-workspace-symbol.test.ts
git commit -m "feat(desktop): pure symbol block-range heuristic for findWorkspaceSymbol"
```

---

## Task 6: `findWorkspaceSymbol` tool runner + registration

**Files:**
- Modify: `packages/agent/src/tools/schemas.ts` (add `FindWorkspaceSymbolInputSchema`)
- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts` (runner + register tool)
- Test: `apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts` (append)

- [ ] **Step 1: Add the input schema**

In `packages/agent/src/tools/schemas.ts`:

```ts
export const FindWorkspaceSymbolInputSchema = z
  .object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    query: z.string().min(1).describe('Symbol name or substring to find'),
    maxMatches: z.number().int().positive().max(20).optional().describe('Max matches (default 5)'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Preview lines before/after each match (default 2)'),
  })
  .strict();

export type FindWorkspaceSymbolInput = z.infer<typeof FindWorkspaceSymbolInputSchema>;
```

- [ ] **Step 2: Write the failing test**

In `apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts` (reuse `createWorkspaceFixture`, which writes `src/lib/math.ts`). Add:

```ts
it('findWorkspaceSymbol returns a precise enclosing range without whole-file content', async () => {
  const workspaceRootPath = await createWorkspaceFixture();
  // Ensure the fixture file has a known multi-line function. If createWorkspaceFixture's
  // src/lib/math.ts does not, write one here before constructing tools:
  await fsPromises.writeFile(
    path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
    ['export function add(a: number, b: number): number {', '  return a + b;', '}', '', 'export const PI = 3.14;', ''].join('\n'),
    'utf8'
  );
  const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
  const tool = tools['brainstrike.findWorkspaceSymbol'];

  const result = await tool.execute({ context: { path: '/src/lib/math.ts', query: 'add' } });
  expect(result.matches[0]).toMatchObject({ declarationLine: 1, startLine: 1, endLine: 3 });
  expect(result.path).toBe('/src/lib/math.ts');
  // Output is bounded: no whole-file content field.
  expect(result).not.toHaveProperty('content');

  const none = await tool.execute({ context: { path: '/src/lib/math.ts', query: 'nope' } });
  expect(none).toMatchObject({ matches: [], totalMatches: 0, truncated: false });

  await expect(
    tool.execute({ context: { path: '../outside.ts', query: 'x' } })
  ).rejects.toThrow();

  await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @brainstrike/desktop test -- --run assistant-tools`
Expected: FAIL — `tools['brainstrike.findWorkspaceSymbol']` is undefined.

- [ ] **Step 4: Implement the runner + register the tool**

In `apps/desktop/src/assistant-server/assistant-tools.ts`:

Add imports:

```ts
import {
  FindWorkspaceSymbolInputSchema,
  type FindWorkspaceSymbolInput,
} from '@brainstrike/agent';
import { findSymbolMatches } from './find-workspace-symbol';
```

Add the tool-id constant near the other `*_TOOL_ID` consts:

```ts
const FIND_WORKSPACE_SYMBOL_TOOL_ID = 'brainstrike.findWorkspaceSymbol' as const;
```

Add the runner (near `runReadWorkspaceFile`):

```ts
async function runFindWorkspaceSymbol(
  input: FindWorkspaceSymbolInput,
  runtimeData: RuntimeData | undefined
): Promise<{
  path: string;
  totalMatches: number;
  truncated: boolean;
  matches: ReturnType<typeof findSymbolMatches>['matches'];
}> {
  const rootPath = resolveWorkspaceRootPath(runtimeData);
  const resolved = await resolveWorkspaceAbsolutePath(rootPath, input.path);
  const content = await fsPromises.readFile(resolved.absolutePath, 'utf8');
  const { matches, totalMatches, truncated } = findSymbolMatches(content, input.query, {
    maxMatches: input.maxMatches ?? 5,
    contextLines: input.contextLines ?? 2,
  });
  return { path: resolved.workspacePath, totalMatches, truncated, matches };
}
```

Register the tool inside `buildDesktopAssistantTools`'s `tools` object (mirror the `readWorkspaceDirectory` entry):

```ts
    [FIND_WORKSPACE_SYMBOL_TOOL_ID]: {
      id: FIND_WORKSPACE_SYMBOL_TOOL_ID,
      description:
        "Find a symbol's exact 1-based line range in a workspace file without returning whole-file content. Use this to get a function/type/section range, then pass it to brainstrike.updateWorkspaceTapestrySelections.",
      inputSchema: FindWorkspaceSymbolInputSchema,
      execute: async (input: ToolExecuteInput<FindWorkspaceSymbolInput>) => {
        const resolvedInput = parseToolExecuteInput(FindWorkspaceSymbolInputSchema, input);
        try {
          return await runFindWorkspaceSymbol(resolvedInput, runtimeData);
        } catch (error) {
          logger.error('findWorkspaceSymbol failed', { error, input: resolvedInput });
          throw error;
        }
      },
    },
```

Confirm `FindWorkspaceSymbolInputSchema` + type are re-exported from `packages/agent/src/index.ts` (add them next to `ReadWorkspaceFileInputSchema` if not auto-exported).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/desktop test -- --run assistant-tools`
Expected: PASS.

- [ ] **Step 6: Gate + commit**

```bash
pnpm --filter @brainstrike/agent type-check && pnpm --filter @brainstrike/desktop type-check
pnpm dlx ultracite check packages/agent/src/tools/schemas.ts apps/desktop/src/assistant-server/assistant-tools.ts apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts
git add packages/agent/src/tools/schemas.ts packages/agent/src/index.ts apps/desktop/src/assistant-server/assistant-tools.ts apps/desktop/src/__tests__/assistant-server/assistant-tools.test.ts
git commit -m "feat(desktop): register findWorkspaceSymbol assistant tool"
```

---

## Task 7: Prompt guidance for symbol lookup + colors

**Files:**
- Modify: `packages/agent/src/mastra/default-instructions.ts`
- Test: `packages/agent/src/mastra/__tests__/default-instructions.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `default-instructions.spec.ts`. Add `findWorkspaceSymbol` to `FULL_TOOL_MAP` first:

```ts
// in FULL_TOOL_MAP add:
  ['findWorkspaceSymbol', 'brainstrike.findWorkspaceSymbol'],
```

Then:

```ts
it('steers symbol lookup and color grouping when the tools are registered', () => {
  const prompt = buildDefaultInstructions(FULL_TOOL_MAP);
  expect(prompt).toContain('findWorkspaceSymbol');
  expect(prompt).toMatch(/exact range .* without reading the whole file/i);
  expect(prompt).toMatch(/color/i);
  expect(prompt).toMatch(/group related/i);
});

it('omits symbol-lookup guidance when findWorkspaceSymbol is not registered', () => {
  const prompt = buildDefaultInstructions(
    new Map([
      ['updateWorkspaceTapestrySelections', 'brainstrike.updateWorkspaceTapestrySelections'],
      ['updateWorkspaceContextSelection', 'brainstrike.updateWorkspaceContextSelection'],
    ])
  );
  expect(prompt).not.toContain('findWorkspaceSymbol');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @brainstrike/agent test -- --run default-instructions`
Expected: FAIL — prompt has no `findWorkspaceSymbol` guidance.

- [ ] **Step 3: Add tool-id, name resolution, and guidance**

In `default-instructions.ts`:

Add to `BRAINSTRIKE_CONTEXT_TOOL_IDS`:

```ts
  findWorkspaceSymbol: 'brainstrike.findWorkspaceSymbol',
```

Add `findWorkspaceSymbol: string | null;` to the names interface, and in the names map:

```ts
    findWorkspaceSymbol: resolveModelFacingToolName(
      toolNameMap,
      BRAINSTRIKE_CONTEXT_TOOL_IDS.findWorkspaceSymbol
    ),
```

Add a guidance line (gated on the tools), e.g. after `selectionDefaultInstruction`:

```ts
  const symbolLookupInstruction =
    names.findWorkspaceSymbol && names.updateWorkspaceTapestrySelections
      ? `When the user names a symbol/function/type, call ${names.findWorkspaceSymbol} to get its exact range without reading the whole file, then pass that range to ${names.updateWorkspaceTapestrySelections}.`
      : '';
  const colorGroupingInstruction = names.updateWorkspaceTapestrySelections
    ? `You may set a named color per range (red, orange, yellow, green, cyan, blue, purple, pink, gray) to group related context — reuse the same color for the same concept.`
    : '';
```

Then include both in `selectionLine` (the joined-and-filtered array): add `symbolLookupInstruction` and `colorGroupingInstruction` to that array.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @brainstrike/agent test -- --run default-instructions`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
pnpm --filter @brainstrike/agent type-check
pnpm dlx ultracite check packages/agent/src/mastra/default-instructions.ts packages/agent/src/mastra/__tests__/default-instructions.spec.ts
git add packages/agent/src/mastra/default-instructions.ts packages/agent/src/mastra/__tests__/default-instructions.spec.ts
git commit -m "feat(agent): prompt guidance for findWorkspaceSymbol + range colors"
```

---

## Task 8: Full gate + live verification note

- [ ] **Step 1: Run the full gate together**

```bash
pnpm --filter @brainstrike/types --filter @brainstrike/agent --filter @brainstrike/app-shell --filter @brainstrike/desktop type-check
pnpm dlx ultracite check $(git diff --name-only main... | tr '\n' ' ')
pnpm --filter @brainstrike/types --filter @brainstrike/agent --filter @brainstrike/app-shell --filter @brainstrike/desktop test -- --run
pnpm --filter @brainstrike/agent build && pnpm --filter @brainstrike/types build
```

Expected: all green together. Fix and re-run until green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/assistant-context-tools
gh pr create --base main --title "Assistant context tools: agent-set range colors + findWorkspaceSymbol" --body "..."
```

- [ ] **Step 3: Live verification (manual, after CI green)**

Rebuild agent + restart desktop dev app, select a hosted provider, and confirm:
- "Select the `add` function and color it blue" → a precise, blue range appears in the Context Explorer Tapestry View (small line count, thin band), and the model used `findWorkspaceSymbol` then `updateWorkspaceTapestrySelections` (visible in the tool cards).

---

## Self-Review

**Spec coverage:** Colors (Tasks 1–4, 7), findWorkspaceSymbol (Tasks 5–6, 7), prompt (Task 7), tests (every task), error handling (zod enum Task 2; path guard + empty result Task 6). Covered.

**Placeholder scan:** No TBD/placeholders; every code step has real code. The one `gh pr create --body "..."` is a CLI invocation, not code — fill the body from this plan at execution time.

**Type consistency:** `TapestryColorName`/`TAPESTRY_COLOR_NAMES`/`resolveTapestryColorHex` (Task 1) are used consistently in Tasks 2 (enum), 3 (payload), 4 (resolution). `findSymbolMatches` signature (Task 5) matches its use in Task 6. `FindWorkspaceSymbolInputSchema` defined in Task 6 Step 1 and used in the same task.
