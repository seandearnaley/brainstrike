# Harness-Aware Agent Prompt + Precise-Selection Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the agent system prompt so it frames the IDE harness + visual context-selection workflow and makes precise Tapestry line-range selection the default for any context-selection request.

**Architecture:** Three targeted additions to `buildDefaultInstructions` — an always-present harness/visual framing line, an ungated precise-by-default selection instruction, and an explicit 1-based Tapestry mechanics line — reusing the existing model-facing tool-name resolution and per-tool availability fallbacks. No tool/schema changes.

**Tech Stack:** TypeScript (strict), Vitest. pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-05-assistant-harness-prompt-design.md`

**Verified facts:**
- File: `packages/agent/src/mastra/default-instructions.ts`. `buildDefaultInstructions(toolNameMap)` is exported; it derives `names` via `getModelFacingToolNames(toolNameMap)` and builds gated instruction fragments, each with an "unavailable" fallback.
- `toolNameMap` is `ReadonlyMap<string, string>` keyed by **model-facing name → original tool ID** (see `buildOriginalToModelFacingToolNameMap`: it iterates `[modelFacingName, originalName]`). So a test registers tools as `new Map([['updateWorkspaceTapestrySelections','brainstrike.updateWorkspaceTapestrySelections'], ...])`.
- No existing test for this file. Agent tests: `cd packages/agent && pnpm vitest run <path>` (`.spec.ts` convention).
- ultracite: accept formatting. Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/agent/src/mastra/default-instructions.ts` | Add harness framing + precise-by-default selection + tapestry mechanics | Modify |
| `packages/agent/src/__tests__/default-instructions.spec.ts` | Content assertions (full toolset / no selection tools / empty map) | New |

---

## Task 1: Harness-aware prompt additions

**Files:**
- Modify: `packages/agent/src/mastra/default-instructions.ts`
- Test: `packages/agent/src/__tests__/default-instructions.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/__tests__/default-instructions.spec.ts
import { describe, expect, it } from 'vitest';
import { buildDefaultInstructions } from '../mastra/default-instructions';

const FULL_TOOL_MAP = new Map<string, string>([
  ['listWorkspaceContext', 'brainstrike.listWorkspaceContext'],
  ['readWorkspaceContext', 'brainstrike.readWorkspaceContext'],
  ['readWorkspaceFile', 'brainstrike.readWorkspaceFile'],
  ['listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
  ['queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
  ['updateWorkspaceContextSelection', 'brainstrike.updateWorkspaceContextSelection'],
  ['updateWorkspaceTapestrySelections', 'brainstrike.updateWorkspaceTapestrySelections'],
]);

describe('buildDefaultInstructions', () => {
  it('includes harness/visual framing regardless of tools', () => {
    const prompt = buildDefaultInstructions(new Map());
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toMatch(/Context Explorer/);
    expect(prompt).toMatch(/none/); // no tools available
  });

  it('makes precise Tapestry selection the default when selection tools are registered', () => {
    const prompt = buildDefaultInstructions(FULL_TOOL_MAP);
    expect(prompt).toMatch(/Context Explorer/);
    // precise-by-default selection guidance
    expect(prompt).toMatch(/not whole files/i);
    expect(prompt).toContain('updateWorkspaceTapestrySelections');
    expect(prompt).toContain('updateWorkspaceContextSelection');
    // 1-based tapestry mechanics
    expect(prompt).toMatch(/1-based/);
    expect(prompt).toContain('startLine');
    expect(prompt).toContain('endLine');
  });

  it('degrades gracefully without selection tools and does not leak raw tool IDs into guidance', () => {
    const noSelection = new Map<string, string>([
      ['listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
      ['queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
    ]);
    const prompt = buildDefaultInstructions(noSelection);
    // unavailable fallback present, no tapestry directive
    expect(prompt).toMatch(/Precise context selection is unavailable/i);
    // model-facing guidance must not reference raw brainstrike.* IDs
    expect(prompt).not.toContain('brainstrike.updateWorkspaceTapestrySelections');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run src/__tests__/default-instructions.spec.ts`
Expected: FAIL — no "Context Explorer", no "not whole files", no "1-based" yet.

- [ ] **Step 3: Implement the additions**

In `packages/agent/src/mastra/default-instructions.ts`, add a module constant near the top (after the imports/`BRAINSTRIKE_CONTEXT_TOOL_IDS`):

```ts
const HARNESS_FRAMING =
  'You run inside the Brainstrike IDE. The user is interactively curating context in a visual Context Explorer alongside this chat; the selections you make with the context tools appear in that UI and become the context the user feeds to an LLM. Be precise: prefer selecting the specific lines that matter over whole files.';
```

Inside `buildDefaultInstructions`, after the existing `curationInstruction` block (before the `return`), add:

