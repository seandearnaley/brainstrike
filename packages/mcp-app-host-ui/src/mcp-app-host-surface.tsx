import type { McpAppToolCallAuthority, McpAppToolRiskCategory } from '@brainstrike/mcp-app-host';
import { Button } from '@brainstrike/ui';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

export type McpAppHostErrorCode = 'load-failed' | 'permission-failed' | 'protocol-failed';

export type McpAppHostState =
  | Readonly<{ phase: 'cancelled' | 'completed' | 'loading' | 'ready' }>
  | Readonly<{ code: McpAppHostErrorCode; phase: 'error' }>;

export interface McpAppHostSurfaceProps {
  /**
   * The app's last reported content height in CSS pixels, from its
   * `ui/notifications/size-changed`. The frame follows it within
   * {@link MCP_APP_MIN_HEIGHT_PX}..{@link MCP_APP_MAX_HEIGHT_PX}; past the
   * maximum the app scrolls inside its own frame.
   */
  readonly appHeight?: number | undefined;
  readonly appName: string;
  readonly authority: McpAppToolCallAuthority;
  readonly children?: ReactNode;
  readonly onCancel?: () => void;
  /** Restarts the app from a fresh session; offered when it failed or closed. */
  readonly onRetry?: () => void;
  readonly recoveryFocusRef: RefObject<HTMLElement | null>;
  readonly state: McpAppHostState;
}

const ERROR_MESSAGES: Readonly<Record<McpAppHostErrorCode, string>> = Object.freeze({
  'load-failed': 'The app resource could not be loaded safely.',
  'permission-failed': 'The app permission request could not be completed safely.',
  'protocol-failed': 'The app could not start safely.',
});

/** What allowing the call lets the app do, in plain words. */
const RISK_SENTENCE: Readonly<Record<McpAppToolRiskCategory, string>> = Object.freeze({
  edit: 'It can change files or data on your behalf.',
  execute: 'It can run commands or take actions with effects outside this app.',
  mcp: 'It runs a tool on the app’s server, which can act on your behalf.',
  read: 'It can read files or data and pass them to the app.',
});

function focus(element: HTMLElement | null): void {
  element?.focus();
}

/**
 * The frame's height before the app reports its own, and while it loads, so a
 * result does not jump when the app appears. Also the least room a consent
 * prompt is given over the app.
 */
const MCP_APP_DEFAULT_HEIGHT_PX = 256;
/** The smallest frame an app can ask for. */
const MCP_APP_MIN_HEIGHT_PX = 96;
/** The tallest frame an app can ask for; a taller app scrolls inside it. */
const MCP_APP_MAX_HEIGHT_PX = 640;

/**
 * The frame follows the app's reported height within the bounds; a pending
 * consent prompt keeps at least the default room, however small the app is.
 */
function frameHeight(appHeight: number | undefined, consentPending: boolean): number {
  const floor = consentPending ? MCP_APP_DEFAULT_HEIGHT_PX : MCP_APP_MIN_HEIGHT_PX;
  if (appHeight === undefined || !Number.isFinite(appHeight)) {
    return Math.max(floor, MCP_APP_DEFAULT_HEIGHT_PX);
  }
  return Math.min(MCP_APP_MAX_HEIGHT_PX, Math.max(floor, Math.ceil(appHeight)));
}

interface AppNameProps {
  readonly appName: string;
}

/** The header row above the app: its name and, when the host can stop it, Cancel. */
function AppHeader({
  appName,
  onCancel,
}: AppNameProps & { readonly onCancel?: (() => void) | undefined }) {
  if (!onCancel) {
    return null;
  }
  return (
    <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-1.5">
      <span className="text-muted-foreground min-w-0 truncate text-xs font-medium">{appName}</span>
      <Button aria-label={`Cancel ${appName}`} onClick={onCancel} size="xs" variant="outline">
        Cancel
      </Button>
    </div>
  );
}

/** The loading box; also what a result shows before its app session exists. */
export function McpAppLoadingState({
  appName,
  onCancel,
}: Pick<McpAppHostSurfaceProps, 'appName' | 'onCancel'>) {
  return (
    <section
      aria-label={appName}
      className="border-border bg-card overflow-hidden rounded-lg border"
    >
      <AppHeader appName={appName} onCancel={onCancel} />
      <div
        className="text-muted-foreground flex items-center justify-center gap-2 text-sm"
        style={{ height: MCP_APP_DEFAULT_HEIGHT_PX }}
      >
        <span
          aria-hidden="true"
          className="border-muted-foreground/30 border-t-muted-foreground size-4 shrink-0 animate-spin rounded-full border-2 motion-reduce:animate-none"
        />
        <span aria-live="polite" role="status">
          Loading {appName}…
        </span>
      </div>
    </section>
  );
}

