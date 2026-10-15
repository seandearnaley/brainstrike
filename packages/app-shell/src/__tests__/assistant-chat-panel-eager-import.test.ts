// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `AssistantChatPanel` is EAGER — it renders before the availability gate and
 * before `AssistantUiPanelWrapperLazy`. Importing the link provider from the
 * `@brainstrike/assistant-ui` root barrel pulls `assistant-ui-panel` and its
 * `react-markdown` + Shiki graph through `export *` into that eager chunk,
 * defeating the lazy boundary this package depends on for first paint.
 *
 * Nothing else catches that: the provider still works, every test passes, and
 * the only symptom is a fatter bundle. Auto-import reaches for the barrel by
 * default, so the narrow import needs a pin.
 */
describe('AssistantChatPanel eager-import boundary', () => {
  it('imports the link seam from the narrow subpath, never the package barrel', () => {
    const source = readFileSync(path.join(SOURCE_ROOT, 'assistant-chat-panel.tsx'), 'utf8');

    expect(source).toContain(
      "from '@brainstrike/assistant-ui/assistant-link-capabilities-provider'"
    );
    // A bare root-barrel specifier, in any import form.
    expect(source).not.toMatch(/from\s+'@brainstrike\/assistant-ui'/);
  });
});
