# Assistant Reasoning Persistence (Restore on Reload) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct reasoning parts when a thread is rehydrated, so model reasoning survives a reload instead of being silently dropped.

**Architecture:** A single hydration function (`toAssistantHistoryContentParts` in the app-shell assistant memory repository) reconstructs persisted `mastra_messages.content` parts but currently handles only `text` and `tool-call`. Add a `reasoning` branch and widen the hydrated part union to include assistant-ui's `ReasoningMessagePart`. No schema migration; the renderer already displays reasoning.

**Tech Stack:** TypeScript (strict), Vitest, `@assistant-ui/react` (history adapter), PGlite/Mastra memory. pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-05-assistant-reasoning-persistence-design.md`

**Verified facts:**
- Hydration choke point: `toAssistantHistoryContentParts` ([assistant-memory-repository.ts:598-627](https://github.com/seandearnaley/brainstrike/blob/b0b960a2bd36cb7f86f2150cfc8572739032b72a/packages/app-shell/src/assistant-memory-repository.ts)); part union `AssistantHydratedContentPart` (line 495) = text | tool-call.
- assistant-ui exports `ReasoningMessagePart = { readonly type: 'reasoning'; readonly text: string; readonly parentId?: string }` (from `@assistant-ui/core`), and `AssistantHistoryMessagePart` is derived from the adapter's `load()` message content union — so `Extract<AssistantHistoryMessagePart, { type: 'reasoning' }>` resolves to a valid reasoning part type.
- Existing test drives the PUBLIC path: `createAssistantThreadHistoryAdapter({ repository })` with a `listMessages` mock, then `adapter.load()` → assert `history.messages`. File: `packages/app-shell/src/__tests__/assistant-memory-repository.test.ts`. `readContentPartArray` accepts `content` that is a direct array OR `{ content: [...] }` / `{ parts: [...] }`.
- App-shell tests: `cd packages/app-shell && pnpm vitest run <path>`. Repo uses ultracite (`pnpm dlx ultracite fix`).
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/app-shell/src/assistant-memory-repository.ts` | Add reasoning to the hydrated part union + reconstruct reasoning parts | Modify (~line 495, ~line 598-627) |
| `packages/app-shell/src/__tests__/assistant-memory-repository.test.ts` | Round-trip + fallback + empty-drop + regression tests | Modify (append tests) |

---

## Task 1: Reconstruct reasoning parts on hydration

**Files:**
- Modify: `packages/app-shell/src/assistant-memory-repository.ts`
- Test: `packages/app-shell/src/__tests__/assistant-memory-repository.test.ts`

- [ ] **Step 1: Confirm the type, then write the failing test**

First confirm `Extract<AssistantHistoryMessagePart, { type: 'reasoning' }>` is a valid non-`never` type (assistant-ui `ReasoningMessagePart`). If it is `never` (adapter content type lacks reasoning), STOP and report a blocker — do not cast.

Append to `packages/app-shell/src/__tests__/assistant-memory-repository.test.ts` (mirror the existing `createAssistantThreadHistoryAdapter` + `listMessages` + `adapter.load()` pattern). Use the helper shape from the existing tests for the repository mock (all methods `vi.fn()`, `listMessages` returns the fixture):

```ts
describe('reasoning hydration', () => {
  function makeRepository(messages: unknown[]): AssistantThreadRepository {
    return {
      appendThreadRunEvent: vi.fn(),
      completeThreadRun: vi.fn(),
      createThread: vi.fn(),
      createThreadRun: vi.fn(),
      deleteThread: vi.fn(),
      listLatestThreadRuns: vi.fn(),
      listMessages: vi.fn(async () => messages),
      listThreadRunEvents: vi.fn(async () => []),
      listThreads: vi.fn(),
      renameThread: vi.fn(),
      updateThreadMetadata: vi.fn(),
    } as unknown as AssistantThreadRepository;
  }

  function reasoningTexts(history: Awaited<ReturnType<ReturnType<typeof createAssistantThreadHistoryAdapter>['load']>>): string[] {
    const texts: string[] = [];
    for (const entry of history.messages) {
      for (const part of entry.message.content) {
        if (part.type === 'reasoning') {
          texts.push(part.text);
        }
      }
    }
    return texts;
  }

  it('reconstructs a persisted reasoning part on reload', async () => {
    const adapter = createAssistantThreadHistoryAdapter({
      repository: makeRepository([
        {
          id: 'm-reason',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'because X' },
            { type: 'text', text: 'the answer is 42' },
          ],
          createdAt: new Date('2026-04-22T10:00:01Z'),
        },
      ]),
      threadId: 'thread-1',
    });
    const history = await adapter.load();
    expect(reasoningTexts(history)).toEqual(['because X']);
  });

  it('falls back to the `reasoning` field when `text` is absent', async () => {
    const adapter = createAssistantThreadHistoryAdapter({
      repository: makeRepository([
        {
          id: 'm-alt',
          role: 'assistant',
          content: [{ type: 'reasoning', reasoning: 'alt thinking' }],
          createdAt: new Date('2026-04-22T10:00:02Z'),
        },
      ]),
      threadId: 'thread-1',
    });
    const history = await adapter.load();
    expect(reasoningTexts(history)).toEqual(['alt thinking']);
  });

  it('drops empty reasoning parts', async () => {
    const adapter = createAssistantThreadHistoryAdapter({
      repository: makeRepository([
        {
          id: 'm-empty',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '   ' },
            { type: 'text', text: 'visible answer' },
          ],
          createdAt: new Date('2026-04-22T10:00:03Z'),
        },
      ]),
      threadId: 'thread-1',
    });
    const history = await adapter.load();
    expect(reasoningTexts(history)).toEqual([]);
  });
});
```