```ts
  const selectionDefaultInstruction =
    names.updateWorkspaceTapestrySelections && names.updateWorkspaceContextSelection
      ? `When the user asks you to select, add, or curate context, default to precise Tapestry line ranges with ${names.updateWorkspaceTapestrySelections}: select only the lines that matter, not whole files. Use ${names.updateWorkspaceContextSelection} for whole-file selection only when the entire file is genuinely needed.`
      : 'Precise context selection is unavailable unless the workspace selection and Tapestry selection tools are registered.';
  const tapestryMechanicsInstruction =
    names.queryEmbeddingSpace && names.updateWorkspaceTapestrySelections
      ? `${names.queryEmbeddingSpace} results include 1-based source line ranges per chunk; pass those directly as ranges: [{ startLine, endLine }] (1-based, inclusive) to ${names.updateWorkspaceTapestrySelections}.`
      : '';
  const selectionLine = [selectionDefaultInstruction, tapestryMechanicsInstruction]
    .filter(Boolean)
    .join(' ');
```

Then change the returned template to (1) insert the harness framing as the second line and (2) insert `selectionLine` after the `curationInstruction` line. The full return becomes:

```ts
  return `You are a helpful assistant for the Brainstrike IDE.
${HARNESS_FRAMING}
Use tools when they help you answer accurately.
Project files, context explorer selections, file trees, token estimates, and embedding spaces are not preloaded into your prompt.
Registered Brainstrike native context tools in this run: ${formatAvailableToolNames(names)}.
When project or codebase context is needed, use registered Brainstrike native tools explicitly. ${workspaceInspectionInstruction} ${semanticSearchInstruction} ${readContextInstruction}
${curationInstruction}
${selectionLine}
Do not assume selected files or embedding spaces are already included. Keep file and retrieval budgets small, and report skipped or truncated tool results when they affect the answer.
If an expected Brainstrike native tool is unavailable, say exactly which tool ID is missing and continue with another available tool only when that still answers the user.
If the user asks what tools you have available, list the tool IDs you can call in this session and briefly describe each one.
Only run state-changing tools after the user confirms.
Provide concise answers after using tools.`;
```

Keep every existing line verbatim — only ADD the `${HARNESS_FRAMING}` line and the `${selectionLine}` line. Note: when `selectionLine` is empty (no selection tools at all), it leaves a blank line; that's acceptable, but the `noSelection` test registers no selection tools, so `selectionDefaultInstruction` falls back to the "unavailable" string (non-empty) and `selectionLine` is non-empty. (Only a fully-empty map yields an empty `selectionLine`; the empty-map test asserts harness framing + "none", not selection content.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && pnpm vitest run src/__tests__/default-instructions.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check + lint + commit**

```bash
cd packages/agent && pnpm exec tsc --noEmit
pnpm dlx ultracite fix packages/agent/src/mastra/default-instructions.ts packages/agent/src/__tests__/default-instructions.spec.ts
git add packages/agent/src/mastra/default-instructions.ts packages/agent/src/__tests__/default-instructions.spec.ts
git commit -m "feat(agent): harness-aware prompt + precise-by-default selection guidance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Scope guard
Modify ONLY these two files. Do NOT change tool schemas, the curation/workspace/semantic fallbacks beyond adding the two new lines, or `convertMessagesToMastra`. Preserve all existing prompt wording verbatim.

---

## Task 2: Full gate + PR

- [ ] **Step 1: Full local gate (CI parity)**

Run from repo root: `pnpm type-check && pnpm lint:ci && pnpm build && pnpm test`
Expected: all green together. Fix anything red and re-run the whole suite. (`db#test` / jsdom-heavy packages can flake under turbo concurrency — re-run in isolation to confirm before treating as real.)

- [ ] **Step 2: Push + PR + monitor CI**

```bash
git push -u origin harden/assistant-harness-prompt
gh pr create --base main --fill
gh pr checks --watch
```
Fix any red checks (incl. `codecov/patch`) and push until green.

---

## Self-Review (completed by author)

- **Spec coverage:** Harness/visual framing → Task 1 `HARNESS_FRAMING` (always present). Ungated precise-by-default → `selectionDefaultInstruction`. Explicit 1-based mechanics → `tapestryMechanicsInstruction`. Preserve fallbacks → gated fragments keep "unavailable" strings; existing lines verbatim. Model-facing names (no raw ID leakage) → reuse `names`; asserted by test 3. Deterministic content tests (full / no-selection / empty) → Task 1 Step 1. Gate + PR → Task 2.
- **Type consistency:** `selectionDefaultInstruction` / `tapestryMechanicsInstruction` / `selectionLine` are local strings; reuse existing `names` (`ModelFacingToolNames`) fields. No new types.
- **No placeholders:** full prompt return shown verbatim; full test code provided; exact `toolNameMap` key/value direction documented and used in the test.
