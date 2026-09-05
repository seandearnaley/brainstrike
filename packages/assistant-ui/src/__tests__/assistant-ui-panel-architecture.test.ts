import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath: string): string =>
  readFileSync(join(sourceRoot, relativePath), 'utf8');

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
    expect(source.split('\n').length).toBeLessThanOrEqual(1880);
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

    const editComposerStart = source.indexOf('const EditComposer =');
    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const editComposerSource = source.slice(editComposerStart, assistantMessageStart);
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

  it('renders assistant tool-call parts through the chain-of-thought tool fallback', () => {
    const source = readSource('assistant-ui-panel.tsx');
    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);
    const localChainOfThoughtStart = source.indexOf('const LocalChainOfThought =');
    const dataRendererStart = source.indexOf('const AssistantDataRendererRegistration =');
    const localChainOfThoughtSource = source.slice(localChainOfThoughtStart, dataRendererStart);

    expect(assistantMessageSource).toContain('ChainOfThought: LocalChainOfThought');
    // The tool-components map (by_name + Fallback) is extracted to
    // CHAIN_OF_THOUGHT_TOOL_COMPONENTS in todo-progress.tsx to stay under the
    // source-file budget above; assert the wiring there instead of inline.
    expect(localChainOfThoughtSource).toContain('Fallback: ActivityToolPart');
    expect(source).toContain('CHAIN_OF_THOUGHT_TOOL_COMPONENTS.by_name[props.toolName]');
    expect(readSource('todo-progress.tsx')).toContain('Fallback: ToolFallback');
  });

  it('uses the shared thinking indicator instead of a bare streaming caret', () => {
    const panelSource = readSource('assistant-ui-panel.tsx');
    const cssSource = readSource('overrides.css');

    expect(panelSource).toContain("from './assistant-thinking-indicator'");
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

  it('only animates the chain-of-thought pill while reasoning is running', () => {
    const panelSource = readSource('assistant-ui-panel.tsx');
    const cssSource = readSource('overrides.css');

    expect(panelSource).toContain('isRunningReasoningPart');
    expect(panelSource).toContain('isReasoningRunning ? (');
    expect(panelSource).toContain('assistant-reasoning-static-mark');
    expect(cssSource).toContain('.bs-thinking-mark-static');
  });
});