NOTE: the exact arguments to `createAssistantThreadHistoryAdapter` (e.g. `threadId`, other required fields) and the `load()` result shape (`history.messages[n].message.content`) must match the existing passing tests in this file — READ them (around lines 40-50 and 192-198) and mirror precisely. Adjust the fixture's `content` wrapper if the existing tests use `{ content: [...] }` vs a bare array (both are accepted by `readContentPartArray`; match whichever the neighbors use). The repository mock must satisfy `AssistantThreadRepository` — copy the exact method set from an existing test in the file rather than guessing.

- [ ] **Step 2: Run, confirm FAIL**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/assistant-memory-repository.test.ts -t "reasoning hydration"`
Expected: FAIL — reasoning parts are dropped (empty arrays).

- [ ] **Step 3: Widen the part union**

In `assistant-memory-repository.ts`, after the `AssistantHistoryToolCallPart` type (line ~494):
```ts
type AssistantHistoryReasoningPart = Extract<AssistantHistoryMessagePart, { type: 'reasoning' }>;
type AssistantHydratedContentPart =
  | AssistantHistoryTextPart
  | AssistantHistoryToolCallPart
  | AssistantHistoryReasoningPart;
```

- [ ] **Step 4: Reconstruct reasoning in `toAssistantHistoryContentParts`**

Inside the `for (const rawPart of rawParts)` loop, after the `tool-call` branch (before the loop ends, ~line 626), add:
```ts
    if (record['type'] === 'reasoning') {
      const reasoningText =
        typeof record['text'] === 'string'
          ? record['text']
          : typeof record['reasoning'] === 'string'
            ? record['reasoning']
            : '';
      const trimmed = reasoningText.trim();
      if (trimmed) {
        parts.push({ type: 'reasoning', text: trimmed });
      }
      continue;
    }
```
(Place it consistently with the existing `text`/`tool-call` branches. The pushed object must match `AssistantHistoryReasoningPart` — `{ type: 'reasoning', text: string }`; do not include `parentId` unless required by the type.)

- [ ] **Step 5: Run, confirm PASS + the whole file (regression)**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/assistant-memory-repository.test.ts`
Expected: new reasoning tests PASS; all existing text/tool-call/memory hydration tests still PASS.

- [ ] **Step 6: Type-check + lint + commit**

```bash
cd packages/app-shell && pnpm exec tsc --noEmit
pnpm dlx ultracite fix packages/app-shell/src/assistant-memory-repository.ts packages/app-shell/src/__tests__/assistant-memory-repository.test.ts
git add packages/app-shell/src/assistant-memory-repository.ts packages/app-shell/src/__tests__/assistant-memory-repository.test.ts
git commit -m "feat(app-shell): restore persisted reasoning parts on thread reload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Scope guard
Modify ONLY the two files. Do NOT change `convertMessagesToMastra` (input filtering stays text-only — reasoning is not resent to the model), the renderer, or any schema. If `Extract<..., { type: 'reasoning' }>` is `never`, report a blocker.

---

## Task 2: Full gate + PR

- [ ] **Step 1: Full local gate (CI parity)**

Run from repo root: `pnpm type-check && pnpm lint:ci && pnpm build && pnpm test`
Expected: all green together. Fix anything red and re-run the whole suite. (`db#test` and some jsdom-heavy packages can flake under turbo concurrency — re-run the specific package in isolation to confirm before treating as real.)

- [ ] **Step 2: Push + PR + monitor CI**

```bash
git push -u origin harden/assistant-reasoning-persistence
gh pr create --base main --fill
gh pr checks --watch
```
Fix any red checks (incl. `codecov/patch` — the new branch + tests should cover the small change) and push until green.

---

## Self-Review (completed by author)

- **Spec coverage:** Reasoning reconstruction on hydration → Task 1 Steps 3-4. Part union widened → Step 3. Field fallback (`text` vs `reasoning`) → Step 4 + test 2. Empty-drop → Step 4 + test 3. Round-trip + regression → Steps 1,5. Type-confirm-first risk mitigation → Step 1 + scope guard. No schema migration / no `convertMessagesToMastra` change → scope guard. Gate + PR → Task 2.
- **Type consistency:** `AssistantHistoryReasoningPart` / `AssistantHydratedContentPart` consistent; pushed reasoning part shape `{ type: 'reasoning', text }` matches assistant-ui `ReasoningMessagePart`.
- **Investigate-then-implement spot:** Step 1 requires reading the existing test's exact `createAssistantThreadHistoryAdapter` args + `load()` result shape + repository mock method set and mirroring them — flagged with the lines to read, not left vague.
