// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the slash-command "Rendered fewer hooks" crash.
 *
 * `@vitejs/plugin-react`'s React Fast Refresh builds each component's hook
 * "signature" by matching call sites whose names start with `use`. A hook
 * imported from a dependency under an `unstable_use…` name (e.g.
 * `unstable_useSlashCommandAdapter`) is NOT recognized as a hook, so React's
 * real hook count (the hook calls `useMemo` internally) exceeds the Fast Refresh
 * signature → "Rendered fewer hooks than expected" crashes the component and
 * loops the error boundary — in the Vite **dev server only** (prod builds and
 * the test runner have no Fast Refresh, which is why this evaded every unit
 * test). The fix is to alias such hooks to a `use`-prefixed name at import.
 *
 * This guard is source-level on purpose: the crash is dev-server-specific and
 * cannot be reproduced under vitest, so we lock the import convention instead.
 */
const readPanelModule = (fileName: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', fileName), 'utf8');

const panelSource = readPanelModule('assistant-ui-panel.tsx');
const threadMessagesSource = readPanelModule('assistant-thread-messages.tsx');

describe('Fast Refresh hook aliasing (assistant-ui-panel)', () => {
  it.each([
    ['assistant-ui-panel.tsx', panelSource],
    ['assistant-thread-messages.tsx', threadMessagesSource],
  ])('never calls an unstable_use* hook by its non-use-prefixed name (%s)', (_name, source) => {
    // A call site like `unstable_useFoo(` breaks Fast Refresh hook tracking.
    const bareUnstableHookCalls = source.match(/(?<![.\w])unstable_use[A-Za-z]+\s*\(/g) ?? [];
    expect(bareUnstableHookCalls).toEqual([]);
  });

  it('imports unstable_useSlashCommandAdapter aliased to a use-prefixed name', () => {
    expect(panelSource).toMatch(/unstable_useSlashCommandAdapter\s+as\s+use[A-Za-z]+/);
  });

  it('imports unstable_useThreadMessageIds aliased to a use-prefixed name (BST-897)', () => {
    expect(threadMessagesSource).toMatch(/unstable_useThreadMessageIds\s+as\s+use[A-Za-z]+/);
  });
});
