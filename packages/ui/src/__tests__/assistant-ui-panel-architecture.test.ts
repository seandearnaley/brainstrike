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
    // Bumped 1735 → 1786 for assistant run-lifecycle OS notifications:
    // onRunFailed/onRunFinished/onToolApprovalRequired thread the SAME 5 layers
    // as onUsage/onModelChange (AssistantUiPanel → Local/DataStream chat →
    // ChatThreadUI), and ChatThreadUI mounts a `RunLifecycleNotificationBridge`
    // (its own module, run-lifecycle-notifications.ts) that reports each new
    // terminal run event / approval request up to app-shell exactly once. The
    // notification DECISION logic (settings gate, permission, coalescing) lives
    // entirely in @brainstrike/preferences — this file only plumbs three
    // optional callback props, matching the existing onUsage seam.
    // Bumped 1786 → 1787 for the hydration-replay fix: RunLifecycleNotificationBridge
    // now also receives `threadKey` so a thread switch re-seeds its "seen"
    // sets instead of treating the new thread's history as new activity.
    // Bumped 1787 → 1792 for the turn-level "Revert all edits" footer:
    // AssistantMessage mounts <CheckpointTurnRevert /> (its own module,
    // checkpoint-turn-revert.tsx) after AssistantMessageError. The control's
    // phase machine, part-scanning, and per-run revert wiring all live in that
    // module; this file only imports + renders it.
    // Bumped 1792 → 1800 for the attachments-availability adapter contract
    // comments (PR #1690 review fix): the adapter memo documents WHY it is
    // keyed on availability presence — tearing it down on an enabled→disabled
    // model switch would wipe staged attachments via an adapter-less send.
    // Bumped 1800 → 1816 for the last-24h budget guardrail landing alongside
    // the attachments work: the composer shell mounts <BudgetGuardrailControl />
    // and EditComposer gains a body to call useBudgetSendGate (edit-resend
    // must not bypass the cap). The chip, the over-cap notice, and the gate
    // derivation all live in their own module (budget-guardrail-control.tsx /
    // budget-guardrail-context.tsx).
    // Bumped 1816 → 1818 for the edit-composer keyboard gate (review #1714):
    // EditComposer's Input is disabled alongside the Send button while the
    // budget cap blocks sends — Enter in the input is a submit path too.
    // This panel accreted several independent features that each threaded a
    // small prop/renderer through it: the multi-root operating-root chip (WS6;
    // <OperatingRootChip /> mounts as a sibling at the top of the composer
    // stack), the approval/suspend outcome chip (WS2), the context-breakdown
    // seam + null-renderer registration (context-ring WS8; assistantContext-
    // BreakdownDataUI mirrors assistantShellOutputDataUI's `render: () => null`
    // so the transient part never surfaces as a stray element), and the
    // shared-clipboard user-message copy (WS3; UserActionBar routes through
    // useCopyToClipboard instead of ActionBarPrimitive.Copy's navigator.clipboard,
    // computing its own tooltip/icon/aria-live states). The model-menu swap
    // net-removed code; after all four panel-touching features merged the file
    // measures 1849 lines; budget carries modest headroom.
    // Bumped 1855 → 1870 for mid-run steering (BST-588): onSteerActiveRun
    // plumbing through the shared ChatThreadProps + both runtime chats; the
    // Steer button + control cluster live in follow-up-queue.tsx
    // (ComposerRunControls keeps the panel's composition site one line).
    expect(source.split('\n').length).toBeLessThanOrEqual(1870);
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

  it('mounts the turn-level revert footer as an owned module on assistant messages', () => {
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    expect(source).toContain("from './checkpoint-turn-revert'");

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<CheckpointTurnRevert />');

    expect(readSource('assistant-ui-panel/checkpoint-turn-revert.tsx')).toContain(
      'export function CheckpointTurnRevert'
    );
  });

  it('mounts the per-run verdict footer as an owned module on assistant messages', () => {
    // Task Ledger 👍/👎 (source 'user'): the runId detection, phase machine,
    // and context seam all live in run-verdict-control.tsx /
    // run-verdict-context.tsx; this file only imports + renders the control.
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    expect(source).toContain("from './run-verdict-control'");

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<RunVerdictControl />');

    expect(readSource('assistant-ui-panel/run-verdict-control.tsx')).toContain(
      'export function RunVerdictControl'
    );
  });

  it('mounts the budget guardrail as an owned module and gates BOTH send paths', () => {
    // Last-24h budget cap (Task Ledger phase 1): the chip, over-cap notice, and
    // gate derivation live in budget-guardrail-control.tsx / the context seam in
    // budget-guardrail-context.tsx; this file only imports + renders the control
    // and calls the gate hook. The composer input row AND the edit-composer
    // resend both consume the gate — a blocked send must have no hidden path.
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    expect(source).toContain("from './budget-guardrail-control'");
    expect(source).toContain('<BudgetGuardrailControl />');

    const editComposerStart = source.indexOf('const EditComposer =');
    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const editComposerSource = source.slice(editComposerStart, assistantMessageStart);
    expect(editComposerSource).toContain('useBudgetSendGate()');
    // The gate must reach the Input too, not just the Send button — Enter in
    // the edit input is a submit path (review #1714).
    expect(editComposerSource.match(/disabled=\{budgetSendBlocked\}/g)?.length).toBe(2);

    const composerInputSource = readSource('assistant-ui-panel/composer-input.tsx');
    expect(composerInputSource).toContain('useBudgetSendGate()');
    expect(readSource('assistant-ui-panel/budget-guardrail-control.tsx')).toContain(
      'export function BudgetGuardrailControl'
    );
  });

  it('gives user messages a copy affordance alongside edit, routed through the shared clipboard service', () => {
    // UNLIKE AssistantActionBar's ActionBarPrimitive.Copy (which uses
    // navigator.clipboard.writeText directly and swallows write rejections),
    // the user-message copy control routes through useCopyToClipboard --
    // the same shared, bridge-aware service CodeBlockHeader/CopyTextButton
    // use -- so a broken Electron clipboard bridge surfaces visibly instead
    // of silently doing nothing (no-silent-fallbacks rule).
    const source = readSource('assistant-ui-panel/assistant-ui-panel.tsx');
    const userActionBarStart = source.indexOf('export const UserActionBar =');
    const editComposerStart = source.indexOf('const EditComposer =');
    const userActionBarSource = source.slice(userActionBarStart, editComposerStart);

    expect(userActionBarSource).toContain('useCopyToClipboard()');
    expect(userActionBarSource).toContain('aui.message().getCopyText()');
    expect(userActionBarSource).toContain('ActionBarPrimitive.Edit');
    // Not USED as a component (a comment may still reference it by name to
    // explain why it was replaced).
    expect(userActionBarSource).not.toContain('<ActionBarPrimitive.Copy');
    // Broken-bridge failure must be visibly rendered, never silent.
    expect(userActionBarSource).toContain("isFailed ? 'Copy failed' : null");
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
