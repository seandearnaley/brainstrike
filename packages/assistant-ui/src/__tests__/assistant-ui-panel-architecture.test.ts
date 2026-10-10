import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ActivityTrace } from '../activity-trace';
import type { ActivitySummary } from '../activity-trace-model';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath: string): string =>
  readFileSync(join(sourceRoot, relativePath), 'utf8');

/** Every `.tsx` file under `src/`, excluding tests — component source only. */
function listComponentSourceFiles(): string[] {
  return readdirSync(sourceRoot, { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => entry.endsWith('.tsx') && !entry.split(sep).includes('__tests__'));
}

/**
 * Finds the `@media (prefers-reduced-motion: reduce) { ... }` block that
 * contains `marker`, matching braces per-block so a nested rule block
 * doesn't end any one scan early (BST-1685 review round 2, Claude Minor 2).
 * A naive `[^}]*` regex can't cross a `}`, so it only ever sees a block's
 * FIRST rule — moving a selector into its own later rule inside the same
 * media block (order- and reformat-preserving) would silently pass.
 *
 * `overrides.css` declares this media query four times; walks every
 * occurrence in turn (brace-matched, so each candidate's own close is found
 * correctly) rather than doing one file-wide `indexOf(marker)` and matching
 * that occurrence's NEAREST preceding `@media` — `marker` (e.g.
 * `.bs-thinking-pulse`) can itself appear earlier in the file outside any
 * reduced-motion block, which would resolve to the wrong block entirely.
 */
function reducedMotionBlockContaining(cssSource: string, marker: string): string {
  const mediaOpen = '@media (prefers-reduced-motion: reduce) {';
  let searchFrom = 0;
  for (;;) {
    const mediaStart = cssSource.indexOf(mediaOpen, searchFrom);
    if (mediaStart === -1) {
      throw new Error(`no reduced-motion media block contains marker: ${marker}`);
    }
    let depth = 0;
    let blockEnd = -1;
    for (let index = mediaStart; index < cssSource.length; index += 1) {
      const char = cssSource[index];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          blockEnd = index;
          break;
        }
      }
    }
    if (blockEnd === -1) {
      throw new Error(`unterminated reduced-motion media block scanning for marker: ${marker}`);
    }
    const block = cssSource.slice(mediaStart, blockEnd + 1);
    if (block.includes(marker)) {
      return block;
    }
    searchFrom = blockEnd + 1;
  }
}

/**
 * Within `block` (already scoped to one `@media` rule), asserts that
 * `selector` — matched at its FIRST occurrence immediately followed by a
 * selector-list separator (`,`) or its own rule's opening brace (`{`), so a
 * match can't be satisfied by a longer compound selector that merely shares
 * `selector` as a trailing substring — resolves to `animation: none` before
 * THAT SPECIFIC rule's own closing `}`. Scoping to one rule (not "somewhere
 * later in the block") matters here: `overrides.css`'s reduced-motion block
 * resets `.assistant-ui-panel .bs-thinking-shimmer` a second time, in an
 * unrelated rule further down that only touches `background`/`color` — a
 * bare presence check would pass on THAT rule even if the real,
 * animation-resetting entry were deleted from the comma list (BST-1685
 * review round 2, Claude Minor 2).
 */
