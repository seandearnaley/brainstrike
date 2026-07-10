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

    // Budget bumped 1500 → 1520 for the durable cumulative-usage prop plumbing
    // (Phase 5.1): cumulativeUsage threads through the 5 layered panel
    // components (AssistantUiPanel → Local/DataStream chat → ChatThreadUI →
    // ThreadContextMeter), which is irreducible without extracting the meter
    // wiring into its own module — a larger refactor than this feature warrants.
    // Bumped 1520 → 1532 for the OM tri-segment prop plumbing (Phase 5.3):
    // omSegment threads the SAME 5 layers alongside cumulativeUsage.
    // Bumped 1532 → 1600 for the "/" slash-command prop plumbing (Phase 6.2):
    // slashCommands threads the SAME 5 layers, plus ChatThreadUI derives the
    // library adapter/icon-map and conditionally wraps the composer in the
    // trigger-popover root ONLY when commands exist (review fix: an empty
    // adapter would surface an empty menu). The shared ComposerInputRow keeps
    // Input/Send/Cancel defined once across the slash/plain paths, and a stable
    // EMPTY_SLASH_COMMANDS default avoids a memo-breaking inline `[]`. The
    // popover UI + command mapper live in their own modules
    // (composer-trigger-popover.tsx, slash-commands.ts).
    // Bumped 1600 → 1610 for the Fast Refresh hook-alias comment: the slash
    // adapter is imported `unstable_useSlashCommandAdapter as useSlashCommandAdapter`
    // so Vite dev's Fast Refresh recognizes it as a hook (a bare `unstable_use…`
    // call corrupts the hook signature and crashes the dev server — see
    // fast-refresh-hook-aliasing.test.ts).
    // Bumped 1610 → 1720 for the "@" file-mention prop plumbing (Phase 6.4):
    // fileMentions + onFileMentionQueryChange thread the SAME 5 layers as
    // slashCommands, ChatThreadUI derives the mention adapter + id→file map, and
    // a `ComposerInputWithTriggers` helper nests the slash + mention roots around
    // the shared ComposerInputRow (each mounted only when its seam is present).
    // The mention popover UI + adapter builder live in their own modules
    // (composer-mention-popover.tsx, file-mentions.ts); the directive
    // serialize/parse contract lives in @brainstrike/assistant-contract.
    // Bumped 1720 → 1730 for the @assistant-ui/react 0.12.26 trigger-popover
    // unification: the old nested Unstable_MentionRoot/Unstable_SlashCommandRoot
    // wrappers were replaced by one shared Unstable_TriggerPopoverRoot ("/" and
    // "@" popovers as siblings, not nested), which needed a few extra doc lines
    // on ComposerInputWithTriggers explaining the sibling model.
    // Bumped 1730 → 1735 for React.FC → plain function typings: explicit
    // destructured props + inline type annotations add a few lines per component
    // without changing runtime behavior.
    expect(source.split('\n').length).toBeLessThanOrEqual(1735);
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

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<AssistantMessageError />');

    expect(readSource('assistant-ui-panel/assistant-message-error.tsx')).toContain(
      'ErrorPrimitive.Message'
    );
  });

  it('renders assistant tool-call parts through the chain-of-thought tool fallback', () => {
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    const localChainOfThoughtStart = source.indexOf('const LocalChainOfThought =');
    const collapsedHistoryStart = source.indexOf('const COLLAPSED_HISTORY_VISIBLE_MESSAGES');
    const localChainOfThoughtSource = source.slice(localChainOfThoughtStart, collapsedHistoryStart);

    expect(assistantMessageSource).toContain('ChainOfThought: LocalChainOfThought');
    // The tool-components map (by_name + Fallback) is extracted to
    // CHAIN_OF_THOUGHT_TOOL_COMPONENTS in todo-progress.tsx to stay under the
    // source-file budget above; assert the wiring there instead of inline.
    expect(localChainOfThoughtSource).toContain('tools: CHAIN_OF_THOUGHT_TOOL_COMPONENTS');
    expect(readSource('assistant-ui-panel/todo-progress.tsx')).toContain('Fallback: ToolFallback');
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