function ErrorState({
  appName,
  code,
  onRetry,
}: Pick<McpAppHostSurfaceProps, 'appName' | 'onRetry'> & { readonly code: McpAppHostErrorCode }) {
  const focusAlert = (node: HTMLDivElement | null): void => {
    if (node && !onRetry) {
      node.focus();
    }
  };
  const focusRetry = (node: HTMLButtonElement | null): void => node?.focus();
  return (
    <section aria-label={appName} className="border-destructive/40 bg-card rounded-lg border p-4">
      <div className="flex flex-col items-start gap-3" ref={focusAlert} role="alert" tabIndex={-1}>
        <p>{ERROR_MESSAGES[code]}</p>
        {onRetry ? (
          <Button
            aria-label={`Retry ${appName}`}
            onClick={onRetry}
            ref={focusRetry}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** Keeps Tab and Shift+Tab cycling between the consent prompt's two buttons. */
function trapConsentTab(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key !== 'Tab') {
    return;
  }
  const buttons = event.currentTarget.parentElement?.querySelectorAll('button');
  const first = buttons?.item(0);
  const last = buttons?.item(1);
  if (!(first && last)) {
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function ClosedState({
  appName,
  onRetry,
}: AppNameProps & { readonly onRetry?: (() => void) | undefined }) {
  return (
    <section aria-label={appName} className="border-destructive/40 bg-card rounded-lg border p-4">
      <div className="flex flex-col items-start gap-3">
        <p role="alert">The app session is closed.</p>
        {onRetry ? (
          <Button aria-label={`Reopen ${appName}`} onClick={onRetry} size="sm" variant="outline">
            Reopen
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function TerminalState({
  appName,
  phase,
  recoveryFocusRef,
}: Pick<McpAppHostSurfaceProps, 'appName' | 'recoveryFocusRef'> & {
  readonly phase: 'cancelled' | 'completed';
}) {
  const recover = (node: HTMLElement | null): void => {
    if (node) {
      focus(recoveryFocusRef.current);
    }
  };
  return (
    <section
      aria-label={appName}
      aria-live="polite"
      className="border-border bg-card text-muted-foreground rounded-lg border p-4 text-sm"
      ref={recover}
      role="status"
    >
      {appName} {phase === 'cancelled' ? 'was cancelled.' : 'completed.'}
    </section>
  );
}

export function McpAppHostSurface({
  appHeight,
  appName,
  authority,
  children,
  onCancel,
  onRetry,
  recoveryFocusRef,
  state,
}: McpAppHostSurfaceProps) {
  const subscribe = (listener: () => void) => {
    let previousApprovalId = authority.snapshot.pendingApprovals[0]?.id;
    return authority.subscribe(() => {
      const nextApprovalId = authority.snapshot.pendingApprovals[0]?.id;
      listener();
      if (previousApprovalId !== undefined && nextApprovalId === undefined) {
        queueMicrotask(() => focus(recoveryFocusRef.current));
      }
      previousApprovalId = nextApprovalId;
    });
  };
  const getSnapshot = () => authority.snapshot;
  const authoritySnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const approval = authoritySnapshot.pendingApprovals[0];
  // Focus "Allow once" only when a different approval takes over, never on
  // the unrelated re-renders every authority publish causes: yanking focus
  // from Deny to Allow mid-decision would be a consent-integrity bug. The
  // callback is stable; it compares the button's approval id itself.
  const focusedApprovalRef = useRef<string | undefined>(undefined);
  const focusApproval = (node: HTMLButtonElement | null): void => {
    const nodeApprovalId = node?.dataset['approvalId'];
    if (node === null || nodeApprovalId === focusedApprovalRef.current) {
      return;
    }
    focusedApprovalRef.current = nodeApprovalId;
    node.focus();
  };
  const [actionErrorId, setActionErrorId] = useState<string | undefined>(undefined);

  const approve = (): void => {
    if (!(approval && authority.approve(approval.id))) {
      setActionErrorId(approval?.id);
    }
  };
  const deny = (): void => {
    if (!(approval && authority.deny(approval.id))) {
      setActionErrorId(approval?.id);
    }
  };
  const handleConsentKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      deny();
      return;
    }
    trapConsentTab(event);
  };

  if (state.phase === 'loading') {
    return <McpAppLoadingState appName={appName} {...(onCancel ? { onCancel } : {})} />;
  }

  if (state.phase === 'error') {
    return <ErrorState appName={appName} code={state.code} {...(onRetry ? { onRetry } : {})} />;
  }

  if (state.phase === 'cancelled' || state.phase === 'completed') {
    return (
      <TerminalState appName={appName} phase={state.phase} recoveryFocusRef={recoveryFocusRef} />
    );
  }

  if (authoritySnapshot.phase === 'closed') {
    return <ClosedState appName={appName} onRetry={onRetry} />;
  }

  return (
    <section
      aria-label={appName}
      className="border-border bg-card relative overflow-hidden rounded-lg border"
    >
      <div aria-hidden={approval ? true : undefined} inert={approval ? true : undefined}>
        <AppHeader appName={appName} onCancel={onCancel} />
        <div style={{ height: frameHeight(appHeight, approval !== undefined) }}>{children}</div>
      </div>
      {approval ? (
        <div
          aria-label={`Allow ${appName} to use ${approval.toolName}?`}
          aria-modal="true"
          className="bg-background/90 absolute inset-0 flex items-center justify-center p-4"
          role="alertdialog"
        >
          <div className="border-border bg-card flex max-w-sm flex-col gap-3 rounded-lg border p-4 shadow-lg">
            <p className="font-medium">
              {appName} wants to run {approval.toolName}
            </p>
            <p className="text-muted-foreground text-sm">{RISK_SENTENCE[approval.riskCategory]}</p>
            {authoritySnapshot.pendingApprovals.length > 1 ? (
              <p className="text-muted-foreground text-xs">
                {authoritySnapshot.pendingApprovals.length - 1} more request
                {authoritySnapshot.pendingApprovals.length === 2 ? '' : 's'} waiting.
              </p>
            ) : null}
            {actionErrorId === approval.id ? (
              <p className="text-destructive text-sm" role="alert">
                This request is no longer pending. Return to the app and try again.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                aria-label={`Deny ${approval.toolName}`}
                onClick={deny}
                onKeyDown={handleConsentKeyDown}
                variant="outline"
              >
                Deny
              </Button>
              <Button
                aria-label={`Allow ${approval.toolName} once`}
                data-approval-id={approval.id}
                onClick={approve}
                onKeyDown={handleConsentKeyDown}
                ref={focusApproval}
              >
                Allow once
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