function assertSelectorResetsAnimationNone(block: string, selector: string): void {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*[,{]`).exec(block);
  expect(match).not.toBeNull();
  const matchIndex = match?.index ?? -1;
  const ruleEnd = block.indexOf('}', matchIndex);
  expect(ruleEnd).toBeGreaterThan(matchIndex);
  expect(block.slice(matchIndex, ruleEnd)).toMatch(/animation:\s*none/);
}

describe('assistant UI panel architecture', () => {
  it('keeps the assistant panel root under the source-file budget', () => {
    const source = readSource('assistant-ui-panel.tsx');

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
    // entirely in @brainstrike/app-state — this file only plumbs three
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
    // small prop/renderer through it: the composer workspace bar (BST-1396;
    // <WorkspaceBar /> mounts as a sibling at the top of the composer stack,
    // replacing WS6's <OperatingRootChip /> one-for-one), the approval/suspend
    // outcome chip (WS2), the context-breakdown
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
    // Bumped 1870 → 1880 for the "Copy debug bundle" button (Task 9, Flight
    // Recorder capstone): AssistantMessage mounts <CopyDebugBundleButton />
    // (its own module, copy-debug-bundle-button.tsx) after
    // <AssistantMessageError />. The runId detection, phase machine, and
    // clipboard/error handling all live in that module; this file only
    // imports + renders it.
    // Dropped 1880 → 1509 (BST-1677): AssistantMessage now renders
    // <AssistantActivityParts /> (assistant-activity-parts.tsx) instead of
    // <MessagePrimitive.Parts components={{ ChainOfThought, Text }} />. The
    // panel's own copies of isRunningReasoningPart, HiddenReasoningPart,
    // isReasoningPart, reasoningToggleLabel, ChainReasoningFold,
    // isActivityPart, ActivityPartLayout, ActivityToolPart, and
    // LocalChainOfThought are deleted — that grouped-parts renderer is the
    // one implementation now, and its invariants live in its own module.
    // Bumped 1509 → 1524 for the thread-tab run-state seam (BST-1844):
    // onRunningChange threads the SAME 5 layers as onRunFinished/onUsage
    // (AssistantUiPanel → Local/DataStream chat → ChatThreadUI); the bridge
    // itself lives in running-state-bridge.tsx.
    expect(source.split('\n').length).toBeLessThanOrEqual(1524);
  });

  it('keeps the composer workspace bar an app-shell-rendered SLOT above the context meter', () => {
    // BST-1396: the workspace bar (folder · branch) replaces the WS6
    // operating-root chip. It is a SIBLING at the top of the composer stack —
    // never nested inside ThreadContextMeter, which is reworked separately.
    //
    // The prop is a ReactNode SLOT, not the bar's props: app-shell renders the
    // bar host (`WorkspaceBarHost`, which owns useWorkspaceBar's two
    // live-refresh subscriptions), so a git push no longer re-renders the
    // 1800-line wrapper that composed those props. This package stays
    // store-free either way — it just no longer needs the props' shape.
    const source = readSource('assistant-ui-panel.tsx');
    expect(source).toContain('workspaceBar?: ReactNode');
    // The bar is NOT constructed here any more; only the slot is rendered.
    expect(source).not.toContain('<WorkspaceBar');
    expect(source).not.toContain("from './workspace-bar/workspace-bar'");

    const composerShellStart = source.indexOf('className="bs-composer-shell"');
    expect(composerShellStart).toBeGreaterThan(-1);
    const composerShellSource = source.slice(composerShellStart);
    const workspaceBarStart = composerShellSource.indexOf('{workspaceBar ?? null}');
    const contextMeterStart = composerShellSource.indexOf('<ThreadContextMeter');
    expect(workspaceBarStart).toBeGreaterThan(-1);
    expect(workspaceBarStart).toBeLessThan(contextMeterStart);

    // The chip it replaces is gone for good — including its prop.
    expect(source).not.toContain('OperatingRootChip');
    expect(source).not.toContain('operatingRoot');

    // The bar module and its types stay exported for the app-shell host.
    expect(readSource('workspace-bar/workspace-bar.tsx')).toContain('export const WorkspaceBar');
    const indexSource = readSource('index.ts');
    expect(indexSource).toContain("from './workspace-bar/workspace-bar'");
    for (const exported of [
      'WorkspaceBar,',
      'type WorkspaceBarBaseRefOption,',
      'type WorkspaceBarBranchMenu,',
      'type WorkspaceBarBranchRow,',
      'type WorkspaceBarCheckout,',
      'type WorkspaceBarCreateWorktreeRequest,',
      'type WorkspaceBarMode,',
      'type WorkspaceBarProps,',
      'type WorkspaceBarRecentRoot,',
      'type WorkspaceBarReveal,',
      'type WorkspaceBarRoot,',
      'type WorkspaceBarWorktreeOption,',
      'type WorkspaceBarWorktreePicker,',
      'type WorkspaceBarWorktreeSummary,',
    ]) {
      expect(indexSource).toContain(exported);
    }
  });

  it('keeps provider settings and controls as owned panel modules', () => {
    const source = readSource('assistant-ui-panel.tsx');

    expect(source).toContain("from './assistant-controls-menu'");
    expect(source).toContain("from './provider-settings-panel'");
    expect(readSource('provider-settings-panel.tsx')).toContain(
      'export const ProviderSettingsPanel'
    );
    expect(readSource('assistant-controls-menu.tsx')).toContain('export const ControlsMenu');
  });

  it('mounts a visible error block on assistant messages', () => {
    // Transport/init failures reject the run with no message parts; without
    // this block they render as an EMPTY assistant bubble and the failure is
    // invisible (the "instant empty reply" bug).
    const source = readSource('assistant-ui-panel.tsx');
    expect(source).toContain("from './assistant-message-error'");

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<AssistantMessageError />');

    expect(readSource('assistant-message-error.tsx')).toContain('ErrorPrimitive.Message');
  });

  it('mounts the turn-level revert footer as an owned module on assistant messages', () => {
    const source = readSource('assistant-ui-panel.tsx');
    expect(source).toContain("from './checkpoint-turn-revert'");

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<CheckpointTurnRevert />');

    expect(readSource('checkpoint-turn-revert.tsx')).toContain(
      'export function CheckpointTurnRevert'
    );
  });

  it('mounts the per-run verdict footer as an owned module on assistant messages', () => {
    // Task Ledger 👍/👎 (source 'user'): the runId detection, phase machine,
    // and context seam all live in run-verdict-control.tsx /
    // run-verdict-context.tsx; this file only imports + renders the control.
    const source = readSource('assistant-ui-panel.tsx');
    expect(source).toContain("from './run-verdict-control'");

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<RunVerdictControl />');

    expect(readSource('run-verdict-control.tsx')).toContain('export function RunVerdictControl');
  });

  it('mounts the copy-debug-bundle button as an owned module on assistant messages', () => {
    // Flight Recorder capstone (Task 9): the runId/error-state detection,
    // phase machine, and clipboard handling all live in
    // copy-debug-bundle-button.tsx / debug-bundle-context.tsx; this file only
    // imports + renders the control, immediately after AssistantMessageError.
    const source = readSource('assistant-ui-panel.tsx');
    expect(source).toContain("from './copy-debug-bundle-button'");

    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    expect(assistantMessageSource).toContain('<CopyDebugBundleButton />');
    expect(assistantMessageSource.indexOf('<AssistantMessageError />')).toBeLessThan(
      assistantMessageSource.indexOf('<CopyDebugBundleButton />')
    );

    expect(readSource('copy-debug-bundle-button.tsx')).toContain(
      'export function CopyDebugBundleButton'
    );
  });

  it('mounts the budget guardrail as an owned module and gates BOTH send paths', () => {
    // Last-24h budget cap (Task Ledger phase 1): the chip, over-cap notice, and
    // gate derivation live in budget-guardrail-control.tsx / the context seam in
    // budget-guardrail-context.tsx; this file only imports + renders the control
    // and calls the gate hook. The composer input row AND the edit-composer
    // resend both consume the gate — a blocked send must have no hidden path.
    const source = readSource('assistant-ui-panel.tsx');
    expect(source).toContain("from './budget-guardrail-control'");
    expect(source).toContain('<BudgetGuardrailControl />');

    expect(source).toContain("import { EditComposer } from './edit-composer'");
    expect(source).toContain('EditComposer,');
    const editComposerSource = readSource('edit-composer.tsx');
    expect(editComposerSource).toContain('export function EditComposer');
    expect(editComposerSource).toContain('useBudgetSendGate()');
    // The gate must reach the Input too, not just the Send button — Enter in
    // the edit input is a submit path (review #1714).
    expect(editComposerSource.match(/disabled=\{budgetSendBlocked\}/g)?.length).toBe(2);

    const composerInputSource = readSource('composer-input.tsx');
    expect(composerInputSource).toContain('useBudgetSendGate()');
    expect(readSource('budget-guardrail-control.tsx')).toContain(
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
    // UserActionBar lives in user-message.tsx (extracted from the panel root
    // under the source-file budget); it is the last export, so the slice runs
    // to end-of-file.
    const source = readSource('user-message.tsx');
    const userActionBarStart = source.indexOf('export const UserActionBar =');
    expect(userActionBarStart).toBeGreaterThan(-1);
    const userActionBarSource = source.slice(userActionBarStart);

    expect(userActionBarSource).toContain('useCopyToClipboard()');
    expect(userActionBarSource).toContain('aui.message().getCopyText()');
    expect(userActionBarSource).toContain('ActionBarPrimitive.Edit');
    // Not USED as a component (a comment may still reference it by name to
    // explain why it was replaced).
    expect(userActionBarSource).not.toContain('<ActionBarPrimitive.Copy');
    // Broken-bridge failure must be visibly rendered, never silent.
    expect(userActionBarSource).toContain("isFailed ? 'Copy failed' : null");
  });

  it('renders assistant parts through the grouped activity renderer, never the legacy ChainOfThought slot', () => {
    const source = readSource('assistant-ui-panel.tsx');
    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);

    expect(assistantMessageSource).toContain('<AssistantActivityParts />');
    expect(source).not.toContain('ChainOfThought: ');
    expect(source).not.toContain('ChainOfThoughtPrimitive');
    expect(source).not.toContain('LocalChainOfThought');

    const partsSource = readSource('assistant-activity-parts.tsx');
    expect(partsSource).toContain('MessagePrimitive.GroupedParts');
    expect(partsSource).toContain('groupBy={groupAssistantActivityPart}');
    expect(partsSource).toContain('CHAIN_OF_THOUGHT_TOOL_COMPONENTS.by_name[props.toolName]');
    expect(readSource('todo-progress.tsx')).toContain('Fallback: ToolFallback');
  });

  it('uses the shared thinking indicator instead of a bare streaming caret', () => {
    // The panel no longer imports assistant-thinking-indicator directly — the
    // reasoning fold that uses it moved to assistant-activity-parts.tsx.
    const partsSource = readSource('assistant-activity-parts.tsx');
    const cssSource = readSource('overrides.css');

    expect(partsSource).toContain("from './assistant-thinking-indicator'");
    expect(cssSource).toContain('.bs-streaming-thinking');
    expect(cssSource).toContain('@media (forced-colors: active)');
    expect(cssSource).toContain('-webkit-text-fill-color: CanvasText');
    expect(cssSource).not.toContain('--aui-content: "|"');
  });

  it('owns thread scrolling with a stick-to-bottom viewport and a floating jump-to-latest button (BST-896)', () => {
    const panelSource = readSource('assistant-ui-panel.tsx');
    // BST-897 moved the scroll region itself into its own module (the two-tier
    // renderer owns the viewport, the message list and the jump button); the
    // panel keeps only the composition site. These invariants moved with it.
    const regionSource = readSource('assistant-thread-messages.tsx');
    const followSource = readSource('thread-scroll-follow.tsx');
    const cssSource = readSource('overrides.css');

    expect(panelSource).toContain("from './assistant-thread-messages'");
    expect(panelSource).toContain('<ThreadMessagesRegion');

    // Persistence contract (docs/agents/assistant-persistence.md): reopening a
    // thread restores its scroll position — the follow engine must never jump
    // on attach (only thread SWITCHES jump; initial mount is a restore).
    expect(followSource).toContain('attach: (el) =>');
    expect(followSource).not.toContain('scrollToBottomOnInitialize');
    expect(regionSource).toContain('switchKeyRef.current === threadKey');

    // The scroller is a PLAIN div wired to the repo-owned follow engine —
    // never ThreadPrimitive.Viewport, whose auto-scroll broke upstream twice
    // (0.14.28, 0.15.x) and is deliberately out of the loop on both tiers.
    expect(regionSource).not.toContain('<ThreadPrimitive.Viewport');
    expect(regionSource).toContain('follow.attach(el)');

    // The button is a SIBLING of the scroller inside the positioned scroll
    // region, so it stays put instead of scrolling away with the messages.
    const regionStart = regionSource.indexOf('<ThreadScrollRegion>');
    const viewportStart = regionSource.indexOf('data-testid="assistant-ui-viewport"');
    const buttonStart = regionSource.indexOf('<ThreadScrollToBottom');
    expect(regionStart).toBeGreaterThan(-1);
    expect(regionStart).toBeLessThan(viewportStart);
    expect(buttonStart).toBeGreaterThan(viewportStart);
    expect(regionSource).toContain('ThreadStaticScrollToBottom');
    // BST-897: the button's chrome (class, icon, label, test id) is declared
    // ONCE and shared by both tiers — only the behaviour differs.
    expect(regionSource).toContain("'data-testid': 'assistant-scroll-to-bottom'");
    expect(regionSource.match(/JUMP_TO_LATEST_PROPS/g)?.length).toBeGreaterThanOrEqual(3);

    // Reduced motion: an explicit `behavior` on the tier-1 jump would bypass
    // CSS scroll-behavior and therefore globals.css's prefers-reduced-motion
    // override, so the engine's explicit scrollToBottom omits it. (BST-897's
    // virtualized tier is the documented exception — there the behavior drives
    // the virtualizer's scroll state machine, so it checks the media query
    // itself.)
    expect(regionSource).not.toContain('behavior="smooth"');
    expect(regionSource).toContain('prefersReducedMotion()');
    expect(followSource).toContain('el.scrollTo({ top: el.scrollHeight })');

    // Scroll anchoring is opted OUT only while pinned (JS owns scrollTop
    // there); scrolled up it is the reader's only protection against content
    // above the fold resizing.
    expect(cssSource).toContain(
      '.bs-thread-scroll-region[data-pinned="true"] .aui-thread-viewport {\n  overflow-anchor: none;\n}'
    );
    expect(regionSource).toContain("data-pinned={isAtBottom ? 'true' : undefined}");
    expect(cssSource).toContain('.bs-scroll-to-bottom');
    expect(cssSource).toContain('.bs-scroll-to-bottom:focus-visible');

    // The buggy collapsed-history toggle it replaces is gone for good.
    for (const removed of [
      'COLLAPSED_HISTORY_VISIBLE_MESSAGES',
      'ThreadHistoryControl',
      'data-history-collapsed',
      'assistant-history-toggle',
    ]) {
      expect(panelSource).not.toContain(removed);
    }
    for (const removed of ['bs-history-control', 'data-history-collapsed', 'nth-last-child']) {
      expect(cssSource).not.toContain(removed);
    }
  });

  it('renders threads through an explicit two-tier renderer (BST-897)', () => {
    const regionSource = readSource('assistant-thread-messages.tsx');
    const followSource = readSource('thread-scroll-follow.tsx');
    const cssSource = readSource('overrides.css');

    // The switch point is a single exported constant — never a magic number
    // duplicated between the renderer and its tests.
    expect(regionSource).toMatch(/export const THREAD_VIRTUALIZATION_THRESHOLD = \d+;/);
    expect(regionSource).toContain('export const THREAD_MESSAGE_ESTIMATED_HEIGHT_PX');

    // NO SILENT FALLBACKS: the active tier is observable in the DOM.
    expect(regionSource).toContain('data-thread-render-tier={tier}');

    // `useVirtualizer` is on React Compiler's incompatible-library list, and the
    // resulting opt-out is WANTED here (this component must re-render per scroll
    // frame). Both engines are suppressed at the call site with a rationale —
    // never with `use no memo`, which `lint:no-no-memo` forbids repo-wide, and
    // never by widening the eslint warning budget.
    expect(regionSource).toContain(
      '// react-doctor-disable-next-line react-hooks-js/incompatible-library --'
    );
    expect(regionSource).toContain('/* eslint-disable react-hooks/incompatible-library --');
    expect(regionSource).toContain('/* eslint-enable react-hooks/incompatible-library */');

    // Tier 2 is the library's documented virtualization escape hatch: message
    // ids drive the list, and the SAME components map renders both tiers.
    expect(regionSource).toContain('unstable_useThreadMessageIds');
    expect(regionSource).toContain('ThreadPrimitive.Unstable_MessageById');
    expect(regionSource).toContain('getItemKey');
    expect(regionSource).toContain("anchorTo: 'end'");
    expect(regionSource).toContain('followOnAppend');

    // One scroll owner per tier: the follow engine attaches only on the
    // static tier; on the virtual tier the virtualizer owns scrollTop
    // outright and the engine idles with no element. The engine itself never
    // grows a second attach site.
    expect(regionSource).toContain("if (!el || tier !== 'static')");
    expect(followSource.match(/new ResizeObserver/g)?.length).toBe(1);
    expect(regionSource).toContain("if (tier === 'static') {");

    // Live-region announcements fork per tier: on the virtual tier rows mount
    // and unmount as the user SCROLLS, and each insertion would be announced.
    expect(regionSource).toContain("aria-live={tier === 'static' ? 'polite' : 'off'}");

    // Pinnedness at the tier switch is RECORDED from the follow engine's own
    // signal while the static tier is still mounted — measuring the viewport
    // after the swap reads the virtualizer's estimated size, not the static
    // geometry.
    expect(regionSource).toContain('pinnedWhileStatic');
    expect(regionSource).toContain('useThreadFollowIsAtBottom()');

    // Tier 1 containment: applied to message roots but NEVER to the last
    // (streaming) row, and never on the virtualized tier.
    expect(cssSource).toContain('content-visibility: auto');
    expect(cssSource).toContain('contain-intrinsic-size: auto');
    expect(cssSource).toContain('[data-thread-render-tier="static"]');
    expect(cssSource).toContain(':not(:last-child)');
    expect(cssSource).toContain('[data-thread-render-tier="virtual"]');
  });

  it('only animates the chain-of-thought row while its own part is running', () => {
    // This logic moved to assistant-activity-parts.tsx alongside the rest of
    // the reasoning disclosure (BST-1677 wave 1); wave 2 then moved it from
    // per-GROUP to per-PART (each reasoning leaf owns its own row/disclosure
    // now, so the group no longer computes a single running flag for all of
    // them) — the panel still never owns it.
    const partsSource = readSource('assistant-activity-parts.tsx');
    const cssSource = readSource('overrides.css');

    expect(partsSource).toContain("part.status.type === 'running'");
    // BST-1681 moved the branch out of the JSX ternary into `ReasoningGlyph`'s
    // early return (the row's glyph slot), but it is still the PART's own
    // status that decides between the live and the static mark.
    expect(partsSource).toContain('<ReasoningGlyph isStreaming={isStreaming} />');
    expect(partsSource).toContain('if (isStreaming) {');
    expect(partsSource).toContain('assistant-reasoning-static-mark');
    expect(cssSource).toContain('.bs-thinking-mark-static');
  });

  it('honours reduced motion for the running step row shimmer', () => {
    // Task 5 review, Minor 4. The shimmer on a running row's verb is
    // STYLESHEET-owned (`.bs-thinking-shimmer` in overrides.css), not a
    // `motion-reduce:` utility on the element — the browser lane has no
    // Tailwind, and the subagent card's old `motion-reduce:animate-none`
    // spinner went away when the row took over the liveness. So this block is
    // the only thing that honours a reduced-motion preference for a running
    // step, and nothing else asserts it exists.
    //
    // The two COMPOUND selectors are checked independently of the plain
    // class and of each other (BST-1685, PR #3066 "Tests / docs nits"): the
    // trace's live status label carries an entrance class and
    // `.bs-thinking-shimmer` at once, and the compound rules that compose
    // those two animations outrank the one-class reset — so each selector
    // below must land its own `animation: none` inside this media block,
    // however the comma list orders or wraps them (the previous single regex
    // pinned one exact order, which broke on an innocuous reformat).
    const cssSource = readSource('overrides.css');
    // Slice the SPECIFIC reduced-motion block first (BST-1685 review round
    // 2, Claude Minor 2): matching against the whole file let the standalone
    // `.bs-thinking-shimmer` assertion pass on nothing but a SUBSTRING of
    // either compound selector below (both end in `.bs-thinking-shimmer`),
    // so deleting the standalone selector from the reset list left all three
    // assertions green — the mutation this test exists to catch. Slicing
    // first, then requiring each selector's own right boundary (`,` or `{`,
    // not a continuation into a longer compound), closes that.
    const reducedMotionBlock = reducedMotionBlockContaining(cssSource, '.bs-thinking-pulse');

    // Each of the three selectors must resolve to `animation: none` inside
    // ITS OWN rule within this block, not merely appear somewhere in it: this
    // same media block also resets `.assistant-ui-panel .bs-thinking-shimmer`
    // a second time, in an UNRELATED rule further down that only touches
    // `background`/`color` — a presence-only check (even boundary-checked)
    // would pass on that rule too if the reset-list entry were deleted, so
    // `assertSelectorResetsAnimationNone` scopes each check to the specific
    // rule the matched selector opens (up to that rule's own `}`).
    // Order- and reformat-resilient: `indexOf`/`exec` don't care how the
    // comma list orders or wraps its entries.
    assertSelectorResetsAnimationNone(
      reducedMotionBlock,
      '.assistant-ui-panel .bs-thinking-shimmer'
    );
    assertSelectorResetsAnimationNone(
      reducedMotionBlock,
      '.assistant-ui-panel .bs-trace-label.bs-thinking-shimmer'
    );
    assertSelectorResetsAnimationNone(
      reducedMotionBlock,
      '.assistant-ui-panel .bs-trace-label-static.bs-thinking-shimmer'
    );
    // Not vacuous: the row really does put that class on a running verb.
    expect(readSource('activity-step-row.tsx')).toContain("'bs-thinking-shimmer'");

    // Not vacuous, BEHAVIOURALLY: the trace really does put both classes on
    // the live label element at once while a step is running. Replaces a
    // source-string pin on the template literal that composes them
    // (`'bs-activity-live-label bs-thinking-shimmer '`, including its
    // trailing space) — that pin broke on innocuous formatting rather than
    // on a behaviour change (PR #3066 review nit).
    const runningSummary: ActivitySummary = {
      counts: { failed: 0, steps: 1 },
      live: 'Reading app.ts',
      resting: 'Read',
      verbs: 'Read',
      waiting: false,
    };
    const { getByTestId, unmount } = render(
      createElement(ActivityTrace, {
        detail: null,
        fallbackMs: undefined,
        incompleteReason: undefined,
        isActive: true,
        restingOverride: null,
        summary: runningSummary,
      })
    );
    try {
      const liveLabel = getByTestId('assistant-activity-working').querySelector(
        '.bs-activity-live-label'
      );
      expect(liveLabel).not.toBeNull();
      expect(liveLabel).toHaveClass('bs-activity-live-label', 'bs-thinking-shimmer');
    } finally {
      // Explicit, on top of the package's global `afterEach(cleanup)`
      // (packages/test-utils/src/vitest.setup.ts) — this file's other tests
      // are fs-only, so leaving the mount around between them is harmless
      // today, but a `screen.*` query added later here shouldn't have to
      // rediscover that this is the one test in the file that renders
      // (BST-1685 review round 2, Claude Minor 1).
      unmount();
    }
  });

  it('honours reduced motion for the step row REVEAL animation', () => {
    // Bot round 1, Claude Minor 8. Every step row mounts with
    // `.bs-trace-reveal` (`RowShell`, both forms) and the phase-2 staggered
    // entrance rides on it, so this is the second animation a reduced-motion
    // preference has to stop — and, like the shimmer, it is STYLESHEET-owned
    // (the browser lane has no Tailwind, so `motion-reduce:` utilities would
    // be inert there). CDT measured `animation-name: none` on all rows under
    // the preference; nothing else pins the rule that produces it.
    const cssSource = readSource('overrides.css');
    expect(cssSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.assistant-ui-panel \.bs-trace-label,\s*\.assistant-ui-panel \.bs-trace-reveal \{\s*animation: none;/
    );
    // Not vacuous: every row form really does carry the class.
    expect(readSource('activity-step-row.tsx')).toContain('bs-step-row bs-trace-reveal');
  });

  it('keeps the "static thinking mark" CSS hook confined to assistant-thinking-indicator.tsx', () => {
    // `bs-thinking-mark-static` is BrainstrikeThinkingMark's own `live={false}`
    // class (assistant-thinking-indicator.tsx); every other caller must go
    // through the component's `live` prop rather than re-spelling the class
    // name, or a rename there would silently desync from callers that never
    // ran through this test.
    const literal = 'bs-thinking-mark-static';
    const offenders = listComponentSourceFiles().filter(
      (file) => file !== 'assistant-thinking-indicator.tsx' && readSource(file).includes(literal)
    );
    expect(offenders).toEqual([]);
    // Sanity: the assertion above is not vacuously true because the literal
    // doesn't exist anywhere — confirm it's still in the one file it belongs.
    expect(readSource('assistant-thinking-indicator.tsx')).toContain(literal);
  });

  it('registers data renderers only via useAssistantDataUI, never a `Data:` key in a components map', () => {
    const panelSource = readSource('assistant-ui-panel.tsx');
    expect(panelSource).toContain("from './assistant-data-renderer-registration'");
    expect(panelSource).toContain('<AssistantDataRendererRegistration />');
    expect(readSource('assistant-data-renderer-registration.tsx')).toContain(
      'useAssistantDataUI(assistantRunTimelineDataUI)'
    );
    // Unquoted, not quoted, is the real regression shape — `components={{
    // Data: X }}`, exactly like the existing `Text: AssistantMessageText`
    // entry — so the guard must match a bare `Data:` object key, not just a
    // quoted string key (the previous `/['"`]Data:['"`]/` could never fail).
    expect(panelSource).not.toMatch(/(^|[{,\s])Data:/m);

    const partsSource = readSource('assistant-activity-parts.tsx');
    expect(partsSource).toContain("case 'data':");
    expect(partsSource).toContain('part.dataRendererUI');
  });
});
