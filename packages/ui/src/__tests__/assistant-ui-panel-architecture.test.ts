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

  it('mounts a visible error block on assistant messages', () => {
    // Transport/init failures reject the run with no message parts; without
    // this block they render as an EMPTY assistant bubble and the failure is
    // invisible (the "instant empty reply" bug).
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    expect(source).toContain("from './assistant-message-error'");

    const assistantMessageStart = source.indexOf('const AssistantMessage: FC');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar: FC');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<AssistantMessageError />');

    expect(readSource('assistant-ui-panel/assistant-message-error.tsx')).toContain(
      'ErrorPrimitive.Message'
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

  it('uses the shared thinking indicator instead of a bare streaming caret', () => {
    const panelSource = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    const cssSource = readSource('assistant-ui-panel/overrides.css');

    expect(panelSource).toContain("from './assistant-thinking-indicator'");
    expect(cssSource).toContain('.bs-streaming-thinking');
    expect(cssSource).toContain('@media (forced-colors: active)');
    expect(cssSource).toContain('-webkit-text-fill-color: CanvasText');
    expect(cssSource).not.toContain('--aui-content: "|"');
  });

  it('only animates the chain-of-thought pill while reasoning is running', () => {
    const panelSource = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    const cssSource = readSource('assistant-ui-panel/overrides.css');

    expect(panelSource).toContain('isRunningReasoningPart');
    expect(panelSource).toContain('isReasoningRunning ? (');
    expect(panelSource).toContain('assistant-reasoning-static-mark');
    expect(cssSource).toContain('.bs-thinking-mark-static');
  });
});
