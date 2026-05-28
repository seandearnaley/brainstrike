import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath: string): string =>
  readFileSync(join(sourceRoot, relativePath), 'utf8');

describe('assistant UI panel architecture', () => {
  it('keeps the assistant panel root under the source-file budget', () => {
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');

    expect(source.split('\n').length).toBeLessThanOrEqual(1500);
  });

  it('keeps provider settings and controls as owned panel modules', () => {
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');

    expect(source).toContain("from './assistant-controls-menu'");
    expect(source).toContain("from './provider-settings-panel'");
    expect(readSource('assistant-ui-panel/provider-settings-panel.tsx')).toContain(
      'export const ProviderSettingsPanel'
    );
    expect(readSource('assistant-ui-panel/assistant-controls-menu.tsx')).toContain(
      'export const ControlsMenu'
    );
  });

  it('renders assistant tool-call parts through the chain-of-thought tool fallback', () => {
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    const assistantMessageStart = source.indexOf('const AssistantMessage: FC');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar: FC');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    const localChainOfThoughtStart = source.indexOf('const LocalChainOfThought: FC');
    const collapsedHistoryStart = source.indexOf('const COLLAPSED_HISTORY_VISIBLE_MESSAGES');
    const localChainOfThoughtSource = source.slice(localChainOfThoughtStart, collapsedHistoryStart);

    expect(assistantMessageSource).toContain('ChainOfThought: LocalChainOfThought');
    expect(localChainOfThoughtSource).toContain('tools: {');
    expect(localChainOfThoughtSource).toContain('Fallback: ToolFallback');
  });
});
